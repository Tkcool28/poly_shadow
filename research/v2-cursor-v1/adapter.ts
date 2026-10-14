/** Isolated research adapter. No import from the production launcher. */
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {mkdirSync,statfsSync,openSync,readSync,closeSync} from 'node:fs';
import {join} from 'node:path';
import {tradesIdentity,activityIdentity,normalizeRestRaw} from '../../src/shadow/racing.js';
import {storagePlan} from '../../src/shadow/storage-budget.js';
export const WALLETS=Object.freeze(['0x82cf2b31d18fca19830e216b98cffa5dbc6c0998','0x924379a79c64b77ad5816ad362122a5f6228658e','0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029','0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b','0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227']);
export const LIMITS=Object.freeze({pages:3,records:100,body:1048576,requestMs:3000,traversalMs:8000,requests:60,minuteMs:60000,spacingMs:500,dailyBytes:8*1024**3,campaignBytes:64*1024**2,memoryBytes:256*1024**2});
export const VERSION='v2-cursor-research-1';
export function fileHash(path:string){const h=createHash('sha256'),fd=openSync(path,'r'),b=Buffer.alloc(65536);try{let n;while((n=readSync(fd,b,0,b.length,null))>0)h.update(b.subarray(0,n));return h.digest('hex')}finally{closeSync(fd)}}
export type Source='trades'|'activity';
export const hash=(b:string|Uint8Array)=>createHash('sha256').update(b).digest('hex');
const object=(v:unknown):Record<string,unknown>=>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('MALFORMED_OBJECT');return v as Record<string,unknown>};
const string=(v:unknown,key:string)=>{if(typeof v!=='string')throw Error(`IDENTITY_FIELD:${key}`);return v};
const number=(v:unknown,key:string)=>{if(typeof v!=='number'||!Number.isFinite(v)||v<0)throw Error(`IDENTITY_FIELD:${key}`);return v};
/** Renaming only. Numeric rounding, source identity, roles and candidate groups
 * remain the existing frozen functions. Missing numbers NEVER become zero. */
export function decode(source:Source,value:unknown,wallet:string){
 const r=object(value),proxyWallet=string(r.proxy_wallet,'proxy_wallet'),transactionHash=string(r.transaction_hash,'transaction_hash'),asset=string(r.token_id,'token_id'),conditionId=string(r.condition_id,'condition_id'),title=string(r.title,'title');
 const size=number(r.size,'size'),price=number(r.price,'price'),timestamp=number(r.timestamp,'timestamp'),side=string(r.side,'side');
 const type=source==='activity'?string(r.type,'type'):undefined;
 if(proxyWallet.toLowerCase()!==wallet||!/^0x[0-9a-f]{64}$/i.test(transactionHash)||!Number.isSafeInteger(timestamp)||!type&&source==='activity')throw Error('IDENTITY_INCOMPATIBLE');
 if(source==='trades'||type==='TRADE'){
  if(!/^\d+$/.test(asset)||!/^0x[0-9a-f]{64}$/i.test(conditionId)||!['BUY','SELL'].includes(side))throw Error('IDENTITY_INCOMPATIBLE');
 }else{
  // Non-trade rows may explicitly carry empty asset/condition/side; retain them.
  if(!/^[A-Z_]+$/.test(type!))throw Error('ACTIVITY_TYPE_INCOMPATIBLE');
 }
 if(r.is_combo===true)throw Error('UNSUPPORTED_COMBO_POPULATION');
 return {proxyWallet,transactionHash,asset,conditionId,title,size,price,timestamp,side,...(type===undefined?{}:{type})};
}
export function page(source:Source,value:unknown,wallet:string){
 const e=object(value),p=object(e.pagination);
 if(!Array.isArray(e.data)||e.data.length>LIMITS.records||p.limit!==LIMITS.records||!Number.isSafeInteger(p.offset)||Number(p.offset)<0||typeof p.has_more!=='boolean'||!Object.hasOwn(p,'next_cursor'))throw Error('MALFORMED_PAGE');
 const next=p.next_cursor;
 if(next!==null&&(typeof next!=='string'||!next.length||next.length>8192)||p.has_more!==(next!==null))throw Error('MALFORMED_CURSOR');
 return {rows:e.data.map(r=>decode(source,r,wallet)),next:next as string|null,more:p.has_more};
}
export function filters(source:Source,wallet:string,end:number){
 if(!WALLETS.includes(wallet)||!Number.isSafeInteger(end)||end<=0)throw Error('UNAPPROVED_QUERY');
 return Object.freeze({user:wallet,limit:'100',start:String(end-3*365*86400),end:String(end),...(source==='trades'?{taker_only:'false'}:{sort_by:'TIMESTAMP',sort_direction:'DESC',exclude_deposits_withdrawals:'true'})});
}
export interface Reply {status:number;body:Buffer;headers:Record<string,string>;requestUtc:string;responseUtc:string;elapsedMs:number;queueMs?:number;error?:string}
export interface Transport {get(url:string,deadline:number):Promise<Reply>}
export interface Clock {now():number}
export const realClock:Clock={now:()=>Date.now()};
/** One transport shared by ALL REST requests. Strict spacing is more conservative
 * than the burst ceiling. No waiting beyond a traversal's deadline, no retries. */
