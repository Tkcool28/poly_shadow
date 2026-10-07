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

import { appendFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { streamRows } from './stream.js';
import { EvidenceIndexError } from './storage.js';

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
  /** Frozen normalization time, persisted before downstream publication. */
  completedUtc?: string;
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

/** Publish a canonical chain row to the two shared evidence stages. */
export function publishChainObservation(store: RacingStore, reconciler: Reconciler,
  obs: import('./storage.js').ObservationRow): void {
  const identity = `${obs.eventId}:${obs.evidence.blockHash.toLowerCase()}`;
  const groupKey = chainGroupKey(obs);
  reconciler.record('CHAIN', identity, groupKey, obs.sourceFirstSeenUtc);
  if (store.hasIdentity('CHAIN', identity)) return;
  store.appendSourceObservation({
    source: 'CHAIN', identity, wallet: obs.wallet, side: obs.side, asset: obs.tokenId,
    size: obs.shares, price: obs.price10, sourceTs: obs.blockTimestamp,
    blockTimestamp: obs.blockTimestamp, sourceFirstSeenUtc: obs.sourceFirstSeenUtc,
    completedUtc: obs.firstSeenUtc, role: obs.role, groupKey, hydration: 'FULL',
  });
}

/** Normalize solely from durable evidence; arrival is never completion. */
export function normalizeRestRaw(raw:RestRawRow):SourceObservationRow {
  if(typeof raw.completedUtc!=='string' || !raw.completedUtc.trim())
    throw new EvidenceIndexError('REST raw missing completedUtc; cannot infer historical normalization time');
  const item=raw.payload;
  const tx=String(item['transactionHash'] ?? '').toLowerCase();
  const asset=item['asset'] != null && item['asset'] !== '' ? String(item['asset']) : null;
  const size=typeof item['size']==='number' ? item['size'].toFixed(6) : null;
  return {
    source:raw.source,identity:raw.identity,wallet:raw.wallet,
    side:item['side']==='BUY' || item['side']==='SELL' ? item['side'] : null,
    asset,size,price:typeof item['price']==='number' ? item['price'].toFixed(4) : null,
    sourceTs:raw.sourceTs,blockTimestamp:null,sourceFirstSeenUtc:raw.firstSeenUtc,
    completedUtc:raw.completedUtc,role:'UNKNOWN',
    groupKey:tx && asset && size ? tradeGroupKey(tx,asset,size) : `ungrouped:${raw.identity}`,
    hydration:item['title'] && item['conditionId'] ? 'FULL' : 'PARTIAL',
  };
}

// ─── append-only store ───

export class RacingStore {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    mkdirSync(dir, { recursive: true });
  }

  private db: DatabaseSync | null=null;
  private statements=new Map<string,ReturnType<DatabaseSync['prepare']>>();
  // An append can be authoritative even when a later cache statement fails.
  // Keep this object fail-stopped (including after close); reopen to rebuild.
  private indexInvalid = false;
  assertUsable(): void {
    if (this.indexInvalid) throw new EvidenceIndexError('racing index invalid; close and reopen store to rebuild authoritative evidence');
  }
  private invalidateIndex(): void {
    this.indexInvalid = true;
    // Preserve the original failure even if closing the disposable cache fails.
    try { this.close(); } catch { /* invalid latch still blocks every operation */ }
  }
  private rebuilding: Promise<void> | null=null;
  private rebuildActive=false;
  private indexRows=0;
  private indexFile: string | null=null;
  private indexLastProgressUtc: string | null=null;
  indexTelemetry() {
    return {racingIndexInvalid:this.indexInvalid,racingIndexRows:this.indexRows,racingIndexRebuildActive:this.rebuildActive,
      racingIndexFile:this.indexFile,racingIndexLastProgressUtc:this.indexLastProgressUtc};
  }
  initializeIndex(): Promise<void> {
    if (this.indexInvalid) return Promise.reject(new EvidenceIndexError('racing index invalid; close and reopen store to rebuild authoritative evidence'));
    if(this.rebuilding) return this.rebuilding;
    if(this.db) return Promise.resolve();
    this.rebuildActive=true;
    this.rebuilding=(async()=>{
      for(const _ of this.rebuildIndex()) await new Promise<void>(resolve=>setImmediate(resolve));
    })().catch(err=>{this.invalidateIndex();throw err;})
      .finally(()=>{this.rebuildActive=false;this.rebuilding=null;});
    return this.rebuilding;
  }
  private stmt(sql:string) {
    if(!this.db) this.index();let s=this.statements.get(sql);
    if(!s) {s=this.db!.prepare(sql);this.statements.set(sql,s);} return s;
  }
  private index() {
    this.assertUsable();
    if(this.rebuildActive) throw Error('racing index rebuilding; await initializeIndex()');
    try {
      if(!this.db) for(const _ of this.rebuildIndex()) { /* fixture compatibility */ }
    } catch(err) {this.invalidateIndex();throw err;}
  }
  private *rebuildIndex(): Generator<void> {
    // Derived disposable cache; rebuilding also repairs an interrupted index.
    rmSync(this.file('racing-index.sqlite'),{force:true});
    this.db=new DatabaseSync(this.file('racing-index.sqlite'));
    this.db.exec('PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA cache_size=-2048; PRAGMA temp_store=FILE; PRAGMA mmap_size=0; CREATE TABLE identities(source TEXT, identity TEXT, PRIMARY KEY(source,identity)); CREATE TABLE rest_raw(source TEXT, identity TEXT, data TEXT, PRIMARY KEY(source,identity)); CREATE TABLE source_rows(source TEXT, identity TEXT, data TEXT, PRIMARY KEY(source,identity)); CREATE TABLE first_groups(key TEXT PRIMARY KEY); CREATE TABLE recovery_candidates(source TEXT, identity TEXT, groupKey TEXT, data TEXT, needsSource INTEGER, PRIMARY KEY(source,identity)); CREATE INDEX recovery_group ON recovery_candidates(groupKey); CREATE TABLE groups(key TEXT PRIMARY KEY); CREATE TABLE positions(key TEXT PRIMARY KEY, position TEXT); BEGIN');
    try {
      this.indexRows=0;
      for(const name of ['rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson']) {
        this.indexFile=name;
        for(const r of streamRows(this.file(name))) {
          this.indexRow(name,r as any);this.indexRows++;
          this.indexLastProgressUtc=new Date().toISOString();
          if(this.indexRows%256===0) yield;
        }
      }
      this.db.exec('COMMIT');
      // Complete unfinished REST evidence before any new source can claim FIRST.
      yield* this.recoverRestPublications();
      this.indexFile=null;this.indexLastProgressUtc=new Date().toISOString();
    } catch(err) {this.invalidateIndex();throw err;}
  }
  private indexRow(name:string,r:any) {
    if(name==='rest_raw.ndjson')
      this.stmt('INSERT OR IGNORE INTO rest_raw VALUES (?,?,?)').run(r.source,r.identity,JSON.stringify(r));
    if(name==='source_observations.ndjson') {
      this.stmt('INSERT OR IGNORE INTO identities VALUES (?,?)').run(r.source,r.identity);
      this.stmt('INSERT OR IGNORE INTO source_rows VALUES (?,?,?)').run(r.source,r.identity,JSON.stringify(r));
    }
    if(name==='reconciliation.ndjson') {
      if(r.position==='FIRST') this.stmt('INSERT OR IGNORE INTO first_groups VALUES (?)').run(r.groupKey);
      this.stmt('INSERT OR IGNORE INTO groups VALUES (?)').run(r.groupKey);
      this.stmt('INSERT OR REPLACE INTO positions VALUES (?,?)').run(`${r.groupKey}|${r.source}|${r.identity}`,r.position);
    }
  }
  /** Prevalidate all recovery candidates on disk before any scientific append.
   * FIRST is reconciliation commit order, never arrival or file traversal order.
   * A missing FIRST is recoverable only for a single unambiguous identity.
   */
  private *recoverRestPublications(): Generator<void> {
    let cursor=0, scanned=0;
    this.indexFile='REST publication prevalidation';
    for (;;) {
      const row=this.stmt('SELECT rowid AS n, data FROM rest_raw WHERE rowid>? ORDER BY rowid LIMIT 1').get(cursor);
      if(!row) break;
      cursor=Number(row.n);
      const raw=JSON.parse(String(row.data)) as RestRawRow;
      const saved=this.stmt('SELECT data FROM source_rows WHERE source=? AND identity=?').get(raw.source,raw.identity);
      const observation=saved ? JSON.parse(String(saved.data)) as SourceObservationRow : normalizeRestRaw(raw);
      this.stageRecoveryCandidate(observation,!saved);
      this.indexLastProgressUtc=new Date().toISOString();
      if(++scanned%256===0) yield;
    }
    // Include CHAIN as a contender, but its canonical recovery remains separate.
    cursor=0;
    for (;;) {
      const row=this.stmt('SELECT rowid AS n, data FROM source_rows WHERE rowid>? ORDER BY rowid LIMIT 1').get(cursor);
      if(!row) break;
      cursor=Number(row.n);
      this.stageRecoveryCandidate(JSON.parse(String(row.data)) as SourceObservationRow,false);
      this.indexLastProgressUtc=new Date().toISOString();
      if(++scanned%256===0) yield;
    }
    // Disk GROUP BY/EXISTS, with bounded SQLite cache and disk temporary storage.
    // Any ambiguous group blocks the entire repair, not just that group's append.
    const ambiguous=this.stmt(`SELECT c.groupKey FROM recovery_candidates c
      LEFT JOIN first_groups f ON f.key=c.groupKey
      WHERE f.key IS NULL
      GROUP BY c.groupKey
      HAVING (count(*)>1 OR EXISTS(SELECT 1 FROM groups g WHERE g.key=c.groupKey))
        AND sum(CASE WHEN c.source!='CHAIN' AND NOT EXISTS(
          SELECT 1 FROM positions p WHERE p.key=c.groupKey||'|'||c.source||'|'||c.identity
        ) THEN 1 ELSE 0 END)>0 LIMIT 1`).get();
    if(ambiguous) throw new EvidenceIndexError('ambiguous REST reconciliation commit order; missing authoritative FIRST');
    this.indexFile='REST publication recovery';
    cursor=0;
    for (;;) {
      const row=this.stmt("SELECT rowid AS n, data, needsSource FROM recovery_candidates WHERE rowid>? AND source!='CHAIN' ORDER BY rowid LIMIT 1").get(cursor);
      if(!row) break;
      cursor=Number(row.n);
      const observation=JSON.parse(String(row.data)) as SourceObservationRow;
      if(row.needsSource) this.recoveryAppend('source_observations.ndjson',observation);
      this.recoverMembership(observation);
      this.indexLastProgressUtc=new Date().toISOString();
      if(++scanned%256===0) yield;
    }
    this.db!.exec('DELETE FROM recovery_candidates');
  }
  private stageRecoveryCandidate(row:SourceObservationRow,needsSource:boolean):void {
    if(row.source!=='CHAIN' && (typeof row.completedUtc!=='string' || !row.completedUtc.trim()))
      throw new EvidenceIndexError('REST source missing completedUtc; cannot infer historical normalization time');
    this.stmt('INSERT OR IGNORE INTO recovery_candidates VALUES (?,?,?,?,?)')
      .run(row.source,row.identity,row.groupKey,JSON.stringify(row),needsSource?1:0);
  }
  private recoverMembership(row:SourceObservationRow): void {
    const key=`${row.groupKey}|${row.source}|${row.identity}`;
    if(this.stmt('SELECT position FROM positions WHERE key=?').get(key)) return;
    const position=this.stmt('SELECT key FROM groups WHERE key=?').get(row.groupKey) ? 'CORROBORATOR' : 'FIRST';
    this.recoveryAppend('reconciliation.ndjson',{groupKey:row.groupKey,source:row.source,identity:row.identity,position,atUtc:row.sourceFirstSeenUtc});
  }
  private recoveryAppend(name:string,row:unknown):void {
    // Only the startup owner may publish while rebuildActive; any error is
    // caught by rebuildIndex and latches the store invalid before delivery.
    appendFileSync(this.file(name),JSON.stringify(row)+'\n');
    this.indexRow(name,row);
  }
  restRawIdentity(source:RestRawRow['source'],identity:string):RestRawRow|undefined {
    this.index();
    const row=this.stmt('SELECT data FROM rest_raw WHERE source=? AND identity=?').get(source,identity);
    return row ? JSON.parse(String(row.data)) as RestRawRow : undefined;
  }
  sourceIdentity(source:SourceKind,identity:string):SourceObservationRow|undefined {
    this.index();
    const row=this.stmt('SELECT data FROM source_rows WHERE source=? AND identity=?').get(source,identity);
    return row ? JSON.parse(String(row.data)) as SourceObservationRow : undefined;
  }
  hasRestPublication(source:RestRawRow['source'],identity:string):boolean {
    this.index();
    const saved=this.stmt('SELECT data FROM source_rows WHERE source=? AND identity=?').get(source,identity);
    if(!saved) return false;
    const row=JSON.parse(String(saved.data)) as SourceObservationRow;
    return !!this.position(`${row.groupKey}|${source}|${identity}`);
  }
  close() {this.statements.clear();this.db?.close();this.db=null;}
  hasIdentity(source:SourceKind,identity:string):boolean {
    this.index();
    return !!this.stmt('SELECT identity FROM identities WHERE source=? AND identity=?').get(source,identity);
  }
  identityCount(source:SourceKind):number {
    this.index();
    return Number(this.stmt('SELECT count(*) AS n FROM identities WHERE source=?').get(source)!.n);
  }
  position(key:string):'FIRST'|'CORROBORATOR'|undefined {
    this.index();
    return this.stmt('SELECT position FROM positions WHERE key=?').get(key)?.position as 'FIRST'|'CORROBORATOR'|undefined;
  }
  hasGroup(key:string):boolean {this.index();return !!this.stmt('SELECT key FROM groups WHERE key=?').get(key);}
  private file(name: string): string { return join(this.dir, name); }
  private append(name: string, row: unknown): void {
    if(this.rebuildActive) throw Error('cannot append during racing index rebuild');
    this.assertUsable();
    try {
      appendFileSync(this.file(name), JSON.stringify(row) + '\n');
      if(this.db) this.indexRow(name,row);
    } catch (err) {
      this.invalidateIndex();
      throw new EvidenceIndexError('racing index invalid after append: ' + String(err).slice(0, 256), { cause: err });
    }
  }
  private readAll<T>(name: string): T[] {
    this.assertUsable();
    const rows:T[]=[];
    for(const r of streamRows<T>(this.file(name))) {
      if(rows.length>=10_000) throw Error(`${name}: array view limit; use streaming reader`);
      rows.push(r);
    }
    return rows;
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
 * Reconciler: records reconciliation commit-order FIRST and CORROBORATOR
 * membership per economic-trade candidate group. Source arrival timestamps
 * remain independent evidence and never determine position. Durable disk
 * membership preserves the committed winner across restarts.
 */
export class Reconciler {
  constructor(private store: RacingStore) {}

  /** Record that `source` observed `identity` belonging to candidate
   *  `groupKey` at `atUtc` (the SOURCE's first-seen time). Returns the
   *  position assigned. Idempotent per (group, source, identity). */
  record(source: SourceKind, identity: string, groupKey: string, atUtc: string)
    : 'FIRST' | 'CORROBORATOR' {
    const mk = `${groupKey}|${source}|${identity}`;
    const existing = this.store.position(mk);
    if (existing) return existing;
    const position = this.store.hasGroup(groupKey) ? 'CORROBORATOR' : 'FIRST';
    this.store.appendReconciliation({ groupKey, source, identity, position, atUtc });
    return position;
  }
}
