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

import { appendFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { streamRows } from './stream.js';

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

/** Fatal uncertainty after an evidence/cache operation; never a transient retry. */
export class EvidenceIndexError extends Error {}

export class ShadowStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private file(name: string): string {
    return join(this.dir, name);
  }

  private db: DatabaseSync | null = null;
  private statements = new Map<string, ReturnType<DatabaseSync['prepare']>>();
  private prepare(sql: string) {
    let stmt=this.statements.get(sql);
    if(!stmt) {stmt=this.db!.prepare(sql); this.statements.set(sql,stmt);}
    return stmt;
  }
  private seq = 0;
  private key(r: {chainId:number; emitter:string; txHash:string; logIndex:number; blockHash:string}): string {
    return `${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}:${r.blockHash.toLowerCase()}`;
  }
  /** Rebuildable disk index, never scientific evidence. One writer per directory.
   * Rebuilt on each process startup: an interrupted append/index update cannot
   * forget raw, pending, observation or tombstone evidence. No finite horizon.
   * SQLite cache is 2MiB; spill/sort use disk, mmap disabled.
   */
  // An append can be authoritative even when a later cache statement fails.
  // Keep this object fail-stopped (including after close); reopen to rebuild.
  private indexInvalid = false;
  assertUsable(): void {
    if (this.indexInvalid) throw new EvidenceIndexError('index invalid; close and reopen store to rebuild authoritative evidence');
  }
  invalidateIndex(): void {
    this.indexInvalid = true;
    // Preserve the original failure even if closing the disposable cache fails.
    try { this.close(); } catch { /* invalid latch still blocks every operation */ }
  }
  private rebuilding: Promise<void> | null = null;
  private rebuildActive = false;
  private indexRows = 0;
  private indexFile: string | null = null;
  private indexLastProgressUtc: string | null = null;
  indexTelemetry() {
    return {indexInvalid:this.indexInvalid, indexRows:this.indexRows, indexRebuildActive:this.rebuildActive,
      indexFile:this.indexFile, indexLastProgressUtc:this.indexLastProgressUtc};
  }
  get indexRebuildPending(): boolean { return this.rebuildActive; }
  /** Runtime calls this before accepting deliveries. Yield every 256 rows so
   * heartbeat/snapshots stay observable; never query a partially built index. */
  initializeIndex(): Promise<void> {
    if (this.indexInvalid) return Promise.reject(new EvidenceIndexError('index invalid; close and reopen store to rebuild authoritative evidence'));
    if (this.rebuilding) return this.rebuilding;
    if (this.db) return Promise.resolve();
    this.rebuildActive = true;
    this.rebuilding = (async () => {
      for (const _ of this.rebuildIndex()) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    })().catch(err => { this.invalidateIndex(); throw err; })
      .finally(() => { this.rebuildActive = false; this.rebuilding = null; });
    return this.rebuilding;
  }
  private index(): DatabaseSync {
    this.assertUsable();
    if (this.rebuildActive) throw Error('recovery index rebuilding; await initializeIndex()');
    // Synchronous small-fixture compatibility; runtime initializes asynchronously.
    try {
      if (!this.db) for (const _ of this.rebuildIndex()) { /* drain */ }
    } catch (err) { this.invalidateIndex(); throw err; }
    return this.db!;
  }
  private *rebuildIndex(): Generator<void> {
    rmSync(this.file('recovery-index.sqlite'),{force:true});
    const db = new DatabaseSync(this.file('recovery-index.sqlite'));
    db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; DROP TABLE IF EXISTS identities; DROP TABLE IF EXISTS latest; DROP TABLE IF EXISTS terminal; CREATE TABLE identities (key TEXT PRIMARY KEY, raw INTEGER DEFAULT 0, arrival TEXT, disposition TEXT, removed INTEGER DEFAULT 0, observed INTEGER DEFAULT 0); CREATE TABLE latest (key TEXT PRIMARY KEY, seq INTEGER); CREATE TABLE terminal (key TEXT PRIMARY KEY); CREATE TABLE canonical_observations (key TEXT PRIMARY KEY, row TEXT NOT NULL);');
    this.db = db; this.seq = 0; this.indexRows = 0;
    db.exec('CREATE TABLE raw_status(native TEXT, hash TEXT, maxArrival TEXT, PRIMARY KEY(native,hash)); CREATE TABLE tomb_status(native TEXT PRIMARY KEY, hash TEXT, atUtc TEXT); BEGIN');
    try {
      for (const name of ['raw_logs.ndjson', 'raw_log_tombstones.ndjson', 'observations.ndjson', 'dispositions.ndjson', 'quarantine.ndjson']) {
        this.indexFile = name;
        for (const row of this.rows(name)) {
          this.indexRow(name, row as any);
          this.indexRows++;
          this.indexLastProgressUtc = new Date().toISOString();
          if (this.indexRows % 256 === 0) yield;
        }
      }
      db.exec('COMMIT');
      this.indexFile = null;
      this.indexLastProgressUtc = new Date().toISOString();
    } catch (err) { this.invalidateIndex(); throw err; }
  }
  private indexRow(name: string, r: any): void {
    const db = this.db!;
    if (name === 'quarantine.ndjson') {
      if (r.kind === 'AMBIGUOUS_FILL') this.prepare('INSERT OR IGNORE INTO terminal VALUES (?)').run(`${r.detail.txHash}:${r.detail.logIndex}`);
      return;
    }
    if (!['raw_logs.ndjson','raw_log_tombstones.ndjson','observations.ndjson','dispositions.ndjson'].includes(name)) return;
    const key = this.key(name === 'observations.ndjson' ? r.evidence : r);
    this.prepare('INSERT OR IGNORE INTO identities (key) VALUES (?)').run(key);
    if (name === 'raw_logs.ndjson') {
      this.seq++;
      this.prepare('INSERT INTO raw_status VALUES (?,?,?) ON CONFLICT(native,hash) DO UPDATE SET maxArrival=max(maxArrival,excluded.maxArrival)').run(`${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}`,r.blockHash,r.firstSeenUtc);
      this.prepare('UPDATE identities SET raw=1, arrival=coalesce(arrival,?) WHERE key=?').run(r.firstSeenUtc,key);
      this.prepare('INSERT OR REPLACE INTO latest VALUES (?,?)').run(`${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}`,this.seq);
    } else if (name === 'raw_log_tombstones.ndjson') {
      this.prepare('UPDATE identities SET removed=1 WHERE key=?').run(key);
      this.prepare('INSERT OR REPLACE INTO tomb_status VALUES (?,?,?)').run(`${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}`,r.blockHash,r.removedAtUtc);
    }
    else if (name === 'observations.ndjson') {
      this.prepare('UPDATE identities SET observed=1 WHERE key=?').run(key);
      // First persisted row is canonical, including completion time. Disk only.
      this.prepare('INSERT OR IGNORE INTO canonical_observations VALUES (?,?)').run(key,JSON.stringify(r));
    }
    else this.prepare('UPDATE identities SET disposition=? WHERE key=?').run(r.disposition,key);
  }
  identityState(key: string): {raw:boolean; arrival?:string; disposition?:Disposition; removed:boolean; observed:boolean} {
    this.index();
    const r = this.prepare('SELECT * FROM identities WHERE key=?').get(key);
    return {raw:!!r?.raw, arrival:r?.arrival as string | undefined, disposition:r?.disposition as Disposition | undefined, removed:!!r?.removed, observed:!!r?.observed};
  }
  canonicalObservation(key: string): ObservationRow | undefined {
    this.index();
    const row=this.prepare('SELECT row FROM canonical_observations WHERE key=?').get(key);
    return row ? JSON.parse(row.row as string) as ObservationRow : undefined;
  }
  legacyEligible(r: RawLogRow, seq: number): boolean {
    const db=this.index();
    return this.prepare('SELECT seq FROM latest WHERE key=?').get(`${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}`)?.seq === seq
      && !this.prepare('SELECT key FROM terminal WHERE key=?').get(`${r.txHash}:${r.logIndex}`);
  }
  close(): void { this.statements.clear(); this.db?.close(); this.db=null; }
  *rows<T>(name: string): Generator<T> {
    this.assertUsable();
    for (const row of streamRows<T>(this.file(name))) {
      this.assertUsable(); // Also stop an iterator opened before invalidation.
      yield row;
    }
  }
  private append(name: string, row: unknown): void {
    if(this.rebuildActive) throw Error('cannot append during recovery index rebuild');
    this.assertUsable();
    try {
      appendFileSync(this.file(name), JSON.stringify(row) + '\n');
      if(this.db) this.indexRow(name,row);
    } catch (err) {
      this.invalidateIndex();
      throw new EvidenceIndexError('index invalid after append: ' + String(err).slice(0, 256), { cause: err });
    }
  }

  /** Small-fixture compatibility only; production recovery uses rows/index.
   * Never silently truncate: callers requesting >10k rows fail explicitly. */
  private readAll<T>(name: string): T[] {
    const result: T[]=[];
    for(const r of this.rows<T>(name)) {
      if(result.length >= 10_000) throw Error(`${name}: array view limit; use rows()`);
      result.push(r);
    }
    return result;
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
  latestBlockHashes(minBlock = 0, maxBlock = minBlock + 512): Map<number, string> {
    if(!Number.isSafeInteger(minBlock) || !Number.isSafeInteger(maxBlock) || maxBlock-minBlock>512 || maxBlock<minBlock) throw Error('block hash window limit: at most 513 block numbers');
    const m = new Map<number, string>();
    for (const r of this.rows<BlockHashRow>('block_hashes.ndjson')) {
      if(r.blockNumber >= minBlock && r.blockNumber <= maxBlock) m.set(r.blockNumber, r.blockHash);
    }
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
    this.index();
    const native=`${id.chainId}:${id.emitter}:${id.txHash}:${id.logIndex}`;
    const tomb=this.prepare('SELECT hash,atUtc FROM tomb_status WHERE native=?').get(native);
    if(!tomb) return 'CONFIRMED';
    return this.prepare('SELECT hash FROM raw_status WHERE native=? AND hash<>? AND maxArrival>? LIMIT 1')
      .get(native,tomb.hash!,tomb.atUtc!) ? 'REINCLUDED' : 'REMOVED';
  }

  /**
   * Reorg handling: tombstone every stored row whose blockNumber > ancestor,
   * then the caller rewinds the cursor to the ancestor and rescans.
   * Nothing is edited or deleted; orphaned first-seen evidence is preserved.
   */
  tombstoneAboveBlock(chainId: number, ancestorBlock: number, nowUtc: string): number {
    let n = 0;
    for (const r of this.rows<RawLogRow>('raw_logs.ndjson')) {
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
