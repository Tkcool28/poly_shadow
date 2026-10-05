/**
 * Phase 4 comparison CLI (offline, read-only).
 *
 *   tsx src/compare/cli.ts <shadowDataDir> <poly2-export.json> <cohorts.json> <outDir>
 *
 * cohorts.json (frozen before the window — handoff §12):
 *   { "window": {"startUtc": "…", "endUtc": "…"},
 *     "controlled": ["0x…"], "exploratory": ["0x…"] }
 *
 * Writes <outDir>/comparison.json (full ComparisonResult artifact).
 * Artifacts in — artifacts out. No Poly2 contact, ever.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { compare, validatePoly2Export } from './phase4.js';
import { buildShadowGroups } from './phase4.js';
import type { SourceObservationRow } from '../shadow/racing.js';

const [, , dataDir, exportPath, cohortsPath, outDir] = process.argv;
if (!dataDir || !exportPath || !cohortsPath || !outDir) {
  console.error('usage: tsx src/compare/cli.ts <shadowDataDir> <poly2-export.json> <cohorts.json> <outDir>');
  process.exit(1);
}

const cohorts = JSON.parse(readFileSync(cohortsPath, 'utf8')) as {
  window: { startUtc: string; endUtc: string };
  controlled: string[];
  exploratory?: string[];
};
const controlled = new Set(cohorts.controlled.map((w) => w.toLowerCase()));
const exploratory = new Set((cohorts.exploratory ?? []).map((w) => w.toLowerCase()));
const cohortOf = (w: string) =>
  controlled.has(w.toLowerCase()) ? 'CONTROLLED_OVERLAP' as const
    : exploratory.has(w.toLowerCase()) ? 'SHADOW_EXPLORATORY' as const : null;

const obsFile = join(dataDir, 'source_observations.ndjson');
const obs: SourceObservationRow[] = existsSync(obsFile)
  ? readFileSync(obsFile, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l))
  : [];

const exportData = validatePoly2Export(JSON.parse(readFileSync(exportPath, 'utf8')));
const groups = buildShadowGroups(obs, cohortOf, cohorts.window);
const result = compare(exportData, groups, cohorts.window);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(`[phase4] groups=${groups.size} poly2Rows=${exportData.rows.length}`);
console.log(`[phase4] coverage:`, result.coverage);
console.log(`[phase4] raw:`, result.raw);
console.log(`[phase4] usable:`, result.usable);
console.log(`[phase4] wrote ${join(outDir, 'comparison.json')}`);
