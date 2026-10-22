/** Diagnostic-only keyset progress. The journal remains publication authority.
 * A cursor is a seek hint, never a snapshot or source-completeness proof. */
import {openSync,closeSync,fsyncSync,writeFileSync,renameSync,readFileSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
export type RestAcquisitionMode='FRESH_DISCOVERY'|'HISTORICAL_CONTINUATION';
export type Continuation={version:1;binding:string;query:Record<string,string>;cursor:string|null;pages:number;lastTimestamp:number|null;boundary:string[];savedUtc:string;exhausted:boolean;previousCursor:string|null};
export const queryBinding=(endpoint:string,query:Record<string,string>)=>createHash('sha256').update(JSON.stringify({version:1,endpoint,query,limit:100,order:'TIMESTAMP_DESC',maxPagesPerTurn:1})).digest('hex');
export function readContinuation(dir:string,source:string,wallet:string):Continuation|null{
 const path=join(dir,`rest-continuation-${source}-${wallet}.json`);
 try{if(statSync(path).size>32768)throw Error('CURSOR_STATE_TOO_LARGE');const c=JSON.parse(readFileSync(path,'utf8')) as Continuation;
 if(c.version!==1||typeof c.binding!=='string'||!c.query||!Number.isSafeInteger(c.pages)||c.pages<1||!Array.isArray(c.boundary)||c.boundary.length>100||c.boundary.some(x=>typeof x!=='string')||typeof c.exhausted!=='boolean'||!Number.isFinite(Date.parse(c.savedUtc))||c.cursor!==null&&(typeof c.cursor!=='string'||!c.cursor||c.cursor.length>8192)||c.lastTimestamp!==null&&!Number.isSafeInteger(c.lastTimestamp))throw Error('CURSOR_STATE_INVALID');return c;
 }catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
}
export function saveContinuation(dir:string,source:string,wallet:string,c:Continuation){
 // Flush publication + receipt before advancing. Crash before rename replays
 // the prior page; exact native identity dedup retains original clocks.
 for(const name of ['rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson','rest_poll_receipts.ndjson']){
  let fd:number;try{fd=openSync(join(dir,name),'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')continue;throw e;}try{fsyncSync(fd);}finally{closeSync(fd);}
 }
 const path=join(dir,`rest-continuation-${source}-${wallet}.json`),tmp=path+'.'+randomUUID()+'.tmp';
 const fd=openSync(tmp,'wx',0o600);try{writeFileSync(fd,JSON.stringify(c)+'\n');fsyncSync(fd);}finally{closeSync(fd);}renameSync(tmp,path);
 const d=openSync(dir,'r');try{fsyncSync(d);}finally{closeSync(d);}
}
