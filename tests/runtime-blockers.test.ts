import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationalEvidence } from '../src/shadow/operational-evidence.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { ShadowStore } from '../src/shadow/storage.js';
import { runtimeHealthSnapshot } from '../src/shadow/runtime-health.js';
import { startMemoryPublisher } from '../src/shadow/runtime-memory.js';
import type { ShadowConfig } from '../src/shadow/config.js';
import { EXCHANGE_V2_STANDARD, TOPIC_ORDER_FILLED_V2, TOPIC_ORDERS_MATCHED_V2 } from '../src/shadow/v2constants.js';
const dirs:string[]=[], closers:Array<()=>void>=[];
afterEach(()=>{vi.useRealTimers();for(const close of closers.splice(0))close();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const now='2026-10-10T12:00:00.000Z', wallet='0x'+'11'.repeat(20), hash='0x'+'aa'.repeat(32), order='0x'+'bb'.repeat(32);
const word=(v:number)=>BigInt(v).toString(16).padStart(64,'0');
const topic=(v:string)=>'0x'+v.slice(2).padStart(64,'0');
async function fixture(options:ConstructorParameters<typeof OperationalEvidence>[2]={}){
 vi.useFakeTimers();vi.setSystemTime(new Date(now));
 const run=mkdtempSync(join(tmpdir(),'runtime-blockers-'));dirs.push(run);const d=join(run,'shadow-data');mkdirSync(d);
 const e=new OperationalEvidence(d,()=>now,options),store=new ShadowStore(d);await store.initializeIndex();closers.push(()=>store.close(),()=>e.close());
 const cfg:ShadowConfig={chainId:137,polygonHttpRpcUrl:'https://offline.invalid',polygonWsRpcUrl:'wss://offline.invalid',polygonHttpRpcUrlB:null,watchedWallets:new Set([wallet]),dataDir:d,heartbeatMs:1000,staleMs:5000,verifyIntervalMs:60000,backfillChunkBlocks:200,dataApiBaseUrl:'https://offline.invalid',tradesPollMs:1000,activityPollMs:1000};
 const rpc=vi.fn(async(_url:string,method:string)=>{if(method==='eth_getBlockByNumber')return {hash,timestamp:'0x1'};throw Error('unexpected offline RPC');});
 const watcher=new ChainWatcher(cfg,store,()=>now,rpc as any,undefined,e);
 const snapshot=()=>runtimeHealthSnapshot(watcher,{indexTelemetry:()=>({})},e,()=>({pid:1}));
 return {run,d,e,store,watcher,rpc,snapshot};
}
it('real OrdersMatched mismatch with null RPC ID reaches CHAIN health from whole-run source quarantine',async()=>{
 const {d,e,watcher,snapshot}=await fixture();
 const base={address:EXCHANGE_V2_STANDARD,transactionHash:hash,blockHash:hash,blockNumber:1};
 await watcher.handleLog({...base,logIndex:7,topics:[TOPIC_ORDER_FILLED_V2,order,topic(wallet),topic(EXCHANGE_V2_STANDARD)],data:'0x'+[0,123,1000000,2000000,0,0,0].map(word).join('')});
 await watcher.handleLog({...base,logIndex:8,topics:[TOPIC_ORDERS_MATCHED_V2,order,topic(wallet)],data:'0x'+[0,123,999999,2000000].map(word).join('')});
 const q=JSON.parse(readFileSync(join(d,'quarantine_v2.ndjson'),'utf8').trim());expect(q.reason).toContain('OrdersMatched mismatch');expect(q.rpcRequestId).toBeNull();
 // Later resolved history must not bury the source failure.
 for(let i=0;i<1601;i++){const row=e.quarantine({...q,quarantineId:'later-'+i});e.resolveQuarantine(row.quarantineId,'RECOVERED','obs','CONFIRMED',false);}
 const h=snapshot();expect(h.operationalEvidence?.chain).toMatchObject({unresolved:0,unresolvedQuarantine:1});
 expect(h.sourceHealth.find(s=>s.source==='CHAIN')?.quality).toMatchObject({state:'DEGRADED',rules:['unresolved quarantine exists']});
 e.resolveQuarantine(q.quarantineId,'TERMINAL',null,'EXCLUDED',true);
 expect(snapshot().sourceHealth.find(s=>s.source==='CHAIN')?.quality.rules).not.toContain('unresolved quarantine exists');
});
it('REST-only quarantine does not contaminate CHAIN health; RPC failures retain their distinct rule',async()=>{
 const {e,snapshot}=await fixture();
 e.quarantine({component:'REST',source:'REST_TRADES',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass:'OTHER',reason:'REST fixture',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
 expect(snapshot().operationalEvidence?.chain.unresolvedQuarantine).toBe(0);
 expect(snapshot().sourceHealth.find(s=>s.source==='CHAIN')?.quality.rules).not.toContain('unresolved quarantine exists');
 await expect(e.rpc(async()=>{throw Error('timeout');},{family:'CHAIN',method:'eth_blockNumber',params:[],component:'CHAIN',reason:'verifier',attempt:1,retryParentRequestId:null})).rejects.toThrow('timeout');
 expect(snapshot().sourceHealth.find(s=>s.source==='CHAIN')?.quality.rules).toContain('unresolved RPC exists');
});
it('actual watcher shutdown publishes terminal tail to real collector even after runtime snapshot becomes stale',async()=>{
 const {run,d,e,watcher,rpc,snapshot}=await fixture();
 const p=startMemoryPublisher(d,snapshot,undefined,s=>e.telemetry(s as Record<string,unknown>));
 expect(JSON.parse(readFileSync(join(d,'runtime-memory.json'),'utf8')).operationalEvidence.chain.tail).toBeNull();
 const before=rpc.mock.calls.length;
 p.finish(()=>watcher.stop());
 const final=JSON.parse(readFileSync(join(d,'runtime-memory.json'),'utf8'));
 const proof=JSON.parse(readFileSync(join(d,'chain_tail_proofs.ndjson'),'utf8').trim());
 expect(final.operationalEvidence.chain.tail).toEqual(proof);expect(final.operationalEvidence.streams['chain_tail_proofs.ndjson']).toBe(1);
 vi.advanceTimersByTime(60000);expect(vi.getTimerCount()).toBe(0);expect(rpc.mock.calls).toHaveLength(before);
 const output=execFileSync('python3',['-c',"import importlib.util,json,pathlib,sys; s=importlib.util.spec_from_file_location('collector',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.operational_status(pathlib.Path(sys.argv[2]),float(sys.argv[3]))))",resolve('scripts/status/collector.py'),run,String(Date.now()/1000)],{encoding:'utf8'});
 const collected=JSON.parse(output);expect(collected.fresh).toBe(false);expect(collected.chain.tail.atUtc).toBe(proof.atUtc);expect(collected.chain.tail.recoveryRequired).toBe(proof.recoveryRequired);expect(collected.evidenceStreams['chain_tail_proofs.ndjson']).toBe(1);
});
it('shutdown snapshot failure makes one bounded attempt and retires cadence without retry',async()=>{
 const {d,watcher,snapshot}=await fixture();let writes=0;
 const p=startMemoryPublisher(d,snapshot,{write:()=>{writes++;throw Error('ENOSPC mutable snapshot');},rename:()=>{},remove:()=>{},diagnose:()=>{}});
 p.finish(()=>watcher.stop());expect(writes).toBe(2);vi.advanceTimersByTime(60000);expect(writes).toBe(2);expect(vi.getTimerCount()).toBe(0);
});
it('terminal tail sink failure stays failclosed and does not publish a successful terminal snapshot',async()=>{
 let armed=false;const failure=Error('terminal sink failed');
 const {d,e,watcher,snapshot}=await fixture({fault:(point,name)=>{if(armed&&point==='before-authoritative-append'&&name==='chain_tail_proofs.ndjson')throw failure;}});
 const p=startMemoryPublisher(d,snapshot,undefined,s=>e.telemetry(s as Record<string,unknown>),undefined,()=>p.stop());
 const bytes=readFileSync(join(d,'runtime-memory.json'),'utf8');armed=true;
 expect(()=>p.finish(()=>watcher.stop())).toThrow(failure);expect(e.isUsable()).toBe(false);
 expect(readFileSync(join(d,'runtime-memory.json'),'utf8')).toBe(bytes);expect(vi.getTimerCount()).toBe(0);
});
