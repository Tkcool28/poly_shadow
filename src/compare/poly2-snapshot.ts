import { createHash } from 'node:crypto';
import { epochMicros } from './exact-clock.js';
import type { Poly2ExportRow } from './phase4.js';

export const TABLES = ['markets', 'paper_orders', 'signals', 'trades', 'wallets'] as const;
export type RecordRow = Record<string, unknown> & { id: string | number };
export interface Snapshot {
  schemaVersion: 1;
  kind: 'historical-table-copy' | 'synthetic-comparator-fixture';
  snapshotIdentity: string;
  /** Transaction snapshot time, NOT file copy time or an ingestion watermark. */
  asOfUtc: string;
  tables: Record<string, RecordRow[]>;
}
export interface CaptureReceipt {
  schemaVersion: 1;
  snapshotIdentity: string;
  transactionIdentity: string;
  asOfUtc: string;
  capturedUtc: string;
  scope: 'FULL_TABLES_UNFILTERED';
  inventory: Record<string, { count: number; ids: (string | number)[]; sha256: string }>;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b, 'en')).map(([k,v]) => JSON.stringify(k)+':'+canonical(v)).join(',') + '}';
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error('snapshot: undefined field');
  return encoded;
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export const utc = epochMicros;
export function inventory(snapshot: Snapshot): CaptureReceipt['inventory'] {
  const result: CaptureReceipt['inventory'] = {};
  for (const name of Object.keys(snapshot.tables).sort()) {
    const rows = [...snapshot.tables[name]!].sort((a,b) => canonical(a.id).localeCompare(canonical(b.id), 'en'));
    const ids = rows.map(r => r.id);
    if (ids.some(id => !(typeof id === 'string' && id.length > 0 || typeof id === 'number' && Number.isSafeInteger(id))) || new Set(ids.map(canonical)).size !== ids.length) throw new Error(`snapshot: invalid/duplicate ${name} identity`);
    result[name] = { count: rows.length, ids, sha256: digest(rows) };
  }
  return result;
}
/** Independent capture receipt is an input, never manufactured by the exporter. */
export function verifyCapture(snapshot: Snapshot, receipt: CaptureReceipt, endUtc: string): void {
  if (snapshot.schemaVersion !== 1 || receipt.schemaVersion !== 1 || !snapshot.snapshotIdentity || !receipt.transactionIdentity || receipt.scope !== 'FULL_TABLES_UNFILTERED' || receipt.snapshotIdentity !== snapshot.snapshotIdentity) throw new Error('snapshot: auditable full-table capture receipt required');
  // Exact end-state evidence is mandatory for mutable signal/order facts. A later
  // current-state copy cannot reconstruct end-state, even with old trade clocks.
  if (utc(snapshot.asOfUtc) !== utc(endUtc) || utc(receipt.asOfUtc) !== utc(endUtc) || utc(receipt.capturedUtc) < utc(endUtc)) throw new Error('snapshot: prefix or later-state snapshot; exact frozen-end transaction required');
  const expected = snapshot.kind === 'historical-table-copy' ? [...TABLES] : snapshot.kind === 'synthetic-comparator-fixture' ? ['fixture_rows'] : [];
  if (!expected.length || canonical(Object.keys(snapshot.tables).sort()) !== canonical(expected.sort())) throw new Error('snapshot: complete source table inventory required');
  if (canonical(inventory(snapshot)) !== canonical(receipt.inventory)) throw new Error('snapshot: capture inventory/count/identity/digest mismatch');
  if (snapshot.kind === 'historical-table-copy') {
    for (const table of ['signals', 'paper_orders']) for (const row of snapshot.tables[table]!) {
      if (utc(row.created_at) > utc(endUtc)) throw new Error('snapshot: later mutable state cannot reconstruct point-in-time facts');
    }
  }
}
function text(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v) throw new Error(`snapshot: missing ${field}`);
  return v;
}
function nullableText(v: unknown, field: string): string | null { return v === null ? null : text(v, field); }
function numeric(v: unknown, field: string): number {
  if ((typeof v !== 'string' && typeof v !== 'number') || v === '' || !Number.isFinite(Number(v))) throw new Error(`snapshot: invalid ${field}`);
  return Number(v);
}
/** Map only persisted facts. Never read approval state/configuration to replay policy. */
export function mapSnapshot(snapshot: Snapshot): (Poly2ExportRow & { sourceRecordId: string | number; sourceEventId: string; signalRecordId?: string | number; paperRecordId?: string | number })[] {
  if (snapshot.kind === 'synthetic-comparator-fixture') return snapshot.tables.fixture_rows!.map(({id, ...r}) => ({ ...r, sourceRecordId: id, sourceEventId: text(r.sourceEventId, 'fixture sourceEventId') } as ReturnType<typeof mapSnapshot>[number]));
  const byId = (table: string) => new Map(snapshot.tables[table]!.map(r => [canonical(r.id), r]));
  const wallets = byId('wallets'), markets = byId('markets');
  const signals = new Map<string, RecordRow>();
  const orders = new Map<string, RecordRow>();
  for (const s of snapshot.tables.signals!) {
    const key = text(s.source_trade_id, 'source_trade_id');
    if (signals.has(key)) throw new Error('snapshot: ambiguous signals');
    utc(s.created_at); signals.set(key, s);
  }
  for (const p of snapshot.tables.paper_orders!) {
    utc(p.created_at);
    if (p.signal_id === null) continue;
    const key = canonical(p.signal_id);
    if (orders.has(key)) throw new Error('snapshot: ambiguous paper orders');
    orders.set(key, p);
  }
  const identities = new Set<string>();
  return snapshot.tables.trades!.map(t => {
    const w = wallets.get(canonical(t.wallet_id)), m = markets.get(canonical(t.market_id));
    if (!w || !m) throw new Error('snapshot: missing historical wallet/market join');
    const wallet = text(w.address, 'wallets.address');
    if (wallet !== wallet.toLowerCase()) throw new Error('snapshot: noncanonical persisted wallet');
    const eventId = text(t.polymarket_trade_id, 'polymarket_trade_id');
    if (identities.has(eventId)) throw new Error('snapshot: duplicate source event identity');
    identities.add(eventId);
    const parts = eventId.split(':');
    // Only the inspected data-api identity can supply txHash. Other native
    // identities survive verbatim but cannot be guessed into transaction hashes.
    const txHash = parts[0] === 'data-api' ? (parts.length === 7 ? text(parts[1], 'identity txHash') : (() => { throw new Error('snapshot: malformed data-api identity'); })()) : null;
    if (parts[0] === 'data-api' && (!/^0x[a-fA-F0-9]{64}$/.test(txHash!) || parts[2] !== wallet || (t.asset_id !== null && parts[3] !== t.asset_id))) throw new Error('snapshot: malformed or inconsistent original data-api identity');
    const s = signals.get(eventId), p = s ? orders.get(canonical(s.id)) : undefined;
    const sourceTs = Number(utc(t.traded_at)) / 1000000;
    const ingestedUtc = text(t.ingested_at, 'ingested_at'); utc(ingestedUtc);
    const side = text(t.side, 'side'); if (side !== 'BUY' && side !== 'SELL') throw new Error('snapshot: invalid persisted side');
    const decisionUtc = p ? nullableText(p.t2_decided_at, 't2_decided_at') : null;
    if (decisionUtc !== null) utc(decisionUtc);
    const reason = p ? nullableText(p.miss_reason, 'miss_reason') : null;
    return { wallet, txHash, asset: nullableText(t.asset_id, 'asset_id'), conditionId: text(m.condition_id, 'condition_id'), side,
      size: numeric(t.size, 'size'), price: numeric(t.price, 'price'), sourceTs, sourceEpochMicros: utc(t.traded_at).toString(), tradedAtUtc: text(t.traded_at, 'traded_at'), ingestedUtc,
      normalizedUtc: null, signalUtc: s ? text(s.created_at, 'created_at') : null, decisionUtc,
      source: parts[0]!, freshnessAgeSec: null, freshnessRejection: reason === 'stale_signal' ? reason : null,
      policyEligible: null, copyabilityOutcome: s ? text(s.status, 'signals.status') : null,
      rejectionReason: reason, paperOutcome: p ? text(p.status, 'paper_orders.status') : null,
      sourceRecordId: t.id, sourceEventId: eventId, ...(s ? { signalRecordId: s.id } : {}), ...(p ? { paperRecordId: p.id } : {}) };
  });
}
