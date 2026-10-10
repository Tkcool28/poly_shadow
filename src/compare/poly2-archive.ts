import { validatePoly2Export, type Poly2Export } from './phase4.js';
import { clockOrder, inWindow, clockEvidence } from './exact-clock.js';
import { canonical, digest, mapSnapshot, utc, verifyCapture, type Snapshot, type CaptureReceipt } from './poly2-snapshot.js';

export interface ArchiveInput {
  runId: string; shadowRunId: string; poly2CodeSha: string; exportToolSha256: string;
  cohort: string[]; window: { startUtc: string; endUtc: string };
  snapshot: Snapshot; captureReceipt: CaptureReceipt;
}
export interface Poly2ArchiveManifest {
  schemaVersion: 3; runId: string; shadowRunId: string; poly2CodeSha: string;
  exportToolVersion: 'poly2-offline-v3'; exportToolSha256: string; cohortSha256: string;
  frozenStartUtc: string; frozenEndUtc: string; rowCount: number;
  minTimestampUtc: string | null; maxTimestampUtc: string | null;
  sourceSnapshotIdentity: string; sourceTables: string[]; inputSha256: string;
  captureReceiptSha256: string; payloadSha256: string; outputSha256: string;
  completenessScope: 'POLY2_RECORDS_AT_FROZEN_END_NOT_UPSTREAM_REST';
  evidenceKind: Snapshot['kind'];
}
export interface Poly2Archive extends Poly2Export {
  manifest: Poly2ArchiveManifest;
  /** Retained full population allows independent replay, not just an asserted watermark. */
  evidence: { snapshot: Snapshot; captureReceipt: CaptureReceipt; clockAudit: ReturnType<typeof clockEvidence>[] };
}
const cohortHash = (c: string[]) => digest([...new Set(c.map(w => w.toLowerCase()))].sort());
export function sealPoly2Archive(input: ArchiveInput): Poly2Archive {
  if (!input.runId || !input.shadowRunId || !/^[a-f0-9]{40}$/.test(input.poly2CodeSha) || !/^[a-f0-9]{64}$/.test(input.exportToolSha256)) throw new Error('poly2 archive: run/code/tool provenance required');
  const start = utc(input.window.startUtc), end = utc(input.window.endUtc);
  if (end <= start || !input.cohort.length || new Set(input.cohort.map(w => w.toLowerCase())).size !== input.cohort.length) throw new Error('poly2 archive: invalid frozen window/cohort');
  verifyCapture(input.snapshot, input.captureReceipt, input.window.endUtc);
  const snapshot: Snapshot = { ...input.snapshot, tables: Object.fromEntries(Object.entries(input.snapshot.tables).map(([name, rows]) => [name, [...rows].sort((a,b) => canonical(a.id).localeCompare(canonical(b.id), 'en'))])) };
  if (snapshot.kind === 'historical-table-copy') {
    const addresses = snapshot.tables.wallets!.map(w => w.address);
    if (new Set(addresses).size !== addresses.length || input.cohort.some(w => !addresses.includes(w.toLowerCase()))) throw new Error('poly2 archive: missing/ambiguous frozen cohort wallet inventory');
  }
  const population = mapSnapshot(snapshot);
  validatePoly2Export({ window: input.window, rows: population });
  for (const row of population) {
    inWindow(row.ingestedUtc, input.window); // strict exact clock validation
    for (const field of ['normalizedUtc', 'decisionUtc', 'signalUtc'] as const) {
      if (row[field] !== null && utc(row[field]) > end) throw new Error(`poly2 archive: later ${field} cannot reconstruct point-in-time facts`);
    }
    const fields = ['txHash','asset','conditionId','side','size','price','sourceTs','normalizedUtc','decisionUtc','signalUtc','source','freshnessAgeSec','freshnessRejection','policyEligible','copyabilityOutcome','rejectionReason','paperOutcome'] as const;
    if (fields.some(f => row[f] === undefined)) throw new Error('poly2 archive: incomplete comparator row schema');
    if (typeof row.source !== 'string' || !row.source || (row.side !== null && row.side !== 'BUY' && row.side !== 'SELL') || (row.policyEligible !== null && typeof row.policyEligible !== 'boolean')) throw new Error('poly2 archive: invalid comparator field');
    for (const f of ['size','price','sourceTs','freshnessAgeSec'] as const) if (row[f] !== null && (typeof row[f] !== 'number' || !Number.isFinite(row[f]))) throw new Error('poly2 archive: invalid numeric field');
    for (const f of ['txHash','asset','conditionId','freshnessRejection','copyabilityOutcome','rejectionReason','paperOutcome'] as const) if (row[f] !== null && typeof row[f] !== 'string') throw new Error('poly2 archive: invalid nullable string');
  }
  const cohort = new Set(input.cohort.map(w => w.toLowerCase()));
  const rows = population.filter(r => cohort.has(r.wallet.toLowerCase()) && utc(r.ingestedUtc) >= start && utc(r.ingestedUtc) <= end)
    .sort((a,b) => canonical(a.sourceRecordId).localeCompare(canonical(b.sourceRecordId), 'en'));
  const timestamps = rows.map(r => r.ingestedUtc).sort((a,b) => clockOrder(a,b));
  const payload = { window: input.window, rows };
  return { ...payload, evidence: { snapshot: snapshot, captureReceipt: input.captureReceipt, clockAudit: [clockEvidence(input.window, ['startUtc','endUtc']), ...population.map(r => clockEvidence(r as unknown as Record<string, unknown>, ['ingestedUtc','normalizedUtc','decisionUtc','signalUtc','tradedAtUtc']))] }, manifest: {
    schemaVersion: 3, runId: input.runId, shadowRunId: input.shadowRunId, poly2CodeSha: input.poly2CodeSha,
    exportToolVersion: 'poly2-offline-v3', exportToolSha256: input.exportToolSha256, cohortSha256: cohortHash(input.cohort),
    frozenStartUtc: input.window.startUtc, frozenEndUtc: input.window.endUtc, rowCount: rows.length,
    minTimestampUtc: timestamps[0] ?? null, maxTimestampUtc: timestamps.at(-1) ?? null,
    sourceSnapshotIdentity: input.snapshot.snapshotIdentity, sourceTables: Object.keys(input.snapshot.tables).sort(),
    inputSha256: digest(snapshot), captureReceiptSha256: digest(input.captureReceipt), payloadSha256: digest(payload), outputSha256: digest(payload),
    completenessScope: 'POLY2_RECORDS_AT_FROZEN_END_NOT_UPSTREAM_REST', evidenceKind: input.snapshot.kind,
  } };
}
/** Replay full source population and mapping. Legacy watermark-only manifests fail closed. */
export function validatePoly2Archive(value: unknown, cohort: string[], window: {startUtc:string;endUtc:string}): Poly2Archive {
  const a = value as Poly2Archive;
  if (a?.manifest?.schemaVersion !== 3 || !a.evidence) throw new Error('poly2 archive: v3 full-population capture evidence required; watermark insufficient');
  if (canonical(a.window) !== canonical(window)) throw new Error('poly2 archive: frozen window mismatch');
  const expected = sealPoly2Archive({ runId: a.manifest.runId, shadowRunId: a.manifest.shadowRunId,
    poly2CodeSha: a.manifest.poly2CodeSha, exportToolSha256: a.manifest.exportToolSha256,
    cohort, window, ...a.evidence });
  if (canonical(a) !== canonical(expected)) throw new Error('poly2 archive: replay manifest/digest/count/cohort mismatch');
  return a;
}
