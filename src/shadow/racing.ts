/**
 * Source racing + reconciliation — Phase 3.
 *
 * CORE RULE (handoff §4): sources are INDEPENDENT. No source validates or
 * canonicalizes another. Each source's observation survives with its own
 * first-seen timestamp; a separate reconciliation layer only records that
 * identities APPEAR to describe the same economic trade (a candidate
 * grouping), who saw it first, and who corroborated later. One source never
 * overwrites another source's timing evidence.
 *
 * Storage is append-only NDJSON, consistent with Phase 2:
 *   rest_raw.ndjson          raw source payloads + per-request telemetry
 *   poll_telemetry.ndjson    per-poll freshness/cache/error measurement
 *   source_observations.ndjson  normalized per-source observations
 *   reconciliation.ndjson    group membership: FIRST / CORROBORATOR
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export type SourceKind = 'CHAIN' | 'REST_TRADES' | 'REST_ACTIVITY';

/** Raw REST evidence row: payload exactly as returned + arrival telemetry. */
export interface RestRawRow {
  source: 'REST_TRADES' | 'REST_ACTIVITY';
  wallet: string;
  /** Source-native identity derived ONLY from fields the source returns. */
  identity: string;
  payload: Record<string, unknown>;
  requestStartUtc: string;
  responseUtc: string;
  httpStatus: number;
  ageHeader: string | null;
  cacheControl: string | null;
  /** Source-provided event timestamp (epoch seconds) when present. */
  sourceTs: number | null;
  firstSeenUtc: string;
}

/** One poll cycle's measured behavior (freshness is measured, not assumed). */
export interface PollTelemetryRow {
  source: 'REST_TRADES' | 'REST_ACTIVITY';
  wallet: string;
  requestStartUtc: string;
  responseUtc: string | null;
  httpStatus: number | null;
  ageHeader: string | null;
  cacheControl: string | null;
  newestSourceTs: number | null;
  returned: number;
  newIdentities: number;
  duplicates: number;
  intervalMs: number;
  error: string | null;
  atUtc: string;
}

/** Normalized per-source observation (source-native identity preserved). */
export interface SourceObservationRow {
  source: SourceKind;
  identity: string;
  wallet: string;
  side: 'BUY' | 'SELL' | null;
  asset: string | null;
  /** Decimal strings normalized from the source's own fields (raw kept in
   *  rest_raw / raw_logs — floats are never used as evidence). */
  size: string | null;
  price: string | null;
  sourceTs: number | null;
  blockTimestamp: number | null;
  /** When THIS source's evidence arrived at this observer. */
  sourceFirstSeenUtc: string;
  /** When normalization completed. */
  completedUtc: string;
  /** Maker/taker when the source representation makes it knowable. */
  role: 'TAKER_AGGREGATE' | 'MAKER_LEG' | 'UNKNOWN';
  /** Economic-trade candidate group key (reconciliation only). */
  groupKey: string;
  /** Metadata hydration state — raw observation survives regardless. */
  hydration: 'FULL' | 'PARTIAL';
}

export interface ReconciliationRow {
  groupKey: string;
  source: SourceKind;
  identity: string;
  position: 'FIRST' | 'CORROBORATOR';
  atUtc: string;
}

// ─── source-native identities (handoff §5) ───

export interface TradesPayload {
  proxyWallet?: string; side?: string; asset?: string; size?: number;
  price?: number; timestamp?: number; transactionHash?: string;
  title?: string; conditionId?: string;
}

/**
 * /trades identity from the fields the source actually returns. The source
 * exposes no logIndex, so multiple legitimate same-tx fills are distinct
 * only via their full field tuple — txHash alone is NEVER the identity.
 */
export function tradesIdentity(t: TradesPayload): string {
  return [
    'rest-trades',
    (t.transactionHash ?? '').toLowerCase(),
    (t.proxyWallet ?? '').toLowerCase(),
    t.asset ?? '',
    Number(t.size).toFixed(6),
    Number(t.price).toFixed(4),
    String(t.timestamp ?? ''),
  ].join(':');
}

export interface ActivityPayload {
  proxyWallet?: string; type?: string; asset?: string; size?: number;
  price?: number; timestamp?: number; transactionHash?: string; side?: string;
}

