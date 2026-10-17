/** Stage 1 v2 classification amendment; phase4.ts remains immutable v1 history. */
import {compare,validatePoly2Export,assertExportWindowMatches,addShadowObservation, type Poly2Export, type ShadowGroup, type CohortFn, type ComparisonResult} from './phase4.js';
import type {SourceObservationRow} from '../shadow/racing.js';
import {readNdjson} from './ndjson.js';
import {join} from 'node:path';
import {epochMicros,secondsMicros,inWindow} from './exact-clock.js';
export const COMPARATOR_VERSION='stage1-v2';
export type Origin='PROSPECTIVE'|'RETROSPECTIVE_RECOVERY'|'ORIGIN_UNKNOWN'|'EVENT_OUTSIDE_WINDOW';
export function origin(clocks:(string|number|null|undefined)[],window:Poly2Export['window']):Origin {
 const times=clocks.filter(v=>v!=null).map(v=>typeof v==='number'?secondsMicros(v):epochMicros(v!));
 if(!times.length)return 'ORIGIN_UNKNOWN';
 if(times.some(t=>t<epochMicros(window.startUtc)))return 'RETROSPECTIVE_RECOVERY';
 if(times.some(t=>t>epochMicros(window.endUtc)))return 'EVENT_OUTSIDE_WINDOW';
 return 'PROSPECTIVE';
}
export interface CoverageKnowledge {shadowComplete:boolean;poly2Complete:boolean;proof:string|null}
export type V2Record=Omit<ComparisonResult['records'][number],'match'>&{
 match:ComparisonResult['records'][number]['match']|'INDETERMINATE';unpairedSide?:'SHADOW'|'POLY2';
};
export function compareV2(data:Poly2Export,groups:Map<string,ShadowGroup>,window:Poly2Export['window'],cohort:CohortFn,
 coverage:CoverageKnowledge={shadowComplete:false,poly2Complete:false,proof:null}) {
 validatePoly2Export(data);assertExportWindowMatches(data,window);
 const omitted:{system:'SHADOW'|'POLY2';identity:string;origin:Origin}[]=[];
 const pg=new Map<string,ShadowGroup>();
 for(const [key,g] of groups){
  const kind=(g as ShadowGroup&{originClass?:Origin}).originClass??origin(g.members.length?g.members.map(m=>m.sourceTs??m.blockTimestamp):[g.sourceTs],window);
  if(kind==='PROSPECTIVE')pg.set(key,g);else omitted.push({system:'SHADOW',identity:key,origin:kind});
 }
 const rows=data.rows.filter((r,i)=>{
  if(cohort(r.wallet)!=='CONTROLLED_OVERLAP'||!inWindow(r.ingestedUtc,window))return true;
  const kind=origin([r.tradedAtUtc??r.sourceTs],window);
  if(kind==='PROSPECTIVE')return true;
  omitted.push({system:'POLY2',identity:String((r as typeof r&{sourceEventId?:string}).sourceEventId??i),origin:kind});return false;
 });
 const base=compare({...data,rows},pg,window,cohort);
 const records:V2Record[]=base.records.map(r=>{
  if(r.match==='SHADOW_ONLY'&&!(coverage.poly2Complete&&coverage.proof))return {...r,match:'INDETERMINATE',unpairedSide:'SHADOW',note:'Counterpart capture coverage unresolved; absence is not a confirmed miss'};
  if(r.match==='POLY2_ONLY'&&!(coverage.shadowComplete&&coverage.proof))return {...r,match:'INDETERMINATE',unpairedSide:'POLY2',note:'Shadow coverage/pagination unresolved; absence is not a confirmed miss'};
  return r;
 });
 const indeterminate=records.filter(r=>r.match==='INDETERMINATE').length;
 return {...base,version:COMPARATOR_VERSION,records,retrospectiveAndUnknown:omitted,
  coverage:{...base.coverage,shadowOnly:records.filter(r=>r.match==='SHADOW_ONLY').length,poly2Only:records.filter(r=>r.match==='POLY2_ONLY').length,indeterminate,
   shadowUnionCoveragePct:indeterminate?null:base.coverage.shadowUnionCoveragePct,poly2UnionCoveragePct:indeterminate?null:base.coverage.poly2UnionCoveragePct,
   upstreamCompleteness:'UNKNOWN_UNPROVEN',counterpartKnowledge:coverage,
   state:indeterminate?'UNKNOWN_UNPROVEN':'RESOLVED_NONAMBIGUOUS_UNION',proof:coverage.proof},
  rowIdentities:rows.filter(r=>cohort(r.wallet)==='CONTROLLED_OVERLAP'&&inWindow(r.ingestedUtc,window)).map((r,i)=>String((r as typeof r&{sourceEventId?:string}).sourceEventId??i))};
}

export async function readShadowGroupsV2(dir:string,cohort:CohortFn,window:Poly2Export['window']) {
 const groups=new Map<string,ShadowGroup&{originClass?:Origin}>();
 for await(const o of readNdjson<SourceObservationRow>(join(dir,'source_observations.ndjson'))){
  if(cohort(o.wallet)!=='CONTROLLED_OVERLAP'||!inWindow(o.sourceFirstSeenUtc,window))continue;
  addShadowObservation(groups,o,cohort,window);
  const g=groups.get(o.groupKey)!;const kind=origin([o.sourceTs??o.blockTimestamp],window);
  const priority:Origin[]=['ORIGIN_UNKNOWN','PROSPECTIVE','EVENT_OUTSIDE_WINDOW','RETROSPECTIVE_RECOVERY'];
  if(!g.originClass||priority.indexOf(kind)>priority.indexOf(g.originClass))g.originClass=kind;
 }
 return groups;
}
