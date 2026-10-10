import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { OperationalEvidence, type RpcRequestInput } from '../src/shadow/operational-evidence.js';
import { installSinkFailureControl } from '../src/shadow/operational-control.js';
import { startMemoryPublisher } from '../src/shadow/runtime-memory.js';
import { dataQuality } from '../src/shadow/data-quality.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { ShadowStore } from '../src/shadow/storage.js';
import { RestPoller } from '../src/shadow/rest-poller.js';
import { RacingStore, Reconciler, tradeGroupKey } from '../src/shadow/racing.js';
import type { ShadowConfig } from '../src/shadow/config.js';
import { EXCHANGE_V2_STANDARD, TOPIC_ORDER_FILLED_V2 } from '../src/shadow/v2constants.js';

const dirs:string[]=[], close:Array<()=>void>=[];
afterEach(()=>{vi.useRealTimers();for(const f of close.splice(0))f();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'sink-failure-'));dirs.push(d);return d;};
const input:RpcRequestInput={family:'eth_getLogs',method:'eth_getLogs',params:[{fromBlock:'0x1',toBlock:'0x2'}],component:'CHAIN',reason:'backfill',attempt:1,retryParentRequestId:null};
const bytes=(d:string,n:string)=>existsSync(join(d,n))?readFileSync(join(d,n),'utf8'):'';
const rows=(d:string,n:string)=>bytes(d,n).trim().split('\n').filter(Boolean).map(x=>JSON.parse(x));
const quarantine=(e:OperationalEvidence,id='q')=>e.quarantine({quarantineId:id,component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:'raw:q',rpcRequestId:null,errorClass:'TIMEOUT',reason:'timeout fixture',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
const fixture=(name:string,point='before-authoritative-append')=>{
 const d=dir(),failure=new Error(`ENOSPC exact ${name}`);let armed=false;
 const e=new OperationalEvidence(d,undefined,{
  write:(path,serialized,n)=>{
   if(armed&&n===name&&(point==='before-authoritative-append'||point==='torn-write')){
    if(point==='torn-write')appendFileSync(path,serialized.slice(0,17));
    throw failure;
   }
   appendFileSync(path,serialized);
  },
  fault:(p,n)=>{if(armed&&p===point&&n===name)throw failure;},
 });
 close.push(()=>e.close());return {d,e,failure,arm:()=>{armed=true;}};
};
const watched='0x'+'11'.repeat(20),hash='0x'+'aa'.repeat(32);
const cfg=(d:string):ShadowConfig=>({chainId:137,polygonHttpRpcUrl:'https://offline.invalid',polygonWsRpcUrl:'wss://offline.invalid',polygonHttpRpcUrlB:null,watchedWallets:new Set([watched]),dataDir:d,heartbeatMs:1000,staleMs:5000,verifyIntervalMs:60000,backfillChunkBlocks:200,dataApiBaseUrl:'https://offline.invalid',tradesPollMs:1000,activityPollMs:1000});
const log=()=>({address:EXCHANGE_V2_STANDARD,transactionHash:'0x'+'bb'.repeat(32),blockHash:hash,blockNumber:1,logIndex:1,topics:[TOPIC_ORDER_FILLED_V2,'0x'+'cc'.repeat(32),'0x'+watched.slice(2).padStart(64,'0'),'0x'+EXCHANGE_V2_STANDARD.slice(2).padStart(64,'0')],data:'0x'+[0,123,1000000,2000000,0,0,0].map(v=>BigInt(v).toString(16).padStart(64,'0')).join('')});
const item={transactionHash:'tx',proxyWallet:'wallet',asset:'asset',size:1,price:.5,timestamp:1,type:'TRADE',side:'BUY'};
const response=(body:unknown=[item],status=200)=>({status,headers:{age:null,cacheControl:null},body});
async function rest(d:string,e:OperationalEvidence,fetch:any,source:'REST_TRADES'|'REST_ACTIVITY'='REST_TRADES'){
 const store=new RacingStore(d);await store.initializeIndex();close.push(()=>store.close());
 const poller=new RestPoller({source,endpoint:source==='REST_TRADES'?'trades':'activity',baseUrl:'https://offline.invalid',wallets:new Set(['wallet']),intervalMs:1000},store,new Reconciler(store),undefined,fetch,e);
 close.push(()=>poller.stop());return {store,poller};
}
async function chain(d:string,e:OperationalEvidence,rpc:any){
 const store=new ShadowStore(d);await store.initializeIndex();close.push(()=>store.close());
 const publish=vi.fn();const watcher=new ChainWatcher(cfg(d),store,undefined,rpc,publish,e);return {store,watcher,publish};
}

it.each([false,true])('rpc_lineage initial write failure surfaces exact error (upstreamFails=%s)',async(upstreamFails)=>{
 const {d,e,failure,arm}=fixture('rpc_lineage.ndjson');arm();const call=vi.fn(async()=>{if(upstreamFails)throw Error('HTTP 503');return [];});
 await expect(e.rpc(call,input)).rejects.toBe(failure);expect(call).toHaveBeenCalledTimes(1);
 expect(bytes(d,'rpc_lineage.ndjson')).toBe('');expect(e.failureStatus()).toMatchObject({state:'BROKEN',code:'EVIDENCE_SINK_FAILURE',error:String(failure)});
 await expect(e.rpc(call,input)).rejects.toBe(failure);expect(call).toHaveBeenCalledTimes(1);
});
it.each([false,true])('rpc_lineage retry write failure never resolves failed request (upstreamFails=%s)',async(upstreamFails)=>{
 const {d,e,failure,arm}=fixture('rpc_lineage.ndjson');await expect(e.rpc(async()=>{throw Error('HTTP 503');},input)).rejects.toThrow('503');
 const before=bytes(d,'rpc_lineage.ndjson'),failed=rows(d,'rpc_lineage.ndjson')[0].requestId;arm();
 await expect(e.rpc(async()=>{if(upstreamFails)throw Error('timeout');return [];},{...input,attempt:2,retryParentRequestId:failed})).rejects.toBe(failure);
 expect(bytes(d,'rpc_lineage.ndjson')).toBe(before);expect(bytes(d,'rpc_recoveries.ndjson')).toBe('');
 const restarted=new OperationalEvidence(d);expect(restarted.unresolvedRpc(input.method,'CHAIN').map(r=>r.requestId)).toEqual([failed]);restarted.close();
});
it('rpc_recoveries write failure preserves successful lineage but leaves failure unresolved on restart',async()=>{
 const {d,e,failure,arm}=fixture('rpc_recoveries.ndjson');await expect(e.rpc(async()=>{throw Error('timeout');},input)).rejects.toThrow('timeout');
 const failed=rows(d,'rpc_lineage.ndjson')[0].requestId;arm();await expect(e.rpc(async()=>[],{...input,attempt:2,retryParentRequestId:failed})).rejects.toBe(failure);
 expect(rows(d,'rpc_lineage.ndjson').map(r=>r.success)).toEqual([false,true]);expect(bytes(d,'rpc_recoveries.ndjson')).toBe('');
 const restarted=new OperationalEvidence(d);expect(restarted.unresolvedRpc(input.method,'CHAIN').map(r=>r.requestId)).toEqual([failed]);restarted.close();
});
it.each(['before-authoritative-append','after-authoritative-append'])('authority vs index failure retains only the actual RPC outcome (%s)',async(point)=>{
 const {d,e,failure,arm}=fixture('rpc_lineage.ndjson',point);arm();await expect(e.rpc(async()=>[],input)).rejects.toBe(failure);
 expect(rows(d,'rpc_lineage.ndjson').map(r=>r.success)).toEqual(point==='after-authoritative-append'?[true]:[]);
 const restarted=new OperationalEvidence(d);expect(restarted.unresolvedRpc(input.method,'CHAIN')).toEqual([]);restarted.close();
});
it('resolution write failure remains unresolved after restart without false terminal/recovered state',()=>{
 const {d,e,failure,arm}=fixture('quarantine_resolutions.ndjson');quarantine(e);const before=bytes(d,'quarantine_v2.ndjson');arm();
 expect(()=>e.resolveQuarantine('q','RECOVERED','obs:q','OBSERVED',false)).toThrow(failure);
 expect(bytes(d,'quarantine_v2.ndjson')).toBe(before);expect(bytes(d,'quarantine_resolutions.ndjson')).toBe('');
 const restarted=new OperationalEvidence(d);expect(restarted.quarantineStateIds()).toEqual([{id:'q',state:'UNRESOLVED'}]);restarted.close();
});
it.each(['timeout','malformed','reorg'])('CHAIN %s quarantine write failure stops before recovery or publication',async(kind)=>{
 const {d,e,failure,arm}=fixture('quarantine_v2.ndjson');const rpc=vi.fn(async()=>{if(kind==='timeout')throw Error('RPC timeout');return {hash:kind==='reorg'?'0x'+'dd'.repeat(32):hash,timestamp:'0x1'};});
 const {watcher,store,publish}=await chain(d,e,rpc);arm();
 await expect(watcher.handleLog(kind==='malformed'?{...log(),data:'0x01'}:log())).rejects.toBe(failure);
 expect(e.isUsable()).toBe(false);expect(publish).not.toHaveBeenCalled();expect(store.observations()).toHaveLength(0);
 expect(bytes(d,'quarantine_resolutions.ndjson')).toBe('');expect((watcher as any).retryQueue).toHaveLength(0);
 const before=bytes(d,'dispositions.ndjson'),calls=rpc.mock.calls.length;
 await expect(watcher.handleLog(log())).rejects.toBe(failure);await expect(watcher.processRetries()).rejects.toBe(failure);await expect(watcher.scanRange(1,2)).rejects.toBe(failure);
 expect(rpc).toHaveBeenCalledTimes(calls);expect(bytes(d,'dispositions.ndjson')).toBe(before);
});
it('CHAIN terminal resolution failure does not publish a terminal disposition',async()=>{
 const {d,e,failure,arm}=fixture('quarantine_resolutions.ndjson');const {watcher}=await chain(d,e,vi.fn());arm();
 await expect(watcher.handleLog({...log(),data:'0x01'})).rejects.toBe(failure);
 expect(bytes(d,'dispositions.ndjson')).toBe('');const restarted=new OperationalEvidence(d);expect(restarted.quarantineState().unresolved).toBe(1);restarted.close();
});
it.each(['HTTP','timeout','parse','publication'])('REST %s quarantine write failure gates later polls',async(kind)=>{
 const {d,e,failure,arm}=fixture('quarantine_v2.ndjson');const fetch=vi.fn(async()=>{if(kind==='timeout')throw Error('REST timeout');return kind==='HTTP'?response([],503):response(kind==='parse'?[null]:[item]);});
 const {store,poller}=await rest(d,e,fetch);if(kind==='publication')vi.spyOn(store,'appendRestRaw').mockImplementation(()=>{throw Error('publication failed');});arm();
 await expect(poller.pollWallet('wallet')).rejects.toBe(failure);expect(e.isUsable()).toBe(false);expect(bytes(d,'rest_poll_receipts.ndjson')).toBe('');
 await expect(poller.pollWallet('wallet')).rejects.toBe(failure);expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(['nonempty','empty','failure'])('REST %s receipt write failure stops the actual timer wrapper',async(kind)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('rest_poll_receipts.ndjson');const fetch=vi.fn(async()=>response(kind==='nonempty'?[item]:[],kind==='failure'?429:200));
 const {poller}=await rest(d,e,fetch);arm();poller.start();await vi.advanceTimersByTimeAsync(1);
 expect(e.failureStatus().error).toBe(String(failure));expect((poller as any).timer).toBeNull();expect(vi.getTimerCount()).toBe(0);
 await vi.advanceTimersByTimeAsync(5000);expect(fetch).toHaveBeenCalledTimes(1);expect(bytes(d,'rest_poll_receipts.ndjson')).toBe('');
 await expect(poller.pollWallet('wallet')).rejects.toBe(failure);expect(()=>poller.start()).toThrow(failure);
});
it.each(['runtime_telemetry.ndjson','audit_snapshots.ndjson'])('%s archive failure is fatal with earlier bytes preserved, including initial publication',async(name)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture(name);const append=(row:Record<string,unknown>)=>name==='runtime_telemetry.ndjson'?e.telemetry(row):e.auditSnapshot(row);
 append({prior:true});const before=bytes(d,name);arm();const retire=vi.fn(),fatal=vi.fn();installSinkFailureControl(e,d,retire,{write:writeFileSync,diagnose:vi.fn()});
 const publisher=startMemoryPublisher(d,()=>({pid:process.pid}),undefined,()=>append({later:true}),undefined,fatal);
 expect(fatal).toHaveBeenCalledWith(failure);expect(retire).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);expect(bytes(d,name)).toBe(before);
 expect(JSON.parse(bytes(d,'operational-failure.json'))).toMatchObject({code:'EVIDENCE_SINK_FAILURE',error:String(failure),dataQuality:{state:'AT_RISK'}});
 publisher.publish();await vi.advanceTimersByTimeAsync(10000);expect(bytes(d,name)).toBe(before);publisher.stop();
});
it('tail proof failure always clears timers/socket before surfacing the exact error',async()=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('chain_tail_proofs.ndjson');e.tailProof({prior:true});const before=bytes(d,'chain_tail_proofs.ndjson');
 const {watcher}=await chain(d,e,vi.fn());const socket={close:vi.fn()};Object.assign(watcher,{ws:socket,heartbeat:setInterval(()=>{},1000),verifier:setInterval(()=>{},1000)});arm();
 expect(()=>watcher.stop()).toThrow(failure);expect(socket.close).toHaveBeenCalled();expect(vi.getTimerCount()).toBe(0);expect((watcher as any).shouldReconnect).toBe(false);expect(bytes(d,'chain_tail_proofs.ndjson')).toBe(before);
 expect(()=>watcher.stop()).not.toThrow();
});
it.each([false,true])('CHAIN scan gates checkpoint/head writes after successful RPC lineage before continuation (checkpoint=%s)',async(checkpoint)=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 const rpc=vi.fn(async(_url:string,method:string)=>method==='eth_getLogs'?[]:{hash,timestamp:'0x1'});
 const {watcher}=await chain(d,e,rpc);
 const observed=e.rpc.bind(e);
 vi.spyOn(e,'rpc').mockImplementation(async(call,args)=>{
   const result=await observed(call,args);
   if(args.method==='eth_getBlockByNumber') {arm();expect(()=>e.telemetry({})).toThrow(failure);}
   return result;
 });
 await expect(watcher.scanRange(1,checkpoint?2:1)).rejects.toBe(failure);
 expect(bytes(d,'block_hashes.ndjson')).toBe('');expect(bytes(d,'cursor.json')).toBe('');
 expect(rows(d,'rpc_lineage.ndjson').map(r=>r.success)).toEqual([true,true]);
});
it.each(['null','mismatch'] as const)('CHAIN post-lineage %s block result preserves sink error without lag timers or reorg',async(kind)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 const rpc=vi.fn(async()=>kind==='null'?null:{hash:'0x'+'dd'.repeat(32),timestamp:'0x1'});
 const {watcher,publish}=await chain(d,e,rpc);const observed=e.rpc.bind(e);
 vi.spyOn(e,'rpc').mockImplementation(async(call,args)=>{const result=await observed(call,args);arm();expect(()=>e.telemetry({})).toThrow(failure);return result;});
 await expect(watcher.handleLog(log())).rejects.toBe(failure);
 expect(vi.getTimerCount()).toBe(0);expect(rpc).toHaveBeenCalledTimes(1);expect(publish).not.toHaveBeenCalled();
 for(const n of ['observations.ndjson','quarantine.ndjson','tombstones.ndjson','quarantine_v2.ndjson','dispositions.ndjson'])expect(bytes(d,n)).toBe('');
});
it('CHAIN blockRef gates between completed providerBlock and mismatch comparison',async()=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const {watcher}=await chain(d,e,vi.fn());
 vi.spyOn(watcher as any,'providerBlock').mockImplementation(async()=>{arm();expect(()=>e.telemetry({})).toThrow(failure);return {hash:'0x'+'dd'.repeat(32),timestamp:'0x1'};});
 await expect((watcher as any).blockRef(1,hash)).rejects.toBe(failure);expect((watcher as any).blockCache.size).toBe(0);
});
it.each(['head','ancestor','target'] as const)('CHAIN cursor validation gates post-lineage %s continuation without scientific mutation',async(stage)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 let blockCalls=0;
 const rpc=vi.fn(async()=>({hash:++blockCalls===1?'0x'+'dd'.repeat(32):hash,timestamp:'0x1'}));
 const {watcher,store}=await chain(d,e,rpc);
 store.advanceCursor({provider:cfg(d).polygonHttpRpcUrl,blockNumber:2,blockHash:hash,updatedAtUtc:'2026-01-01T00:00:00Z'});
 if(stage!=='head')store.appendBlockHash({chainId:137,blockNumber:1,blockHash:hash,firstSeenUtc:'2026-01-01T00:00:00Z'});
 const before=['quarantine.ndjson','cursor.json','tombstones.ndjson','block_hashes.ndjson'].map(n=>bytes(d,n));
 const observed=e.rpc.bind(e);let completed=0;
 vi.spyOn(e,'rpc').mockImplementation(async(call,args)=>{const result=await observed(call,args);if(++completed===({head:1,ancestor:2,target:3}[stage])){arm();expect(()=>e.telemetry({})).toThrow(failure);}return result;});
 await expect(watcher.validateCursor()).rejects.toBe(failure);
 expect(['quarantine.ndjson','cursor.json','tombstones.ndjson','block_hashes.ndjson'].map(n=>bytes(d,n))).toEqual(before);
 expect(watcher.recoveryRequired).toBe(false);expect((watcher as any).verifier).toBeNull();expect(vi.getTimerCount()).toBe(0);
 const calls=rpc.mock.calls.length;await expect(watcher.validateCursor()).rejects.toBe(failure);expect(rpc).toHaveBeenCalledTimes(calls);
});
it('CHAIN completed backfill cannot rearm verifier after shared sink retirement',async()=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 const rpc=vi.fn(async(_url:string,method:string)=>method==='eth_blockNumber'?'0x1':{hash,timestamp:'0x1'});
 const {watcher}=await chain(d,e,rpc);
 vi.spyOn(watcher,'scanRange').mockImplementation(async()=>{arm();expect(()=>e.telemetry({})).toThrow(failure);});
 await expect(watcher.backfillFromCursor()).rejects.toBe(failure);
 expect((watcher as any).verifier).toBeNull();expect(vi.getTimerCount()).toBe(0);
});

