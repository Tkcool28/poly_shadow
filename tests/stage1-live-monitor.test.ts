import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,appendFileSync,rmSync,linkSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {generateKeyPairSync,sign,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {LiveMonitor,checkpoint} from '../src/compare/live-monitor.js';
import {COMPARATOR_VERSION,compareV2} from '../src/compare/phase4-v2.js';
import {buildShadowGroups,compare,type Poly2ExportRow} from '../src/compare/phase4.js';
import {authenticatedBytes,authorityDigest,producerFingerprint} from '../src/compare/production-authority.js';
import {contractPath} from '../src/compare/stage1-approval.js';
import {clockEvidence} from '../src/compare/exact-clock.js';
import {WALLETS} from '../research/v2-cursor-v1/adapter.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{for(const c of cleanup.splice(0).reverse())c();});
const window={startUtc:'2026-10-17T00:00:00.000Z',endUtc:'2026-10-18T00:00:00.000Z'},sha='a'.repeat(40),tx='0x'+'11'.repeat(32),wallet=WALLETS[0]!,now='2026-10-17T00:40:05.000Z';
const sourceTs=Date.parse('2026-10-17T00:40:00Z')/1000;
const obs=(over:any={})=>({source:'REST_TRADES',identity:'rest-trade-1',wallet,side:'BUY',asset:'7',size:'1.000000',price:'0.5',sourceTs,blockTimestamp:null,sourceFirstSeenUtc:'2026-10-17T00:40:01.000Z',completedUtc:'2026-10-17T00:40:02.000Z',role:'UNKNOWN',groupKey:'econ:'+tx+':7:1.000000',hydration:'FULL',...over});
const row=(over:any={}):Poly2ExportRow=>({wallet,txHash:tx,asset:'7',conditionId:null,side:'BUY',size:1,price:null,sourceTs,ingestedUtc:'2026-10-17T00:40:03.000Z',normalizedUtc:null,decisionUtc:null,signalUtc:null,source:'data-api',freshnessAgeSec:null,freshnessRejection:null,policyEligible:null,copyabilityOutcome:null,rejectionReason:null,paperOutcome:null,...over});
const cohort=(w:string)=>w===wallet?'CONTROLLED_OVERLAP' as const:null;
function fixture(){
 const root=mkdtempSync(join(tmpdir(),'stage1-monitor-'));cleanup.push(()=>rmSync(root,{recursive:true,force:true}));
 const run=join(root,'runs/phase4-fixture');mkdirSync(join(run,'shadow-data'),{recursive:true});mkdirSync(join(run,'poly2-comparison-capture'));
 const keys=generateKeyPairSync('ed25519');const b:any={runId:'poly2-fixture',shadowRunId:'phase4-fixture',poly2CodeSha:'b'.repeat(40),shadowCodeSha:sha,componentSha256:'c'.repeat(64),protocolDigest:'d'.repeat(64),generationId:'fixture-generation',cohort:[...WALLETS],window,evidenceKind:'observational',sourcePublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString(),expectedWorkers:['backend:test','bot:test']};
 const a:any={schemaVersion:1,version:'poly2-production-authority-v1',binding:b,cohortSha256:authorityDigest(b.cohort),requiredWriterServices:['backend','bot'],producerFingerprint:producerFingerprint(b.sourcePublicKey),approvedUtc:'2026-10-16T23:00:00Z',installations:Object.fromEntries(b.expectedWorkers.map((w:string)=>[w,{installationSha256:'e'.repeat(64),approvedUtc:'2026-10-16T22:00:00Z'}]))};
 const approval={version:COMPARATOR_VERSION,approved:true,approvedBy:'DETERMINISTIC_FIXTURE_NOT_REAL_AUTHORIZATION',approvedUtc:a.approvedUtc,contractSha256:createHash('sha256').update(readFileSync(contractPath)).digest('hex'),shadowSha:sha,runId:b.shadowRunId,window,cohort:b.cohort};
 const put=(file:string,value:unknown)=>writeFileSync(file,JSON.stringify(value));
 const authorityPath=join(root,'authority.json'),approvalPath=join(root,'approval.json'),pointerPath=join(root,'pointer.json');put(authorityPath,a);put(approvalPath,approval);
 const manifest={state:'SEALED_NOT_STARTED',durationSeconds:86400,experimentDirectory:run,shadowSha:sha,window,controlled:b.cohort,productionAuthority:{sha256:authorityDigest(a)}};put(join(run,'run-manifest.json'),manifest);put(join(run,'cohorts.json'),{window,controlled:b.cohort,exploratory:[]});
 const pointer={schemaVersion:1,runDirectory:run,runId:b.shadowRunId,approvedShadowSha:sha,startUtc:window.startUtc,endUtc:window.endUtc,lifecycleState:'AUTHORIZED'};put(pointerPath,pointer);
 writeFileSync(join(run,'shadow-data/source_observations.ndjson'),'');put(join(run,'shadow-data/runtime-memory.json'),{publisher:{lastAttemptUtc:now},operationalSinkBroken:false,dataQuality:{state:'DEGRADED',rules:['REST coverage UNKNOWN_UNPROVEN']}});
 const db=new DatabaseSync(join(run,'poly2-comparison-capture/source_fence.sqlite'));db.exec('CREATE TABLE events(seq INTEGER PRIMARY KEY,body TEXT)');cleanup.push(()=>{try{db.close();}catch{/* fixture may explicitly close source */}});let previous:any=null;
 const emit=(kind:string,payload:any,at=now)=>{const e:any={seq:(previous?.seq??0)+1,previousSha256:previous?authorityDigest(previous):null,bindingSha256:authorityDigest(b),observedUtc:at,kind,payload};e.signedPayload=authenticatedBytes(e,b,a,'fence');e.signature=sign(null,Buffer.from(e.signedPayload),keys.privateKey).toString('base64');db.prepare('INSERT INTO events VALUES(?,?)').run(e.seq,JSON.stringify(e));previous=e;return e;};
 emit('ARM',b,'2026-10-16T23:30:00Z');for(const worker of b.expectedWorkers)emit('ENROLL',{worker,installation:a.installations[worker]},'2026-10-16T23:31:00Z');
 const trade=(over:any={})=>{const t={sourceRecordId:1,sourceEventId:`data-api:${tx}:${wallet}:7:BUY:1:0.5`,wallet,asset:'7',conditionId:null,side:'BUY',size:1,sourceTs,tradedAtUtc:'2026-10-17T00:40:00.000Z',ingestedUtc:'2026-10-17T00:40:03.000Z',...over};return {...t,clockEvidence:clockEvidence(t,['ingestedUtc','tradedAtUtc'])};};
 let attempt=0;const commit=(trades:any[])=>{const transactionId='txn-'+(++attempt);emit('ATTEMPT',{transactionId,worker:'bot:test',epoch:0,retryOf:null,admittedUtc:now});emit('COMMITTED',{transactionId,witness:{transactionId,worker:'bot:test',epoch:0,bindingSha256:authorityDigest(b),trades}});};
 const config={runDirectory:run,pointerPath,authorityPath,authorityPin:authorityDigest(a),approvalPath,approvalPin:createHash('sha256').update(readFileSync(approvalPath)).digest('hex')};
 const monitor=()=>{const m=new LiveMonitor(config,join(root,'cache'));cleanup.push(()=>m.close());return m;};
 const append=(o:any)=>appendFileSync(join(run,'shadow-data/source_observations.ndjson'),JSON.stringify(o)+'\n');
 return {root,run,db,monitor,commit,trade,append,emit,put,pointer,pointerPath,config,manifest};
}
it('v2 preserves matched timing, indeterminate uncertainty and frozen v1 history',()=>{
 const groups=buildShadowGroups([obs(),obs({identity:'other',groupKey:'econ:other:7:1.000000'})],cohort,window),data={window,rows:[row()]};
 const v1=compare(data,groups,window,cohort),v2=compareV2(data,groups,window,cohort);
 expect(v1.records.some(r=>r.match==='SHADOW_ONLY')).toBe(true);expect(v2.records.some(r=>r.match==='INDETERMINATE')).toBe(true);
 expect(v2.raw).toEqual(v1.raw);expect(v2.usable).toEqual(v1.usable);expect(v2.coverage.shadowUnionCoveragePct).toBeNull();
});
it('historical retrievals and unknown origin stay retained outside prospective latency',()=>{
 const old=sourceTs-86400;const v=compareV2({window,rows:[row({sourceTs:old})]},buildShadowGroups([obs({sourceTs:old})],cohort,window),window,cohort);
 expect(v.raw.n).toBe(0);expect(v.records).toHaveLength(0);expect(v.retrospectiveAndUnknown.map(r=>r.origin)).toEqual(['RETROSPECTIVE_RECOVERY','RETROSPECTIVE_RECOVERY']);
 const unknown=compareV2({window,rows:[row({sourceTs:null})]},new Map(),window,cohort);expect(unknown.retrospectiveAndUnknown[0]!.origin).toBe('ORIGIN_UNKNOWN');
});
it('same trade CHAIN+REST is one confirmed pair with exact source traces and delta',()=>{
 const f=fixture();f.append(obs());f.append(obs({source:'CHAIN',identity:'137:emitter:'+tx+':1:block',role:'TAKER_LEG'}));f.commit([f.trade()]);
 const m=f.monitor(),s=m.refresh(now) as any;expect(s.state,s.error).toBe('ACTIVE');expect(s.counts).toMatchObject({MATCHED_HIGH_CONFIDENCE:1,shadowDetections:1,poly2Detections:1});
 expect(s.recent[0]).toMatchObject({shadowSources:['CHAIN','REST_TRADES'],rawDeltaSec:2,poly2Ref:{seq:5,sourceRecordId:1},shadowRefs:[{journal:'source_observations.ndjson'},{journal:'source_observations.ndjson'}]});
 expect(s.mostRecentPairedUtc).toBe('2026-10-17T00:40:03.000Z');expect(s.viability.classification).toBe('PAIRED_EVIDENCE_CONFIRMED');
 const original=readFileSync(join(f.run,'shadow-data/source_observations.ndjson'));expect(m.refresh(now)).toEqual(s);expect(readFileSync(join(f.run,'shadow-data/source_observations.ndjson'))).toEqual(original);
});
it('same transaction multiple assets remains two trades; duplicate candidates revoke confirmation',()=>{
 const f=fixture();f.append(obs());f.append(obs({identity:'asset8',asset:'8',groupKey:'econ:'+tx+':8:1.000000'}));f.commit([f.trade(),f.trade({sourceRecordId:2,sourceEventId:`data-api:${tx}:${wallet}:8:BUY:1:0.5`,asset:'8'})]);const m=f.monitor();
 expect((m.refresh(now) as any).counts.MATCHED_HIGH_CONFIDENCE).toBe(2);
 f.commit([f.trade({sourceRecordId:3,sourceEventId:`data-api:${tx}:${wallet}:7:BUY:1:0.6`})]);const s=m.refresh(now) as any;
 expect(s.counts.MATCHED_HIGH_CONFIDENCE).toBe(1);expect(s.counts.AMBIGUOUS).toBe(2);
});
it('incomplete pagination and unrelated historical evidence do not invalidate valid prospective pairs',()=>{
 const f=fixture();f.append(obs());f.append(obs({identity:'unpaired',groupKey:'econ:unpaired:7:1.000000'}));f.append(obs({identity:'old',sourceTs:sourceTs-86400,groupKey:'econ:old:7:1.000000'}));f.commit([f.trade()]);
 const s=f.monitor().refresh(now) as any;expect(s.counts).toMatchObject({MATCHED_HIGH_CONFIDENCE:1,INDETERMINATE:1,RETROSPECTIVE_RECOVERY:1});expect(s.coverage).toBe('UNKNOWN_UNPROVEN');expect(s.viability.classification).toBe('PAIRED_EVIDENCE_CONFIRMED');
});
it('different transactions never become confirmed from market/wallet similarity; probable stays separate',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade({sourceEventId:'other-source:native-1'})]);const s=f.monitor().refresh(now) as any;
 expect(s.counts.MATCHED_HIGH_CONFIDENCE??0).toBe(0);expect(s.counts.MATCHED_PROBABLE).toBe(1);expect(s.recent[0].match).toBe('MATCHED_PROBABLE');
});
it('authorization revocation, missing approval and memory-validation paths fail closed',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade()]);const m=f.monitor();expect((m.refresh(now) as any).counts.MATCHED_HIGH_CONFIDENCE).toBe(1);
 f.put(f.pointerPath,{...f.pointer,lifecycleState:'INACTIVE'});expect(m.refresh(now)).toMatchObject({authorization:false,counts:null,state:'AUTHORIZATION_REVOKED_OR_INVALID'});
 f.put(f.pointerPath,f.pointer);f.put(join(f.run,'run-manifest.json'),{...f.manifest,evidenceBoundary:'MEMORY_VALIDATION_ONLY_NOT_SCIENTIFIC_COMPARISON'});expect(()=>f.monitor()).toThrow();
});
it('capture stale is explicit and zero overlap is advisory, never automatic failure/control',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade({sourceEventId:`data-api:other:${wallet}:7:BUY:1:0.5`})]);const m=f.monitor(),s=m.refresh(now) as any;
 expect(s.viability.classification).toBe('ACTIVE_NO_PAIRS_YET');expect(s.counts.MATCHED_HIGH_CONFIDENCE??0).toBe(0);
 expect((m.refresh('2026-10-17T00:50:00Z') as any).viability.classification).toBe('INSUFFICIENT_EVIDENCE');
 expect(checkpoint({authorized:true,blocked:false,healthy:true,elapsed:2400,shadow:0,poly2:0,high:0,txCapable:true,sharedTransactions:0}).classification).toBe('INSUFFICIENT_EVIDENCE');
});
it('size boundary matches the immutable matcher instead of a rounded-bucket false miss',()=>{
 const f=fixture();f.append(obs({size:'0.000004',groupKey:'econ:'+tx+':7:0.000004'}));f.commit([f.trade({size:.0000035})]);const s=f.monitor().refresh(now) as any;
 expect(s.counts,s.error).not.toBeNull();expect(s.counts.MATCHED_HIGH_CONFIDENCE).toBe(1);
});
it('midpoint routing preserves ambiguity when both neighboring canonical groups satisfy frozen tolerance',()=>{
 const f=fixture();f.append(obs({identity:'small',size:'0.000003',groupKey:'econ:'+tx+':7:0.000003'}));f.append(obs({identity:'large',size:'0.000004',groupKey:'econ:'+tx+':7:0.000004'}));f.commit([f.trade({size:.0000035})]);
 const s=f.monitor().refresh(now) as any;expect(s.counts,s.error).not.toBeNull();expect(s.counts.AMBIGUOUS).toBe(1);expect(s.counts.MATCHED_HIGH_CONFIDENCE??0).toBe(0);
});
it('late bridge evidence revokes old confirmations across bounded size components',()=>{
 const f=fixture();f.append(obs({identity:'small',size:'0.000003',groupKey:'econ:'+tx+':7:0.000003'}));f.append(obs({identity:'large',size:'0.000004',groupKey:'econ:'+tx+':7:0.000004'}));f.commit([f.trade({size:.000003})]);const m=f.monitor();expect((m.refresh(now) as any).counts.MATCHED_HIGH_CONFIDENCE).toBe(1);
 f.commit([f.trade({sourceRecordId:2,sourceEventId:'data-api:'+tx+':second',size:.0000035})]);const s=m.refresh(now) as any;expect(s.counts.MATCHED_HIGH_CONFIDENCE).toBe(0);expect(s.counts.AMBIGUOUS).toBe(2);
});
it('checkpoint is explicitly requested once and frozen separately from current advisory health',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade()]);const m=f.monitor();expect((m.refresh(now) as any).checkpoint.classification).toBe('NOT_REQUESTED');
 const first=m.refresh(now,true) as any;expect(first.checkpoint).toMatchObject({classification:'PAIRED_EVIDENCE_CONFIRMED',evaluatedUtc:now,readOnly:true,provisional:true});
 const later=m.refresh('2026-10-17T00:50:00Z',true) as any;expect(later.checkpoint).toEqual(first.checkpoint);expect(later.viability.classification).toBe('INSUFFICIENT_EVIDENCE');
});
it('missing capture is explicit, and authorization or memory-boundary changes revoke current display',()=>{
 const f=fixture();const m=f.monitor();f.db.close();rmSync(join(f.run,'poly2-comparison-capture/source_fence.sqlite'));
 expect(m.refresh(now)).toMatchObject({state:'CAPTURE_DISABLED_OR_UNAVAILABLE',counts:null});
 f.put(join(f.run,'shadow-data/EVIDENCE_BOUNDARY.json'),{evidenceBoundary:'MEMORY_VALIDATION_ONLY_NOT_SCIENTIFIC_COMPARISON'});
 expect(m.refresh(now)).toMatchObject({state:'AUTHORIZATION_REVOKED_OR_INVALID',authorization:false});
});
it.each(['future-completion','reverse-completion','future-capture','invalid-epoch'])('invalid %s evidence never produces a confirmed pair',kind=>{
 const f=fixture();f.append(obs(kind==='future-completion'?{completedUtc:'2026-10-17T01:00:00Z'}:kind==='reverse-completion'?{completedUtc:'2026-10-17T00:00:00Z'}:{}));
 if(kind==='invalid-epoch')f.emit('ATTEMPT',{transactionId:'wrong',worker:'bot:test',epoch:1,retryOf:null});
 else f.commit([f.trade(kind==='future-capture'?{ingestedUtc:'2026-10-17T01:00:00Z'}:{})]);
 const s=f.monitor().refresh(now) as any;expect(s.state).toBe('EVIDENCE_INVALID');expect(s.counts).toBeNull();
});
it('no observations on healthy enrolled systems remains insufficient, not a claimed capture failure',()=>{
 const f=fixture();f.commit([]);const s=f.monitor().refresh(now) as any;expect(s.state).toBe('ACTIVE');expect(s.viability).toMatchObject({classification:'INSUFFICIENT_EVIDENCE',reason:'NO_ELIGIBLE_ACTIVITY_OBSERVED'});
});
it('incremental restart retains offsets and counts without evidence mutation',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade()]);const m=f.monitor(),first=m.refresh(now) as any;m.close();cleanup.pop();
 const again=f.monitor().refresh(now) as any;expect(again.counts).toEqual(first.counts);expect(again.recent).toEqual(first.recent);
});

