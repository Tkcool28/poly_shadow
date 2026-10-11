import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ShadowStore } from '../src/shadow/storage.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { OperationalEvidence } from '../src/shadow/operational-evidence.js';
import { RacingStore, Reconciler, chainGroupKey, publishChainObservation } from '../src/shadow/racing.js';
import { startMemoryPublisher } from '../src/shadow/runtime-memory.js';
import { EXCHANGE_V2_STANDARD, TOPIC_ORDER_FILLED_V2 } from '../src/shadow/v2constants.js';
const dirs:string[]=[];
afterEach(()=>{vi.useRealTimers();for(const d of dirs.splice(0)) rmSync(d,{recursive:true,force:true});});
const arrival='2026-01-01T00:00:00Z', completion='2026-01-01T00:00:01Z';
const wallet='0x'+'11'.repeat(20);
const topic=(s:string)=>'0x'+s.slice(2).padStart(64,'0');
const log={address:EXCHANGE_V2_STANDARD,transactionHash:'0x'+'aa'.repeat(32),logIndex:0,blockNumber:1,blockHash:'0x'+'bb'.repeat(32),topics:[TOPIC_ORDER_FILLED_V2,'0x'+'00'.repeat(32),topic(wallet),topic(EXCHANGE_V2_STANDARD)],data:'0x'+[0,1,2,3,0,0,0].map(n=>n.toString(16).padStart(64,'0')).join('')};
const identity=`137:${log.address}:${log.transactionHash}:0:${log.blockHash}`;
function setup(){const dir=mkdtempSync(join(tmpdir(),'publication-'));dirs.push(dir);const cfg={chainId:137,watchedWallets:new Set([wallet]),polygonHttpRpcUrl:'https://rpc.test',dataDir:dir,backfillChunkBlocks:1} as any;return {dir,cfg};}
const rpc=(async(_url:string,method:string)=>method==='eth_getLogs'?[log]:{hash:log.blockHash,timestamp:'0x1'}) as any;
for(const stage of ['reconciliation','source','completion'] as const) for(const reopen of [false,true]) {
 it(`repairs ${stage} failure exactly once ${reopen?'after reopening':'in process'} without premature cursor advance`,async()=>{
  const {dir,cfg}=setup();let store=new ShadowStore(dir),racing=new RacingStore(dir),reconciler=new Reconciler(racing);
  let fail=true,now=completion;
  const callback=(obs:any)=>publishChainObservation(racing,reconciler,obs);
  const originalDisposition=store.appendDisposition.bind(store);
  const installFailure=()=>stage==='completion'
   ? vi.spyOn(store,'appendDisposition').mockImplementation(row=>{if(fail&&row.disposition==='OBSERVED')throw Error('completion failure');originalDisposition(row);})
   : vi.spyOn(racing,stage==='reconciliation'?'appendReconciliation':'appendSourceObservation').mockImplementation(()=>{if(fail) throw Error('injected publication failure');});
  const spy=installFailure();
  const operational=new OperationalEvidence(dir);
  let watcher=new ChainWatcher(cfg,store,()=>now,rpc,callback,operational);
  await watcher.handleLog(log,arrival);
  expect(operational.quarantineState().unresolved).toBe(1);
  const canonical=store.observations()[0]!;expect(canonical).toBeDefined();
  expect(store.identityState(identity).disposition).toBe('PENDING');
  await watcher.scanRange(1,1);expect(store.readCursor(cfg.polygonHttpRpcUrl)).toBeNull();
  expect(store.observations()).toEqual([canonical]);
  expect(racing.reconciliation()).toHaveLength(stage==='reconciliation'?0:1);
  spy.mockRestore();fail=false;now='2026-01-02T00:00:00Z';
  if(reopen){store.close();racing.close();store=new ShadowStore(dir);racing=new RacingStore(dir);reconciler=new Reconciler(racing);watcher=new ChainWatcher(cfg,store,()=>now,rpc,callback);await racing.initializeIndex();}
  expect(await watcher.replayIncompleteFromStore()).toBe(1);
  await watcher.handleLog(log);await watcher.scanRange(1,1);
  expect(await watcher.replayIncompleteFromStore()).toBe(0);
  expect(store.observations()).toEqual([canonical]);
  expect(store.rawLogs()).toHaveLength(1);
  expect(store.identityState(identity).disposition).toBe('OBSERVED');
  expect(store.readCursor(cfg.polygonHttpRpcUrl)?.blockNumber).toBe(1);
  expect(racing.reconciliation()).toEqual([{groupKey:chainGroupKey(canonical),source:'CHAIN',identity,position:'FIRST',atUtc:arrival}]);
  expect(racing.sourceObservations()).toHaveLength(1);
  expect(racing.sourceObservations()[0]).toMatchObject({identity,sourceFirstSeenUtc:arrival,completedUtc:completion});
  expect(reconciler.record('REST_TRADES','later',chainGroupKey(canonical),now)).toBe('CORROBORATOR');
  store.close();racing.close();
 });
}
for (const stage of ['canonical', 'source', 'group', 'position'] as const) it(`stops watcher retries after ${stage} index failure and reopens without evidence drift`, async () => {
 const {dir,cfg}=setup();let store=new ShadowStore(dir),racing=new RacingStore(dir),reconciler=new Reconciler(racing);
 await store.initializeIndex();await racing.initializeIndex();
 const target=stage==='canonical'?store:racing;
 const table={canonical:'canonical_observations',source:'identities',group:'groups',position:'positions'}[stage];
 (target as any).db.exec(`CREATE TRIGGER fail_update BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'injected index failure'); END`);
 const callback=(obs:any)=>publishChainObservation(racing,reconciler,obs);
 const operational=new OperationalEvidence(dir);
 let watcher=new ChainWatcher(cfg,store,()=>completion,rpc,callback,operational);
 await expect(watcher.handleLog(log,arrival)).rejects.toThrow(/index invalid/);
 expect(operational.quarantineState()).toMatchObject({unresolved:1,total:1});
 const files=['raw_logs.ndjson','dispositions.ndjson','observations.ndjson','source_observations.ndjson','reconciliation.ndjson','quarantine.ndjson'];
 const bytes=()=>files.map(file=>existsSync(join(dir,file))?readFileSync(join(dir,file),'utf8'):null);
 const before=bytes();
 expect(before[5]).toBeNull();
 for(let n=0;n<3;n++) {
  await expect(watcher.handleLog(log)).rejects.toThrow(/index invalid/);
  await expect(watcher.processRetries()).rejects.toThrow(/index invalid/);
  expect(bytes()).toEqual(before);
 }
 store.close();racing.close();store=new ShadowStore(dir);racing=new RacingStore(dir);reconciler=new Reconciler(racing);
 await store.initializeIndex();await racing.initializeIndex();
 watcher=new ChainWatcher(cfg,store,()=> '2026-01-02T00:00:00Z',rpc,callback);
 expect(await watcher.replayIncompleteFromStore()).toBe(1);
 await watcher.handleLog(log);
 const canonical=store.observations()[0]!;
 expect(store.rawLogs()).toHaveLength(1);expect(store.observations()).toHaveLength(1);
 expect(canonical).toMatchObject({sourceFirstSeenUtc:arrival,firstSeenUtc:completion});
 expect(store.identityState(identity).disposition).toBe('OBSERVED');
 expect(racing.sourceObservations()).toHaveLength(1);
 expect(racing.sourceObservations()[0]).toMatchObject({sourceFirstSeenUtc:arrival,completedUtc:completion});
 expect(racing.reconciliation()).toEqual([{groupKey:chainGroupKey(canonical),source:'CHAIN',identity,position:'FIRST',atUtc:arrival}]);
 store.close();racing.close();
});
for(const stage of ['write','rename'] as const) it(`contains initial and interval snapshot ${stage} failures, retries and cleans up without evidence mutation`,async()=>{
 vi.useFakeTimers();const {dir,cfg}=setup();const store=new ShadowStore(dir);const watcher=new ChainWatcher(cfg,store,()=>completion,rpc);
 await watcher.handleLog(log,arrival);
 const evidence=readFileSync(join(dir,'observations.ndjson'),'utf8');
 writeFileSync(join(dir,'runtime-memory.json'),'previous snapshot\n');
 let fail=true;const diagnose=vi.fn();
 const {stop}=startMemoryPublisher(dir,()=>watcher.memoryTelemetry(),{write:(...args:Parameters<typeof writeFileSync>)=>{if(fail&&stage==='write')throw Error('write denied');writeFileSync(...args);},rename:(...args:Parameters<typeof renameSync>)=>{if(fail&&stage==='rename')throw Error('rename denied');renameSync(...args);},remove:unlinkSync,diagnose});
 expect(diagnose).toHaveBeenCalledTimes(1);
 await watcher.handleLog({...log,transactionHash:'0x'+'cc'.repeat(32)},arrival);
 expect(store.observations()).toHaveLength(2);
 const evidenceFiles=['observations.ndjson','raw_logs.ndjson','dispositions.ndjson'];
 const bytes=()=>evidenceFiles.map(file=>readFileSync(join(dir,file),'utf8'));
 const before=bytes();
 vi.advanceTimersByTime(15000);expect(diagnose).toHaveBeenCalledTimes(1);
 expect(bytes()).toEqual(before);
 expect(existsSync(join(dir,'quarantine.ndjson'))).toBe(false);
 expect(readFileSync(join(dir,'runtime-memory.json'),'utf8')).toBe('previous snapshot\n');
 expect(existsSync(join(dir,'runtime-memory.json.tmp'))).toBe(false);
 fail=false;vi.advanceTimersByTime(5000);
 expect(JSON.parse(readFileSync(join(dir,'runtime-memory.json'),'utf8')).pid).toBe(process.pid);
 expect(readFileSync(join(dir,'observations.ndjson'),'utf8').startsWith(evidence)).toBe(true);
 const unchanged=readFileSync(join(dir,'observations.ndjson'),'utf8');
 vi.advanceTimersByTime(5000);expect(readFileSync(join(dir,'observations.ndjson'),'utf8')).toBe(unchanged);
 const recovered=readFileSync(join(dir,'runtime-memory.json'),'utf8');
 fail=true;vi.advanceTimersByTime(10000);expect(diagnose).toHaveBeenCalledTimes(2);
 expect(readFileSync(join(dir,'runtime-memory.json'),'utf8')).toBe(recovered);
 expect(bytes()).toEqual(before);
 stop();expect(vi.getTimerCount()).toBe(0);expect(existsSync(join(dir,'runtime-memory.json.tmp'))).toBe(false);store.close();
});