it('shared broken sink gates every source and already-inflight CHAIN/REST publication',async()=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');let releaseRest!:(v:any)=>void,releaseChain!:(v:any)=>void;
 const fetch=vi.fn(()=>new Promise(resolve=>{releaseRest=resolve;})),rpc=vi.fn(()=>new Promise(resolve=>{releaseChain=resolve;}));
 const trades=await rest(d,e,fetch),activity=await rest(d,e,vi.fn(async()=>response()),'REST_ACTIVITY');const {watcher,publish}=await chain(d,e,rpc);
 const restPending=trades.poller.pollWallet('wallet');const chainPending=watcher.handleLog(log());
 const restReject=expect(restPending).rejects.toBe(failure),chainReject=expect(chainPending).rejects.toBe(failure);
 await vi.advanceTimersByTimeAsync(1);activity.poller.start();await vi.advanceTimersByTimeAsync(1);
 const sourceBefore=bytes(d,'source_observations.ndjson'),restBefore=bytes(d,'rest_raw.ndjson');arm();expect(()=>e.telemetry({})).toThrow(failure);
 releaseRest(response());releaseChain({hash,timestamp:'0x1'});await restReject;await chainReject;
 expect(bytes(d,'source_observations.ndjson')).toBe(sourceBefore);expect(bytes(d,'rest_raw.ndjson')).toBe(restBefore);expect(publish).not.toHaveBeenCalled();
 expect((activity.poller as any).timer).toBeNull();expect(vi.getTimerCount()).toBe(0);
 await expect(activity.poller.pollWallet('wallet')).rejects.toBe(failure);await expect(trades.poller.pollWallet('wallet')).rejects.toBe(failure);await expect(watcher.validateCursor()).rejects.toBe(failure);expect(()=>watcher.start()).toThrow(failure);
 expect(fetch).toHaveBeenCalledTimes(1);expect(rpc).toHaveBeenCalledTimes(1);
});
it.each(['HTTP 429','HTTP 503','RPC timeout'])('ordinary upstream %s remains recoverable',async(message)=>{
 const d=dir(),e=new OperationalEvidence(d);close.push(()=>e.close());await expect(e.rpc(async()=>{throw Error(message);},input)).rejects.toThrow(message);
 expect(e.isUsable()).toBe(true);await e.rpc(async()=>[],input);expect(e.unresolvedRpc(input.method,'CHAIN')).toEqual([]);
 const fetch=message==='RPC timeout'?vi.fn().mockRejectedValueOnce(Error('REST timeout')).mockResolvedValue(response()):vi.fn().mockResolvedValueOnce(response([],message==='HTTP 503'?503:429)).mockResolvedValue(response());const {poller}=await rest(d,e,fetch);
 await poller.pollWallet('wallet');await poller.pollWallet('wallet');expect(fetch).toHaveBeenCalledTimes(2);expect(e.isUsable()).toBe(true);
});
it.each(['REST_TRADES','REST_ACTIVITY'] as const)('%s timer stops when upstream-failure quarantine itself cannot append',async(source)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('quarantine_v2.ndjson');const fetch=vi.fn(async()=>response([],503));const {poller}=await rest(d,e,fetch,source);arm();poller.start();
 await vi.advanceTimersByTimeAsync(1);expect(e.failureStatus().error).toBe(String(failure));expect((poller as any).timer).toBeNull();expect(vi.getTimerCount()).toBe(0);
 await vi.advanceTimersByTimeAsync(5000);expect(fetch).toHaveBeenCalledTimes(1);expect(bytes(d,'rest_poll_receipts.ndjson')).toBe('');
});
it('control retirement still runs when both diagnostic channels fail on ENOSPC',()=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const retire=vi.fn(),write=vi.fn(()=>{throw Error('ENOSPC diagnostic');}),diagnose=vi.fn(()=>{throw Error('stderr unavailable');});
 installSinkFailureControl(e,d,retire,{write:write as any,diagnose});arm();expect(()=>e.telemetry({})).toThrow(failure);expect(retire).toHaveBeenCalledTimes(1);expect(write).toHaveBeenCalledTimes(1);expect(diagnose).toHaveBeenCalledTimes(1);
 expect(()=>e.telemetry({})).toThrow(failure);expect(retire).toHaveBeenCalledTimes(1);
});
it('health explicitly names EVIDENCE_SINK_FAILURE even while process is alive and progress fresh',()=>{
 const quality=dataQuality({operationalSinkBroken:true,lastProgressUtc:new Date().toISOString()});expect(quality).toEqual({state:'AT_RISK',rules:['EVIDENCE_SINK_FAILURE']});
});
it('real authoritative filesystem append failure is latched and surfaced without another request',async()=>{
 const d=dir(),e=new OperationalEvidence(d);close.push(()=>e.close());mkdirSync(join(d,'rpc_lineage.ndjson'));const call=vi.fn(async()=>[]);
 await expect(e.rpc(call,input)).rejects.toThrow(/EISDIR/);expect(e.isUsable()).toBe(false);await expect(e.rpc(call,input)).rejects.toThrow(/EISDIR/);expect(call).toHaveBeenCalledTimes(1);
});
it('REST gates the request after an awaited index preflight yields to a shared sink failure',async()=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const fetch=vi.fn(async()=>response());const {store,poller}=await rest(d,e,fetch);
 let release!:()=>void;vi.spyOn(store,'initializeIndex').mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));
 const pending=poller.pollWallet('wallet'),rejected=expect(pending).rejects.toBe(failure);arm();expect(()=>e.telemetry({})).toThrow(failure);release();await rejected;expect(fetch).not.toHaveBeenCalled();
});
it('CHAIN callback failure clears heartbeat/verifier/reconnect without recursive quarantine or tail writes',async()=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('quarantine_v2.ndjson');const {watcher}=await chain(d,e,vi.fn());const socket={close:vi.fn()};
 Object.assign(watcher,{ws:socket,heartbeat:setInterval(()=>{},1000),verifier:setInterval(()=>{},1000)});
 (watcher as any).scheduleReconnect();arm();(watcher as any).recordFailure('websocket-error',Error('source failure'));
 expect(e.failureStatus().error).toBe(String(failure));expect(vi.getTimerCount()).toBe(0);expect(socket.close).toHaveBeenCalled();
 (watcher as any).recordFailure('later-callback',Error('later'));expect(bytes(d,'quarantine_v2.ndjson')).toBe('');expect(bytes(d,'chain_tail_proofs.ndjson')).toBe('');
 await vi.advanceTimersByTimeAsync(5000);expect((watcher as any).shouldReconnect).toBe(false);
});
it.each(['runtime_telemetry.ndjson','audit_snapshots.ndjson'])('periodic %s archive failure stops publication with earlier archive bytes preserved',async(name)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture(name);const archive=()=>name==='runtime_telemetry.ndjson'?e.telemetry({}):e.auditSnapshot({});const fatal=vi.fn();
 const publisher=startMemoryPublisher(d,()=>({pid:process.pid}),undefined,archive,undefined,fatal);const before=bytes(d,name);expect(before).not.toBe('');arm();
 await vi.advanceTimersByTimeAsync(5000);expect(fatal).toHaveBeenCalledWith(failure);expect(vi.getTimerCount()).toBe(0);expect(bytes(d,name)).toBe(before);publisher.stop();
});
it('CHAIN recovered-resolution write failure preserves earlier publication but leaves canonical disposition pending and quarantine unresolved on restart',async()=>{
 const {d,e,failure,arm}=fixture('quarantine_resolutions.ndjson');const rawKey=`137:${EXCHANGE_V2_STANDARD.toLowerCase()}:${log().transactionHash}:1:${hash}`;
 e.quarantine({...quarantine(e,'baseline'),quarantineId:'pending',rawEvidenceRef:`raw:${rawKey}`});
 const {watcher,store,publish}=await chain(d,e,vi.fn(async()=>({hash,timestamp:'0x1'})));arm();await expect(watcher.handleLog(log())).rejects.toBe(failure);
 expect(store.observations()).toHaveLength(1);expect(publish).toHaveBeenCalledTimes(1);expect(rows(d,'dispositions.ndjson').at(-1).disposition).toBe('PENDING');
 const restarted=new OperationalEvidence(d);expect(restarted.quarantineStateIds()).toContainEqual({id:'pending',state:'UNRESOLVED'});restarted.close();
});
it('REST startup recovery gates authoritative publication after a shared failure during streaming preflight',async()=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const at='2026-01-01T00:00:00Z';
 writeFileSync(join(d,'reconciliation.ndjson'),JSON.stringify({source:'CHAIN',identity:'first',groupKey:tradeGroupKey('tx','asset','1.000000'),position:'FIRST',atUtc:at})+'\n');
 for(let i=0;i<300;i++)appendFileSync(join(d,'rest_raw.ndjson'),JSON.stringify({source:'REST_TRADES',wallet:'wallet',identity:`pending-${i}`,payload:item,sourceTs:1,firstSeenUtc:at,completedUtc:at})+'\n');
 const before=bytes(d,'reconciliation.ndjson'),store=new RacingStore(d,()=>e.assertUsable());close.push(()=>store.close());
 const pending=store.initializeIndex(),rejected=expect(pending).rejects.toBe(failure);arm();expect(()=>e.telemetry({})).toThrow(failure);await rejected;
 expect(bytes(d,'source_observations.ndjson')).toBe('');expect(bytes(d,'reconciliation.ndjson')).toBe(before);
});
it('REST recovery retains its earlier authoritative source append but stops the next membership publication after sink failure',async()=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const at='2026-01-01T00:00:00Z';
 writeFileSync(join(d,'rest_raw.ndjson'),JSON.stringify({source:'REST_TRADES',wallet:'wallet',identity:'pending',payload:item,sourceTs:1,firstSeenUtc:at,completedUtc:at})+'\n');
 const store=new RacingStore(d,()=>e.assertUsable());close.push(()=>store.close());const original=(store as any).recoveryAppend.bind(store);
 vi.spyOn(store as any,'recoveryAppend').mockImplementation((name:any,row:any)=>{original(name,row);if(name==='source_observations.ndjson'){arm();expect(()=>e.telemetry({})).toThrow(failure);}});
 await expect(store.initializeIndex()).rejects.toBe(failure);expect(rows(d,'source_observations.ndjson')).toHaveLength(1);expect(bytes(d,'reconciliation.ndjson')).toBe('');
});
const authorityFiles=['rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson','rest_poll_receipts.ndjson','runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson'];
const tornCases=[
 ['rpc-initial-success','rpc_lineage.ndjson'],['rpc-initial-failure','rpc_lineage.ndjson'],
 ['rpc-retry-success','rpc_lineage.ndjson'],['rpc-retry-failure','rpc_lineage.ndjson'],
 ['rpc-recovery','rpc_recoveries.ndjson'],['chain-timeout','quarantine_v2.ndjson'],
 ['chain-malformed','quarantine_v2.ndjson'],['chain-reorg','quarantine_v2.ndjson'],
 ['rest-HTTP','quarantine_v2.ndjson'],['rest-timeout','quarantine_v2.ndjson'],['rest-parse','quarantine_v2.ndjson'],
 ['rest-publication','quarantine_v2.ndjson'],['resolution','quarantine_resolutions.ndjson'],
 ['receipt-nonempty','rest_poll_receipts.ndjson'],['receipt-empty','rest_poll_receipts.ndjson'],
 ['receipt-failure','rest_poll_receipts.ndjson'],['telemetry','runtime_telemetry.ndjson'],
 ['audit','audit_snapshots.ndjson'],['tail','chain_tail_proofs.ndjson'],
] as const;
it.each(['null-block','invalid-range'] as const)('CHAIN shared sink break cancels already-scheduled %s provider lag timer with exact error',async(kind)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 const rpc=vi.fn(async(_url:string,method:string)=>{if(method==='eth_getLogs')throw Error('invalid block range');return kind==='null-block'?null:'0x2';});
 const {watcher}=await chain(d,e,rpc);
 const pending=kind==='null-block'?watcher.handleLog(log()):watcher.scanRange(1,2);
 const rejected=expect(pending).rejects.toBe(failure);await vi.advanceTimersByTimeAsync(1);
 expect(vi.getTimerCount()).toBe(1);const count=rpc.mock.calls.length;arm();expect(()=>e.telemetry({})).toThrow(failure);
 expect(vi.getTimerCount()).toBe(0);await rejected;await vi.advanceTimersByTimeAsync(5000);expect(rpc).toHaveBeenCalledTimes(count);
 expect(bytes(d,'quarantine_v2.ndjson')).toBe('');expect(bytes(d,'chain_tail_proofs.ndjson')).toBe('');
});
it.each(['initial','periodic'] as const)('publisher %s snapshot failure with broken quarantine reporter retires without rearming a timer',async(stage)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture('quarantine_v2.ndjson');let failSnapshot=stage==='initial';
 const snapshot=vi.fn(()=>{if(failSnapshot)throw Error('snapshot IO failure');return {pid:process.pid};});
 if(stage==='initial')arm();
 const fatal=vi.fn(),publisher=startMemoryPublisher(d,snapshot,undefined,undefined,()=>quarantine(e),fatal);
 if(stage==='periodic'){arm();failSnapshot=true;await vi.advanceTimersByTimeAsync(5000);}
 expect(fatal).toHaveBeenCalledExactlyOnceWith(failure);expect(vi.getTimerCount()).toBe(0);
 const calls=snapshot.mock.calls.length;await vi.advanceTimersByTimeAsync(10000);expect(snapshot).toHaveBeenCalledTimes(calls);
 expect(e.failureStatus().state).toBe('BROKEN');publisher.stop();
});
it.each(['REST_TRADES','REST_ACTIVITY'] as const)('%s broken sink during publication is not recursively quarantined and retains exact original failure',async(source)=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');const fetch=vi.fn(async()=>response());
 const {store,poller}=await rest(d,e,fetch,source);const q=vi.spyOn(e,'quarantine');
 vi.spyOn(store,'appendRestRaw').mockImplementation(()=>{arm();try{e.telemetry({});}catch{};throw Error('secondary publication exception');});
 await expect(poller.pollWallet('wallet')).rejects.toBe(failure);expect(q).not.toHaveBeenCalled();
 expect(bytes(d,'rest_poll_receipts.ndjson')).toBe('');await expect(poller.pollWallet('wallet')).rejects.toBe(failure);expect(fetch).toHaveBeenCalledTimes(1);
});
it.each(tornCases)('actual torn authoritative write %s (%s) preserves prefix, exact failure, no derived row and refuses restart repair',async(kind,name)=>{
 vi.useFakeTimers();const {d,e,failure,arm}=fixture(name,'torn-write');
 const apply=vi.spyOn(e as any,'apply'),retire=vi.fn();e.onBroken(retire);
 let invoke:()=>Promise<unknown>,calls=vi.fn();
 if(kind.startsWith('rpc-')){
  let parent:string|null=null;
  if(kind.includes('retry')||kind==='rpc-recovery'){
   await expect(e.rpc(async()=>{throw Error('HTTP 503');},input)).rejects.toThrow('503');
   parent=rows(d,'rpc_lineage.ndjson')[0].requestId;
  }
  calls=vi.fn(async()=>{if(kind.endsWith('failure'))throw Error('RPC timeout');return [];});
  invoke=()=>e.rpc(calls,{...input,attempt:parent?2:1,retryParentRequestId:parent});
 } else if(kind.startsWith('chain-')){
  calls=vi.fn(async()=>{if(kind==='chain-timeout')throw Error('RPC timeout');return {hash:kind==='chain-reorg'?'0x'+'dd'.repeat(32):hash,timestamp:'0x1'};});
  const {watcher}=await chain(d,e,calls);
  Object.assign(watcher,{heartbeat:setInterval(()=>{},1000),verifier:setInterval(()=>{},1000)});
  invoke=()=>watcher.handleLog(kind==='chain-malformed'?{...log(),data:'0x01'}:log());
 } else if(kind.startsWith('rest-')||kind.startsWith('receipt-')){
  calls=vi.fn(async()=>{if(kind==='rest-timeout')throw Error('REST timeout');return response(kind==='rest-parse'?[null]:kind==='receipt-empty'?[]:[item],kind==='rest-HTTP'||kind==='receipt-failure'?503:200);});
  const {store,poller}=await rest(d,e,calls);
  if(kind==='rest-publication')vi.spyOn(store,'appendRestRaw').mockImplementation(()=>{throw Error('publication failed');});
  invoke=()=>poller.pollWallet('wallet');
 } else if(kind==='resolution'){
  quarantine(e);invoke=async()=>e.resolveQuarantine('q','RECOVERED','obs:q','OBSERVED',false);
 } else {
  const append=()=>kind==='telemetry'?e.telemetry({prior:true}):kind==='audit'?e.auditSnapshot({prior:true}):e.tailProof({prior:true});
  append();invoke=async()=>append();
 }
 const before=bytes(d,name);apply.mockClear();arm();await expect(invoke()).rejects.toBe(failure);
 expect(e.failureStatus()).toMatchObject({state:'BROKEN',code:'EVIDENCE_SINK_FAILURE',file:name,error:String(failure)});
 expect(retire).toHaveBeenCalledExactlyOnceWith(failure);
 expect(apply.mock.calls.filter(([file])=>file===name)).toEqual([]);
 const damaged=bytes(d,name);expect(damaged.startsWith(before)).toBe(true);
 expect(damaged.slice(before.length)).toHaveLength(17);expect(damaged.endsWith('\n')).toBe(false);
 const scientific=['observations.ndjson','dispositions.ndjson','block_hashes.ndjson','cursor.json','rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson','quarantine.ndjson'].map(n=>bytes(d,n));
 const callCount=calls.mock.calls.length;
 await expect(invoke()).rejects.toBe(failure);await vi.advanceTimersByTimeAsync(5000);
 expect(calls).toHaveBeenCalledTimes(callCount);expect(vi.getTimerCount()).toBe(0);
 expect(['observations.ndjson','dispositions.ndjson','block_hashes.ndjson','cursor.json','rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson','quarantine.ndjson'].map(n=>bytes(d,n))).toEqual(scientific);
 expect(bytes(d,name)).toBe(damaged);expect(retire).toHaveBeenCalledTimes(1);
 const cache=readFileSync(join(d,'operational-index.sqlite'));
 expect(()=>new OperationalEvidence(d)).toThrow('truncated NDJSON');
 expect(bytes(d,name)).toBe(damaged);expect(readFileSync(join(d,'operational-index.sqlite'))).toEqual(cache);
});
it.each([false,true])('CHAIN failed downstream publication never resolves quarantine before successful canonical replay (breakSink=%s)',async(breakSink)=>{
 const {d,e,failure,arm}=fixture('runtime_telemetry.ndjson');
 const rawKey=`137:${EXCHANGE_V2_STANDARD.toLowerCase()}:${log().transactionHash}:1:${hash}`;
 e.quarantine({...quarantine(e,'baseline'),quarantineId:'pending',rawEvidenceRef:`raw:${rawKey}`});
 const {watcher,store,publish}=await chain(d,e,vi.fn(async()=>({hash,timestamp:'0x1'})));
 publish.mockImplementationOnce(()=>{if(breakSink){arm();try{e.telemetry({});}catch{};}throw Error('racer publication failed');});
 if(breakSink)await expect(watcher.handleLog(log())).rejects.toBe(failure);else await watcher.handleLog(log());
 expect(store.observations()).toHaveLength(1);expect(bytes(d,'quarantine_resolutions.ndjson')).toBe('');
 expect(rows(d,'dispositions.ndjson').at(-1).disposition).toBe('PENDING');
 if(breakSink){expect(()=>e.assertUsable()).toThrow(failure);}else{
  expect(e.quarantineStateIds()).toContainEqual({id:'pending',state:'UNRESOLVED'});
  await watcher.handleLog(log());expect(store.observations()).toHaveLength(1);
  expect(publish).toHaveBeenCalledTimes(2);expect(e.quarantineStateIds()).toContainEqual({id:'pending',state:'RECOVERED'});
  expect(rows(d,'dispositions.ndjson').at(-1).disposition).toBe('OBSERVED');
 }
});
it.each(authorityFiles.flatMap(name=>['torn-json','missing-newline','same-size-malformed'].map(kind=>({name,kind}))))('startup rejects $kind in $name without repair or stale cache trust',async({name,kind})=>{
 const d=dir(),e=new OperationalEvidence(d);await expect(e.rpc(async()=>{throw Error('timeout');},input)).rejects.toThrow('timeout');await e.rpc(async()=>[],input);quarantine(e);e.resolveQuarantine('q','RECOVERED','obs:q','OBSERVED',false);e.restReceipt({});e.telemetry({});e.auditSnapshot({});e.tailProof({});e.close();const file=join(d,name),original=bytes(d,name);
 if(kind==='torn-json')appendFileSync(file,'{"requestId":');
 if(kind==='missing-newline')writeFileSync(file,original.slice(0,-1));
 if(kind==='same-size-malformed')writeFileSync(file,'!'+original.slice(1));
 const damaged=bytes(d,name),index=readFileSync(join(d,'operational-index.sqlite'));
 expect(()=>new OperationalEvidence(d)).toThrow(/truncated NDJSON|malformed NDJSON/);expect(bytes(d,name)).toBe(damaged);expect(readFileSync(join(d,'operational-index.sqlite'))).toEqual(index);
});
