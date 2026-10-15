/** Exactly one explicit GitHub Actions campaign. Never a production collector. */
import {existsSync,mkdirSync,writeFileSync,readdirSync,statSync,readFileSync,appendFileSync} from 'node:fs';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {Evidence,PublicTransport,WALLETS,LIMITS,traverse,hash,fileHash,type Reply} from './adapter.js';
import {assertPrelaunchDisk} from '../../src/shadow/storage-budget.js';
import {analyze} from './replay.js';
import {authorize,CAMPAIGN,BASE} from '../v2-corrected-v1-1/authorization.js';
const dir=authorize(process.env);
if(existsSync(dir))throw Error('CAMPAIGN_ALREADY_EXISTS');mkdirSync(dir,{recursive:true});
const started=Date.now(),end=Math.floor(started/1000),t=new PublicTransport();let failure:string|null=null;let disk:unknown;let e:Evidence|undefined;let peakRss=process.memoryUsage().rss;let requests=0;
const sampleMemory=setInterval(()=>{peakRss=Math.max(peakRss,process.memoryUsage().rss)},10);
try{
 disk=assertPrelaunchDisk(dir);e=new Evidence(dir);
 const auxiliary=async(id:string,url:string)=>{if(Date.now()>started+115000)throw Error('CAMPAIGN_TIME_BUDGET');e!.gate();const r=await t.get(url,started+120000);const rid=e!.receipt(id,0,r,url);e!.outcome(rid,r.status===200&&!r.error?'SUCCESS':'FAILURE');return r};
 await auxiliary('OPENAPI','https://data-api.polymarket.com/v2/openapi.json');
 await auxiliary('STATUS','https://data-api.polymarket.com/v2/status');
 for(const source of ['trades','activity'] as const)for(const wallet of WALLETS){
  if(Date.now()>started+100000)throw Error('CAMPAIGN_TIME_BUDGET');
  const legacy=new URL(`https://data-api.polymarket.com/${source}`);legacy.searchParams.set('user',wallet);legacy.searchParams.set('limit','100');legacy.searchParams.set('start',String(end-3*365*86400));legacy.searchParams.set('end',String(end));if(source==='trades')legacy.searchParams.set('takerOnly','false');
  await auxiliary(`v1:${source}:${wallet}`,legacy.href);
  await traverse(e,t,source,wallet,end);
 }
 // One previously used, explicitly public Polygon host; no credentials,
 // no redirects, no provider rotation, no retry, max ONE receipt.
 const candidate=e.db.prepare("SELECT row FROM observations WHERE page>0 AND source='trades' ORDER BY identity LIMIT 1").get() as {row:string}|undefined;
 if(candidate){
  e.gate();const tx=JSON.parse(candidate.row).payload.transactionHash;
  const requestUtc=new Date().toISOString(),began=Date.now();let body=Buffer.alloc(0),status=0,error:string|undefined;const headers:Record<string,string>={};
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),Math.min(3000,Math.max(1,started+120000-Date.now())));
  try{const r=await fetch('https://polygon-bor-rpc.publicnode.com',{method:'POST',redirect:'error',signal:controller.signal,headers:{'Content-Type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_getTransactionReceipt',params:[tx]})});status=r.status;for(const k of ['date','content-type','retry-after']){const v=r.headers.get(k);if(v)headers[k]=v.slice(0,8192)}const reader=r.body?.getReader();if(!reader)throw Error('MISSING_BODY');try{while(true){const c=await reader.read();if(c.done)break;const remaining=LIMITS.body-body.length;body=Buffer.concat([body,c.value.subarray(0,remaining)]);if(c.value.length>remaining){await reader.cancel();throw Error('BODY_BUDGET')}e.gate()}}catch(err){controller.abort();try{await reader.cancel()}catch{};throw err}finally{reader.releaseLock()}}catch(err){error=String(err)}finally{clearTimeout(timer)}
  const reply:Reply={status,body,headers,requestUtc,responseUtc:new Date().toISOString(),elapsedMs:Date.now()-began,...(error?{error}:{})};const rid=e.receipt(`CHAIN:${tx}`,0,reply,'https://polygon-bor-rpc.publicnode.com');e.outcome(rid,status===200&&!error?'SUCCESS':'FAILURE');
 }
 requests=t.count;
}catch(error){failure=String(error)}finally{peakRss=Math.max(peakRss,process.memoryUsage().rss);if(e){
 for(const r of e.db.prepare('SELECT id,traversal,page,row,body FROM receipts ORDER BY id').iterate() as Iterable<{id:number;traversal:string;page:number;row:string;body:Uint8Array}>){e.charge(r.body.length+Buffer.byteLength(r.row)+1024);const file=`response-${String(r.id).padStart(3,'0')}.json`;writeFileSync(join(dir,file),r.body);appendFileSync(join(dir,'requests.ndjson'),JSON.stringify({id:r.id,traversal:r.traversal,page:r.page,...JSON.parse(r.row),bodyFile:file})+'\n')}
 for(const r of e.db.prepare('SELECT source,identity,traversal,page,row FROM observations ORDER BY source,identity').iterate() as Iterable<{source:string;identity:string;traversal:string;page:number;row:string}>){e.charge(Buffer.byteLength(r.row)+1024);appendFileSync(join(dir,'observations.ndjson'),JSON.stringify({...r,row:JSON.parse(r.row)})+'\n')}
 for(const c of e.db.prepare('SELECT id,row FROM checkpoints ORDER BY id').iterate() as Iterable<{id:string;row:string}>){e.charge(Buffer.byteLength(c.row)+1024);appendFileSync(join(dir,'checkpoints.ndjson'),JSON.stringify({id:c.id,...JSON.parse(c.row)})+'\n')}
 e.close();}
 writeFileSync(join(dir,'campaign.json'),JSON.stringify({version:2,evidenceVersion:2,campaignId:CAMPAIGN,adapterBaseline:BASE,scope:'one current-time bounded public sample; no production capture',sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),wallets:WALLETS,limits:LIMITS,startedUtc:new Date(started).toISOString(),completedUtc:new Date().toISOString(),end,elapsedMs:Date.now()-started,restRequests:t.count,requests,peakRss,disk,failure,completeness:'UNKNOWN_UNPROVEN',chainMaxRequests:1},null,2)+'\n');
 try{analyze(dir)}catch(error){failure??=String(error);writeFileSync(join(dir,'analysis-error.txt'),String(error)+'\n')}
 peakRss=Math.max(peakRss,process.memoryUsage().rss,process.resourceUsage().maxRSS*1024);const finalCampaign=JSON.parse(readFileSync(join(dir,'campaign.json'),'utf8'));writeFileSync(join(dir,'campaign.json'),JSON.stringify({...finalCampaign,peakRss,elapsedMs:Date.now()-started},null,2)+'\n');clearInterval(sampleMemory);
 const files=Object.fromEntries(readdirSync(dir).sort().filter(n=>statSync(join(dir,n)).isFile()&&n!=='manifest.json').map(n=>[n,{bytes:statSync(join(dir,n)).size,sha256:fileHash(join(dir,n))}]));
 writeFileSync(join(dir,'manifest.json'),JSON.stringify({version:1,files},null,2)+'\n');console.log(JSON.stringify({failure,restRequests:t.count,peakRss,manifestSha256:hash(readFileSync(join(dir,'manifest.json')))}));
}
if(failure)process.exitCode=1;
