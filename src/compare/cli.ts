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

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { compare, validatePoly2Export } from './phase4.js';
import { validatePoly2Archive } from './poly2-archive.js';
import { validateFencedArchiveFile } from './poly2-fenced-archive.js';
import { archiveSchemaVersion } from './json-cursor.js';
import { ProspectiveCapture, type Binding } from './poly2-prospective.js';
import { readMarketMetadata, readShadowGroups } from './evidence.js';

const [, , dataDir, exportPath, cohortsPath, outDir] = process.argv;
if (!dataDir || !exportPath || !cohortsPath || !outDir) {
  console.error('usage: tsx src/compare/cli.ts <shadowDataDir> <poly2-export.json> <cohorts.json> <outDir>');
  process.exit(1);
}

const cohorts = JSON.parse(readFileSync(cohortsPath, 'utf8')) as {
  window: { startUtc: string; endUtc: string };
  controlled: string[];
  exploratory?: string[];
  poly2CaptureBinding?: Binding;
};
const controlled = new Set(cohorts.controlled.map((w) => w.toLowerCase()));
const exploratory = new Set((cohorts.exploratory ?? []).map((w) => w.toLowerCase()));
const cohortOf = (w: string) =>
  controlled.has(w.toLowerCase()) ? 'CONTROLLED_OVERLAP' as const
    : exploratory.has(w.toLowerCase()) ? 'SHADOW_EXPLORATORY' as const : null;

const schemaVersion = archiveSchemaVersion(exportPath);
const legacyArchive: unknown = schemaVersion === 3 ? JSON.parse(readFileSync(exportPath, 'utf8')) : undefined;
if (schemaVersion === 3) {
  const archive = legacyArchive as {manifest?: {evidenceKind?: unknown}; evidence?: {snapshot?: {kind?: unknown}}};
  if (archive?.manifest?.evidenceKind !== 'historical-table-copy'
      || archive?.evidence?.snapshot?.kind !== 'historical-table-copy') {
    throw new Error('CLI: synthetic comparator fixtures are not production authority');
  }
}
const exportData = validatePoly2Export(schemaVersion === 5
  ? validateFencedArchiveFile(exportPath, cohorts.controlled, cohorts.window)
  : schemaVersion === 4
  ? ProspectiveCapture.validateFile(exportPath, cohorts.controlled, cohorts.window, false, cohorts.poly2CaptureBinding)
  : validatePoly2Archive(legacyArchive, cohorts.controlled, cohorts.window));
const marketByGroupKey = await readMarketMetadata(dataDir);
const groups = await readShadowGroups(dataDir, cohortOf, cohorts.window);

const result = compare(exportData, groups, cohorts.window, cohortOf, marketByGroupKey);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'comparison.json'), JSON.stringify(result, null, 2));
console.log(`[phase4] groups=${groups.size} poly2Rows=${exportData.rows.length}`);
console.log(`[phase4] excluded:`, result.excluded);
console.log(`[phase4] coverage:`, result.coverage);
console.log(`[phase4] raw:`, result.raw);
console.log(`[phase4] usable:`, result.usable);
console.log(`[phase4] wrote ${join(outDir, 'comparison.json')}`);