export class PublicTransport implements Transport {
 private requests:number[]=[];private busy=false;private last=-Infinity;private denied=false;
 count=0;
 async get(url:string,deadline:number):Promise<Reply>{
  const u=new URL(url);if(u.origin!=='https://data-api.polymarket.com'||!['/v2/trades','/v2/activity','/trades','/activity','/v2/status','/v2/openapi.json'].includes(u.pathname)||u.username||u.password)throw Error('NETWORK_ALLOWLIST');
  if(this.busy||this.denied)throw Error(this.denied?'HOST_STOPPED':'CONCURRENCY_LIMIT');
  this.busy=true;let requestUtc=new Date().toISOString();let body=Buffer.alloc(0);let status=0;const headers:Record<string,string>={};const began=Date.now();let error:string|undefined;
  try{
   const wait=Math.max(0,this.last+LIMITS.spacingMs-Date.now());if(Date.now()+wait+LIMITS.requestMs>deadline)throw Error('TIME_BUDGET');
   if(wait)await new Promise(r=>setTimeout(r,wait));
   const now=Date.now();this.requests=this.requests.filter(t=>now-t<LIMITS.minuteMs);
   if(this.requests.length>=LIMITS.requests||this.count>=60)throw Error('REQUEST_BUDGET');
   this.requests.push(now);this.last=now;this.count++;requestUtc=new Date(now).toISOString();
   const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(LIMITS.requestMs,deadline-now));
   try{
    const response=await fetch(url,{signal:controller.signal,redirect:'error',headers:{Accept:'application/json','User-Agent':'PolyShadow-bounded-v2-research/1'}});status=response.status;
    for(const key of ['date','age','cache-control','etag','retry-after','x-trace-id','content-type','content-length']){const v=response.headers.get(key);if(v!==null)headers[key]=v.slice(0,8192)}
    if([403,429,503].includes(status))this.denied=true;
    if(Number(headers['content-length'])>LIMITS.body){await response.body?.cancel();controller.abort();throw Error('BODY_BUDGET')}
    const reader=response.body?.getReader();if(!reader)throw Error('MISSING_BODY');
    try{while(true){const chunk=await reader.read();if(chunk.done)break;const remaining=LIMITS.body-body.length;body=Buffer.concat([body,chunk.value.subarray(0,remaining)]);if(chunk.value.length>remaining){await reader.cancel();throw Error('BODY_BUDGET')}if(process.memoryUsage().rss>LIMITS.memoryBytes){await reader.cancel();throw Error('MEMORY_BUDGET')}}}catch(error){controller.abort();try{await reader.cancel()}catch{};throw error}finally{reader.releaseLock()}
   }finally{clearTimeout(timer)}
  }catch(e){error=String(e)}finally{this.busy=false}
  return {status,body,headers,requestUtc,responseUtc:new Date().toISOString(),elapsedMs:Date.now()-Date.parse(requestUtc),queueMs:Date.parse(requestUtc)-began,...(error?{error}:{})};
 }
}
export interface Checkpoint {version:string;queryHash:string;source:Source;wallet:string;filters:Record<string,string>;page:number;cursor:string|null;seenCursors:string[];started:number;lastTimestamp:number|null;inflight:boolean;stop:string|null}
/** SQLite is the durable publication sink AND checkpoint authority. One bounded
 * page/transaction; WAL FULL. No in-memory whole-history sets or replay. */
