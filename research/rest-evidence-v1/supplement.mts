/** Offline-only enrichment of the retained bounded sample. No network code. */
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tradesIdentity,activityIdentity,tradeGroupKey} from '../../src/shadow/racing.js';
const dir='research/rest-evidence-v1/evidence';
const receipts=readFileSync(join(dir,'requests.ndjson'),'utf8').trim().split('\n').map(s=>JSON.parse(s));
if(receipts.length>46)throw Error('sample request budget violated');
const firstGroups=new Set<string>(),beyondGroups=new Set<string>(),beyond:any[]=[],seen=new Map<string,Set<string>>();
const pageCosts:any[]=[];
for(const r of receipts){
 if(!['trades','activity'].includes(r.source)||r.status!==200||r.error||r.page===3)continue;
 const data=JSON.parse(readFileSync(join(dir,r.bodyFile),'utf8'));if(!Array.isArray(data)||data.length>100)throw Error('sample page budget violated');
 const ages=data.map((x:any)=>Date.parse(r.responseUtc)/1000-x.timestamp);
 pageCosts.push({source:r.source,wallet:r.wallet,page:r.page,offset:r.offset,newestAgeSeconds:Math.min(...ages),oldestAgeSeconds:Math.max(...ages),within30Seconds:ages.filter((n:number)=>n>=0&&n<=30).length,within300Seconds:ages.filter((n:number)=>n>=0&&n<=300).length,bytes:r.bytes});
 const key=r.source+'|'+r.wallet,ids=seen.get(key)??new Set<string>();seen.set(key,ids);
 for(const x of data){
  const identity=r.source==='trades'?tradesIdentity(x):activityIdentity(x),trade=r.source==='trades'||x.type==='TRADE';
  const group=tradeGroupKey(x.transactionHash??'',String(x.asset??''),Number(x.size??0).toFixed(6));
  if(r.page===0&&trade)firstGroups.add(group);
  if(r.page>0&&!ids.has(identity)){beyond.push({source:r.source,wallet:r.wallet,identity,group,trade});if(trade)beyondGroups.add(group);}
  ids.add(identity);
 }
}
const totals={distinctBeyondSourceIdentities:beyond.length,beyondTradeIdentities:beyond.filter(r=>r.trade).length,beyondOtherActivity:beyond.filter(r=>!r.trade).length,beyondTradeCandidateGroups:beyondGroups.size,candidatesAbsentFromAllSampledFirstPages:[...beyondGroups].filter(g=>!firstGroups.has(g)).length,candidatesAlreadySupportedOnSampledFirstPages:[...beyondGroups].filter(g=>firstGroups.has(g)).length,beyondTradeIdentitiesSupportingFirstPageCandidates:beyond.filter(r=>r.trade&&firstGroups.has(r.group)).length,beyondWithin30Seconds:pageCosts.filter(r=>r.offset).reduce((n,r)=>n+r.within30Seconds,0),beyondWithin300Seconds:pageCosts.filter(r=>r.offset).reduce((n,r)=>n+r.within300Seconds,0)};
const cacheControls:Record<string,number>={};for(const r of receipts.filter(r=>['trades','activity'].includes(r.source))){const k=String(r.headers['cache-control']);cacheControls[k]=(cacheControls[k]??0)+1;}
const out={scope:'offline bounded sample enrichment; frozen repository JS identities and candidate grouping',totals,pageAgeAndByteCosts:pageCosts,totalResponseBytes:receipts.reduce((n,r)=>n+r.bytes,0),maxResponseBytes:Math.max(...receipts.map(r=>r.bytes)),cacheControls,chainReconciliation:{state:'BLOCKED_HTTP_403',confirmed:0,notMatched:null,unknown:beyond.filter(r=>r.trade).length}};
writeFileSync(join(dir,'supplemental.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(totals));
