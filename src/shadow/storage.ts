/**
 * Append-only evidence storage (bounded NDJSON files — the "bounded
 * append-only files" option from PHASE2_REMOVAL_PLAN §4).
 *
 * Hard rules:
 * - raw_logs and raw_log_tombstones are APPEND-ONLY. No update, no delete.
 * - Reorg/removal => append a tombstone; re-inclusion => a NEW raw_logs row
 *   (uniqueness includes blockHash). Current validity is a DERIVED value
 *   computed by logStatus(), never a mutation.
 * - scan_cursor advances only after raw evidence is committed, and empty
 *   scanned blocks advance it too.
 * - Observations reference raw evidence by identity key; their derived
 *   validity comes from logStatus(), not from editing observation rows.
 * - Quarantine is a one-way door: discrepancies enter, are preserved, and
 *   are never silently repaired.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export interface RawLogRow {
  chainId: number;
  emitter: string;
  blockNumber: number;
  blockHash: string;
  txHash: string;
  logIndex: number;
  topic0: string;
  topics: string[];
  data: string;
  firstSeenUtc: string;
}

export interface TombstoneRow {
  chainId: number;
  emitter: string;
  txHash: string;
  logIndex: number;
  blockHash: string;
  removedAtUtc: string;
  reason: 'REMOVED_FLAG' | 'REORG_REWIND' | 'HASH_CONFLICT';
}

export type LogStatus = 'CONFIRMED' | 'REMOVED' | 'REINCLUDED';

export interface ObservationRow {
  /**
   * PRIMARY KEY — native blockchain event identity:
   *   chainId:emitter:txHash:logIndex
   * Shadow's storage and dedup identity is the chain event itself, not any
   * downstream system's formula. Poly2 canonical equivalence lives ONLY in
   * src/compare/poly2-adapter.ts and is computed offline at comparison time.
   */
  eventId: string;
  /** Separately classified populations; MAKER_LEG is a first-class stored
   *  population (an investigation target), not a diagnostic to discard. */
  role: 'TAKER_AGGREGATE' | 'MAKER_LEG';
  wallet: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  shares: string;
  price10: string;
  feeUnits: string;
  blockTimestamp: number;
  source: 'CHAIN' | 'REST_TRADES' | 'REST_ACTIVITY';
  /** When the raw evidence ARRIVED at this observer (discovery latency). */
  sourceFirstSeenUtc: string;
  /** When this observation row was completed (may be later, after retries). */
  firstSeenUtc: string;
  evidence: { chainId: number; emitter: string; txHash: string; logIndex: number; blockHash: string };
}

export interface QuarantineRow {
  kind:
    | 'ROUNDING_DISCREPANCY'
    | 'CANONICAL_COLLISION'
    | 'UNKNOWN_MARKET_MAPPING'
    | 'AMBIGUOUS_FILL'
    | 'ORDERSMATCHED_MISMATCH'
    | 'REORG_ANOMALY'
    | 'TRANSIENT_FAILURE';
  detail: Record<string, unknown>;
  firstSeenUtc: string;
}

export interface BlockHashRow {
  chainId: number;
  blockNumber: number;
  blockHash: string;
  firstSeenUtc: string;
}

/**
 * Durable per-evidence disposition — the restart/recovery contract.
 * Keyed by the full blockHash-aware native identity. Append-only; the
 * latest row per identity wins (derived index, never a mutation).
 */
export type Disposition =
  | 'OBSERVED'                 // observation committed
  | 'COMPLETED_NO_OBSERVATION' // valid terminal, no observation by design
                               // (OrdersMatched, unwatched, redundant leg, foreign)
  | 'TERMINAL_QUARANTINE'      // malformed/conflicted — never replay
  | 'REMOVED_INVALID'          // a removal/reorg tombstone dominates this exact
                               // blockHash-aware identity — never replay; only a
                               // NEW raw row with a NEW blockHash is new evidence
  | 'PENDING';                 // transient failure — replay at startup

export interface DispositionRow {
  chainId: number;
  emitter: string;
  txHash: string;
  logIndex: number;
  blockHash: string;
  disposition: Disposition;
  atUtc: string;
}

export interface CursorRow {
  provider: string;
  blockNumber: number;
  blockHash: string;
  updatedAtUtc: string;
}

export function logIdentity(r: {
  chainId: number; emitter: string; txHash: string; logIndex: number; blockHash: string;
}): string {
  return `${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}:${r.blockHash}`;
}

