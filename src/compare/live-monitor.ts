/** Bounded private projection; never writes acquisition/capture evidence or scientific results. */
import {DatabaseSync} from 'node:sqlite';
import {openSync,readSync,closeSync,statSync,existsSync,mkdirSync,readFileSync,constants,fstatSync,lstatSync} from 'node:fs';
import {join,resolve,basename,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {approveV2,boundedJson,safePath} from './stage1-approval.js';
import {authorityCanonical,authorityDigest,loadAuthority,verifyAuthenticated,type ProductionAuthority,type ProductionBinding} from './production-authority.js';
import {buildShadowGroups,type Poly2ExportRow} from './phase4.js';
import {compareV2,COMPARATOR_VERSION} from './phase4-v2.js';
import {inWindow,epochMicros,clockEvidence} from './exact-clock.js';
import {WALLETS} from '../../research/v2-cursor-v1/adapter.js';
import type {SourceObservationRow} from '../shadow/racing.js';
export const LIMITS={bytes:2*1024*1024,line:128*1024,rows:2000,buckets:64,candidates:1024,records:250000,cacheBytes:512*1024*1024,recent:12};
const check=(ok:unknown,message:string):void=>{if(!ok)throw Error(message);};
const hash=(s:string|Buffer)=>createHash('sha256').update(s).digest('hex');
const parsed=(s:unknown)=>JSON.parse(String(s));
const candidateBuckets=(wallet:string,size:unknown)=>{
 const n=Number(size);check(Number.isFinite(n)&&Math.abs(n*1e6)<Number.MAX_SAFE_INTEGER,'Size candidate range unavailable');
 const center=Math.floor(n*1e6),values=new Set<string>();
 for(let i=center-1;i<=center+2;i++){const v=(i/1e6).toFixed(6);if(Math.abs(Number(v)-n)<5e-7)values.add(v);}
 return [...(values.size?values:new Set([n.toFixed(6)]))].map(v=>wallet.toLowerCase()+'|'+v);
};
export function unavailable(reason='COMPARISON_NOT_AUTHORIZED') {
 return {version:COMPARATOR_VERSION,provisional:true,certified:false,state:reason,authorization:false,coverage:'UNKNOWN_UNPROVEN',counts:null,recent:[],checkpoint:{classification:'CAPTURE_OR_IDENTITY_BLOCKED',reason}};
}
export function checkpoint(s:{authorized:boolean;blocked:boolean;healthy:boolean;elapsed:number;shadow:number;poly2:number;high:number;txCapable:boolean;sharedTransactions:number}) {
 if(!s.authorized||s.blocked||s.poly2>0&&!s.txCapable)return {classification:'CAPTURE_OR_IDENTITY_BLOCKED',reason:'Authorization, enrollment or authenticated trade identity unavailable'};
 if(s.elapsed<1800||!s.healthy||!s.shadow||!s.poly2)return {classification:'INSUFFICIENT_EVIDENCE',reason:s.elapsed<1800?'EARLY_BEFORE_30_MINUTES':!s.healthy?'STALE_REPLAY_OR_RETENTION_UNKNOWN':'NO_ELIGIBLE_ACTIVITY_OBSERVED'};
 if(s.high)return {classification:'PAIRED_EVIDENCE_CONFIRMED',reason:'Authenticated prospective high-confidence pairs exist'};
 return {classification:'ACTIVE_NO_PAIRS_YET',reason:s.sharedTransactions?'SHARED_TRANSACTIONS_WITHOUT_UNIQUE_COMPATIBLE_TRADES':'NO_OBSERVED_OVERLAPPING_OPPORTUNITY'};
}
export interface MonitorConfig {runDirectory:string;pointerPath:string;approvalPath:string;approvalPin:string;authorityPath:string;authorityPin:string}
export class LiveMonitor {
 private config:MonitorConfig;private db:DatabaseSync;private m:any;private b:ProductionBinding;private a:ProductionAuthority;private run:string;private cacheFile:string;private cohort:(w:string)=>'CONTROLLED_OVERLAP'|null;
 constructor(config:MonitorConfig,cacheDirectory:string){
  this.config=config;this.run=safePath(config.runDirectory);check(basename(dirname(this.run))==='runs'&&/^phase4-[A-Za-z0-9_-]+$/.test(basename(this.run)),'Scientific run directory required');
  const manifest=boundedJson(join(this.run,'run-manifest.json')),pointer=boundedJson(config.pointerPath);
  check(manifest.state==='SEALED_NOT_STARTED'&&manifest.durationSeconds===86400&&manifest.experimentDirectory===this.run&&!manifest.evidenceBoundary&&!existsSync(join(this.run,'INVALID'))&&!existsSync(join(this.run,'shadow-data/EVIDENCE_BOUNDARY.json')),'Invalid or memory-only run');
  check(pointer.lifecycleState==='AUTHORIZED'&&pointer.runDirectory===this.run&&pointer.runId===basename(this.run)&&pointer.approvedShadowSha===manifest.shadowSha&&authorityCanonical({startUtc:pointer.startUtc,endUtc:pointer.endUtc})===authorityCanonical(manifest.window),'Comparison not authorized');
  const external=loadAuthority(config.authorityPath,config.authorityPin);this.a=external.authority;this.b=this.a.binding;
  check(this.b.shadowRunId===basename(this.run)&&this.b.shadowCodeSha===manifest.shadowSha&&authorityCanonical(this.b.window)===authorityCanonical(manifest.window)&&authorityCanonical([...this.b.cohort].sort())===authorityCanonical([...WALLETS].sort())&&this.b.expectedWorkers.length<=32,'Capture/run/cohort binding mismatch');
  check(manifest.productionAuthority?.sha256===config.authorityPin,'Launch authority pin mismatch');
  approveV2(config.approvalPath,config.approvalPin,{runId:basename(this.run),shadowSha:manifest.shadowSha,window:this.b.window,cohort:this.b.cohort});
  const cache=resolve(cacheDirectory);check(cache!==this.run&&!cache.startsWith(this.run+'/')&&!cache.split('/').includes('runs'),'Projection must be outside immutable evidence');
  mkdirSync(cache,{recursive:true,mode:0o700});safePath(cache);check((statSync(cache).mode&0o022)===0,'Private projection directory required');const file=join(cache,'live.sqlite');if(existsSync(file)){safePath(file);const st=statSync(file);check(st.isFile()&&st.nlink===1&&st.size<=LIMITS.cacheBytes,'Private single-link projection file required');}else{const fd=openSync(file,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);closeSync(fd);}
  for(const suffix of ['-journal','-wal','-shm']){const st=lstatSync(file+suffix,{throwIfNoEntry:false});if(st){check(!st.isSymbolicLink()&&st.isFile()&&st.nlink===1,'Unsafe projection sidecar');safePath(file+suffix);}}
  this.cacheFile=file;this.db=new DatabaseSync(file);this.db.exec(`PRAGMA cache_size=-2048; PRAGMA busy_timeout=100; PRAGMA journal_mode=DELETE; PRAGMA max_page_count=65536;
   CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY,body TEXT);
   CREATE TABLE IF NOT EXISTS shadow(id TEXT PRIMARY KEY,bucket TEXT,body TEXT,ref TEXT); CREATE INDEX IF NOT EXISTS shadow_bucket ON shadow(bucket); CREATE TABLE IF NOT EXISTS group_owner(id TEXT PRIMARY KEY,bucket TEXT); CREATE INDEX IF NOT EXISTS owner_bucket ON group_owner(bucket); CREATE TABLE IF NOT EXISTS aliases(id TEXT PRIMARY KEY,component TEXT); CREATE INDEX IF NOT EXISTS alias_component ON aliases(component);
   CREATE TABLE IF NOT EXISTS poly2(id TEXT PRIMARY KEY,bucket TEXT,body TEXT,ref TEXT); CREATE INDEX IF NOT EXISTS poly2_bucket ON poly2(bucket); CREATE UNIQUE INDEX IF NOT EXISTS poly2_event ON poly2(json_extract(body,'$.sourceEventId'));
   CREATE TABLE IF NOT EXISTS attempts(id TEXT PRIMARY KEY,body TEXT);
   CREATE TABLE IF NOT EXISTS pending(bucket TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS bucket_stats(bucket TEXT PRIMARY KEY,body TEXT);
   CREATE TABLE IF NOT EXISTS results(id TEXT PRIMARY KEY,bucket TEXT,kind TEXT,at INTEGER,body TEXT); CREATE INDEX IF NOT EXISTS recent_results ON results(kind,at DESC);
   CREATE INDEX IF NOT EXISTS result_bucket ON results(bucket);
   CREATE TABLE IF NOT EXISTS counts(kind TEXT PRIMARY KEY,n INTEGER);
   CREATE TRIGGER IF NOT EXISTS result_add AFTER INSERT ON results BEGIN INSERT INTO counts VALUES(new.kind,1) ON CONFLICT(kind) DO UPDATE SET n=n+1; END;
   CREATE TRIGGER IF NOT EXISTS result_del AFTER DELETE ON results BEGIN UPDATE counts SET n=n-1 WHERE kind=old.kind; END;`);
  const binding=authorityDigest({config,version:COMPARATOR_VERSION});const prior=this.db.prepare('SELECT body FROM meta WHERE id=1').get();
  this.m=prior?parsed(prior.body):{binding,offset:0,seq:0,previous:null,enrolled:[],shadowCount:0,poly2Count:0,attemptCount:0,shadowOriginCount:0,poly2OriginCount:0,txCapable:0,lastCapture:null,lastShadow:null,error:null,epoch:0,closed:false};
  check(this.m.binding===binding,'Projection bound to a different run/config; use a new private cache');this.cohort=w=>this.b.cohort.includes(w.toLowerCase())?'CONTROLLED_OVERLAP':null;
 }
 private revalidate(){
  const c=this.config,p=boundedJson(c.pointerPath),m=boundedJson(join(this.run,'run-manifest.json'));
  check(p.lifecycleState==='AUTHORIZED'&&p.runDirectory===this.run&&p.runId===this.b.shadowRunId&&p.approvedShadowSha===this.b.shadowCodeSha&&authorityCanonical({startUtc:p.startUtc,endUtc:p.endUtc})===authorityCanonical(this.b.window)&&!existsSync(join(this.run,'INVALID'))&&!existsSync(join(this.run,'shadow-data/EVIDENCE_BOUNDARY.json'))&&!m.evidenceBoundary,'Authorization revoked');
  check(m.state==='SEALED_NOT_STARTED'&&m.experimentDirectory===this.run&&m.shadowSha===this.b.shadowCodeSha&&m.productionAuthority?.sha256===c.authorityPin&&authorityCanonical(m.window)===authorityCanonical(this.b.window),'Manifest binding changed');
  const cohorts=boundedJson(join(this.run,'cohorts.json'));check(authorityCanonical(cohorts.window)===authorityCanonical(this.b.window)&&authorityCanonical(cohorts.controlled)===authorityCanonical(this.b.cohort)&&Array.isArray(cohorts.exploratory)&&cohorts.exploratory.length===0,'Frozen cohort changed');
  const a=loadAuthority(c.authorityPath,c.authorityPin);check(authorityCanonical(a.authority)===authorityCanonical(this.a),'Authority changed');
  approveV2(c.approvalPath,c.approvalPin,{runId:this.b.shadowRunId,shadowSha:this.b.shadowCodeSha,window:this.b.window,cohort:this.b.cohort});
 }
 close(){this.db.close();}
 private key(wallet:string,size:unknown){
  const bases=candidateBuckets(wallet,size);
  for(const base of bases)this.db.prepare('INSERT OR IGNORE INTO aliases VALUES(?,?)').run(base,base);
  const components=[...new Set(bases.map(base=>String(this.db.prepare('SELECT component FROM aliases WHERE id=?').get(base)!.component)))].sort();
  const target=components[0]!;
  if(components.length>1){
   let members=0;
   for(const key of components){
    const n=Number(this.db.prepare('SELECT count(*) AS n FROM aliases WHERE component=?').get(key)!.n);members+=n;
    for(const table of ['shadow','poly2'])check(Number(this.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE bucket=?`).get(key)!.n)<=LIMITS.candidates,'Matching component bound');
   }
   check(members<=LIMITS.candidates,'Matching component alias bound');
   for(const key of components){this.dirty(key);this.db.prepare('DELETE FROM pending WHERE bucket=?').run(key);if(key!==target){
    for(const table of ['shadow','poly2','group_owner'])this.db.prepare(`UPDATE ${table} SET bucket=? WHERE bucket=?`).run(target,key);
    this.db.prepare('UPDATE aliases SET component=? WHERE component=?').run(target,key);
   }}
   this.db.prepare('INSERT OR IGNORE INTO pending VALUES(?)').run(target);
  }
  return target;
 }
 private dirty(key:string){this.stats(key,null);this.db.prepare('DELETE FROM results WHERE bucket=?').run(key);this.db.prepare('INSERT OR IGNORE INTO pending VALUES(?)').run(key);}
 private stats(key:string,values:Record<string,number>|null){
  const prior=this.db.prepare('SELECT body FROM bucket_stats WHERE bucket=?').get(key);const old=prior?parsed(prior.body):{};
  for(const [kind,n] of Object.entries(old))this.db.prepare('UPDATE counts SET n=n-? WHERE kind=?').run(Number(n),kind);
  this.db.prepare('DELETE FROM bucket_stats WHERE bucket=?').run(key);
  if(values){for(const [kind,n] of Object.entries(values))this.db.prepare('INSERT INTO counts VALUES(?,?) ON CONFLICT(kind) DO UPDATE SET n=n+excluded.n').run(kind,n);this.db.prepare('INSERT INTO bucket_stats VALUES(?,?)').run(key,JSON.stringify(values));}
 }
 private insert(system:'shadow'|'poly2',id:string,key:string,body:unknown,ref:unknown){
  const json=JSON.stringify(body),old=this.db.prepare(`SELECT body FROM ${system} WHERE id=?`).get(id);
  if(old){check(old.body===json,'Conflicting immutable source identity');return;}
  check(this.m[system+'Count']<LIMITS.records,'Monitor source-record bound');this.db.prepare(`INSERT INTO ${system} VALUES(?,?,?,?)`).run(id,key,json,JSON.stringify(ref));this.m[system+'Count']++;this.dirty(key);
 }
 private shadow(nowUtc:string){
  const path=join(this.run,'shadow-data/source_observations.ndjson');safePath(path);const stat=statSync(path);check(stat.isFile()&&stat.size>=this.m.offset,'Shadow evidence truncated');
  const identity=stat.dev+':'+stat.ino;check(!this.m.fileIdentity||identity===this.m.fileIdentity,'Shadow evidence replaced');this.m.fileIdentity=identity;
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{check(fstatSync(fd).dev===stat.dev&&fstatSync(fd).ino===stat.ino,'Shadow file changed before read');
   if(this.m.anchor){const b=Buffer.alloc(this.m.anchor.length);check(readSync(fd,b,0,b.length,this.m.anchor.offset)===b.length&&hash(b)===this.m.anchor.hash,'Shadow immutable boundary changed');}
   const bytes=Buffer.alloc(Math.min(LIMITS.bytes,stat.size-this.m.offset));readSync(fd,bytes,0,bytes.length,this.m.offset);
   let from=0,n=0;while(n<LIMITS.rows){const end=bytes.indexOf(10,from);if(end<0)break;check(end-from<=LIMITS.line,'Shadow row bound');const raw=bytes.subarray(from,end),o=JSON.parse(raw.toString('utf8')) as SourceObservationRow;
    if(this.cohort(o.wallet)==='CONTROLLED_OVERLAP'&&inWindow(o.sourceFirstSeenUtc,this.b.window)){
     check(['CHAIN','REST_TRADES','REST_ACTIVITY'].includes(o.source)&&typeof o.identity==='string'&&typeof o.groupKey==='string'&&typeof o.size==='string'&&Number.isFinite(Number(o.size)),'Malformed Shadow identity');check(epochMicros(o.completedUtc)>=epochMicros(o.sourceFirstSeenUtc)&&epochMicros(o.completedUtc)<=epochMicros(nowUtc),'Invalid completion clock');check(epochMicros(o.sourceFirstSeenUtc)<=epochMicros(nowUtc)&&Number(o.size).toFixed(6)===o.size,'Future or noncanonical Shadow evidence');
     const owner=this.db.prepare('SELECT bucket FROM group_owner WHERE id=?').get(o.groupKey);const key=owner?String(owner.bucket):this.key(o.wallet,o.size);
     if(!owner)this.db.prepare('INSERT INTO group_owner VALUES(?,?)').run(o.groupKey,key);
     this.insert('shadow',o.source+':'+o.identity,key,o,{journal:'source_observations.ndjson',offset:this.m.offset+from,sha256:hash(raw),identity:o.identity,source:o.source});
     if(!this.m.lastShadow||epochMicros(o.sourceFirstSeenUtc)>epochMicros(this.m.lastShadow))this.m.lastShadow=o.sourceFirstSeenUtc;
    }
    from=end+1;n++;
   }
   check(bytes.length-from<LIMITS.line||n===LIMITS.rows,'Oversized or unframed Shadow row');
   if(from){this.m.anchor={offset:this.m.offset+Math.max(0,from-4096),length:Math.min(from,4096),hash:hash(bytes.subarray(Math.max(0,from-4096),from))};this.m.offset+=from;}
   return this.m.offset<stat.size;
  }finally{closeSync(fd);}
 }
 private fence(nowUtc:string){
  const path=join(this.run,'poly2-comparison-capture/source_fence.sqlite');safePath(path);const source=new DatabaseSync(path,{readOnly:true});source.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=100;');
  try{
   if(this.m.seq){const prior=source.prepare('SELECT CASE WHEN length(CAST(body AS BLOB))<=? THEN body ELSE NULL END AS body FROM events WHERE seq=?').get(LIMITS.line,this.m.seq);check(prior?.body&&authorityDigest(parsed(prior.body))===this.m.previous,'Capture cursor replaced or truncated');}
   if(this.m.closed)return false;
   let bytes=0,n=0;
   for(const row of source.prepare('SELECT seq,CASE WHEN length(CAST(body AS BLOB))<=? THEN body ELSE NULL END AS body FROM events WHERE seq>? ORDER BY seq LIMIT ?').iterate(LIMITS.line,this.m.seq,LIMITS.rows)){
    check(typeof row.body==='string','Capture frame bound');bytes+=Buffer.byteLength(String(row.body));if(bytes>LIMITS.bytes)break;
    const e=parsed(row.body);verifyAuthenticated(e,this.b,this.a,'fence');
    check(e.seq===this.m.seq+1&&e.seq===Number(row.seq)&&e.previousSha256===this.m.previous&&e.bindingSha256===authorityDigest(this.b),'Capture sequence/binding gap');check(epochMicros(e.observedUtc)<=epochMicros(nowUtc),'Future capture receipt');
    const p=e.payload;
    if(e.seq===1)check(e.kind==='ARM'&&authorityCanonical(p)===authorityCanonical(this.b)&&epochMicros(e.observedUtc)<epochMicros(this.b.window.startUtc),'Capture ARM invalid');
    else if(e.kind==='ENROLL'){
     check(this.b.expectedWorkers.includes(p.worker)&&!this.m.enrolled.includes(p.worker)&&authorityCanonical(p.installation)===authorityCanonical(this.a.installations[p.worker])&&epochMicros(e.observedUtc)<epochMicros(this.b.window.startUtc),'Capture enrollment invalid');this.m.enrolled.push(p.worker);
    }else if(e.kind==='ATTEMPT'){
     check(p.epoch===0&&this.m.epoch===0&&typeof p.transactionId==='string'&&this.m.enrolled.length===this.b.expectedWorkers.length&&this.m.enrolled.includes(p.worker)&&!this.db.prepare('SELECT 1 FROM attempts WHERE id=?').get(p.transactionId)&&this.m.attemptCount<LIMITS.records,'Capture admission invalid');
     if(p.retryOf!==null){const prior=this.db.prepare('SELECT body FROM attempts WHERE id=?').get(p.retryOf);check(prior&&parsed(prior.body).terminal==='ROLLED_BACK','Capture retry outcome unknown');}
     this.db.prepare('INSERT INTO attempts VALUES(?,?)').run(p.transactionId,JSON.stringify(p));this.m.attemptCount++;
    }else if(e.kind==='COMMITTED'||e.kind==='ROLLED_BACK'){
     const row=this.db.prepare('SELECT body FROM attempts WHERE id=?').get(p.transactionId);check(row,'Unregistered capture commit');const attempt=parsed(row!.body);check(!attempt.terminal,'Duplicate capture terminal');
     if(e.kind==='COMMITTED'){
      const w=p.witness;check(w&&w.transactionId===p.transactionId&&w.worker===attempt.worker&&w.epoch===attempt.epoch&&w.bindingSha256===authorityDigest(this.b)&&Array.isArray(w.trades)&&w.trades.length<=LIMITS.candidates,'Commit witness mismatch/bound');
      check(new Set(w.trades.map((t:any)=>authorityCanonical(t.sourceRecordId))).size===w.trades.length&&new Set(w.trades.map((t:any)=>t.sourceEventId)).size===w.trades.length,'Duplicate witness identities');
      for(const t of w.trades){
       check(t.clockEvidence&&authorityCanonical(t.clockEvidence)===authorityCanonical(clockEvidence(t,['ingestedUtc','tradedAtUtc'])),'Original capture clock evidence missing');
       check(epochMicros(t.ingestedUtc)<=epochMicros(e.observedUtc),'Future original ingestion relative to commit visibility');
       if(!this.b.cohort.includes(t.wallet)||!inWindow(t.ingestedUtc,this.b.window))continue;
       check(typeof t.sourceEventId==='string'&&t.sourceEventId&&t.sourceRecordId!=null&&t.size!=null&&Number.isFinite(t.size),'Capture identity unavailable');
       const parts=t.sourceEventId.split(':'),tx=parts[0]==='data-api'?parts[1]??null:null;
       const r:Poly2ExportRow&{sourceEventId:string;sourceRecordId:unknown}={wallet:t.wallet,txHash:tx,asset:t.asset,conditionId:t.conditionId,side:t.side,size:t.size,price:null,sourceTs:t.sourceTs,tradedAtUtc:t.tradedAtUtc,ingestedUtc:t.ingestedUtc,normalizedUtc:null,decisionUtc:null,signalUtc:null,source:parts[0],freshnessAgeSec:null,freshnessRejection:null,policyEligible:null,copyabilityOutcome:null,rejectionReason:null,paperOutcome:null,sourceEventId:t.sourceEventId,sourceRecordId:t.sourceRecordId};
       check(!this.db.prepare('SELECT 1 FROM poly2 WHERE id=?').get(String(t.sourceRecordId)),'Duplicate source commit identity');
       this.insert('poly2',String(t.sourceRecordId),this.key(t.wallet,t.size),r,{journal:'source_fence.sqlite/events',seq:e.seq,sha256:authorityDigest(e),sourceRecordId:t.sourceRecordId,sourceEventId:t.sourceEventId});
      }
     }
     attempt.terminal=e.kind;this.db.prepare('UPDATE attempts SET body=? WHERE id=?').run(JSON.stringify(attempt),p.transactionId);
    }else if(e.kind==='CLOSE'){check(!this.m.closed&&authorityCanonical(p)===authorityCanonical({closingEpoch:0,nextEpoch:1})&&epochMicros(e.observedUtc)>epochMicros(this.b.window.endUtc),'Capture close transition invalid');this.m.closed=true;this.m.epoch=1;}
    else throw Error('Unsupported/invalid live capture transition: '+e.kind);
    if(e.kind==='ERROR')throw Error('Capture reported ERROR');
    this.m.seq=e.seq;this.m.previous=authorityDigest(e);this.m.lastCapture=e.observedUtc;n++;if(this.m.closed)break;
   }
   return !this.m.closed&&!!source.prepare('SELECT 1 FROM events WHERE seq>? LIMIT 1').get(this.m.seq);
  }finally{source.close();}
 }
 private reconcile(){
  const pending=[...this.db.prepare('SELECT bucket FROM pending ORDER BY bucket LIMIT ?').iterate(LIMITS.buckets)];
  for(const pendingRow of pending){const key=String(pendingRow.bucket);
   const s=[...this.db.prepare('SELECT body,ref FROM shadow WHERE bucket=? ORDER BY rowid LIMIT ?').iterate(key,LIMITS.candidates+1)];
   const p=[...this.db.prepare('SELECT body,ref FROM poly2 WHERE bucket=? ORDER BY rowid LIMIT ?').iterate(key,LIMITS.candidates+1)];
   check(s.length<=LIMITS.candidates&&p.length<=LIMITS.candidates,'Candidate ambiguity work bound');
   const obs=s.map(r=>parsed(r.body)),rows=p.map(r=>parsed(r.body));const groups=buildShadowGroups(obs,this.cohort,this.b.window);const result=compareV2({window:this.b.window,rows},groups,this.b.window,this.cohort);
   const excludedShadow=new Set(result.retrospectiveAndUnknown.filter(r=>r.system==='SHADOW').map(r=>r.identity));
   const excludedPoly=new Set(result.retrospectiveAndUnknown.filter(r=>r.system==='POLY2').map(r=>r.identity));
   const prospectiveGroups=[...groups.values()].filter(g=>!excludedShadow.has(g.groupKey)),prospectiveRows=rows.filter(r=>!excludedPoly.has(r.sourceEventId));
   const stx=new Set(prospectiveGroups.map(g=>g.tx).filter(Boolean));
   this.stats(key,{shadowDetections:prospectiveGroups.length,poly2Detections:prospectiveRows.length,transactionIdentities:prospectiveRows.filter(r=>!!r.txHash).length,sharedTransactionCandidates:prospectiveRows.filter(r=>stx.has(r.txHash)).length});
   let i=0;
   for(const r of result.records){
    const id=key+':'+i++,source=r.groupKey&&!r.groupKey.includes('|')?groups.get(r.groupKey):null;
    const polyId=r.poly2Index==null?null:result.rowIdentities[r.poly2Index];
    const poly=polyId==null?null:p.find(v=>parsed(v.body).sourceEventId===polyId);
    const shadowRefs=source?s.filter(v=>parsed(v.body).groupKey===source.groupKey).map(v=>parsed(v.ref)):[];
    const pairedDetectionUtc=r.shadowRawUtc&&r.poly2RawUtc?(epochMicros(r.shadowRawUtc)>epochMicros(r.poly2RawUtc)?r.shadowRawUtc:r.poly2RawUtc):null;
    const record={...r,pairedDetectionUtc,walletAlias:'Wallet '+(this.b.cohort.indexOf(r.wallet?.toLowerCase()??'')+1),poly2Ref:poly?parsed(poly.ref):null,shadowRefs:shadowRefs.slice(0,8),shadowRefsTruncated:shadowRefs.length>8};
    this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(id,key,r.match,pairedDetectionUtc||r.timeUtc?epochMicros(pairedDetectionUtc??r.timeUtc!):null,JSON.stringify(record));
   }
   for(const r of result.retrospectiveAndUnknown)this.db.prepare('INSERT INTO results VALUES(?,?,?,?,?)').run(key+':'+i++,key,r.origin,null,JSON.stringify(r));
   this.db.prepare('DELETE FROM pending WHERE bucket=?').run(key);
  }
 }
 refresh(nowUtc=new Date().toISOString(),assess=false) {
  try{this.revalidate();}catch(error){return {...unavailable('AUTHORIZATION_REVOKED_OR_INVALID'),error:String(error).slice(0,200)};}
  const assessmentAge=Number(epochMicros(nowUtc)-epochMicros(this.b.window.startUtc))/1e6;
  if(assess&&!this.m.checkpoint&&(assessmentAge<1800||assessmentAge>3600))return {...unavailable('CHECKPOINT_OUTSIDE_30_60_WINDOW'),authorization:true,generatedUtc:nowUtc};
  if(this.m.error)return {...unavailable('EVIDENCE_INVALID'),authorization:true,error:this.m.error};
  if(epochMicros(nowUtc)<epochMicros(this.b.window.startUtc))return {...unavailable('NOT_STARTED'),authorization:true,generatedUtc:nowUtc};
  if(!existsSync(join(this.run,'poly2-comparison-capture/source_fence.sqlite')))return {...unavailable('CAPTURE_DISABLED_OR_UNAVAILABLE'),authorization:true,generatedUtc:nowUtc};
  if(!existsSync(join(this.run,'shadow-data/source_observations.ndjson'))||!existsSync(join(this.run,'shadow-data/runtime-memory.json')))return {...unavailable('WAITING_FOR_SHADOW_EVIDENCE'),authorization:true,generatedUtc:nowUtc};
  check(statSync(this.cacheFile).nlink===1&&statSync(this.cacheFile).size<=LIMITS.cacheBytes,'Projection size/link bound');
  const before=JSON.parse(JSON.stringify(this.m));let transaction=false;
  try{this.db.exec('BEGIN IMMEDIATE');transaction=true;
   const shadowBacklog=this.shadow(nowUtc),captureBacklog=this.fence(nowUtc);this.reconcile();
   const counts=Object.fromEntries([...this.db.prepare('SELECT kind,n FROM counts').iterate()].map(r=>[String(r.kind),Number(r.n)]));
   const recent=['MATCHED_HIGH_CONFIDENCE','MATCHED_PROBABLE','AMBIGUOUS','INDETERMINATE'].flatMap(kind=>[...this.db.prepare('SELECT body FROM results WHERE kind=? ORDER BY at DESC LIMIT ?').iterate(kind,LIMITS.recent)].map(r=>parsed(r.body))).sort((a,b)=>Number(epochMicros(b.pairedDetectionUtc??b.timeUtc??'1970-01-01T00:00:00Z')-epochMicros(a.pairedDetectionUtc??a.timeUtc??'1970-01-01T00:00:00Z'))).slice(0,LIMITS.recent);
   const latestRow=this.db.prepare("SELECT body FROM results WHERE kind='MATCHED_HIGH_CONFIDENCE' ORDER BY at DESC LIMIT 1").get();const latest=latestRow?parsed(latestRow.body).pairedDetectionUtc:null;
   const replaying=shadowBacklog||captureBacklog||!!this.db.prepare('SELECT 1 FROM pending LIMIT 1').get();
   const runtime=boundedJson(join(this.run,'shadow-data/runtime-memory.json'));
   const runtimeUtc=runtime.publisher?.lastAttemptUtc??null;
   const age=(t:string|null)=>t?(Number(epochMicros(nowUtc)-epochMicros(t))/1e6):null;
   const captureAge=age(this.m.lastCapture),acquisitionAge=age(runtimeUtc);
   const retentionHealthy=runtime.operationalSinkBroken===false&&['GREEN','DEGRADED'].includes(runtime.dataQuality?.state);
   const ended=epochMicros(nowUtc)>=epochMicros(this.b.window.endUtc);
   const healthy=!ended&&!this.m.closed&&!replaying&&retentionHealthy&&captureAge!=null&&captureAge>=0&&captureAge<=180&&acquisitionAge!=null&&acquisitionAge>=0&&acquisitionAge<=30;
   const enrolled=this.m.enrolled.length===this.b.expectedWorkers.length;

   // Counts are event-level matcher records; no source-lane double counting.
   const high=counts.MATCHED_HIGH_CONFIDENCE??0;
   const txCapable=(counts.transactionIdentities??0)>0;
   const snapshot={version:COMPARATOR_VERSION,provisional:true,certified:false,authorization:true,generatedUtc:nowUtc,runId:basename(this.run),window:this.b.window,
    state:ended||this.m.closed?'WINDOW_ENDED_FINAL_ARCHIVE_REQUIRED':replaying?'REPLAYING':!enrolled?'CAPTURE_NOT_ENROLLED':healthy?'ACTIVE':'STALE_OR_UNHEALTHY',coverage:'UNKNOWN_UNPROVEN',
    counts:{...counts,shadowSourceRecords:this.m.shadowCount,poly2CaptureRecords:this.m.poly2Count,shadowDetections:counts.shadowDetections??0,poly2Detections:counts.poly2Detections??0},
    mostRecentPairedUtc:latest,recent,acquisitionFreshness:{ageSeconds:acquisitionAge,latestObservationUtc:this.m.lastShadow},captureFreshness:{ageSeconds:captureAge,enrolled},retentionHealthy,replaying,
    viability:checkpoint({authorized:true,blocked:!enrolled,healthy,elapsed:Number(epochMicros(nowUtc)-epochMicros(this.b.window.startUtc))/1e6,shadow:counts.shadowDetections??0,poly2:counts.poly2Detections??0,high,txCapable,sharedTransactions:counts.sharedTransactionCandidates??0}),
    bounds:LIMITS};
   if(assess&&!this.m.checkpoint){const elapsed=Number(epochMicros(nowUtc)-epochMicros(this.b.window.startUtc))/1e6;check(elapsed>=1800&&elapsed<=3600,'One-time checkpoint requires 30–60 minutes actual operation');this.m.checkpoint={...snapshot.viability,evaluatedUtc:nowUtc,elapsedSeconds:elapsed,provisional:true,readOnly:true,counts:snapshot.counts,mostRecentPairedUtc:snapshot.mostRecentPairedUtc,sourceOffsets:{shadow:this.m.offset,fence:this.m.seq},authorityPin:this.config.authorityPin,approvalPin:this.config.approvalPin};}
   Object.assign(snapshot,{checkpoint:this.m.checkpoint??{classification:'NOT_REQUESTED',reason:'Run explicit one-time checkpoint at 30–60 minutes'}});
   this.db.prepare('INSERT OR REPLACE INTO meta VALUES(1,?)').run(JSON.stringify(this.m));this.db.exec('COMMIT');return snapshot;
  }catch(error){if(transaction)this.db.exec('ROLLBACK');this.m=before;
   const e=error as {code?:string;errcode?:number;message?:string};
   if(e.code==='ENOENT'||[5,6].includes(e.errcode??0)||/database is (?:locked|busy)/i.test(e.message??''))return {...unavailable('MONITOR_UNAVAILABLE'),authorization:true,generatedUtc:nowUtc};
   if(/bound|limit/i.test(e.message??''))return {...unavailable('MONITOR_RESOURCE_LIMIT'),authorization:true,generatedUtc:nowUtc,error:String(error).slice(0,200)};
   this.m.error=String(error).slice(0,256);this.db.prepare('INSERT OR REPLACE INTO meta VALUES(1,?)').run(JSON.stringify(this.m));return {...unavailable('EVIDENCE_INVALID'),authorization:true,error:this.m.error};}
 }
}