export class Evidence {
 readonly db:DatabaseSync;
 constructor(readonly dir:string,private free:()=>number=()=>{const s=statfsSync(dir);return Number(s.bavail)*Number(s.bsize)},private memory:()=>number=()=>process.memoryUsage().rss){
  mkdirSync(dir,{recursive:true});this.db=new DatabaseSync(join(dir,'evidence.sqlite'));this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048; CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL); CREATE TABLE IF NOT EXISTS receipts(id INTEGER PRIMARY KEY, traversal TEXT NOT NULL,page INTEGER NOT NULL,row TEXT NOT NULL,body BLOB NOT NULL); CREATE TABLE IF NOT EXISTS observations(source TEXT NOT NULL,identity TEXT NOT NULL,traversal TEXT NOT NULL,page INTEGER NOT NULL,row TEXT NOT NULL,PRIMARY KEY(source,identity)); CREATE TABLE IF NOT EXISTS checkpoints(id TEXT PRIMARY KEY,row TEXT NOT NULL);');
 }
 gate(bytes=0){
  if(this.free()-bytes<storagePlan.alertReserveBytes)throw Error('DISK_RESERVE');
  if(this.memory()>LIMITS.memoryBytes)throw Error('MEMORY_BUDGET');
  const used=Number((this.db.prepare("SELECT v FROM meta WHERE k='bytes'").get() as {v:string}|undefined)?.v??0);
  if(bytes<0||used+bytes>LIMITS.campaignBytes||used+bytes>LIMITS.dailyBytes)throw Error('APPEND_BUDGET');
 }
 charge(bytes:number){this.gate(bytes);this.db.prepare("INSERT INTO meta VALUES('bytes',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(Number((this.db.prepare("SELECT v FROM meta WHERE k='bytes'").get() as {v:string}|undefined)?.v??0)+bytes))}
 private proof(id:string,c:Checkpoint){const h=createHash('sha256').update(JSON.stringify(c));let n=0;for(const r of this.db.prepare("SELECT row FROM receipts WHERE traversal=? AND json_extract(row,'$.outcome')='SUCCESS' ORDER BY id").iterate(id)){if(++n>3)throw Error('CHECKPOINT_RECEIPT_BUDGET');h.update(JSON.stringify(r))}n=0;for(const r of this.db.prepare('SELECT row FROM observations WHERE traversal=? ORDER BY identity').iterate(id)){if(++n>300)throw Error('CHECKPOINT_ROW_BUDGET');h.update(JSON.stringify(r))}return h.digest('hex')}
 checkpoint(id:string):Checkpoint|null{const v=this.db.prepare('SELECT row FROM checkpoints WHERE id=?').get(id) as {row:string}|undefined;if(!v)return null;const c=JSON.parse(v.row) as Checkpoint;const proof=this.db.prepare('SELECT v FROM meta WHERE k=?').get(`checkpoint:${id}`) as {v:string}|undefined;
 if(!c||c.version!==VERSION||!Number.isInteger(c.page)||c.page<0||c.page>3||!Number.isSafeInteger(c.started)||c.started<0||typeof c.inflight!=='boolean'||!Array.isArray(c.seenCursors)||c.seenCursors.length>3||c.seenCursors.some(v=>typeof v!=='string'||!v||v.length>8192)||new Set(c.seenCursors).size!==c.seenCursors.length||c.cursor!==null&&(typeof c.cursor!=='string'||!c.seenCursors.includes(c.cursor))||c.stop!==null&&typeof c.stop!=='string'||c.lastTimestamp!==null&&(!Number.isSafeInteger(c.lastTimestamp)||c.lastTimestamp<0)||this.proof(id,c)!==proof?.v)throw Error('CHECKPOINT_INTEGRITY');
 const success=this.db.prepare("SELECT count(*) n FROM receipts WHERE traversal=? AND json_extract(row,'$.outcome')='SUCCESS'").get(id) as {n:number};if(success.n!==c.page)throw Error('CHECKPOINT_PUBLICATION_LINK');return c} 
 save(id:string,c:Checkpoint){this.gate(32768);this.db.prepare('INSERT INTO checkpoints VALUES(?,?) ON CONFLICT(id) DO UPDATE SET row=excluded.row').run(id,JSON.stringify(c));this.db.prepare('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(`checkpoint:${id}`,this.proof(id,c))}
 receipt(id:string,p:number,r:Reply,url:string){this.charge(r.body.length+32768);return Number(this.db.prepare('INSERT INTO receipts(traversal,page,row,body) VALUES(?,?,?,?)').run(id,p,JSON.stringify({...r,body:undefined,url,bodySha256:hash(r.body),bodyHashScope:r.error?'RECEIVED_PREFIX_ONLY':'FULL_RESPONSE',publication:'PENDING',completeness:'UNKNOWN_UNPROVEN'}),r.body).lastInsertRowid)}
 outcome(receipt:number,outcome:string,extra:Record<string,unknown>={}){const row=this.db.prepare('SELECT row FROM receipts WHERE id=?').get(receipt) as {row:string};this.db.prepare('UPDATE receipts SET row=? WHERE id=?').run(JSON.stringify({...JSON.parse(row.row),...extra,outcome,publication:outcome==='SUCCESS'?'SUCCESS':'FAILED'}),receipt)}
 close(){this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');this.db.close()}
}
export async function traverse(e:Evidence,t:Transport,source:Source,wallet:string,end:number,clock:Clock=realClock,publishFault?:()=>void){
 const query=filters(source,wallet,end),queryHash=hash(JSON.stringify({version:VERSION,source,query})),id=`${source}:${wallet}`;
 let c:Checkpoint=e.checkpoint(id)??{version:VERSION,queryHash,source,wallet,filters:query,page:0,cursor:null,seenCursors:[],started:clock.now(),lastTimestamp:null,inflight:false,stop:null};
 if(c.version!==VERSION||c.queryHash!==queryHash||JSON.stringify(c.filters)!==JSON.stringify(query)||c.source!==source||c.wallet!==wallet)throw Error('CHECKPOINT_BINDING');
 if(c.inflight){c.stop='CRASH_INFLIGHT';e.save(id,c);return c}
 if(c.stop)return c;
 while(c.page<LIMITS.pages){
  let rid:number|undefined;
  try{
   e.gate();if(clock.now()+LIMITS.requestMs>c.started+LIMITS.traversalMs)throw Error('TIME_BUDGET');
   const url=new URL(`https://data-api.polymarket.com/v2/${source}`);for(const [k,v]of Object.entries(query))url.searchParams.set(k,v);if(c.cursor!==null)url.searchParams.set('cursor',c.cursor);
   c.inflight=true;e.save(id,c);
   const r=await t.get(url.href,c.started+LIMITS.traversalMs);rid=e.receipt(id,c.page,r,url.href);
   if(r.error)throw Error(r.error);if(r.status!==200)throw Error(`HTTP_${r.status}`);if(r.body.length>LIMITS.body)throw Error('BODY_BUDGET');
   if(clock.now()>c.started+LIMITS.traversalMs)throw Error('TIME_BUDGET');
   const p=page(source,JSON.parse(r.body.toString('utf8')),wallet);
   if(p.next!==null&&(p.next===c.cursor||c.seenCursors.includes(p.next)))throw Error('REPEATED_CURSOR');
   let last=c.lastTimestamp;for(const row of p.rows){if(row.timestamp>Number(query.end)||row.timestamp<Number(query.start)||last!==null&&row.timestamp>last)throw Error('ORDER_OR_WINDOW_ANOMALY');last=row.timestamp}
   // Prepare complete page first. Original arrival is immutable on duplicate/replay.
   const rows=p.rows.map(payload=>{const identity=source==='trades'?tradesIdentity(payload):activityIdentity(payload);const sourceName=source==='trades'?'REST_TRADES':'REST_ACTIVITY';return {payload,normalized:normalizeRestRaw({source:sourceName,identity,wallet,payload,sourceTs:payload.timestamp,firstSeenUtc:r.responseUtc,completedUtc:r.responseUtc,requestStartUtc:r.requestUtc,responseUtc:r.responseUtc,httpStatus:r.status,ageHeader:r.headers.age??null,cacheControl:r.headers['cache-control']??null})}});
   const next:Checkpoint={...c,page:c.page+1,cursor:p.next,seenCursors:p.next===null?c.seenCursors:[...c.seenCursors,p.next],lastTimestamp:last,inflight:false,stop:!p.more?'API_EXHAUSTED':c.page+1===LIMITS.pages?'PAGE_BUDGET':null};
   e.db.exec('BEGIN IMMEDIATE');try{let published=0;for(const row of rows){if(clock.now()>c.started+LIMITS.traversalMs)throw Error('TIME_BUDGET');publishFault?.();e.charge(Buffer.byteLength(JSON.stringify(row))+1024);published+=Number(e.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?)').run(source,row.normalized.identity,id,c.page,JSON.stringify(row)).changes)}if(clock.now()>c.started+LIMITS.traversalMs)throw Error('TIME_BUDGET');e.outcome(rid,'SUCCESS',{records:rows.length,published,duplicates:rows.length-published,nextCursor:p.next,stopReason:next.stop,atApiLimit:rows.length===100});e.save(id,next);if(clock.now()>c.started+LIMITS.traversalMs)throw Error('TIME_BUDGET');e.db.exec('COMMIT');c=next}catch(err){e.db.exec('ROLLBACK');throw Error(`PUBLICATION_FAILURE:${String(err)}`)}
   if(c.stop)return c;
  }catch(error){c={...c,inflight:false,stop:String(error)};if(rid!==undefined)e.outcome(rid,'FAILURE',{error:String(error),stopReason:c.stop});e.save(id,c);return c}
 }
 return c;
}
