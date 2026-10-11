import { sealPoly2Archive } from '../src/compare/poly2-archive.js';
import { inventory, type Snapshot, type CaptureReceipt } from '../src/compare/poly2-snapshot.js';
import type { Poly2ExportRow } from '../src/compare/phase4.js';
/** SYNTHETIC ONLY: models capture authority; never used by production exporter. */
export function fixtureCapture(rows: Poly2ExportRow[], endUtc: string) {
  const snapshot: Snapshot = { schemaVersion: 1, kind: 'synthetic-comparator-fixture', snapshotIdentity: 'synthetic:test-only', asOfUtc: endUtc,
    tables: { fixture_rows: rows.map((r,i) => ({ ...r, id: i+1, sourceEventId: `synthetic:event:${i+1}` })) } };
  const captureReceipt: CaptureReceipt = { schemaVersion: 1, snapshotIdentity: snapshot.snapshotIdentity, transactionIdentity: 'synthetic:transaction', asOfUtc: endUtc, capturedUtc: endUtc, scope: 'FULL_TABLES_UNFILTERED', inventory: inventory(snapshot) };
  return { snapshot, captureReceipt };
}
export function fixtureArchive(rows: Poly2ExportRow[], window: {startUtc:string;endUtc:string}, cohort: string[]) {
  return sealPoly2Archive({runId:'fixture',shadowRunId:'fixture',poly2CodeSha:'a'.repeat(40),exportToolSha256:'b'.repeat(64),cohort,window,...fixtureCapture(rows,window.endUtc)});
}
