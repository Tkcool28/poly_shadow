import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tradesIdentity,activityIdentity,tradeGroupKey} from '../../src/shadow/racing.js';
import {decodeV2Log,classifyFill,normalizeGross} from '../../src/shadow/decoder.js';
const dir='research/rest-evidence-v1/evidence';
const requests=readFileSync(join(dir,'requests.ndjson'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
const manifest=JSON.parse(readFileSync(join(dir,'manifest.json'),'utf8'));
const wallets=new Set<string>(manifest.wallets),rows:any[]=[],incremental:any[]=[];
for(const source of ['trades','activity'])for(const wallet of wallets){
 const pages=requests.filter(r=>r.source===source&&r.wallet===wallet);
 const identities=new Set<string>(),groups=new Set<string>();let firstIds:string[]=[],firstPayload:any[]=[];
 const result:any={source,wallet,requests:pages.length,successfulPages:0,firstPageSize:null,saturated:null,beyondRecords:0,beyondDistinct:0,beyondWalletRelevant:0,beyondEconomicCandidates:0,beyondOtherActivity:0,duplicateRows:0,orderViolations:0,boundaries:[],repeatFirstEqual:null,oldestBeyondAgeSeconds:null};
 for(const receipt of pages){
  if(receipt.status!==200||receipt.error)continue;
  const data=JSON.parse(readFileSync(join(dir,receipt.bodyFile),'utf8'));if(!Array.isArray(data))continue;
  result.successfulPages++;
  const id=(r:any)=>source==='trades'?tradesIdentity(r):activityIdentity(r);
  const ids=data.map(id);
  result.orderViolations+=data.slice(1).filter((r:any,i:number)=>r.timestamp>data[i].timestamp).length;
  if(receipt.page===3){result.repeatFirstEqual=JSON.stringify(ids)===JSON.stringify(firstIds);continue;}
  if(receipt.page===0){result.firstPageSize=data.length;result.saturated=data.length===100;firstIds=ids;firstPayload=data;}
  else result.boundaries.push({offset:receipt.offset,overlapMatches:rows.length?null:null,firstIdentity:ids[0]??null,lastIdentity:ids.at(-1)??null});
  for(let i=0;i<data.length;i++){
   const row=data[i],identity=ids[i],isNew=!identities.has(identity),group=tradeGroupKey(String(row.transactionHash??''),String(row.asset??''),Number(row.size??0).toFixed(6));
   if(!isNew)result.duplicateRows++;
   if(receipt.offset){result.beyondRecords++;if(isNew){result.beyondDistinct++;const relevant=wallets.has(String(row.proxyWallet??'').toLowerCase());if(relevant)result.beyondWalletRelevant++;const trade=source==='trades'||row.type==='TRADE';if(!trade)result.beyondOtherActivity++;if(trade&&!groups.has(group))result.beyondEconomicCandidates++;incremental.push({source,wallet,identity,group,relevant,trade,payload:row});result.oldestBeyondAgeSeconds=Math.max(result.oldestBeyondAgeSeconds??0,Date.parse(receipt.responseUtc)/1000-Number(row.timestamp));}}
   identities.add(identity);if(source==='trades'||row.type==='TRADE')groups.add(group);
  }
 }
 const originalPages=pages.filter(r=>r.status===200&&r.page<3&&!r.error).map(r=>JSON.parse(readFileSync(join(dir,r.bodyFile),'utf8'))).filter(Array.isArray);
 result.boundaries=originalPages.slice(1).map((data,i)=>({offset:(i+1)*98,overlapMatches:JSON.stringify(originalPages[i].slice(-2).map(source==='trades'?tradesIdentity:activityIdentity))===JSON.stringify(data.slice(0,2).map(source==='trades'?tradesIdentity:activityIdentity))}));
 rows.push(result);
}
const chain:any[]=[],chainGroups=new Set<string>();
for(const r of requests.filter(r=>r.source==='CHAIN_RECEIPT')){
 let matched=0,errors=0;const body=r.status===200?JSON.parse(readFileSync(join(dir,r.bodyFile),'utf8')):null;
 if(body?.result?.transactionHash?.toLowerCase()===r.tx.toLowerCase()&&body.result.status==='0x1')for(const log of body.result.logs??[]){try{const d=decodeV2Log(log);if(d?.kind==='OrderFilled'){const role=classifyFill(d,wallets);if(role&&role.role!=='TAKER_LEG_REDUNDANT'){const n=normalizeGross(d);chainGroups.add(tradeGroupKey(log.transactionHash,d.tokenId,n.shares));matched++;}}}catch{errors++;}}
 chain.push({tx:r.tx,status:r.status??null,receiptValid:body?.result?.transactionHash?.toLowerCase()===r.tx.toLowerCase()&&body.result.status==='0x1',eligibleDecodedFills:matched,decodeErrors:errors});
}
const totals={requests:requests.length,successfulRestRequests:requests.filter(r=>['trades','activity'].includes(r.source)&&r.status===200&&!r.error).length,beyondDistinct:incremental.length,beyondWalletRelevant:incremental.filter(r=>r.relevant).length,uniqueBeyondTradeCandidateGroups:new Set(incremental.filter(r=>r.trade).map(r=>r.group)).size,beyondChainCorroboratedIdentities:incremental.filter(r=>r.trade&&chainGroups.has(r.group)).length};
const out={scope:manifest.scope,completeness:'UNKNOWN_UNPROVEN',rows,chain,totals,limitations:['Current public sample cannot reconstruct stopped-run coverage or measure source discovery latency.','Coarse economic candidate grouping is frozen repo logic, not proof of unique economic events.','Only at most six receipts sampled; all other chain matches unknown.']};
writeFileSync(join(dir,'summary.json'),JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
