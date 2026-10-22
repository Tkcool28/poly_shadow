/** Additional diagnostic evidence only; no certified fields or matching rules. */
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import type {DiagnosticWindow} from './uncertified-diagnostic.js';
export async function diagnosticReadiness(dir:string,window:DiagnosticWindow,read:<T>(path:string)=>AsyncIterable<T>){
 const rest:Record<string,any>={};
 for(const src of ['REST_TRADES','REST_ACTIVITY'])rest[src]={pages:0,budgetStops:0,cursorInvalidations:0,latestTraversal:null,latestByWallet:{},coverage:'UNKNOWN_UNPROVEN'};
 const receipts=join(dir,'rest_poll_receipts.ndjson');
 if(existsSync(receipts))for await(const r of read<Record<string,any>>(receipts)){
  const lane=rest[String(r.source)];if(!lane)continue;
  if(r.recordType==='REST_PAGE')lane.pages++;
  if(r.recordType==='REST_CURSOR_INVALIDATION')lane.cursorInvalidations++;
  if(r.recordType==='REST_POLL'){
   if(['REQUEST_BUDGET_EXHAUSTED','REQUEST_BUDGET','TIME_BUDGET'].includes(r.stopReason))lane.budgetStops++;
   // Explicit invalidation records are counted once above, not again per poll.
   const progress={wallet:r.wallet,atUtc:r.responseUtc??r.atUtc??null,mode:r.acquisitionMode??'UNKNOWN',pages:r.pageCount,identitiesObserved:r.itemCount,newIdentities:r.newIdentities,stopReason:r.stopReason,
    continuationAvailable:r.continuationAvailable??null,unvisitedRange:r.unvisitedRange??'UNKNOWN_UNPROVEN',cumulativePages:r.cumulativePages??null};
   lane.latestTraversal=progress;
   if(typeof r.wallet==='string'&&(Object.keys(lane.latestByWallet).length<10||Object.hasOwn(lane.latestByWallet,r.wallet)))lane.latestByWallet[r.wallet]=progress;
  }
 }
 let chain:Record<string,any>|null=null;
 const tail=join(dir,'chain_tail_proofs.ndjson');
 if(existsSync(tail))for await(const r of read<Record<string,any>>(tail))chain=r;
 const samples:Record<string,any>[]=[];let clockSamples=0,unhealthy=0,last:number|null=null,maxGap=0,first:number|null=null;
 const clocks=join(dir,'clock_health.ndjson');
 if(existsSync(clocks))for await(const r of read<Record<string,any>>(clocks)){
  clockSamples++;const stamp=Date.parse(r.observedUtc);if(!Number.isFinite(stamp)){unhealthy++;continue;}
  if(first===null)first=stamp;if(last!==null)maxGap=Math.max(maxGap,stamp-last);last=stamp;
  if(r.state!=='HEALTHY'||r.ntpSynchronized!==true||!Number.isFinite(r.estimatedHostOffsetSeconds)||Math.abs(r.estimatedHostOffsetSeconds)>.1||!Number.isFinite(r.rootDistanceSeconds)||r.rootDistanceSeconds<0||r.rootDistanceSeconds>.1)unhealthy++;
  samples.push(r);if(samples.length>32)samples.shift();
 }
 const windowCovered=first!==null&&first<=Date.parse(window.startUtc)&&last!==null&&last>=Date.parse(window.endUtc)-120000&&maxGap<=120000;
 const healthy=clockSamples>0&&!unhealthy&&windowCovered;
 return {rest,chain:chain??{headState:'UNKNOWN',coverage:'UNKNOWN_UNPROVEN',reason:'NO_CHAIN_HEAD_OR_SCAN_EVIDENCE'},
  clockHealth:{state:healthy?'HEALTHY':'UNKNOWN_OR_UNCERTAIN',sampleCount:clockSamples,unhealthySamples:unhealthy,maxSampleGapSeconds:maxGap/1000,windowCovered,latestSamples:samples,retainedSampleLimit:32,providerClockOffset:'UNKNOWN_NOT_MEASURED'},
  matchedEventTimingSupport:healthy?'OBSERVED_HOST_CLOCK_DIFFERENCES_SUPPORTED':'UNKNOWN',
  eventTimeLatencySupport:'UNCERTAIN_PROVIDER_CLOCK_OFFSET_NOT_MEASURED'};
}