it('an out-of-time checkpoint request never poisons a later normal refresh',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade()]);const m=f.monitor();
 expect(m.refresh('2026-10-17T00:29:00Z',true)).toMatchObject({state:'CHECKPOINT_OUTSIDE_30_60_WINDOW'});
 expect(m.refresh('2026-10-17T01:01:00Z',true)).toMatchObject({state:'CHECKPOINT_OUTSIDE_30_60_WINDOW'});
 expect((m.refresh(now) as any).state).toBe('ACTIVE');
});
it('a hardlinked projection database cannot modify immutable capture evidence',()=>{
 const f=fixture();const file=join(f.run,'poly2-comparison-capture/source_fence.sqlite');const before=readFileSync(file);
 const cache=join(f.root,'cache');mkdirSync(cache,{mode:0o700});linkSync(file,join(cache,'live.sqlite'));
 expect(()=>f.monitor()).toThrow('single-link');expect(readFileSync(file)).toEqual(before);
});
it('bounded source backlog is visible and progresses without a whole-history refresh',()=>{
 const f=fixture();for(let i=0;i<2100;i++)f.append(obs({identity:'repeat-'+i}));f.commit([f.trade()]);const m=f.monitor();
 // Deliberately duplicated economic evidence exceeds the component work cap:
 // the diagnostic refuses counts instead of declaring a scientific failure.
 const s=m.refresh(now) as any;expect(s.state).toBe('MONITOR_RESOURCE_LIMIT');expect(s.counts).toBeNull();
 expect((m.refresh(now) as any).state).toBe('MONITOR_RESOURCE_LIMIT');
});
it('changed immutable evidence or a malformed authenticated transition never fabricates a pair',()=>{
 const f=fixture();f.append(obs());f.emit('ACK',{worker:'bot:test',epoch:1});const s=f.monitor().refresh(now) as any;
 expect(s.state).toBe('EVIDENCE_INVALID');expect(s.counts).toBeNull();
});

