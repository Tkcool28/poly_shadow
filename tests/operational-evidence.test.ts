import { existsSync, mkdtempSync, readFileSync, rmSync, truncateSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { OperationalEvidence, type OperationalEvidenceOptions } from '../src/shadow/operational-evidence.js';

const dirs:string[]=[];
const make=(dir?:string,options:OperationalEvidenceOptions={})=>{const d=dir??mkdtempSync(join(tmpdir(),'op-evidence-'));if(!dir)dirs.push(d);return new OperationalEvidence(d,()=> '2026-01-01T00:00:00.000Z',options);};
afterEach(()=>{while(dirs.length) rmSync(dirs.pop()!,{recursive:true,force:true});});
const q=(e:OperationalEvidence,id?:string)=>e.quarantine({quarantineId:id,component:'CHAIN',source:'CHAIN',sourceIdentity:id??null,rawEvidenceRef:id?`raw:${id}`:null,rpcRequestId:null,errorClass:'TIMEOUT',reason:'fixture',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
const state=(e:OperationalEvidence)=>({counts:e.quarantineState(),ids:e.quarantineStateIds()});
const evidenceBytes=(d:string)=>['rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson'].map(n=>{const p=join(d,n);return existsSync(p)?readFileSync(p,'utf8'):''}).join('\n');

describe('comparison-ready operational evidence',()=>{
  it('retains failed getLogs and links a complete later successful range',async()=>{
    const e=make(); const params=[{fromBlock:'0x64',toBlock:'0x6e'}];
    await expect(e.rpc(async()=>{throw new Error('RPC HTTP 503');},{family:'eth_getLogs',method:'eth_getLogs',params,component:'CHAIN',reason:'backfill',attempt:1,retryParentRequestId:null})).rejects.toThrow('503');
    await e.rpc(async()=>[],{family:'eth_getLogs',method:'eth_getLogs',params,component:'CHAIN',reason:'backfill',attempt:2,retryParentRequestId:null});
    const rows=readFileSync(join((e as unknown as {dir:string}).dir,'rpc_lineage.ndjson'),'utf8').trim().split('\n').map((line: string)=>JSON.parse(line));
    expect(rows).toHaveLength(2); expect(rows[0].requestedRange).toEqual({fromBlock:100,toBlock:110}); expect(rows[0].success).toBe(false);
    const resolution=JSON.parse(readFileSync(join((e as unknown as {dir:string}).dir,'rpc_recoveries.ndjson'),'utf8'));
    expect(resolution.fullFailedRangeCovered).toBe(true); expect(resolution.failedRequestId).toBe(rows[0].requestId);
  });
  it('rebuilds complete unresolved state after long history without a tail scan',()=>{
    const e=make();const early=q(e,'early');for(let i=0;i<5000;i++)q(e,`later-${i}`);expect(e.unresolvedQuarantineCount()).toBe(5001);e.resolveQuarantine(early.quarantineId,'RECOVERED','obs:old','OBSERVED',false);const expected=state(e);
    const d=(e as unknown as {dir:string}).dir;e.close();const restarted=make(d);expect(restarted.indexStatus().rebuildReason).toBe('VALID');expect(state(restarted)).toEqual(expected);restarted.resolveQuarantine(early.quarantineId,'RECOVERED','obs:old','OBSERVED',false);expect(state(restarted)).toEqual(expected);expect(()=>restarted.resolveQuarantine(early.quarantineId,'TERMINAL',null,'FAILED',true)).toThrow(/conflicting resolution/);
  });
  it('discards a corrupt index and rebuilds exact indexed state without mutating evidence',()=>{
    const e=make();const a=q(e,'unresolved'),b=q(e,'recovered');e.resolveQuarantine(b.quarantineId,'RECOVERED','obs:b','OBSERVED',false);for(let i=0;i<5000;i++)q(e,`later-${i}`);const d=(e as unknown as {dir:string}).dir,expected=state(e),before=evidenceBytes(d);e.close();truncateSync(join(d,'operational-index.sqlite'),7);
    const rebuilt=make(d);expect(rebuilt.indexStatus().rebuildReason).toBe('CORRUPT_OR_UNUSABLE');expect(state(rebuilt)).toEqual(expected);expect(rebuilt.quarantineStateIds()).toContainEqual({id:a.quarantineId,state:'UNRESOLVED'});expect(evidenceBytes(d)).toBe(before);expect(rebuilt.indexStatus().indexed).toBe(true);
  });
  it('rebuilds when index is entirely missing and then serves normal queries from the index',()=>{
    const e=make();q(e,'missing-index');const d=(e as unknown as {dir:string}).dir,expected=state(e);e.close();unlinkSync(join(d,'operational-index.sqlite'));const rebuilt=make(d);expect(rebuilt.indexStatus().rebuildReason).toBe('MISSING');expect(state(rebuilt)).toEqual(expected);expect(rebuilt.unresolvedQuarantineCount()).toBe(1);
  });
  it('rejects a readable semantically stale derived index and rebuilds it from NDJSON',()=>{
    const e=make();const a=q(e,'semantic-a'),b=q(e,'semantic-b');e.resolveQuarantine(b.quarantineId,'RECOVERED','obs:b','OBSERVED',false);const d=(e as unknown as {dir:string}).dir,expected=state(e);e.close();const db=new DatabaseSync(join(d,'operational-index.sqlite'));db.prepare('DELETE FROM q WHERE id=?').run(a.quarantineId);db.close();const rebuilt=make(d);expect(rebuilt.indexStatus().rebuildReason).toBe('SEMANTIC_MISMATCH');expect(state(rebuilt)).toEqual(expected);
  });
  it('is idempotent across build then repeated rebuilds without NDJSON mutation',()=>{
    const e=make();const a=q(e,'repeat-a'),b=q(e,'repeat-b');e.resolveQuarantine(b.quarantineId,'RECOVERED','obs:b','OBSERVED',false);const d=(e as unknown as {dir:string}).dir,expected=state(e),before=evidenceBytes(d);e.close();unlinkSync(join(d,'operational-index.sqlite'));const one=make(d);one.close();unlinkSync(join(d,'operational-index.sqlite'));const two=make(d);expect(state(two)).toEqual(expected);expect(evidenceBytes(d)).toBe(before);
  });
  it.each(['quarantine','resolution','rpc','rpc-recovery'] as const)('recovers authoritative %s append after an interrupted derived update',async(kind)=>{
    const d=mkdtempSync(join(tmpdir(),'op-fault-'));dirs.push(d);let hit=false;const failing=make(d,{fault:(point,name)=>{if(point==='after-authoritative-append'&&!hit&&((kind==='quarantine'&&name==='quarantine_v2.ndjson')||(kind==='resolution'&&name==='quarantine_resolutions.ndjson')||(kind==='rpc'&&name==='rpc_lineage.ndjson')||(kind==='rpc-recovery'&&name==='rpc_recoveries.ndjson'))){hit=true;throw Error('injected index interruption')}}});
    if(kind==='quarantine')expect(()=>q(failing,'fault-q')).toThrow('injected');
    if(kind==='resolution'){const base=q(failing,'fault-resolution');expect(()=>failing.resolveQuarantine(base.quarantineId,'RECOVERED','obs','OBSERVED',false)).toThrow('injected');}
    if(kind==='rpc')await expect(failing.rpc(async()=>{throw Error('RPC HTTP 503')},{family:'rpc',method:'eth_getBlockByNumber',params:['0x1'],component:'CHAIN',reason:'verifier',attempt:1,retryParentRequestId:null})).rejects.toThrow('injected');
    if(kind==='rpc-recovery'){await expect(failing.rpc(async()=>{throw Error('RPC HTTP 503')},{family:'rpc',method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x2'}],component:'CHAIN',reason:'backfill',attempt:1,retryParentRequestId:null})).rejects.toThrow('503');await expect(failing.rpc(async()=>[],{family:'rpc',method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x2'}],component:'CHAIN',reason:'backfill',attempt:2,retryParentRequestId:null})).rejects.toThrow(/operational index is invalid|injected/);}
    const rebuilt=make(d);expect(rebuilt.indexStatus().rebuildReason).toBe('AUTHORITATIVE_ADVANCED');if(kind==='quarantine')expect(rebuilt.quarantineStateIds()).toContainEqual({id:'fault-q',state:'UNRESOLVED'});if(kind==='resolution')expect(rebuilt.quarantineStateIds()).toContainEqual({id:'fault-resolution',state:'RECOVERED'});if(kind==='rpc'||kind==='rpc-recovery')expect(readFileSync(join(d,'rpc_lineage.ndjson'),'utf8')).not.toBe('');
    expect(failing.isUsable()).toBe(false);expect(()=>failing.assertUsable()).toThrow('injected index interruption');
  });

  it.each(['rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson','rest_poll_receipts.ndjson','runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson'] as const)('fails closed before authoritative %s append without phantom state',async(name)=>{
    const d=mkdtempSync(join(tmpdir(),'op-prewrite-'));dirs.push(d);const e=make(d,{fault:(point,file)=>{if(point==='before-authoritative-append'&&file===name)throw Error('ENOSPC injected')}});
    if(name==='rpc_lineage.ndjson')await expect(e.rpc(async()=>[],{family:'rpc',method:'eth_blockNumber',params:[],component:'CHAIN',reason:'verifier',attempt:1,retryParentRequestId:null})).rejects.toThrow(/ENOSPC|operational index/);
    else if(name==='rpc_recoveries.ndjson'){await expect(e.rpc(async()=>{throw Error('RPC 503')},{family:'rpc',method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x1'}],component:'CHAIN',reason:'backfill',attempt:1,retryParentRequestId:null})).rejects.toThrow('503');await expect(e.rpc(async()=>[],{family:'rpc',method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x1'}],component:'CHAIN',reason:'backfill',attempt:2,retryParentRequestId:null})).rejects.toThrow(/ENOSPC|operational index/);}
    else if(name==='quarantine_v2.ndjson')expect(()=>q(e,'never')).toThrow('ENOSPC');
    else if(name==='quarantine_resolutions.ndjson'){const base=q(e,'base');expect(()=>e.resolveQuarantine(base.quarantineId,'RECOVERED','obs','OBSERVED',false)).toThrow('ENOSPC');}
    else if(name==='rest_poll_receipts.ndjson')expect(()=>e.restReceipt({source:'REST_TRADES'})).toThrow('ENOSPC');
    else if(name==='runtime_telemetry.ndjson')expect(()=>e.telemetry({rssBytes:1})).toThrow('ENOSPC');
    else if(name==='audit_snapshots.ndjson')expect(()=>e.auditSnapshot({processHealth:'ALIVE'})).toThrow('ENOSPC');
    else expect(()=>e.tailProof({finalCursor:null})).toThrow('ENOSPC');
    expect(e.isUsable()).toBe(false);expect(existsSync(join(d,name))).toBe(false);
  });
});
