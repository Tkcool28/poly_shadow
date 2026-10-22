import {it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildDiagnosticReport} from '../src/compare/uncertified-diagnostic.js';
import {WALLETS} from '../research/v2-cursor-v1/adapter.js';
const start='2026-01-01T00:00:00Z',end='2026-01-02T00:00:00Z';
const t=(n:number)=>new Date(Date.parse(start)+n*1000).toISOString();
const tx='0x'+'a'.repeat(64);
function row(extra:any={}){return {wallet:WALLETS[0],sourceRecordId:1,sourceEventId:'native-poly2',txHash:tx,asset:'7',conditionId:'m',side:'BUY',size:2,price:.5,sourceTs:Date.parse(t(1))/1000,tradedAtUtc:t(1),ingestedUtc:t(4),normalizedUtc:null,decisionUtc:null,signalUtc:null,source:'POLY2_INGESTION',freshnessAgeSec:3,freshnessRejection:null,policyEligible:null,copyabilityOutcome:null,rejectionReason:null,paperOutcome:null,...extra};}
function obs(source:string,seen:number,completed:number,extra:any={}){return {wallet:WALLETS[0],source,identity:source+'-native',side:'BUY',asset:'7',size:'2.000000',price:'0.500000',sourceTs:Date.parse(t(1))/1000,blockTimestamp:null,sourceFirstSeenUtc:t(seen),completedUtc:t(completed),role:'UNKNOWN',groupKey:`econ:${tx}:7:2.000000`,hydration:'FULL',...extra};}
async function run(rows:any[],observations:any[]){
 const dir=mkdtempSync(join(tmpdir(),'diagnostic-report-'));
 try{
  writeFileSync(join(dir,'source_observations.ndjson'),observations.map(o=>JSON.stringify(o)).join('\n')+'\n');
  const software={shadowGitSha:'1'.repeat(40),poly2CheckoutGitSha:'2'.repeat(40),poly2RuntimeImageId:'sha256:'+'3'.repeat(64),poly2RuntimeRevisionLabel:'2'.repeat(40),runtimeStable:true};
  const pre={tradeIdHighWater:0,decisionLogIdHighWater:0,cohort:WALLETS,approvedWallets:WALLETS};
  const manifest:any={schemaVersion:1,classification:'UNCERTIFIED_DIAGNOSTIC',certified:false,state:'COMPLETE',runId:'fixture',window:{startUtc:start,endUtc:end},cohort:WALLETS,software,poly2Preflight:pre,poly2EndPreflight:{...pre,tradeIdHighWater:rows.length}};
  const exp:any={classification:'UNCERTIFIED_DIAGNOSTIC',certified:false,runId:'fixture',window:manifest.window,cohort:WALLETS,approvedWalletsAtExport:WALLETS,cohortStableAtExport:true,software,rows,exportedUtc:end,coverage:{tradeQueryComplete:true,decisionAuditCompleteWithinConfiguredCap:true,mutablePresentDayStateUsed:false,databaseWrites:0,tradeIdRange:{after:0,through:rows.length},decisionLogIdRange:{after:0,through:0}}};
  return await buildDiagnosticReport({manifest,poly2Export:exp,shadowDataDirectory:dir});
 }finally{rmSync(dir,{recursive:true,force:true});}
}
it('uses completed normalization clocks for lane/union leads, de-duplicates and reports unknown prices',async()=>{
 const rest=obs('REST_TRADES',2,3);
 const r=await run([row()],[obs('CHAIN',1,5),rest,rest,obs('REST_ACTIVITY',2,3.5)]);
 expect(r.discovery.shadowUnionUnique).toBe(1);expect(r.overall.matched).toBe(1);expect(r.overall.duplicateShadowObservationRows).toBe(1);
 const methods=Object.fromEntries(r.timing.map(x=>[x.method,x]));
 expect(methods.CHAIN!.signedShadowLead.medianSeconds).toBe(-1);
 expect(methods.SHADOW_UNION!.signedShadowLead.medianSeconds).toBe(1);
 expect(methods.REST_TRADES!.detectionLatency.p90Seconds).toBe(2);
 expect(r.examples[0]!.nativeSourceIdentities).toEqual({CHAIN:['CHAIN-native'],REST_TRADES:['REST_TRADES-native'],REST_ACTIVITY:['REST_ACTIVITY-native']});
 expect(r.priceOpportunity.state).toBe('PRICE_ADVANTAGE_UNKNOWN');
});
it('preserves probable/ambiguous distinctions without claiming confident timing',async()=>{
 const probable=await run([row({txHash:null})],[obs('CHAIN',2,3)]);
 expect(probable.discovery.matchingConfidence.probable).toBe(1);expect(probable.examples).toHaveLength(0);
 const ambiguous=await run([row(),row({sourceRecordId:2,sourceEventId:'another-native'})],[obs('CHAIN',2,3)]);
 expect(ambiguous.overall.ambiguous).toBe(2);expect(ambiguous.discovery.matchingConfidence.high).toBe(0);
});
it('keeps one-sided observations indeterminate and retrospective/exact-end rows out of speed metrics',async()=>{
 const r=await run([],[obs('CHAIN',2,3),obs('REST_ACTIVITY',2,3,{identity:'history',groupKey:'econ:historical:7:2',sourceTs:Date.parse(start)/1000-1}),obs('REST_TRADES',86400,86400)]);
 expect(r.overall.indeterminate).toBe(1);expect(r.overall.shadowOnlyObserved).toBe(1);expect(r.comparison.coverage.shadowOnly).toBe(0);
 expect(r.retrospectiveAndUnknown.shadow).toHaveLength(1);
 expect(r.timing.every(x=>x.detectionLatency.samples===0)).toBe(true);
});
it('scopes economic candidate groups by wallet while retaining original source group references',async()=>{
 const r=await run([row(),row({wallet:WALLETS[1],sourceRecordId:2,sourceEventId:'second-wallet'})],
  [obs('CHAIN',2,3),obs('CHAIN',2,3,{wallet:WALLETS[1]})]);
 expect(r.discovery.shadowUnionUnique).toBe(2);expect(r.overall.matched).toBe(2);
 expect(r.wallets[0]!.counts.matched).toBe(1);expect(r.wallets[1]!.counts.matched).toBe(1);
 expect(r.examples[0]!.sourceGroupReferences).toEqual(r.examples[1]!.sourceGroupReferences);
});
it('excludes explicitly recovered in-window records from prospective matching and timing without rewriting clocks',async()=>{
 const recovered=obs('REST_TRADES',2,3,{acquisitionMode:'HISTORICAL_CONTINUATION'});
 const r=await run([row()],[recovered]);expect(r.discovery.shadowUnionUnique).toBe(0);expect(r.discovery.matchingConfidence.high).toBe(0);
 expect(r.timing.every(x=>x.detectionLatency.samples===0)).toBe(true);expect(r.sources.find(x=>x.source==='REST_TRADES')!.acquisitionCounts).toMatchObject({prospective:0,retrospective:1});
 expect(r.acquisitionReadiness.matchedEventTimingSupport).toBe('UNKNOWN');
});