it('dangling SQLite sidecars are rejected without writing source evidence',()=>{
 const f=fixture();const cache=join(f.root,'cache');mkdirSync(cache,{mode:0o700});symlinkSync(join(f.root,'absent'),join(cache,'live.sqlite-journal'));
 expect(()=>f.monitor()).toThrow('sidecar');
});
it('existing Python status adapter publishes real persisted fixture matches without changing sources',()=>{
 const f=fixture();f.append(obs());f.commit([f.trade()]);const config=join(f.root,'config.json');f.put(config,f.config);
 const source=join(f.run,'shadow-data/source_observations.ndjson'),fence=join(f.run,'poly2-comparison-capture/source_fence.sqlite');
 const before=[readFileSync(source),readFileSync(fence)];
 const result=spawnSync('python3',['-B','-c',`import importlib.util,json,sys
from pathlib import Path
s=importlib.util.spec_from_file_location('live','scripts/status/live_match.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
original=m.subprocess.Popen
def launch(args,**kwargs):
 args[0]=sys.argv[5]
 return original(args,**kwargs)
m.subprocess.Popen=launch
print(json.dumps(m.refresh(Path(sys.argv[1]),Path(sys.argv[2]),sys.argv[3],Path(sys.argv[4]))))`,f.run,join(f.root,'publisher-cache'),now,config,process.execPath],{encoding:'utf8',timeout:15000});
 expect(result.status,result.stderr).toBe(0);const value=JSON.parse(result.stdout);expect(value.state).toBe('ACTIVE');expect(value.counts.MATCHED_HIGH_CONFIDENCE).toBe(1);
 expect(readFileSync(source)).toEqual(before[0]);expect(readFileSync(fence)).toEqual(before[1]);
});
