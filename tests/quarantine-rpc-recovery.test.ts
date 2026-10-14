import { mkdtempSync, readFileSync, rmSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { OperationalEvidence, rpcRequestId } from '../src/shadow/operational-evidence.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { ShadowStore } from '../src/shadow/storage.js';
import { loadConfig } from '../src/shadow/config.js';
const dirs:string[]=[];afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'rpc-proof-'));dirs.push(d);return d;};
const count=(d:string,file:string)=>existsSync(join(d,file))?readFileSync(join(d,file),'utf8').trim().split('\n').length:0;
const request=(from=100,to=110,address='exchange')=>({family:'eth_getLogs',method:'eth_getLogs',params:[{fromBlock:'0x'+from.toString(16),toBlock:'0x'+to.toString(16),address}],component:'CHAIN',reason:'backfill' as const,attempt:1,retryParentRequestId:null});
async function failure(e:OperationalEvidence,input=request()){
 let failed:string|null=null;try{await e.rpc(async()=>{throw Error('timeout');},input);}catch(err){failed=rpcRequestId(err);}
 expect(failed).toBeTruthy();
 return e.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:failed,errorClass:'TIMEOUT',reason:'verifier timeout',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
}
it('A5/A6/A7/A8: HTTP success and partial/different-filter proofs cannot recover; exact processed publication does, once across restart',async()=>{
 const d=dir();let e=new OperationalEvidence(d);const q=await failure(e);
 let partial='',wrong='',full='';
 await e.rpc(async()=>[],request(105,110),id=>{partial=id;});
 e.confirmRpcPublication(partial,{fromBlock:105,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64));
 expect(e.unresolvedQuarantineCount()).toBe(1);
 await e.rpc(async()=>[],request(100,110,'other'),id=>{wrong=id;});
 e.confirmRpcPublication(wrong,{fromBlock:100,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64));expect(e.unresolvedQuarantineCount()).toBe(1);
 await e.rpc(async()=>[],request(),id=>{full=id;});expect(e.unresolvedQuarantineCount()).toBe(1);
 expect(()=>e.confirmRpcPublication(full,{fromBlock:99,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64))).toThrow('identity');
 e.confirmRpcPublication(full,{fromBlock:100,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64));
 expect(e.quarantineState()).toMatchObject({recovered:1,unresolved:0});
 const original=readFileSync(join(d,'quarantine_resolutions.ndjson'),'utf8');expect(JSON.parse(original)).toMatchObject({quarantineId:q.quarantineId,canonicalObservationRef:`rpc-publication:${full}`});
 e.confirmRpcPublication(full,{fromBlock:100,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64));expect(count(d,'quarantine_resolutions.ndjson')).toBe(1);
 e.close();unlinkSync(join(d,'operational-index.sqlite'));e=new OperationalEvidence(d);e.reconcileRpcQuarantines(full);
 expect(e.quarantineState()).toMatchObject({recovered:1,unresolved:0});expect(readFileSync(join(d,'quarantine_resolutions.ndjson'),'utf8')).toBe(original);e.close();
});
it('event-specific, terminal and transport-only historical failures do not get fabricated recovery',async()=>{
 const e=new OperationalEvidence(dir());const q=await failure(e);e.resolveQuarantine(q.quarantineId,'TERMINAL',null,'TERMINAL',true);
 await failure(e);let id='';await e.rpc(async()=>[],request(),v=>{id=v;});e.reconcileRpcQuarantines(id);expect(e.quarantineState()).toMatchObject({terminal:1,unresolved:1,recovered:0});e.close();
});
it.each(['valid','cursor-publication-failure','malformed-response'] as const)('real watcher emits proof only after validated processing and durable cursor: %s',async fault=>{
 const d=dir(),e=new OperationalEvidence(d),store=new ShadowStore(d);let fail=true;
 const config=loadConfig({SHADOW_WATCHED_WALLETS:'0x'+'1'.repeat(40),SHADOW_DATA_DIR:d});
 const rpc=async <T>(_url:string,method:string):Promise<T>=>{
  if(method==='eth_getLogs'){if(fail){fail=false;throw Error('timeout');}return (fault==='malformed-response'?{}:[]) as T;}
  if(method==='eth_getBlockByNumber')return {hash:'0x'+'a'.repeat(64),timestamp:'0x64'} as T;
  throw Error('unexpected method');
 };
 const w=new ChainWatcher(config,store,()=>new Date().toISOString(),rpc,()=>{},e);
 let error:unknown;try{await w.scanRange(100,110);}catch(err){error=err;}
 // Same recordFailure path used by the verifier's catch, without timers/network.
 (w as any).recordFailure('verifier',error);expect(e.unresolvedQuarantineCount()).toBe(1);
 if(fault==='cursor-publication-failure')store.advanceCursor=()=>{throw Error('publication failed');};
 if(fault==='valid'){
  await w.scanRange(100,110);expect(e.quarantineState()).toMatchObject({recovered:1,unresolved:0});expect(count(d,'rpc_publications.ndjson')).toBe(1);
 }else{
  await expect(w.scanRange(100,110)).rejects.toThrow();expect(e.unresolvedQuarantineCount()).toBe(1);expect(count(d,'rpc_publications.ndjson')).toBe(0);
 }
 w.stop();store.close();e.close();
});

