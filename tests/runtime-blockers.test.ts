import { mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
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
import { cgroupMemory } from '../src/shadow/memory.js';
import { assertPrelaunchDisk, storageBudget, storageTelemetry } from '../src/shadow/storage-budget.js';
import { runInNewContext } from 'node:vm';
import { transpileModule, ModuleKind } from 'typescript';
import { streamRows } from '../src/shadow/stream.js';
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
it('real publisher and Python collector retain every quarantine class and old unresolved counts after index rebuild',async()=>{
 const {run,d,e,snapshot}=await fixture();
 const classes=[['TIMEOUT','timeout','CHAIN'],['HTTP_429','429','REST_TRADES'],['HTTP_503','503','REST_ACTIVITY'],['MALFORMED_PAYLOAD','malformed','REST_TRADES'],['PUBLICATION_ERROR','publication','REST_ACTIVITY'],['OTHER','reorg removal','CHAIN']] as const;
 const base={sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true};
 for(const [errorClass,reason,source] of classes)e.quarantine({...base,quarantineId:reason,component:source,source,errorClass,reason,timestampUtc:'2026-10-10T09:00:00.000Z'});
 for(let i=0;i<1601;i++){e.quarantine({...base,quarantineId:'recovered-'+i,component:'CHAIN',source:'CHAIN',errorClass:'TIMEOUT',reason:'timeout'});e.resolveQuarantine('recovered-'+i,'RECOVERED','obs','CONFIRMED',false);}
 e.quarantine({...base,quarantineId:'terminal',component:'CHAIN',source:'CHAIN',errorClass:'HTTP_503',reason:'503'});e.resolveQuarantine('terminal','TERMINAL',null,'EXCLUDED',true);
 const collect=()=>JSON.parse(execFileSync('python3',['-B','-c',"import importlib.util,json,pathlib,sys; s=importlib.util.spec_from_file_location('collector',sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); print(json.dumps(m.operational_status(pathlib.Path(sys.argv[2]),float(sys.argv[3]))))",resolve('scripts/status/collector.py'),run,String(Date.now()/1000)],{encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}}));
 const p=startMemoryPublisher(d,snapshot);p.stop();const before=collect();
 expect(before.quarantine).toMatchObject({total:1608,unresolved:6,recovered:1601,terminal:1,additions5m:1602,additions1h:1602,oldestUnresolvedAgeSeconds:10800,latestSource:'CHAIN',latestClass:'503',classBreakdown:{timeout:1602,'429':1,'503':2,malformed:1,publication:1,reorg:1}});
 expect(before.chain.unresolvedQuarantine).toBe(2);expect(before.fresh).toBe(true);
 closers.pop();e.close();unlinkSync(join(d,'operational-index.sqlite'));const rebuilt=new OperationalEvidence(d,()=>now);closers.push(()=>rebuilt.close());
 const restart=startMemoryPublisher(d,()=>runtimeHealthSnapshot({memoryTelemetry:()=>({atUtc:now,lastProgressUtc:now})},{indexTelemetry:()=>({})},rebuilt,()=>({pid:1})));restart.stop();
 const after=collect();expect(after.quarantine).toEqual(before.quarantine);expect(after.chain.unresolvedQuarantine).toBe(2);
 vi.advanceTimersByTime(60000);const stale=collect();expect(stale.fresh).toBe(false);expect(stale.quality.state).toBe('UNKNOWN');expect(stale.quarantine).toEqual(before.quarantine);
});
it('26h real append-only telemetry and ten-minute audits retain bounded derived state and survive restart',async()=>{
 const {d,e,snapshot}=await fixture();const started=Date.now();let lastAudit=started-600000;
 // The entrypoint composition/cadence with actual telemetry/audit writers, not a mock archive counter.
 const p=startMemoryPublisher(d,()=>({...snapshot(),atUtc:new Date().toISOString(),storage:storageTelemetry(d,(Date.now()-started)/1000),...cgroupMemory()}),undefined,s=>{
  e.telemetry(s as Record<string,unknown>);if(Date.now()-lastAudit>=600000){lastAudit=Date.now();e.auditSnapshot({processHealth:'ALIVE',telemetry:s});}
 });
 vi.advanceTimersByTime(93600000);p.stop();
 const s=e.operationalSnapshot();expect(s.streams['runtime_telemetry.ndjson']).toBe(18721);expect(s.streams['audit_snapshots.ndjson']).toBe(157);
 let telemetry=0,audits=0,first:any,last:any;
 for(const row of streamRows<any>(join(d,'runtime_telemetry.ndjson'))){first??=row;last=row;telemetry++;}
 for(const row of streamRows<any>(join(d,'audit_snapshots.ndjson'))){expect(row.processHealth).toBe('ALIVE');audits++;}
 expect(telemetry).toBe(18721);expect(audits).toBe(157);expect(Date.parse(last.atUtc)-Date.parse(first.atUtc)).toBe(93600000);
 expect(last).toHaveProperty('rssBytes');expect(last).toHaveProperty('heapUsedBytes');expect(last).toHaveProperty('externalBytes');expect(last.storage.disk).toHaveProperty('availableBytes');expect(last).toHaveProperty('cgroupUsageBytes');
 const db=(e as any).db;expect(db.prepare('SELECT count(*) n FROM meta').get().n).toBeLessThan(20);expect(db.prepare('SELECT count(*) n FROM q').get().n).toBe(0);expect(db.prepare('PRAGMA cache_size').get().cache_size).toBe(-2048);
 closers.pop();e.close();unlinkSync(join(d,'operational-index.sqlite'));const rebuilt=new OperationalEvidence(d,()=>new Date().toISOString());closers.push(()=>rebuilt.close());expect(rebuilt.operationalSnapshot().streams).toEqual(s.streams);expect(vi.getTimerCount()).toBe(0);
},120000);
it.each(['runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson'] as const)('actual %s append survives before-index interruption exactly once; shared sink gates later work',async name=>{
 const failure=Error('after-append before-index interruption');let armed=false;
 const {d,e,rpc}=await fixture({fault:(point,file)=>{if(armed&&point==='after-authoritative-append'&&file===name)throw failure;}});
 const append=()=>name==='runtime_telemetry.ndjson'?e.telemetry({rssBytes:1}):name==='audit_snapshots.ndjson'?e.auditSnapshot({processHealth:'ALIVE'}):e.tailProof({coverage:'UNKNOWN_UNPROVEN'});
 append();const before=readFileSync(join(d,name),'utf8');armed=true;
 let thrown:unknown;try{append();}catch(error){thrown=error;}expect(thrown).toBe(failure);expect(e.isUsable()).toBe(false);expect(e.failureStatus().state).toBe('BROKEN');
 const retained=readFileSync(join(d,name),'utf8');expect(retained.startsWith(before)).toBe(true);expect([...streamRows(join(d,name))]).toHaveLength(2);
 const calls=rpc.mock.calls.length;await expect(e.rpc(rpc as any,{family:'CHAIN',method:'eth_blockNumber',params:[],component:'CHAIN',reason:'verifier',attempt:1,retryParentRequestId:null})).rejects.toBe(failure);expect(rpc.mock.calls).toHaveLength(calls);
 expect(()=>e.restReceipt({source:'REST_TRADES'})).toThrow(failure);expect(()=>e.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass:'OTHER',reason:'blocked',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true})).toThrow(failure);
 closers.pop();e.close();const rebuilt=new OperationalEvidence(d,()=>now);closers.push(()=>rebuilt.close());expect(rebuilt.operationalSnapshot().streams[name]).toBe(2);expect(readFileSync(join(d,name),'utf8')).toBe(retained);
 rebuilt.close();const again=new OperationalEvidence(d,()=>now);closers.pop();closers.push(()=>again.close());expect(again.operationalSnapshot().streams[name]).toBe(2);expect(readFileSync(join(d,name),'utf8')).toBe(retained);
});
it.each([null,119058826239,10737418239,119058826240] as const)('actual observer entrypoint startup gates available=%s before scientific stores or sources',async available=>{
 const d=mkdtempSync(join(tmpdir(),'observer-startup-gate-'));dirs.push(d);
 const calls:string[]=[];const errors:unknown[][]=[];const processStub={exitCode:0};
 const sentinel=Error('test stop after admitted startup gate');
 const source=readFileSync(resolve('src/shadow/main.ts'),'utf8');
 const compiled=transpileModule(source,{compilerOptions:{module:ModuleKind.CommonJS}}).outputText;
 const modules:Record<string,unknown>={
  './config.js':{loadConfig:()=>({dataDir:d})},
  './operational-evidence.js':{OperationalEvidence:class{constructor(){calls.push('operational');}close(){calls.push('close');}}},
  './storage-budget.js':{assertPrelaunchDisk:()=>{calls.push('gate');assertPrelaunchDisk(d,()=>{if(available===null)throw Error('stat unavailable');return {bavail:available,bsize:1,blocks:available} as ReturnType<typeof import('node:fs').statfsSync>;});}},
  './storage.js':{ShadowStore:class{constructor(){calls.push('scientific-store');throw sentinel;}}},
 };
 runInNewContext(compiled,{exports:{},require:(name:string)=>modules[name]??new Proxy({},{get:()=>()=>{calls.push('unexpected-side-effect');throw Error('startup collaborator reached');}}),process:processStub,console:{error:(...args:unknown[])=>errors.push(args)},Date});
 await Promise.resolve();await Promise.resolve();
 expect(storageBudget().requiredFreeBytes).toBe(119058826240);
 expect(processStub.exitCode).toBe(1);expect(errors).toHaveLength(1);
 if(available===119058826240){expect(calls).toEqual(['operational','gate','scientific-store']);expect(errors[0]![1]).toBe(sentinel);}
 else{expect(calls).toEqual(['operational','gate','close']);expect(String(errors[0]![1])).toContain(available===null?'stat unavailable':'PRELAUNCH_DISK_GATE');}
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
