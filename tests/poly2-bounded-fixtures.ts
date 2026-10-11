import { writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest } from '../src/compare/poly2-snapshot.js';
import { clockEvidence } from '../src/compare/exact-clock.js';
import type { FenceBinding } from '../src/compare/poly2-fenced-archive.js';
import type { Binding,SourceFrame,TradeFact } from '../src/compare/poly2-prospective.js';
export const cohort=['a','b','c','d','e'].map(c=>'0x'+c.repeat(40));
export const window={startUtc:'2026-01-01T00:00:00Z',endUtc:'2026-01-02T00:00:00Z'};
export const binding:Binding={runId:'bounded',shadowRunId:'shadow',poly2CodeSha:'a'.repeat(40),componentSha256:'b'.repeat(64),cohort,window,evidenceKind:'synthetic',sourcePublicKey:null};
export const fact:TradeFact={sourceRecordId:1,sourceEventId:'source:early',wallet:cohort[0]!,asset:'7',conditionId:'market',side:'BUY',size:1,sourceTs:null,tradedAtUtc:null,ingestedUtc:window.startUtc};
fact.clockEvidence=clockEvidence(fact as unknown as Record<string,unknown>,['ingestedUtc','tradedAtUtc']);
export function frame(cursor:number,kind:SourceFrame['kind'],over:Partial<SourceFrame>={}):SourceFrame {
  const time='2026-01-03T00:00:00.000001Z';
  return {version:1,bindingSha256:digest(binding),cursor,previousCursor:cursor-1,transactionId:'transaction:'+cursor,kind,
    observedUtc:kind==='ACTIVATION'?window.startUtc:time,commitBeforeUtc:kind==='COMMIT'?time:null,commitAfterUtc:kind==='COMMIT'?time:null,
    trades:[],decisions:[],signature:null,fence:kind==='END_FENCE'?{protocol:'all-writers-transaction-drain-v1',registeredWriters:['execution','ingestion'],outstandingTransactions:0,unresolvedFailures:0,throughCursor:cursor-1}:null,...over};
}
/** Synthetic fixture only: lifecycle is generated, never advertised as source proof. */
export function fenceFixture(dir:string,n:number):{b:FenceBinding;fencePath:string;drainPath:string} {
  const b={...binding,expectedWorkers:['bot:runtime-A','backend:runtime-B']}, fencePath=join(dir,'fence.ndjson'),drainPath=join(dir,'drain.ndjson');
  writeFileSync(fencePath,'');writeFileSync(drainPath,'');let seq=0,previous:string|null=null;
  const event=(kind:string,payload:unknown,time=window.startUtc):any=>{const e={seq:++seq,previousSha256:previous,bindingSha256:digest(b),observedUtc:time,kind,payload};previous=digest(e);appendFileSync(fencePath,canonical(e)+'\n');return e;};
  event('ARM',b);event('ENROLL',{worker:'bot:runtime-A'});event('ENROLL',{worker:'backend:runtime-B'});event('ATTEMPT',{transactionId:'early',worker:'bot:runtime-A',epoch:0,retryOf:null});
  let retry:string|null=null;
  for(let i=0;i<n;i++){const transactionId='retry:'+i;event('ATTEMPT',{transactionId,worker:'bot:runtime-A',epoch:0,retryOf:retry});event('ROLLED_BACK',{transactionId});retry=transactionId;}
  const time='2026-01-03T00:00:00.000001Z';
  const close=event('CLOSE',{closingEpoch:0,nextEpoch:1},time);event('ACK',{worker:'bot:runtime-A',epoch:1},time);event('ACK',{worker:'backend:runtime-B',epoch:1},time);
  for(let i=0;i<n;i++){const transactionId='post:'+i;event('ATTEMPT',{transactionId,worker:'bot:runtime-A',epoch:1,retryOf:null},time);event('COMMITTED',{transactionId,witness:{transactionId,worker:'bot:runtime-A',epoch:1,bindingSha256:digest(b),trades:[]}},time);}
  event('COMMITTED',{transactionId:'early',witness:{transactionId:'early',worker:'bot:runtime-A',epoch:0,bindingSha256:digest(b),trades:[fact]}},time);
  const fence=event('FENCE',{protocol:'source-epoch-inflight-v1',runId:b.runId,endpointUtc:window.endUtc,closingEpoch:0,requiredWriterServices:['backend','bot'],expectedWorkers:[...b.expectedWorkers].sort(),acknowledgements:[...b.expectedWorkers].sort(),admitted:n+1,committed:1,rolledBack:n,outstanding:0,highWaterMark:close.seq},time);
  const checkpoint=(fixed:boolean,decisions:unknown[]):any=>{
    let predicate='w.address IN ('+cohort.map(()=>'%s').join(',')+') AND t.ingested_at >= %s AND t.ingested_at <= %s';
    const params:(string|number)[]=[...cohort,window.startUtc,window.endUtc];if(fixed){predicate+=' AND t.id IN (%s)';params.push(1);}
    return {isolation:'repeatable read',readOnly:'on',snapshot:'1:2:',sourceFactsSha256:digest([fact]),sourceRecordIds:[1],querySha256:digest({predicate,params}),decisionsSha256:digest(decisions)};
  };
  event('FREEZE',{sourceFacts:[fact],sourceFactsSha256:digest([fact]),frozenIds:[1],frozenIdsSha256:digest([1]),count:1,fenceReceiptSha256:digest(fence),query:{observedUtc:time,isolation:'REPEATABLE_READ_READ_ONLY',sourceFactsSha256:digest([fact]),sourceSQLCheckpoint:checkpoint(false,[])}},time);
  let previousDrain:string|null=null;
  for(let i=0;i<=Math.max(2,Math.floor(n/10));i++){
    const complete=i===Math.max(2,Math.floor(n/10));
    const decision=complete?{sourceEventId:fact.sourceEventId,paperRecordId:2,signalRecordId:1,sourceIngestedUtc:fact.ingestedUtc,decisionUtc:time,rejectionReason:null,sourceAudit:{recordId:3,action:'paper_order_executed',createdUtc:time,context:{signal_id:1,source_trade_id:fact.sourceEventId}},clockEvidence:clockEvidence({sourceIngestedUtc:fact.ingestedUtc,decisionUtc:time},['sourceIngestedUtc','decisionUtc'])}:null;
    const decisions=decision?[decision]:[],perId={[fact.sourceEventId]:{state:complete?'DECISION_RECORDED':'PENDING',decision}};
    const d={bindingSha256:digest(b),cursor:i+1,previousSha256:previousDrain,frozenIds:[1],frozenIdsSha256:digest([1]),sourceFacts:[fact],sourceFactsSha256:digest([fact]),perId,perIdSha256:digest(perId),counts:{DECISION_RECORDED:complete?1:0,NO_INITIAL_DECISION_EXPECTED:0,PENDING:complete?0:1,CAPTURE_ERROR:0},state:complete?'COMPLETE':'DRAINING',error:null,comparisonEligible:complete,incompleteProperty:null,signature:null,query:{isolation:'REPEATABLE_READ_READ_ONLY',observedUtc:time,tradesSha256:digest([fact]),decisionsSha256:digest(decisions),tradeCount:1,decisionCount:decisions.length,sourceSQLCheckpoint:checkpoint(true,decisions)}};
    previousDrain=digest(d);appendFileSync(drainPath,canonical(d)+'\n');
  }
  return {b,fencePath,drainPath};
}