it.each(['publication-failure','terminal-malformed','success'] as const)('nonempty watcher response retains timeout unless relevant evidence really publishes: %s',async fault=>{
 const d=dir(),e=new OperationalEvidence(d),store=new ShadowStore(d);
 const fixture=JSON.parse(readFileSync(new URL('./fixtures/v2_fills.json',import.meta.url),'utf8'))[0];
 const log={...fixture.logs.find((x:any)=>x.topics.length===4&&x.topics[2].toLowerCase().endsWith(fixture.wallet.slice(2))),blockNumber:100,blockHash:'0x'+'a'.repeat(64)};
 if(fault==='terminal-malformed')log.data='0x';
 let fail=true;
 const rpc=async <T>(_url:string,method:string):Promise<T>=>{
  if(method==='eth_getLogs'){if(fail){fail=false;throw Error('timeout');}return [log] as T;}
  if(method==='eth_getBlockByNumber')return {hash:log.blockHash,timestamp:'0x64'} as T;
  throw Error('unexpected method');
 };
 const config=loadConfig({SHADOW_WATCHED_WALLETS:fixture.wallet,SHADOW_DATA_DIR:d});
 const w=new ChainWatcher(config,store,()=>new Date().toISOString(),rpc,()=>{if(fault==='publication-failure')throw Error('publication failed');},e);
 try{await w.scanRange(100,110);}catch(err){(w as any).recordFailure('verifier',err);}
 await w.scanRange(100,110);
 expect(count(d,'rpc_publications.ndjson')).toBe(fault==='success'?1:0);
 if(fault==='success')expect(e.quarantineState()).toMatchObject({unresolved:0,recovered:1});
 else expect(e.unresolvedQuarantineCount()).toBeGreaterThan(0);
 w.stop();store.close();e.close();
});
it('online recovery reads only the explicit current proof; unrelated history is never decoded',async()=>{
 const d=dir(),e=new OperationalEvidence(d);await failure(e);
 const ids:string[]=[];
 for(let i=0;i<20;i++){let id='';await e.rpc(async()=>[],request(200+i,200+i),v=>{id=v;});e.confirmRpcPublication(id,{fromBlock:200+i,toBlock:200+i},'0x'+'a'.repeat(64),'b'.repeat(64));ids.push(id);}
 // Poison only a disposable historical cache row as a sentinel: current-proof
 // reconciliation must not decode it. Authoritative journals stay intact.
 (e as any).db.prepare('UPDATE rpc_publications SET row=? WHERE id=?').run('not json',ids[0]);
 let current='';await e.rpc(async()=>[],request(),v=>{current=v;});
 expect(()=>e.confirmRpcPublication(current,{fromBlock:100,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64))).not.toThrow();
 expect(e.quarantineState()).toMatchObject({recovered:1,unresolved:0});e.close();
});
it('persisted proof survives append interruption; explicit replay resolves exactly once without inventing proof',async()=>{
 const d=dir();let armed=false;
 let e=new OperationalEvidence(d,undefined,{fault:(point,name)=>{if(armed&&point==='after-authoritative-append'&&name==='rpc_publications.ndjson')throw Error('interrupted');}});
 await failure(e);let id='';await e.rpc(async()=>[],request(),v=>{id=v;});armed=true;
 expect(()=>e.confirmRpcPublication(id,{fromBlock:100,toBlock:110},'0x'+'a'.repeat(64),'b'.repeat(64))).toThrow('interrupted');
 expect(count(d,'quarantine_resolutions.ndjson')).toBe(0);
 e=new OperationalEvidence(d);e.reconcileRpcQuarantines(id);expect(e.quarantineState()).toMatchObject({recovered:1,unresolved:0});
 const before=readFileSync(join(d,'rpc_publications.ndjson'),'utf8');e.reconcileRpcQuarantines(id);
 expect(count(d,'quarantine_resolutions.ndjson')).toBe(1);expect(readFileSync(join(d,'rpc_publications.ndjson'),'utf8')).toBe(before);e.close();
});