/** /activity identity: the activity TYPE is part of the identity (TRADE,
 *  MERGE, SPLIT, REDEEM etc. are distinct populations). */
export function activityIdentity(a: ActivityPayload): string {
  return [
    'rest-activity',
    (a.type ?? '').toUpperCase(),
    (a.transactionHash ?? '').toLowerCase(),
    (a.proxyWallet ?? '').toLowerCase(),
    a.asset ?? '',
    Number(a.size ?? 0).toFixed(6),
    String(a.timestamp ?? ''),
  ].join(':');
}

/**
 * Economic-trade CANDIDATE group key (reconciliation layer only — never a
 * storage primary key). Deliberately coarse: tx + asset + size. Price is
 * excluded because maker legs and aggregate legs can legitimately differ in
 * gross/net terms. Cross-source grouping is a hypothesis, recorded as such.
 */
export function tradeGroupKey(txHash: string, asset: string, size6: string): string {
  return `econ:${txHash.toLowerCase()}:${asset}:${size6}`;
}

/** Group key for a normalized chain observation (shares already 6dp). */
export function chainGroupKey(obs: {
  evidence: { txHash: string }; tokenId: string; shares: string;
}): string {
  return tradeGroupKey(obs.evidence.txHash, obs.tokenId, obs.shares);
}

// ─── append-only store ───

export class RacingStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string { return join(this.dir, name); }
  private append(name: string, row: unknown): void {
    appendFileSync(this.file(name), JSON.stringify(row) + '\n');
  }
  private readAll<T>(name: string): T[] {
    const f = this.file(name);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as T);
  }

  appendRestRaw(row: RestRawRow): void { this.append('rest_raw.ndjson', row); }
  appendPollTelemetry(row: PollTelemetryRow): void { this.append('poll_telemetry.ndjson', row); }
  appendSourceObservation(row: SourceObservationRow): void { this.append('source_observations.ndjson', row); }
  appendReconciliation(row: ReconciliationRow): void { this.append('reconciliation.ndjson', row); }

  restRaw(): RestRawRow[] { return this.readAll('rest_raw.ndjson'); }
  pollTelemetry(): PollTelemetryRow[] { return this.readAll('poll_telemetry.ndjson'); }
  sourceObservations(): SourceObservationRow[] { return this.readAll('source_observations.ndjson'); }
  reconciliation(): ReconciliationRow[] { return this.readAll('reconciliation.ndjson'); }

  /** All previously committed identities per source (restart dedup seed). */
  identityIndex(source: SourceKind): Set<string> {
    const s = new Set<string>();
    for (const o of this.sourceObservations()) if (o.source === source) s.add(o.identity);
    for (const r of this.restRaw()) if (r.source === source) s.add(r.identity);
    return s;
  }
}

/**
 * Reconciler: records FIRST-seen and CORROBORATOR membership per economic-
 * trade candidate group. Append-only; in-memory winner set is seeded from
 * durable rows at startup, so the first-source winner survives restarts.
 */
export class Reconciler {
  private winners = new Set<string>();
  private positions = new Map<string, 'FIRST' | 'CORROBORATOR'>();

  constructor(private store: RacingStore) {
    for (const r of store.reconciliation()) {
      this.winners.add(r.groupKey);
      this.positions.set(`${r.groupKey}|${r.source}|${r.identity}`, r.position);
    }
  }

  /** Record that `source` observed `identity` belonging to candidate
   *  `groupKey` at `atUtc` (the SOURCE's first-seen time). Returns the
   *  position assigned. Idempotent per (group, source, identity). */
  record(source: SourceKind, identity: string, groupKey: string, atUtc: string)
    : 'FIRST' | 'CORROBORATOR' {
    const mk = `${groupKey}|${source}|${identity}`;
    const existing = this.positions.get(mk);
    if (existing) return existing;
    const position = this.winners.has(groupKey) ? 'CORROBORATOR' : 'FIRST';
    this.winners.add(groupKey);
    this.positions.set(mk, position);
    this.store.appendReconciliation({ groupKey, source, identity, position, atUtc });
    return position;
  }
}
