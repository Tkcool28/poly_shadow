/** Native-test bridge: calls actual production comparator and Shadow reader reducer. */
import { readFileSync } from 'node:fs';
import { compare, buildShadowGroups, type Poly2ExportRow } from '../src/compare/phase4.js';
import { epochMicros } from '../src/compare/exact-clock.js';
import type { SourceObservationRow } from '../src/shadow/racing.js';
import { fixtureArchive } from './poly2-fixtures.js';
import { validatePoly2Archive } from '../src/compare/poly2-archive.js';
const data = JSON.parse(readFileSync(0,'utf8')) as {window:{startUtc:string;endUtc:string}; clocks:string[]};
const results = data.clocks.map(clock => {
  const row: Poly2ExportRow = {wallet:'0x'+'a'.repeat(40),txHash:null,asset:'7',conditionId:null,side:'BUY',size:100,price:null,sourceTs:null,ingestedUtc:clock,normalizedUtc:null,decisionUtc:null,signalUtc:null,source:'native-matrix',freshnessAgeSec:null,freshnessRejection:null,policyEligible:null,copyabilityOutcome:null,rejectionReason:null,paperOutcome:null};
  const observation: SourceObservationRow = {source:'REST_TRADES',wallet:row.wallet,identity:'original',asset:'7',side:'BUY',size:'100',price:null,sourceTs:null,blockTimestamp:null,sourceFirstSeenUtc:clock,completedUtc:clock,role:'UNKNOWN',groupKey:'matrix',hydration:'PARTIAL'};
  // Synthetic custody only: exercise the actual archive seal/replay membership,
  // not a claim of a native source-boundary capture receipt.
  const archive = fixtureArchive([row], data.window, [row.wallet]);
  validatePoly2Archive(archive, [row.wallet], data.window);
  return {clock,epochMicros:epochMicros(clock).toString(),included:compare({window:data.window,rows:[row]},new Map(),data.window,()=> 'CONTROLLED_OVERLAP').records.length === 1,shadowIncluded:buildShadowGroups([observation],()=> 'CONTROLLED_OVERLAP',data.window).size === 1,archiveIncluded:archive.rows.length === 1,archiveClockEvidence:archive.evidence.clockAudit[1]!.ingestedUtc};
});
process.stdout.write(JSON.stringify(results));
