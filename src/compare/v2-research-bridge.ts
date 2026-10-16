/** Read-only bridge: verified v2 research rows -> existing frozen Phase 4 groups.
 * Does not grant publication, capture authority, or prove same-window Poly2 coverage.
 * It never substitutes event/source times for first-observed or normalized clocks.
 */
import {join} from 'node:path';
import {readNdjson} from './ndjson.js';
import {addShadowObservation, type CohortFn, type ShadowGroup} from './phase4.js';
import type {SourceObservationRow} from '../shadow/racing.js';
import {analyze} from '../../research/v2-cursor-v1/replay.js';

type ResearchRow = {
 source: string; identity: string; traversal: string; page: number;
 row: {payload: Record<string,unknown>; normalizationUtc: string; normalized: SourceObservationRow};
};
export async function readVerifiedV2Groups(
 evidenceDir: string, cohort: CohortFn, window: {startUtc:string; endUtc:string},
): Promise<Map<string, ShadowGroup>> {
 // The existing replay checks raw response hashes, version-2 measured clocks,
 // normalized row consistency and the frozen publication/summary digest.
 const summary = analyze(evidenceDir, true);
 if(summary.completeness !== 'UNKNOWN_UNPROVEN') throw Error('V2_BRIDGE_UNEXPECTED_COMPLETENESS');
 const groups = new Map<string, ShadowGroup>();
 let rows=0;
 for await (const entry of readNdjson<ResearchRow>(join(evidenceDir,'observations.ndjson'))) {
  if(++rows>3000) throw Error('V2_BRIDGE_RECORD_BUDGET');
  const o=entry.row?.normalized;
  if(!o || o.identity!==entry.identity
   || !['REST_TRADES','REST_ACTIVITY'].includes(o.source)
   || entry.source!==(o.source==='REST_TRADES'?'trades':'activity')
   || entry.row.normalizationUtc!==o.completedUtc
   || typeof o.sourceFirstSeenUtc!=='string'
   || Date.parse(o.completedUtc)<Date.parse(o.sourceFirstSeenUtc))
   throw Error('V2_BRIDGE_IDENTITY_OR_CLOCK_MISMATCH');
  addShadowObservation(groups,o,cohort,window);
 }
 return groups;
}
