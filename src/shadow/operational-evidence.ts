/** Append-only operational evidence with a disposable, self-validating index.
 * NDJSON remains authoritative. The SQLite file is cache state only: startup
 * validates it, and any missing/corrupt/stale/cache-semantic mismatch causes a
 * full streaming rebuild before the instance becomes usable. */
import { appendFileSync, existsSync, mkdirSync, rmSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { streamRows } from './stream.js';

export type RpcReason='live_subscription_verification'|'backfill'|'verifier'|'reconnect_recovery'|'block_metadata_lookup'|'other';
export type ErrorClass='TIMEOUT'|'HTTP_503'|'HTTP_429'|'HTTP_FAILURE'|'RPC_ERROR'|'INDEX_ERROR'|'PUBLICATION_ERROR'|'MALFORMED_PAYLOAD'|'OTHER';
export interface RpcLineageRow {schemaVersion:2;recordType:'RPC_REQUEST';requestId:string;family:string;method:string;params:unknown[];component:string;reason:RpcReason;attempt:number;retryParentRequestId:string|null;requestUtc:string;timeoutDeadlineUtc:string|null;completionUtc:string;httpStatus:number|null;success:boolean;errorClass:ErrorClass|null;error:string|null;requestedRange:{fromBlock:number;toBlock:number}|null;responseRange:{fromBlock:number;toBlock:number}|null;responseBlock:number|null;resultCount:number|null}
export interface QuarantineEvidenceRow {pollId?:string;schemaVersion:2;quarantineId:string;timestampUtc:string;component:string;source:string|null;sourceIdentity:string|null;rawEvidenceRef:string|null;rpcRequestId:string|null;errorClass:ErrorClass;reason:string;eventIdentityKnown:boolean;wallet:string|null;txHash:string|null;logIdentity:string|null;affectedRange:{fromBlock:number;toBlock:number}|null;recoveryState:'UNRESOLVED'|'RECOVERED'|'TERMINAL';retryCount:number;latestRetryUtc:string|null;scientificImpactPossible:boolean}
export interface RpcRequestInput {family:string;method:string;params:unknown[];component:string;reason:RpcReason;attempt:number;retryParentRequestId:string|null;timeoutMs?:number}
export type IndexFaultPoint='before-authoritative-append'|'after-authoritative-append'|'after-derived-row';
export interface OperationalEvidenceOptions {
 /** Inject the actual authoritative write, independently of derived-index faults.
  * A test may throw before writing or append a partial byte prefix then throw.
  * Production always uses appendFileSync; a failed write is never retried here. */
 write?:(path:string,serialized:string,name:string)=>void;
 fault?:(point:IndexFaultPoint,name:string,row:Record<string,unknown>)=>void;
}
const files=['rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson','rest_poll_receipts.ndjson','runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson','rpc_publications.ndjson'] as const;
const schema=7;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const classify=(e:unknown):ErrorClass=>{const m=String(e).toLowerCase();return m.includes('timeout')||m.includes('abort')?'TIMEOUT':m.includes('503')?'HTTP_503':m.includes('429')?'HTTP_429':m.includes('index')?'INDEX_ERROR':m.includes('publish')?'PUBLICATION_ERROR':m.includes('malformed')||m.includes('parse')?'MALFORMED_PAYLOAD':m.includes('rpc')?'RPC_ERROR':m.includes('http')?'HTTP_FAILURE':'OTHER'};
const rangeFrom=(method:string,params:unknown[])=>{if(method!=='eth_getLogs')return null;const f=params[0] as Record<string,unknown>|undefined;const n=(v:unknown)=>typeof v==='string'&&/^0x[0-9a-f]+$/i.test(v)?parseInt(v,16):null;const a=n(f?.fromBlock),b=n(f?.toBlock);return a!==null&&b!==null?{fromBlock:a,toBlock:b}:null};
export const rpcRequestId=(e:unknown)=>typeof (e as {operationalRpcRequestId?:unknown})?.operationalRpcRequestId==='string'?(e as {operationalRpcRequestId:string}).operationalRpcRequestId:null;

export interface RestSourceSummary {source:string;pages:number;polls:number;failures:number;consecutiveFailures:number;pageLimitEver:boolean;cursorFailures:number;completenessFailures:number;publicationFailures:number;lastPollUtc:string|null;lastSuccessUtc:string|null;lastOutcome:string|null;lastStopReason:string|null;lastTraversal:string;completeness:'UNKNOWN_UNPROVEN'}
/** Exclusive primary class: explicit error class precedes request purpose. */
export function quarantineClass(row:{errorClass:string;component:string;reason:string}):string {
 const known:Record<string,string>={TIMEOUT:'timeout',HTTP_503:'503',HTTP_429:'429',MALFORMED_PAYLOAD:'malformed',PUBLICATION_ERROR:'publication',INDEX_ERROR:'index'};
 if(known[row.errorClass])return known[row.errorClass]!;
 const detail=(row.component+' '+row.reason).toLowerCase();
 return detail.includes('reorg')?'reorg':detail.includes('verifier')?'verifier':detail.includes('backfill')?'backfill':'other';
}
export class OperationalEvidence {
 private db!:DatabaseSync; private sequence=0; private metaWrites=0; private metaWriteInterval=128; private broken=false; private failure:unknown; private failureFile:string|null=null; private listeners=new Set<(error:unknown)=>void>(); private readonly dbFile:string; private rebuildReason:string;
 constructor(private readonly dir:string,private readonly nowIso:()=>string=()=>new Date().toISOString(),private readonly options:OperationalEvidenceOptions={}) {mkdirSync(dir,{recursive:true});this.dbFile=join(dir,'operational-index.sqlite');this.validateAuthority();this.rebuildReason=this.openOrRebuild();}
 private validateAuthority(){for(const name of files){const file=join(this.dir,name);if(!existsSync(file))continue;const size=statSync(file).size;if(size){const fd=openSync(file,'r');try{const last=Buffer.alloc(1);readSync(fd,last,0,1,size-1);if(last[0]!==10)throw Error(`EVIDENCE_SINK_FAILURE: ${file}: truncated NDJSON final line`)}finally{closeSync(fd)}}for(const row of streamRows<unknown>(file)){if(!row||typeof row!=='object'||Array.isArray(row))throw Error(`EVIDENCE_SINK_FAILURE: ${file}: invalid NDJSON row`)}}}
 /** Exposes detection/rebuild behavior for dashboard diagnostics and regressions. */
 indexStatus(){return {indexed:!this.broken,rebuildReason:this.rebuildReason,schemaVersion:schema}}
 private marker(){return JSON.stringify(Object.fromEntries(files.map(n=>{const p=join(this.dir,n);return [n,existsSync(p)?statSync(p).size:0]})))}
 private openOrRebuild(){if(!existsSync(this.dbFile)){this.rebuild('MISSING');return 'MISSING'}try {this.db=new DatabaseSync(this.dbFile);this.db.exec('PRAGMA temp_store=FILE;PRAGMA cache_size=-2048');const integrity=this.db.prepare('PRAGMA integrity_check').get() as {integrity_check?:string};if(integrity.integrity_check!=='ok')throw Error('integrity');const meta=this.meta();if(meta.schema!==String(schema))throw Error('SCHEMA_MISMATCH');if(meta.marker!==this.marker())throw Error('AUTHORITATIVE_ADVANCED');if(meta.digest!==this.indexDigest())throw Error('SEMANTIC_MISMATCH');this.validateInvariants();return 'VALID'}catch(cause){try{this.db?.close()}catch{};const reason=String(cause).includes('SCHEMA_MISMATCH')?'SCHEMA_MISMATCH':String(cause).includes('AUTHORITATIVE_ADVANCED')?'AUTHORITATIVE_ADVANCED':String(cause).includes('SEMANTIC_MISMATCH')?'SEMANTIC_MISMATCH':'CORRUPT_OR_UNUSABLE';this.rebuild(reason);return reason}}
 private create(){this.db=new DatabaseSync(this.dbFile);this.db.exec('PRAGMA temp_store=FILE;PRAGMA cache_size=-2048');this.db.exec('PRAGMA journal_mode=OFF;PRAGMA synchronous=OFF;CREATE TABLE meta(k TEXT PRIMARY KEY,v TEXT NOT NULL);CREATE TABLE rpc(id TEXT PRIMARY KEY,row TEXT NOT NULL,success INTEGER NOT NULL,method TEXT NOT NULL,component TEXT NOT NULL,range_json TEXT);CREATE INDEX rpc_kind ON rpc(method,component,success);CREATE TABLE rpc_resolution(failed TEXT PRIMARY KEY,success TEXT NOT NULL,row TEXT NOT NULL);CREATE TABLE q(id TEXT PRIMARY KEY,row TEXT NOT NULL,raw_ref TEXT,recovery TEXT NOT NULL);CREATE INDEX q_raw ON q(raw_ref);CREATE INDEX q_rpc ON q(json_extract(row,\'$.rpcRequestId\'));CREATE TABLE q_resolution(qid TEXT PRIMARY KEY,row TEXT NOT NULL);CREATE TABLE coverage_q(qid TEXT PRIMARY KEY);CREATE TABLE coverage_periods(id TEXT PRIMARY KEY,source TEXT NOT NULL,wallet TEXT NOT NULL,condition TEXT NOT NULL,occurrences INTEGER NOT NULL,firstUtc TEXT NOT NULL,lastUtc TEXT NOT NULL,firstReceipt TEXT NOT NULL,lastReceipt TEXT NOT NULL);CREATE TABLE rpc_publications(id TEXT PRIMARY KEY,row TEXT NOT NULL);CREATE TABLE rest_quality(id TEXT PRIMARY KEY CHECK(id=\'REST\'),row TEXT NOT NULL);')}
 private rebuild(reason:string){try{this.db?.close()}catch{};rmSync(this.dbFile,{force:true});this.create();try{this.db.exec('BEGIN');for(const n of files)for(const r of streamRows<Record<string,unknown>>(join(this.dir,n)))this.apply(n,r);this.db.exec('COMMIT');this.syncMeta()}catch(e){try{this.db.exec('ROLLBACK')}catch{};try{this.db.close()}catch{};this.broken=true;throw Error(`operational index rebuild failed (${reason}): ${String(e)}`)}}
 private meta(){const rows=this.db.prepare('SELECT k,v FROM meta').all() as {k:string;v:string}[];return Object.fromEntries(rows.map(x=>[x.k,x.v])) as Record<string,string>}
 private put(k:string,v:string){this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k,v)}
 private indexDigest(){const hash=createHash('sha256');let first=true;for(const [table,id] of [['rpc','id'],['rpc_resolution','failed'],['q','id'],['q_resolution','qid'],['rest_quality','id'],['rpc_publications','id']] as const){for(const x of this.db.prepare(`SELECT ${id} id,row FROM ${table} ORDER BY ${id}`).iterate() as Iterable<{id:string;row:string}>){if(!first)hash.update('\n');first=false;hash.update(`${table}\u0000${x.id}\u0000${x.row}`)}}for(const table of ['coverage_q','coverage_periods'])for(const x of this.db.prepare(`SELECT * FROM ${table} ORDER BY 1`).iterate())hash.update(JSON.stringify(x));hash.update(JSON.stringify(this.restCompletenessState()));for(const x of this.db.prepare("SELECT k,v FROM meta WHERE k LIKE 'summary:%' ORDER BY k").iterate() as Iterable<{k:string;v:string}>)hash.update(`${x.k}\u0000${x.v}`);return hash.digest('hex')}
 private validateInvariants(){const bad=this.db.prepare('SELECT failed FROM rpc_resolution WHERE failed NOT IN(SELECT id FROM rpc)').get();if(bad)throw Error('SEMANTIC_MISMATCH');const qbad=this.db.prepare('SELECT qid FROM q_resolution WHERE qid NOT IN(SELECT id FROM q)').get();if(qbad)throw Error('SEMANTIC_MISMATCH')}
 private syncMeta(){this.put('schema',String(schema));this.put('marker',this.marker());this.put('digest',this.indexDigest())}
 private usable(){if(this.broken)throw this.failure ?? Error('operational index is invalid; restart is required')}
 failureStatus(){return {state:this.broken?'BROKEN':'READY',code:this.broken?'EVIDENCE_SINK_FAILURE':null,file:this.failureFile,error:this.broken?String(this.failure):null}}
 onBroken(listener:(error:unknown)=>void){this.listeners.add(listener);if(this.broken)listener(this.failure);return ()=>{this.listeners.delete(listener)}}
 private breakSink(error:unknown,name:string){if(this.broken)return;this.failure=error;this.failureFile=name;this.broken=true;try{this.db.close()}catch{};for(const listener of this.listeners){try{listener(error)}catch{/* control diagnostics cannot replace the original failure */}}}
 /** Fail-closed boundary for callers that cannot run scientifically without receipts. */
 assertUsable(){this.usable()}
 isUsable(){return !this.broken}
 // Geometric cache checkpoints avoid quadratic whole-index digest work. A
 // crash between checkpoints rebuilds from authority; clean close still seals.
 private append(name:typeof files[number],row:Record<string,unknown>){this.usable();try{this.options.fault?.('before-authoritative-append',name,row);const serialized=JSON.stringify(row)+'\n';if(this.options.write)this.options.write(join(this.dir,name),serialized,name);else appendFileSync(join(this.dir,name),serialized);this.options.fault?.('after-authoritative-append',name,row);this.apply(name,row);this.options.fault?.('after-derived-row',name,row);if(++this.metaWrites>=this.metaWriteInterval){this.syncMeta();this.metaWrites=0;this.metaWriteInterval=Math.min(Number.MAX_SAFE_INTEGER,this.metaWriteInterval*2)}}catch(e){this.breakSink(e,name);throw e}}
 private apply(name:string,row:Record<string,unknown>){this.applySummary(name,row);const text=(v:unknown)=>v===null||v===undefined?null:String(v);if(name==='rpc_lineage.ndjson')this.db.prepare('INSERT OR IGNORE INTO rpc VALUES(?,?,?,?,?,?)').run(text(row.requestId),JSON.stringify(row),row.success?1:0,text(row.method),text(row.component),JSON.stringify(row.requestedRange));else if(name==='rpc_recoveries.ndjson')this.db.prepare('INSERT OR IGNORE INTO rpc_resolution VALUES(?,?,?)').run(text(row.failedRequestId),text(row.successfulRequestId),JSON.stringify(row));else if(name==='quarantine_v2.ndjson')this.db.prepare('INSERT OR IGNORE INTO q VALUES(?,?,?,?)').run(text(row.quarantineId),JSON.stringify(row),text(row.rawEvidenceRef),text(row.recoveryState));else if(name==='quarantine_resolutions.ndjson')this.db.prepare('INSERT OR IGNORE INTO q_resolution VALUES(?,?)').run(text(row.quarantineId),JSON.stringify(row));else if(name==='rpc_publications.ndjson')this.db.prepare('INSERT OR IGNORE INTO rpc_publications VALUES(?,?)').run(text(row.requestId),JSON.stringify(row));else if(name==='rest_poll_receipts.ndjson'){this.indexCoverage(row);const prior=this.restQuality();this.db.prepare('INSERT INTO rest_quality VALUES(\'REST\',?) ON CONFLICT(id) DO UPDATE SET row=excluded.row').run(JSON.stringify({restAtPageLimit:prior.restAtPageLimit||row.atApiLimit===true,restCompletenessUnproven:true}));const state=this.restCompletenessState();if(row.recordType==='REST_PAGE'){state.pages++;state.failures+=['HTTP_FAILURE','TIMEOUT','PARSE_FAILURE','PUBLICATION_FAILURE'].includes(String(row.outcome))?1:0;state.unstablePages+=row.overlap==='MISSING_OR_MOVED'?1:0;state.budgetExhaustions+=['REQUEST_BUDGET_EXHAUSTED','OFFSET_CAP_EXHAUSTED'].includes(String(row.stopReason))?1:0;}if(row.recordType==='REST_POLL'){state.polls++;state.skipped+=row.outcome==='SKIPPED'?1:0;}this.put('rest_completeness',JSON.stringify(state));}}
 /** Receipt-backed classification only: success is not completeness. No lifetime JS set.
  * UTC-hour buckets distinguish periods; source/wallet/limit/stop/overlap distinguish mechanisms.
  * Historical warnings are excluded ONLY when their exact linked page proves successful publication. */
 private indexCoverage(row:Record<string,unknown>){
  if(row.recordType!=='REST_PAGE'||!['REST_TRADES','REST_ACTIVITY'].includes(String(row.source))
   ||row.httpStatus!==200||row.publication!=='SUCCESS'||row.identityVectorComplete!==true
   ||!String(row.outcome).startsWith('SUCCESS')||!(row.atApiLimit===true||row.overlap==='MISSING_OR_MOVED'))return;
  const stamp=String(row.responseUtc),time=Date.parse(stamp);
  if(!Number.isFinite(time)||typeof row.wallet!=='string'||typeof row.receiptId!=='string')return;
  const condition=JSON.stringify([row.stopReason,row.limit,row.overlap,row.pagination]);
  const id=JSON.stringify([row.source,row.wallet,new Date(time).toISOString().slice(0,13),condition]);
  this.db.prepare('INSERT INTO coverage_periods VALUES(?,?,?,?,1,?,?,?,?) ON CONFLICT(id) DO UPDATE SET occurrences=occurrences+1,lastUtc=excluded.lastUtc,lastReceipt=excluded.lastReceipt')
   .run(id,String(row.source),row.wallet,condition,stamp,stamp,row.receiptId,row.receiptId);
  for(const qid of Array.isArray(row.quarantineIds)?row.quarantineIds:[]){
   const q=this.db.prepare('SELECT row FROM q WHERE id=?').get(qid) as {row:string}|undefined;
   if(!q)continue;
   const v=JSON.parse(q.row) as QuarantineEvidenceRow;
   if(v.errorClass==='OTHER'&&v.pollId===row.pollId&&v.source===row.source&&v.component===row.source&&v.wallet===row.wallet
    &&v.sourceIdentity===null&&v.rawEvidenceRef===null&&v.rpcRequestId===null&&!v.eventIdentityKnown
    &&v.reason===`poll ${row.pollId}: REST completeness UNPROVEN: ${row.stopReason}; limit ${row.limit}`)
    this.db.prepare('INSERT OR IGNORE INTO coverage_q VALUES(?)').run(qid);
  }
 }
 coverageLimitations(){this.usable();return {state:'UNKNOWN_UNPROVEN' as const,...(this.db.prepare('SELECT count(*) periods,coalesce(sum(occurrences),0) occurrences,min(firstUtc) firstUtc,max(lastUtc) lastUtc FROM coverage_periods').get() as {periods:number;occurrences:number;firstUtc:string|null;lastUtc:string|null}),scope:'successful limited-coverage pages; UTC-hour/source/wallet/mechanism buckets; all poll receipts retained'};}
 coveragePeriods(limit=100,offset=0){this.usable();if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw Error('bounded coverage query required');return this.db.prepare('SELECT * FROM coverage_periods ORDER BY id LIMIT ? OFFSET ?').all(limit,offset);}
 private summary<T>(key:string,fallback:T):T {const r=this.db.prepare('SELECT v FROM meta WHERE k=?').get('summary:'+key) as {v:string}|undefined;return r?JSON.parse(r.v):fallback;}
 private applySummary(name:string,row:Record<string,unknown>){
  const counts=this.summary<Record<string,number>>('streams',{});counts[name]=(counts[name]??0)+1;this.put('summary:streams',JSON.stringify(counts));
  if(name==='chain_tail_proofs.ndjson')this.put('summary:tail',JSON.stringify(row));
  if(name!=='rest_poll_receipts.ndjson'||!['REST_TRADES','REST_ACTIVITY'].includes(String(row.source)))return;
  const s=this.restSource(String(row.source));
  const failure=['HTTP_FAILURE','TIMEOUT','PARSE_FAILURE','PUBLICATION_FAILURE'].includes(String(row.outcome));
  const stamp=typeof row.responseUtc==='string'?row.responseUtc:typeof row.atUtc==='string'?row.atUtc:null;
  if(row.recordType==='REST_PAGE'){
   s.pages++;s.pageLimitEver ||=row.atApiLimit===true;
   s.cursorFailures+=row.overlap==='MISSING_OR_MOVED'?1:0;
   s.completenessFailures+=['REQUEST_BUDGET_EXHAUSTED','OFFSET_CAP_EXHAUSTED','UNSTABLE_OVERLAP','PAGINATION_DISABLED'].includes(String(row.stopReason))?1:0;
   s.publicationFailures+=row.outcome==='PUBLICATION_FAILURE'?1:0;
  }
  if(row.recordType==='REST_POLL'){
   s.polls++;s.lastPollUtc=stamp;s.lastOutcome=String(row.outcome);s.lastStopReason=String(row.stopReason??'UNKNOWN');
   s.lastTraversal=row.stopReason==='SHORT_PAGE'?'TRAVERSED_RETURNED_PAGES_ONLY':'INCOMPLETE_OR_UNSUPPORTED';
   if(row.outcome!=='SKIPPED'){s.consecutiveFailures=failure?s.consecutiveFailures+1:0;if(!failure&&String(row.outcome).startsWith('SUCCESS'))s.lastSuccessUtc=stamp;}
   s.failures+=failure?1:0;
  }
  this.put('summary:rest:'+row.source,JSON.stringify(s));
 }
 restSource(source:string):RestSourceSummary {this.usable();return this.summary('rest:'+source,{source,pages:0,polls:0,failures:0,consecutiveFailures:0,pageLimitEver:false,cursorFailures:0,completenessFailures:0,publicationFailures:0,lastPollUtc:null,lastSuccessUtc:null,lastOutcome:null,lastStopReason:null,lastTraversal:'UNKNOWN',completeness:'UNKNOWN_UNPROVEN'} as RestSourceSummary);}
 /** All aggregates are disk-backed; result cardinality is fixed, never lifetime arrays. */
 operationalSnapshot(nowUtc=this.nowIso()){
  this.usable();const now=Date.parse(nowUtc),age=(s:unknown)=>typeof s==='string'&&Number.isFinite(Date.parse(s))?Math.max(0,(now-Date.parse(s))/1000):null;
  const quarantine=this.quarantineState();
  const ageRow=this.db.prepare("SELECT min(json_extract(q.row,'$.timestampUtc')) oldest FROM q LEFT JOIN q_resolution r ON q.id=r.qid WHERE coalesce(json_extract(r.row,'$.recoveryState'),q.recovery)='UNRESOLVED' AND q.id NOT IN(SELECT qid FROM coverage_q)").get() as {oldest:string|null};
  const latest=this.db.prepare("SELECT row FROM q ORDER BY json_extract(row,'$.timestampUtc') DESC,id DESC LIMIT 1").get() as {row:string}|undefined;
  const q=latest?JSON.parse(latest.row) as QuarantineEvidenceRow:null;
  const windows=this.db.prepare("SELECT coalesce(sum(json_extract(row,'$.timestampUtc')>=?),0) additions5m,coalesce(sum(json_extract(row,'$.timestampUtc')>=?),0) additions1h FROM q WHERE json_extract(row,'$.timestampUtc')<=?").get(new Date(now-300000).toISOString(),new Date(now-3600000).toISOString(),nowUtc);
  const classes:Record<string,number>=Object.fromEntries(['timeout','503','429','malformed','verifier','backfill','publication','index','reorg','other'].map(k=>[k,0]));
  for(const r of this.db.prepare("SELECT json_extract(row,'$.errorClass') errorClass,json_extract(row,'$.component') component,json_extract(row,'$.reason') reason,count(*) n FROM q GROUP BY errorClass,component,reason").iterate() as Iterable<{errorClass:string;component:string;reason:string;n:number}>){const c=quarantineClass(r);classes[c]=(classes[c]??0)+r.n;}
  const rpc=this.db.prepare("SELECT count(*) requests,coalesce(sum(success=0),0) failures,coalesce(sum(json_extract(row,'$.attempt')>1),0) retries,max(json_extract(row,'$.completionUtc')) lastRequestUtc,max(CASE WHEN success=1 THEN json_extract(row,'$.completionUtc') END) lastSuccessUtc FROM rpc").get();
  const pending=this.db.prepare("SELECT count(*) unresolved,min(json_extract(row,'$.completionUtc')) oldestFailureUtc FROM rpc WHERE success=0 AND id NOT IN(SELECT failed FROM rpc_resolution)").get() as {unresolved:number;oldestFailureUtc:string|null};
  return {coverageLimitations:this.coverageLimitations(),quarantine:{...quarantine,...windows,oldestUnresolvedUtc:ageRow.oldest,oldestUnresolvedAgeSeconds:age(ageRow.oldest),latestTimestampUtc:q?.timestampUtc??null,latestSource:q?.source??null,latestClass:q?quarantineClass(q):null,classBreakdown:classes,scope:'whole-run immutable authority; derived validated SQLite index'},chain:{...rpc,...pending,unresolvedQuarantine:this.unresolvedQuarantineCount('CHAIN'),oldestFailureAgeSeconds:age(pending.oldestFailureUtc),tail:this.summary<Record<string,unknown>|null>('tail',null)},rest:['REST_TRADES','REST_ACTIVITY'].map(s=>this.restSource(s)),streams:this.summary<Record<string,number>>('streams',{}),operationalIndex:this.indexStatus()};
 }
 nextId(p:string){return `${p}-${Date.now()}-${++this.sequence}-${randomUUID()}`}
 async rpc<T>(call:()=>Promise<T>,input:RpcRequestInput,onSuccess?:(requestId:string)=>void):Promise<T>{
  this.usable();
  const id=this.nextId('rpc'),start=this.nowIso(),r=rangeFrom(input.method,input.params);
  const deadline=input.timeoutMs?new Date(Date.parse(start)+input.timeoutMs).toISOString():null;
  const common={schemaVersion:2 as const,recordType:'RPC_REQUEST' as const,requestId:id,
   family:input.family,method:input.method,params:input.params,component:input.component,
   reason:input.reason,attempt:input.attempt,retryParentRequestId:input.retryParentRequestId,
   requestUtc:start,timeoutDeadlineUtc:deadline,httpStatus:null,requestedRange:r};
  let result:T;
  // Only upstream execution belongs in this catch. Evidence/recovery failures
  // must never be reinterpreted as a failed request or contradictory lineage.
  try {result=await call();}
  catch(error){
   this.usable(); // another source may have broken the sink while in flight
   const row:RpcLineageRow={...common,completionUtc:this.nowIso(),success:false,
    errorClass:classify(error),error:String(error).slice(0,512),responseRange:null,responseBlock:null,resultCount:null};
   this.append('rpc_lineage.ndjson',row as unknown as Record<string,unknown>);
   if(error&&(typeof error==='object'||typeof error==='function'))Object.defineProperty(error,'operationalRpcRequestId',{value:id,configurable:true});
   throw error;
  }
  this.usable();
  const row:RpcLineageRow={...common,completionUtc:this.nowIso(),success:true,errorClass:null,error:null,
   responseRange:r,responseBlock:input.method==='eth_getBlockByNumber'&&typeof input.params[0]==='string'?parseInt(input.params[0],16):null,
   resultCount:Array.isArray(result)?result.length:null};
  this.append('rpc_lineage.ndjson',row as unknown as Record<string,unknown>);
  onSuccess?.(id);
  if(input.retryParentRequestId)this.rpcRecovery(input.retryParentRequestId,id,r!==null,r);
  for(const old of this.unresolvedRpcRows(input.method,input.component)){
   const a=old.requestedRange;
   if(a&&r&&r.fromBlock<=a.fromBlock&&r.toBlock>=a.toBlock)this.rpcRecovery(old.requestId,id,true,r);
  }
  return result;
 }
 /** Called only after watcher validates/handles every log and durably publishes its cursor.
  * RPC success/retry lineage alone NEVER resolves quarantine. */
 confirmRpcPublication(requestId:string,range:{fromBlock:number;toBlock:number},cursorHash:string,responseSha256:string){
  this.usable();const row=this.db.prepare('SELECT row FROM rpc WHERE id=? AND success=1').get(requestId) as {row:string}|undefined;
  const request=row?JSON.parse(row.row) as RpcLineageRow:null;
  if(!request||request.method!=='eth_getLogs'||request.component!=='CHAIN'||JSON.stringify(range)!==JSON.stringify(request.requestedRange)
   ||!Number.isSafeInteger(request.resultCount)||!/^0x[0-9a-f]{64}$/i.test(cursorHash)||!/^[0-9a-f]{64}$/.test(responseSha256))throw Error('validated range publication identity required');
  const proof={schemaVersion:2,recordType:'PROCESSED_RPC_RANGE',requestId,range,cursorHash,responseSha256,processedUtc:this.nowIso(),publication:'SUCCESS'};
  const prior=this.db.prepare('SELECT row FROM rpc_publications WHERE id=?').get(requestId) as {row:string}|undefined;
  if(prior){const old=JSON.parse(prior.row);if(old.cursorHash!==cursorHash||old.responseSha256!==responseSha256||JSON.stringify(old.range)!==JSON.stringify(range))throw Error('conflicting range publication');}
  else this.append('rpc_publications.ndjson',proof);
  this.reconcileRpcQuarantines(requestId);
 }
 /** Explicit replay of retained processed proofs; idempotent, never upgrades transport-only history. */
 reconcileRpcQuarantines(requestId:string){
  this.usable();if(!requestId)throw Error('explicit processed proof required');
  const filter=(params:unknown[])=>JSON.stringify(params.map((v,i)=>i===0&&v&&typeof v==='object'?Object.fromEntries(Object.entries(v).filter(([k])=>!['fromBlock','toBlock'].includes(k)).sort(([a],[b])=>a.localeCompare(b))):v));
  // Both online and explicit replay target one retained proof, at most 1000 pending failures per call.
  // SQL narrows failures by exact method/component/range before any JS decoding.
  const sql=`SELECT q.id,q.row quarantine,f.row failure,p.row proof,r.row request
   FROM rpc_publications p JOIN rpc r ON p.id=r.id
   JOIN rpc f ON f.success=0 AND f.method=r.method AND f.component=r.component
    AND json_extract(p.row,'$.range.fromBlock')<=json_extract(f.row,'$.requestedRange.fromBlock')
    AND json_extract(p.row,'$.range.toBlock')>=json_extract(f.row,'$.requestedRange.toBlock')
   JOIN q ON json_extract(q.row,'$.rpcRequestId')=f.id
   WHERE q.id NOT IN(SELECT qid FROM q_resolution) AND p.id=? ORDER BY q.id LIMIT 1000`;
  for(const x of this.db.prepare(sql).iterate(requestId) as Iterable<{id:string;quarantine:string;failure:string;proof:string;request:string}>){
   const q=JSON.parse(x.quarantine) as QuarantineEvidenceRow,failed=JSON.parse(x.failure) as RpcLineageRow;
   const p=JSON.parse(x.proof),r=JSON.parse(x.request) as RpcLineageRow;
   if(q.source!=='CHAIN'||q.component!=='CHAIN'||q.eventIdentityKnown||q.rawEvidenceRef!==null||q.recoveryState!=='UNRESOLVED'||!failed.requestedRange)continue;
   if(p.recordType!=='PROCESSED_RPC_RANGE'||p.publication!=='SUCCESS'||!r.success||r.method!=='eth_getLogs'||r.component!=='CHAIN'
    ||filter(r.params)!==filter(failed.params)||JSON.stringify(p.range)!==JSON.stringify(r.requestedRange)
    ||!Number.isFinite(Date.parse(p.processedUtc))||Date.parse(p.processedUtc)<Date.parse(failed.completionUtc))continue;
   this.resolveQuarantine(x.id,'RECOVERED',`rpc-publication:${p.requestId}`,'VALIDATED_RANGE_PROCESSED_AND_PUBLISHED',false);
  }
 }
 private rpcRecovery(failed:string,success:string,full:boolean,range:{fromBlock:number;toBlock:number}|null){this.append('rpc_recoveries.ndjson',{schemaVersion:2,recoveryId:this.nextId('rpc-recovery'),failedRequestId:failed,successfulRequestId:success,resolvedUtc:this.nowIso(),fullFailedRangeCovered:full,successfulRange:range})}
 private *unresolvedRpcRows(method:string,component:string){this.usable();for(const x of this.db.prepare('SELECT row FROM rpc WHERE success=0 AND method=? AND component=? AND id NOT IN(SELECT failed FROM rpc_resolution)').iterate(method,component))yield JSON.parse(String((x as {row:string}).row)) as RpcLineageRow;}
 unresolvedRpc(method:string,component:string){return [...this.unresolvedRpcRows(method,component)];}
 quarantine(row:Omit<QuarantineEvidenceRow,'schemaVersion'|'quarantineId'|'timestampUtc'|'recoveryState'|'retryCount'|'latestRetryUtc'>&Partial<Pick<QuarantineEvidenceRow,'quarantineId'|'timestampUtc'|'recoveryState'|'retryCount'|'latestRetryUtc'>>){const full:QuarantineEvidenceRow={schemaVersion:2,quarantineId:row.quarantineId??this.nextId('quarantine'),timestampUtc:row.timestampUtc??this.nowIso(),recoveryState:row.recoveryState??'UNRESOLVED',retryCount:row.retryCount??0,latestRetryUtc:row.latestRetryUtc??null,...row};this.append('quarantine_v2.ndjson',full as unknown as Record<string,unknown>);return full}
 resolveQuarantine(id:string,state:'RECOVERED'|'TERMINAL',canonicalObservationRef:string|null,disposition:string,scientificImpactPossible:boolean){this.usable();const exists=this.db.prepare('SELECT id FROM q WHERE id=?').get(id);if(!exists)throw Error(`unknown quarantine ${id}`);const prior=this.db.prepare('SELECT row FROM q_resolution WHERE qid=?').get(id) as {row:string}|undefined;if(prior){const p=JSON.parse(prior.row) as {recoveryState:string;canonicalObservationRef:string|null;terminalDisposition:string;scientificImpactPossible:boolean};if(p.recoveryState===state&&p.canonicalObservationRef===canonicalObservationRef&&p.terminalDisposition===disposition&&p.scientificImpactPossible===scientificImpactPossible)return;throw Error(`conflicting resolution for quarantine ${id}`)}this.append('quarantine_resolutions.ndjson',{schemaVersion:2,resolutionId:this.nextId('quarantine-resolution'),quarantineId:id,resolvedUtc:this.nowIso(),recoveryState:state,canonicalObservationRef,terminalDisposition:disposition,scientificImpactPossible})}
 resolveQuarantinesForRaw(raw:string,state:'RECOVERED'|'TERMINAL',canonical:string|null,disposition:string,impact:boolean){this.usable();for(const v of this.db.prepare('SELECT id FROM q WHERE raw_ref=? AND id NOT IN(SELECT qid FROM q_resolution)').iterate(raw) as Iterable<{id:string}>)this.resolveQuarantine(v.id,state,canonical,disposition,impact)}
 unresolvedQuarantineCount(source:string|null=null){this.usable();const row=this.db.prepare("SELECT count(*) n FROM q LEFT JOIN q_resolution r ON q.id=r.qid WHERE coalesce(json_extract(r.row,'$.recoveryState'),q.recovery)='UNRESOLVED' AND q.id NOT IN(SELECT qid FROM coverage_q) AND (? IS NULL OR json_extract(q.row,'$.source')=?)").get(source,source) as {n:number}|undefined;return Number(row?.n??0)}
 /** Constant-size indexed whole-run flags. A later short page is not overlap proof.
  * Current REST receipt contract has no supported pagination completeness proof. */
 restQuality():{restAtPageLimit:boolean;restCompletenessUnproven:boolean}{this.usable();const row=this.db.prepare("SELECT row FROM rest_quality WHERE id='REST'").get() as {row:string}|undefined;return row?JSON.parse(row.row):{restAtPageLimit:false,restCompletenessUnproven:true}}
 /** Constant-size durable full-run operational counters, rebuilt from ALL receipts.
  * They never assert cross-poll coverage from a matched overlap or a short page. */
 restCompletenessState():{state:'UNKNOWN_UNPROVEN';pages:number;polls:number;skipped:number;failures:number;unstablePages:number;budgetExhaustions:number}{this.usable();const row=this.db.prepare("SELECT v FROM meta WHERE k='rest_completeness'").get() as {v:string}|undefined;return row?JSON.parse(row.v):{state:'UNKNOWN_UNPROVEN',pages:0,polls:0,skipped:0,failures:0,unstablePages:0,budgetExhaustions:0}}
 /** Indexed stable IDs, exposed only for audit/readiness checks. */
 quarantineStateIds(){this.usable();return (this.db.prepare('SELECT q.id,q_resolution.row resolution FROM q LEFT JOIN q_resolution ON q.id=q_resolution.qid ORDER BY q.id').all() as {id:string;resolution:string|null}[]).map(x=>({id:x.id,state:x.resolution?(JSON.parse(x.resolution) as {recoveryState:string}).recoveryState:'UNRESOLVED'}))}
 quarantineState(){this.usable();const out={unresolved:0,recovered:0,terminal:0,ambiguous:0,total:0,coverageWarnings:0};for(const x of this.db.prepare('SELECT q.row,q_resolution.row resolution,coverage_q.qid coverage FROM q LEFT JOIN coverage_q ON q.id=coverage_q.qid LEFT JOIN q_resolution ON q.id=q_resolution.qid').iterate() as Iterable<{row:string;resolution:string|null;coverage:string|null}>){const q=JSON.parse(x.row) as QuarantineEvidenceRow;const r=x.resolution?JSON.parse(x.resolution) as {recoveryState:string;scientificImpactPossible:boolean}:null;const state=r?.recoveryState??q.recoveryState;if(x.coverage)out.coverageWarnings++;else if(state==='UNRESOLVED')out.unresolved++;else if(state==='RECOVERED')out.recovered++;else out.terminal++;if(r?.scientificImpactPossible??q.scientificImpactPossible)out.ambiguous++;out.total++;}return out}
 restReceipt(row:Record<string,unknown>){this.append('rest_poll_receipts.ndjson',{schemaVersion:2,receiptId:this.nextId('rest-poll'),...row})} telemetry(row:Record<string,unknown>){this.append('runtime_telemetry.ndjson',{schemaVersion:2,atUtc:this.nowIso(),...row})} auditSnapshot(row:Record<string,unknown>){this.append('audit_snapshots.ndjson',{schemaVersion:2,snapshotId:this.nextId('audit'),atUtc:this.nowIso(),...row})} tailProof(row:Record<string,unknown>){this.append('chain_tail_proofs.ndjson',{schemaVersion:2,proofId:this.nextId('tail'),atUtc:this.nowIso(),...row})} digestIdentityVector(ids:readonly string[]){return sha(ids.join('\n'))} static errorClass(e:unknown){return classify(e)} close(){if(this.broken)return;try{this.syncMeta();this.metaWrites=0;this.db.close()}catch(error){this.breakSink(error,'operational-index.sqlite');throw error}}
}