export class ShadowStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  private append(name: string, row: unknown): void {
    appendFileSync(this.file(name), JSON.stringify(row) + '\n');
  }

  private readAll<T>(name: string): T[] {
    const f = this.file(name);
    if (!existsSync(f)) return [];
    return readFileSync(f, 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '')
      .map((l) => JSON.parse(l) as T);
  }

  // ─── append-only writers ───

  appendRawLog(row: RawLogRow): void {
    this.append('raw_logs.ndjson', row);
  }

  appendTombstone(row: TombstoneRow): void {
    this.append('raw_log_tombstones.ndjson', row);
  }

  appendObservation(row: ObservationRow): void {
    this.append('observations.ndjson', row);
  }

  appendQuarantine(row: QuarantineRow): void {
    this.append('quarantine.ndjson', row);
  }

  /** Append-only record of block hashes we have scanned past — the evidence
   *  base for common-ancestor detection during reorg recovery. */
  appendBlockHash(row: BlockHashRow): void {
    this.append('block_hashes.ndjson', row);
  }

  appendDisposition(row: DispositionRow): void {
    this.append('dispositions.ndjson', row);
  }

  // ─── cursor (small mutable state; cursor file is rewritten, evidence is not) ───

  readCursor(provider: string): CursorRow | null {
    return this.readAll<CursorRow>('cursor.json').find((c) => c.provider === provider) ?? null;
  }

  advanceCursor(row: CursorRow): void {
    const all = this.readAll<CursorRow>('cursor.json').filter((c) => c.provider !== row.provider);
    all.push(row);
    writeFileSync(this.file('cursor.json'), all.map((c) => JSON.stringify(c)).join('\n') + '\n');
  }

  // ─── derived views (rebuildable at any time) ───

  rawLogs(): RawLogRow[] {
    return this.readAll<RawLogRow>('raw_logs.ndjson');
  }

  tombstones(): TombstoneRow[] {
    return this.readAll<TombstoneRow>('raw_log_tombstones.ndjson');
  }

  observations(): ObservationRow[] {
    return this.readAll<ObservationRow>('observations.ndjson');
  }

  quarantine(): QuarantineRow[] {
    return this.readAll<QuarantineRow>('quarantine.ndjson');
  }

  blockHashes(): BlockHashRow[] {
    return this.readAll<BlockHashRow>('block_hashes.ndjson');
  }

  /** Latest stored hash per block number (derived view of block_hashes). */
  latestBlockHashes(): Map<number, string> {
    const m = new Map<number, string>();
    for (const r of this.blockHashes()) m.set(r.blockNumber, r.blockHash);
    return m;
  }

  /**
   * Every tombstoned blockHash-aware identity (ALL reasons — REMOVED_FLAG,
   * REORG_REWIND, HASH_CONFLICT). A tombstone dominates any PENDING state for
   * that exact identity forever; only a raw row under a NEW blockHash is new
   * evidence (and has a different key).
   */
  tombstoneIndex(): Set<string> {
    const s = new Set<string>();
    for (const t of this.tombstones()) {
      s.add(`${t.chainId}:${t.emitter}:${t.txHash}:${t.logIndex}:${t.blockHash.toLowerCase()}`);
    }
    return s;
  }

  dispositions(): DispositionRow[] {
    return this.readAll<DispositionRow>('dispositions.ndjson');
  }

  /** Latest disposition per full blockHash-aware identity (derived index). */
  dispositionIndex(): Map<string, Disposition> {
    const m = new Map<string, Disposition>();
    for (const d of this.dispositions()) {
      m.set(`${d.chainId}:${d.emitter}:${d.txHash}:${d.logIndex}:${d.blockHash.toLowerCase()}`,
        d.disposition);
    }
    return m;
  }

  /**
   * Derived current status for one raw log identity:
   * - no tombstone covering any row with this (chainId,emitter,txHash,logIndex) => CONFIRMED
   * - tombstone exists and no later re-inclusion row => REMOVED
   * - tombstone exists AND a raw row with a different blockHash seen after => REINCLUDED
   */
  logStatus(id: {
    chainId: number; emitter: string; txHash: string; logIndex: number;
  }): LogStatus {
    const sameLog = (r: { chainId: number; emitter: string; txHash: string; logIndex: number }) =>
      r.chainId === id.chainId && r.emitter === id.emitter &&
      r.txHash === id.txHash && r.logIndex === id.logIndex;

    const tombs = this.tombstones().filter(sameLog);
    if (tombs.length === 0) return 'CONFIRMED';
    const lastTomb = tombs[tombs.length - 1]!;
    const reincluded = this.rawLogs().some(
      (r) => sameLog(r) && r.blockHash !== lastTomb.blockHash && r.firstSeenUtc > lastTomb.removedAtUtc,
    );
    return reincluded ? 'REINCLUDED' : 'REMOVED';
  }

  /**
   * Reorg handling: tombstone every stored row whose blockNumber > ancestor,
   * then the caller rewinds the cursor to the ancestor and rescans.
   * Nothing is edited or deleted; orphaned first-seen evidence is preserved.
   */
  tombstoneAboveBlock(chainId: number, ancestorBlock: number, nowUtc: string): number {
    let n = 0;
    for (const r of this.rawLogs()) {
      if (r.chainId === chainId && r.blockNumber > ancestorBlock) {
        this.appendTombstone({
          chainId: r.chainId, emitter: r.emitter, txHash: r.txHash,
          logIndex: r.logIndex, blockHash: r.blockHash,
          removedAtUtc: nowUtc, reason: 'REORG_REWIND',
        });
        n++;
      }
    }
    if (n > 0) {
      this.appendQuarantine({
        kind: 'REORG_ANOMALY',
        detail: { chainId, ancestorBlock, tombstoned: n },
        firstSeenUtc: nowUtc,
      });
    }
    return n;
  }
}
