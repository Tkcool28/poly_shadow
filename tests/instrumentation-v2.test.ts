import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { OperationalEvidence, quarantineClass } from '../src/shadow/operational-evidence.js';
import { cgroupMemory } from '../src/shadow/memory.js';
import { startMemoryPublisher } from '../src/shadow/runtime-memory.js';
import { storageBudget, diskState, storagePlan, assertPrelaunchDisk, storageTelemetry } from '../src/shadow/storage-budget.js';
import { dataQuality } from '../src/shadow/data-quality.js';
import { runtimeHealthSnapshot } from '../src/shadow/runtime-health.js';
const dirs:string[]=[];
it('resolution idempotence rejects conflicts and unknown IDs without changing whole-run aggregates or authority',()=>{
 const d=dir(),e=new OperationalEvidence(d,()=>now);quarantine(e,'once');e.resolveQuarantine('once','RECOVERED','obs','CONFIRMED',false);
 const before=readFileSync(join(d,'quarantine_resolutions.ndjson'),'utf8'),s=e.operationalSnapshot(now);
 e.resolveQuarantine('once','RECOVERED','obs','CONFIRMED',false);expect(()=>e.resolveQuarantine('once','TERMINAL',null,'BAD',true)).toThrow('conflicting');expect(()=>e.resolveQuarantine('missing','RECOVERED',null,'BAD',false)).toThrow('unknown');
 expect(readFileSync(join(d,'quarantine_resolutions.ndjson'),'utf8')).toBe(before);expect(e.operationalSnapshot(now)).toEqual(s);e.close();
});
it('bounded whole-run SQL reads stream quarantine and recovery without lifetime all() materialization',async()=>{
 const e=new OperationalEvidence(dir(),()=>now);for(let i=0;i<100;i++)quarantine(e,'q'+i,'OTHER',now,'unique-'+i);
 const all=vi.spyOn(Object.getPrototypeOf((e as any).db.prepare('SELECT 1')),'all');
 const s=e.operationalSnapshot(now);expect(s.quarantine.total).toBe(100);expect(all).not.toHaveBeenCalled();
 expect((e as any).db.prepare('PRAGMA temp_store').get().temp_store).toBe(1);expect((e as any).db.prepare('PRAGMA cache_size').get().cache_size).toBe(-2048);
 all.mockRestore();e.close();
});
it('actual indexed source reducer elevates persistent REST failures and remains independent of liveness',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(now));const e=new OperationalEvidence(dir(),()=>now);
 for(let i=0;i<10;i++)e.restReceipt({recordType:'REST_POLL',source:'REST_ACTIVITY',outcome:'TIMEOUT',responseUtc:now});
 const h=runtimeHealthSnapshot({memoryTelemetry:()=>({atUtc:now,lastProgressUtc:now})} as any,{indexTelemetry:()=>({})} as any,e,()=>({pid:1}));
 expect(h.dataQuality.state).toBe('AT_RISK');expect(h.sourceHealth.find(s=>s.source==='REST_ACTIVITY')?.quality.state).toBe('AT_RISK');expect(h.operationalEvidence?.rest[1]?.consecutiveFailures).toBe(10);e.close();
});
const dir=()=>{const d=mkdtempSync(join(tmpdir(),'instrumentation-v2-'));dirs.push(d);return d;};
afterEach(()=>{vi.useRealTimers();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const now='2026-10-10T12:00:00.000Z';
const quarantine=(e:OperationalEvidence,id:string,errorClass:Parameters<OperationalEvidence['quarantine']>[0]['errorClass']='TIMEOUT',timestampUtc=now,reason='fixture')=>e.quarantine({quarantineId:id,timestampUtc,component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass,reason,eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true});
it('whole-run operational projection retains old unresolved failures behind large history and rebuilds identical counters',()=>{
 const d=dir();let e=new OperationalEvidence(d,()=>now);quarantine(e,'early','TIMEOUT','2026-10-10T09:00:00.000Z');
 for(let i=0;i<1601;i++){quarantine(e,'later-'+i);e.resolveQuarantine('later-'+i,'RECOVERED','obs','CONFIRMED',false);}
 quarantine(e,'terminal','HTTP_503');e.resolveQuarantine('terminal','TERMINAL',null,'EXCLUDED',true);
 quarantine(e,'pre-terminal','INDEX_ERROR',now,'fixture');e.resolveQuarantine('pre-terminal','TERMINAL',null,'EXCLUDED',false);
 const s=e.operationalSnapshot(now);expect(s.quarantine).toMatchObject({total:1604,unresolved:1,recovered:1601,terminal:2,ambiguous:2,oldestUnresolvedAgeSeconds:10800,additions5m:1603,additions1h:1603});
 expect(s.quarantine.classBreakdown.timeout).toBe(1602);expect(s.quarantine.latestClass).toBe('503');
 e.close();unlinkSync(join(d,'operational-index.sqlite'));e=new OperationalEvidence(d,()=>now);expect(e.operationalSnapshot(now)).toEqual({...s,operationalIndex:{indexed:true,rebuildReason:'MISSING',schemaVersion:6}});e.close();
});
it.each([['TIMEOUT','timeout'],['HTTP_503','503'],['HTTP_429','429'],['MALFORMED_PAYLOAD','malformed'],['PUBLICATION_ERROR','publication'],['INDEX_ERROR','index'],['OTHER','verifier'],['OTHER','backfill'],['OTHER','reorg'],['OTHER','other']])('quarantine primary classification %s / %s', (errorClass,expected)=>{
 expect(quarantineClass({errorClass:errorClass!,component:'CHAIN',reason:expected!})).toBe(expected);
});
it('per-source REST summaries retain sticky cap/cursor/completeness/publication uncertainty across short success and semantic-cache rebuild',()=>{
 const d=dir();let e=new OperationalEvidence(d,()=>now);
 e.restReceipt({recordType:'REST_PAGE',source:'REST_TRADES',outcome:'PUBLICATION_FAILURE',atApiLimit:true,overlap:'MISSING_OR_MOVED',stopReason:'UNSTABLE_OVERLAP'});
 for(let i=0;i<11;i++)e.restReceipt({recordType:'REST_POLL',source:'REST_TRADES',outcome:'TIMEOUT',responseUtc:now,stopReason:'FAILURE'});
 expect(e.restSource('REST_TRADES').consecutiveFailures).toBe(11);expect(e.restSource('REST_ACTIVITY').polls).toBe(0);
 e.restReceipt({recordType:'REST_POLL',source:'REST_TRADES',outcome:'SUCCESS_EMPTY',responseUtc:now,stopReason:'SHORT_PAGE'});
 const expected=e.restSource('REST_TRADES');expect(expected).toMatchObject({consecutiveFailures:0,lastSuccessUtc:now,lastTraversal:'TRAVERSED_RETURNED_PAGES_ONLY',pageLimitEver:true,completeness:'UNKNOWN_UNPROVEN',publicationFailures:1,cursorFailures:1,completenessFailures:1});e.close();
 const db=new DatabaseSync(join(d,'operational-index.sqlite'));db.prepare("UPDATE meta SET v='{}' WHERE k='summary:rest:REST_TRADES'").run();db.close();
 e=new OperationalEvidence(d,()=>now);expect(e.indexStatus().rebuildReason).toBe('SEMANTIC_MISMATCH');expect(e.restSource('REST_TRADES')).toEqual(expected);e.close();
});
it('RPC lineage progress oldest failure age recovery and terminal tail persist through restart',async()=>{
 const d=dir();let e=new OperationalEvidence(d,()=>now);const params=[{fromBlock:'0x1',toBlock:'0x2'}];
 await expect(e.rpc(async()=>{throw Error('timeout');},{family:'CHAIN',method:'eth_getLogs',params,component:'CHAIN',reason:'backfill',attempt:1,retryParentRequestId:null})).rejects.toThrow('timeout');
 expect(e.operationalSnapshot('2026-10-10T12:05:00.000Z').chain).toMatchObject({unresolved:1,oldestFailureAgeSeconds:300,requests:1,failures:1});
 await e.rpc(async()=>[],{family:'CHAIN',method:'eth_getLogs',params,component:'CHAIN',reason:'backfill',attempt:2,retryParentRequestId:null});
 e.tailProof({recoveryRequired:false,finalVerifiedBlock:2,coverage:'UNKNOWN_UNPROVEN'});const s=e.operationalSnapshot(now);expect(s.chain).toMatchObject({unresolved:0,retries:1,requests:2,tail:{finalVerifiedBlock:2,coverage:'UNKNOWN_UNPROVEN'}});e.close();
 e=new OperationalEvidence(d,()=>now);expect(e.operationalSnapshot(now).chain).toEqual(s.chain);e.close();
});
it('bounded cgroup telemetry distinguishes governing group cache/kernel usage from PSI and all events/swap/high',()=>{
 const d=dir();mkdirSync(join(d,'leaf'));writeFileSync(join(d,'leaf/memory.max'),'max');writeFileSync(join(d,'leaf/memory.current'),'1');
 for(const [name,value] of Object.entries({'memory.max':'1000','memory.current':'900','memory.high':'800','memory.swap.current':'12','memory.swap.max':'30','memory.events':'low 1\nhigh 2\nmax 3\noom 4\noom_kill 5','memory.stat':'anon 100\nfile 700\nkernel 100\nslab 25\nsock 5','memory.pressure':'some avg10=1.25 avg60=2.0 avg300=3.0 total=123\nfull avg10=0.1 avg60=0.2 avg300=0.3 total=7'}))writeFileSync(join(d,name),value);
 const m=cgroupMemory(d,'0::/leaf');expect(m).toMatchObject({cgroupUsageBytes:900,cgroupLimitBytes:1000,cgroupHighBytes:800,cgroupSwapUsageBytes:12,cgroupSwapLimitBytes:30,cgroupEvents:{low:1,high:2,max:3,oom:4,oom_kill:5},cgroupMemoryStat:{file:700,kernel:100},cgroupPsi:{some:{avg10:1.25,total:123},full:{total:7}}});
 expect(cgroupMemory(d,'0::/../escape')).toEqual({cgroupUsageBytes:null,cgroupLimitBytes:null});
});
it('storage gate reconciles engineering envelope margin with 10GiB reserve and exact boundaries',()=>{
 const b=storageBudget();expect(b.requiredFreeBytes).toBe(b.upperBytes+b.marginBytes+10*1024**3);expect(Object.keys(b.families)).toHaveLength(8);
 expect(diskState(b.requiredFreeBytes,b.seconds).state).toBe('GREEN');expect(diskState(b.requiredFreeBytes-1,b.seconds).state).toBe('DEGRADED');expect(diskState(storagePlan.alertReserveBytes-1,0).state).toBe('AT_RISK');expect(diskState(null,0).state).toBe('UNKNOWN');
 expect(()=>assertPrelaunchDisk(dir(),()=>({bavail:1,bsize:1,blocks:2}) as ReturnType<typeof import('node:fs').statfsSync>)).toThrow('PRELAUNCH_DISK_GATE');
 expect(storageTelemetry(dir(),0).files['rpc_lineage.ndjson']).toBeNull();
});
it.each(['before','torn'] as const)('actual ENOSPC telemetry %s write latches failclosed and never starts later upstream request',async mode=>{
 const d=dir(),failure=Object.assign(Error('actual write ENOSPC'),{code:'ENOSPC'});let armed=false;
 const e=new OperationalEvidence(d,()=>now,{write:(path,serialized,name)=>{if(armed&&name==='runtime_telemetry.ndjson'){if(mode==='torn')appendFileSync(path,serialized.slice(0,12));throw failure;}appendFileSync(path,serialized);}});
 e.telemetry({rssBytes:1});const before=readFileSync(join(d,'runtime_telemetry.ndjson'),'utf8');armed=true;
 expect(()=>e.telemetry({rssBytes:2})).toThrow(failure);let requests=0;await expect(e.rpc(async()=>{requests++;return 1;},{family:'CHAIN',method:'eth_blockNumber',params:[],component:'CHAIN',reason:'verifier',attempt:1,retryParentRequestId:null})).rejects.toBe(failure);expect(requests).toBe(0);expect(e.failureStatus().code).toBe('EVIDENCE_SINK_FAILURE');
 expect(readFileSync(join(d,'runtime_telemetry.ndjson'),'utf8')).toBe(mode==='torn'?before+'{"schemaVers':before);
 if(mode==='torn')expect(()=>new OperationalEvidence(d)).toThrow('truncated NDJSON');else{const rebuilt=new OperationalEvidence(d);expect(rebuilt.operationalSnapshot().streams['runtime_telemetry.ndjson']).toBe(1);rebuilt.close();}
});
it('full-run telemetry cadence survives over 1500 cycles and archives during snapshot failure without finite lifecycle',()=>{
 vi.useFakeTimers();vi.setSystemTime(new Date(now));let samples=0,archives=0,failed=true;const d=dir();
 const p=startMemoryPublisher(d,()=>({atUtc:new Date().toISOString(),sample:++samples}),{write:()=>{if(failed)throw Error('denied');},rename:()=>{},remove:()=>{},diagnose:()=>{}},()=>{archives++;});
 vi.advanceTimersByTime(93600000);expect(samples).toBe(18721);expect(archives).toBe(samples);failed=false;vi.advanceTimersByTime(5000);expect(samples).toBe(18722);p.stop();vi.advanceTimersByTime(10000);expect(samples).toBe(18722);expect(vi.getTimerCount()).toBe(0);
});
it.each([['GREEN',{lastProgressUtc:now}],['DEGRADED',{lastProgressUtc:now,retryQueue:1}],['AT_RISK',{operationalSinkBroken:true}],['UNKNOWN',{lastProgressUtc:'invalid'}]] as const)('quality %s derives from evidence not process liveness',(state,input)=>{expect(dataQuality({...input,nowUtc:now}).state).toBe(state);});
