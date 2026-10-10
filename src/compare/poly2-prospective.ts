/** Prospective, independently controlled capture. Never imported by trading/Shadow. */
import { clockOrder, inWindow, clockEvidence } from './exact-clock.js';
import { DiskIndex, DiskMap, DiskSet, journalLines } from './disk-index.js';
import { JsonCursor } from './json-cursor.js';
import { tmpdir } from 'node:os';
import { createHash, verify } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, linkSync, unlinkSync, renameSync, writeSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { canonical, digest, utc } from './poly2-snapshot.js';
import { validatePoly2Export, type Poly2Export, type Poly2ExportRow } from './phase4.js';

export const JOURNAL = 'poly2_comparison_evidence.ndjson';
export const VERSION = 'poly2-prospective-v1';
export interface Binding {
  runId: string; shadowRunId: string; poly2CodeSha: string; componentSha256: string;
  cohort: string[]; window: { startUtc: string; endUtc: string };
  evidenceKind: 'synthetic' | 'observational';
  /** Public key pinned before activation. Source receipt signatures authenticate custody,
   * not correctness of hook coverage; sourceProtocol must be independently reviewed. */
  sourcePublicKey: string | null;
  /** Independently retained authority, not a producer self-report. */
  terminalAuthority?: { inventorySha256: string; contractSha256: string };
}
export interface TradeFact {
  sourceRecordId: string | number; sourceEventId: string;
  wallet: string; asset: string | null; conditionId: string | null;
  side: 'BUY' | 'SELL' | null; size: number | null; sourceTs: number | null;
  tradedAtUtc: string | null;
  ingestedUtc: string;
  clockEvidence?: ReturnType<typeof clockEvidence>;
}
export interface DecisionFact {
  sourceEventId: string; paperRecordId: string | number;
  decisionUtc: string | null; rejectionReason: string | null;
  sourceIngestedUtc: string;
  /** SQLAdapter-captured immutable source audit linkage; required at fenced seal. */
  signalRecordId?: string | number;
  sourceAudit?: {recordId: number; action: 'signal_skipped' | 'paper_order_executed'; createdUtc: string; context: Record<string, unknown>};
  clockEvidence?: ReturnType<typeof clockEvidence>;
}
export interface SourceFrame {
  version: 1; bindingSha256: string; cursor: number; previousCursor: number;
  transactionId: string; observedUtc: string;
  /** Actual source-driver receipt, not an ingestion MAX or requested timestamp. */
  kind: 'ACTIVATION' | 'COMMIT' | 'CHECKPOINT' | 'END_FENCE';
  trades: TradeFact[]; decisions: DecisionFact[];
  commitBeforeUtc: string | null; commitAfterUtc: string | null;
  /** End fence counts obtained by the source coordinator after draining registered
   * transactions. All begin/commit/rollback boundaries must participate. */
  fence: null | { protocol: 'all-writers-transaction-drain-v1'; registeredWriters: string[];
    outstandingTransactions: number; unresolvedFailures: number; throughCursor: number;
    certificate?: { inventorySha256: string; contractSha256: string; closedUtc: string;
      noFutureInWindowInsertions: true; noFutureRelevantDecisions: true;
      insertionFactsRetained: true; outstandingTransactions: number; unresolvedFailures: number;
      registeredWriters: string[]; finalCheckpointCursor: number; finalCheckpointSha256: string } };
  signature: string | null;
  signedPayload?: string;
  /** Original serialized read checkpoint retained for cross-language byte hash. */
  checkpointPayload?: string;
}
type State = 'ARMED' | 'ACTIVE' | 'SEALED' | 'FAILED';
type Entry = { version: 1; seq: number; previousSha256: string | null; kind: 'ARM' | 'SOURCE' | 'GAP' | 'RESOLVE' | 'FAIL' | 'SEAL'; payload: unknown };
export interface CaptureHealth {
  state: State; quality: 'HEALTHY' | 'AT_RISK'; lastSuccessUtc: string | null;
  cursor: number; endCoverage: boolean; failures: number; gaps: string[];
  count: number; error: string | null; gapCount: number; gapsTruncated: boolean;
  archiveState: 'INCOMPLETE' | 'SEALED'; incompleteProperty: string | null;
}
export interface ProspectiveArchive extends Poly2Export {
  manifest: { schemaVersion: 4; version: typeof VERSION; binding: Binding; bindingSha256: string;
    journalSha256: string; payloadSha256: string; rowCount: number; sourceCursor: number;
    minTimestampUtc: string | null; maxTimestampUtc: string | null;
    activationUtc: string; endReceiptSha256: string; gaps: string[]; failures: number;
    completenessScope: 'COMMITTED_POLY2_INGESTIONS_IN_FROZEN_WINDOW_NOT_UPSTREAM_REST' };
  evidence: { journal: string; clockAudit: ReturnType<typeof clockEvidence>[] };
}
export interface IO {
  append(path: string, bytes: string): void;
  publish(path: string, bytes: string): void;
}
function durableAppend(path: string, bytes: string): void {
  const fd = openSync(path, 'a', 0o600);
  try { const b = Buffer.from(bytes); let n = 0; while (n < b.length) n += writeSync(fd, b, n, b.length - n); fsyncSync(fd); }
  finally { closeSync(fd); }
}
function syncDirectory(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
const disk: IO = {
  append: durableAppend,
  publish(path, bytes) {
    const tmp = path + '.pending'; const fd = openSync(tmp, 'w', 0o600);
    try { const b = Buffer.from(bytes); let n = 0; while (n < b.length) n += writeSync(fd, b, n, b.length - n); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(tmp, path); syncDirectory(join(path, '..'));
  },
};
const hashBytes = (s: string) => createHash('sha256').update(s).digest('hex');
function checkBinding(b: Binding): void {
  if (!b || !b.runId || !b.shadowRunId || !/^[a-f0-9]{40}$/.test(b.poly2CodeSha) || !/^[a-f0-9]{64}$/.test(b.componentSha256)
    || !Array.isArray(b.cohort) || b.cohort.length !== 5 || new Set(b.cohort).size !== 5
    || b.cohort.some(w => !/^0x[a-f0-9]{40}$/.test(w)) || utc(b.window.endUtc) <= utc(b.window.startUtc)
    || !['synthetic', 'observational'].includes(b.evidenceKind)
    || (b.evidenceKind === 'observational' && !b.sourcePublicKey)) throw new Error('capture: exact run/code/component/five-wallet/window binding required');
}
function assertClockMembership(clock: string, b: Binding): void {
  inWindow(clock, b.window); // validate exact instant, retain original spelling
}
function identity(id: unknown): boolean { return typeof id === 'string' && !!id || typeof id === 'number' && Number.isSafeInteger(id); }
function checkTrade(t: TradeFact, b: Binding): void {
  if (!t || !identity(t.sourceRecordId) || typeof t.sourceEventId !== 'string' || !t.sourceEventId || !/^0x[a-f0-9]{40}$/.test(t.wallet)
    || ![null, 'BUY', 'SELL'].includes(t.side) || t.asset !== null && typeof t.asset !== 'string'
    || t.conditionId !== null && typeof t.conditionId !== 'string'
    || t.size !== null && (typeof t.size !== 'number' || !Number.isFinite(t.size))
    || t.sourceTs !== null && (typeof t.sourceTs !== 'number' || !Number.isFinite(t.sourceTs))) throw new Error('capture: malformed trade');
  assertClockMembership(t.ingestedUtc, b);
  if (t.clockEvidence && canonical(t.clockEvidence) !== canonical(clockEvidence(t as unknown as Record<string, unknown>, ['ingestedUtc','tradedAtUtc']))) throw new Error('capture: canonical trade clock conflicts with original');
  if (t.tradedAtUtc !== null) utc(t.tradedAtUtc);
  if (t.tradedAtUtc === null && t.sourceTs !== null) throw new Error('capture: original source clock missing');
  const p = t.sourceEventId.split(':');
  if (p[0] === 'data-api' && (p.length !== 7 || !/^0x[a-fA-F0-9]{64}$/.test(p[1]!) || p[2] !== t.wallet || t.asset !== null && p[3] !== t.asset)) throw new Error('capture: original data-api identity invalid');
}
function checkFrame(f: SourceFrame, b: Binding): void {
  if (!f || f.version !== 1 || f.bindingSha256 !== digest(b) || !Number.isSafeInteger(f.cursor) || f.cursor <= 0
    || !Number.isSafeInteger(f.previousCursor) || f.previousCursor < 0 || f.cursor !== f.previousCursor + 1 || !f.transactionId
    || !['ACTIVATION', 'COMMIT', 'CHECKPOINT', 'END_FENCE'].includes(f.kind) || !Array.isArray(f.trades) || !Array.isArray(f.decisions)) throw new Error('capture: malformed source cursor/receipt');
  utc(f.observedUtc);
  if (b.evidenceKind === 'observational') {
    const { signature, signedPayload, ...unsigned } = f;
    if (!signature || !signedPayload || canonical(JSON.parse(signedPayload)) !== canonical(unsigned)
      || !verify(null, Buffer.from(signedPayload), b.sourcePublicKey!, Buffer.from(signature, 'base64'))) throw new Error('capture: source receipt authentication failed');
  } else if (f.signature !== null) throw new Error('capture: synthetic receipt must not impersonate producer');
  if (f.checkpointPayload !== undefined) {
    const { signature, signedPayload, checkpointPayload, ...checkpoint } = f;
    if (f.kind !== 'CHECKPOINT' || canonical(JSON.parse(checkpointPayload)) !== canonical(checkpoint))
      throw new Error('capture: checkpoint payload mismatch');
  }
  for (const t of f.trades) checkTrade(t, b);
  for (const d of f.decisions) {
    if (!d || !d.sourceEventId || !identity(d.paperRecordId) || d.rejectionReason !== null && typeof d.rejectionReason !== 'string') throw new Error('capture: malformed decision');
    assertClockMembership(d.sourceIngestedUtc, b);
    if (d.clockEvidence && canonical(d.clockEvidence) !== canonical(clockEvidence(d as unknown as Record<string, unknown>, ['sourceIngestedUtc','decisionUtc']))) throw new Error('capture: canonical decision clock conflicts with original');
    if (d.decisionUtc !== null) utc(d.decisionUtc);
  }
  if (f.kind === 'COMMIT') {
    if (utc(f.commitBeforeUtc) > utc(f.commitAfterUtc) || utc(f.commitAfterUtc) > utc(f.observedUtc)) throw new Error('capture: invalid committed source interval');
    // Commit visibility at E is not a frozen comparator population predicate.
  } else if (f.kind === 'CHECKPOINT' ? f.commitBeforeUtc !== null || f.commitAfterUtc !== null : f.trades.length || f.decisions.length || f.commitBeforeUtc !== null || f.commitAfterUtc !== null) throw new Error('capture: control receipt contains source facts');
  if (f.kind === 'ACTIVATION' && (utc(f.observedUtc) > utc(b.window.startUtc) || f.previousCursor !== 0)) throw new Error('capture: late/noninitial activation');
  if (f.kind === 'END_FENCE') {
    const x = f.fence;
    if (utc(f.observedUtc) < utc(b.window.endUtc) || !x || x.protocol !== 'all-writers-transaction-drain-v1'
      || canonical([...x.registeredWriters].sort()) !== canonical(['execution', 'ingestion'])
      || x.outstandingTransactions !== 0 || x.unresolvedFailures !== 0 || x.throughCursor !== f.previousCursor) throw new Error('capture: authoritative drained source boundary receipt required; MAX timestamp insufficient');
  } else if (f.fence !== null) throw new Error('capture: unexpected fence');
}

/** Journal authority is rebuilt before accepting any new source request. Cursor cache
 * is disposable; no source cursor advances until journal append+fsync succeeds. */
export class ProspectiveCapture {
  readonly path: string;
  readonly healthPath: string;
  private index = new DiskIndex();
  private journalHash = createHash('sha256');
  private eligibleTradeCount=0;
  private entryCount = 0;
  private lastEntry: Entry | null = null;
  private frames = new DiskMap<number, SourceFrame>(this.index, 'frames');
  private seenTransactions = new DiskSet(this.index, 'transactions');
  private trades = new DiskMap<string, TradeFact>(this.index, 'trades');
  private decisions = new DiskMap<string, DecisionFact>(this.index, 'decisions');
  private sourceIds = new DiskMap<string, string>(this.index, 'source_ids');
  private gaps = new DiskSet(this.index, 'gaps');
  private activation: string | null = null;
  private end: SourceFrame | null = null;
  private state: State = 'ARMED';
  private failures = 0;
  private error: string | null = null;
  private lastSuccess: string | null = null;
  private unusable = false;
  constructor(readonly dir: string, readonly binding: Binding, private readonly io: IO = disk) {
    checkBinding(binding); mkdirSync(dir, { recursive: true });
    this.path = join(dir, JOURNAL); this.healthPath = join(dir, 'poly2_capture_health.json');
    try {
      if (existsSync(this.path)) this.restore(journalLines(this.path));
      else { this.append('ARM', binding); syncDirectory(dir); }
      // Cache is never read as authority, including an ahead-of-journal cursor.
      this.publish();
    } catch(error) {this.index.close();throw error;}
  }
  private restore(lines: Iterable<string>): void {
    for (const line of lines) {
      const e = JSON.parse(line) as Entry;
      if (e.version !== 1 || e.seq !== this.entryCount + 1 || e.previousSha256 !== (this.lastEntry ? digest(this.lastEntry) : null)) throw new Error('capture: journal chain invalid');
      this.apply(e); this.entryCount++; this.lastEntry=e;
      this.journalHash.update(line+'\n');
    }
  }
  private apply(e: Entry): void {
    if (e.kind === 'ARM') {
      if (e.seq !== 1 || canonical(e.payload) !== canonical(this.binding)) throw new Error('capture: journal run binding mismatch');
      return;
    }
    if (!this.entryCount || this.state === 'SEALED' || this.state === 'FAILED') throw new Error('capture: illegal terminal transition');
    if (e.kind === 'SOURCE') {
      const f = e.payload as SourceFrame; checkFrame(f, this.binding);
      if (this.frames.has(f.cursor) || f.previousCursor !== this.frames.size || this.seenTransactions.has(f.transactionId)) throw new Error('capture: source ordering/duplicate transaction conflict');
      if (!this.activation && f.kind !== 'ACTIVATION' || this.activation && f.kind === 'ACTIVATION' || this.end) throw new Error('capture: source activation/fence ordering');
      if (f.kind === 'ACTIVATION') { this.activation = f.observedUtc; this.state = 'ACTIVE'; }
      for (const t of f.trades) {
        const old = this.trades.get(t.sourceEventId);
        if (old && canonical(old) !== canonical(t)) throw new Error('capture: trade identity conflict');
        const id = canonical(t.sourceRecordId), oldEvent = this.sourceIds.get(id);
        if (oldEvent && oldEvent !== t.sourceEventId) throw new Error('capture: source record identity conflict');
        if(!old&&this.binding.cohort.includes(t.wallet)&&inWindow(t.ingestedUtc,this.binding.window))this.eligibleTradeCount++;
        this.trades.set(t.sourceEventId, t); this.sourceIds.set(id, t.sourceEventId);
      }
      for (const d of f.decisions) {
        if (!inWindow(d.sourceIngestedUtc, this.binding.window)) continue;
        const original = this.trades.get(d.sourceEventId);
        if (!original || original.ingestedUtc !== d.sourceIngestedUtc) throw new Error('capture: decision without captured original ingestion');
        const old = this.decisions.get(d.sourceEventId);
        if (old && canonical(old) !== canonical(d)) throw new Error('capture: conflicting initial decision');
        this.decisions.set(d.sourceEventId, d);
      }
      if (f.kind === 'END_FENCE') {
        const cert = f.fence?.certificate, checkpoint = cert && this.frames.get(cert.finalCheckpointCursor);
        if (this.binding.evidenceKind === 'observational' || this.binding.terminalAuthority || this.frames.get(f.previousCursor)?.kind === 'CHECKPOINT' || cert) {
          const authority = this.binding.terminalAuthority;
          if (!cert || !authority || cert.inventorySha256 !== authority.inventorySha256
            || cert.contractSha256 !== authority.contractSha256 || !/^[a-f0-9]{64}$/.test(cert.inventorySha256)
            || !/^[a-f0-9]{64}$/.test(cert.contractSha256)
            || cert.noFutureInWindowInsertions !== true || cert.noFutureRelevantDecisions !== true
            || cert.insertionFactsRetained !== true || cert.outstandingTransactions !== 0 || cert.unresolvedFailures !== 0
            || !Array.isArray(cert.registeredWriters) || canonical([...cert.registeredWriters].sort()) !== canonical([...(f.fence?.registeredWriters ?? [])].sort()) || !checkpoint || checkpoint.kind !== 'CHECKPOINT'
            || checkpoint.cursor !== f.previousCursor || (checkpoint.checkpointPayload ? hashBytes(checkpoint.checkpointPayload) : digest(checkpoint)) !== cert.finalCheckpointSha256
            || utc(cert.closedUtc) < utc(this.binding.window.endUtc)
            || utc(checkpoint.observedUtc) < utc(cert.closedUtc) || utc(f.observedUtc) < utc(checkpoint.observedUtc))
            throw new Error('capture: INCOMPLETE terminal visibility/drain certificate missing or invalid');
        }
        this.end = f;
      }
      this.frames.set(f.cursor, f); this.seenTransactions.add(f.transactionId); this.lastSuccess = f.observedUtc;
    } else if (e.kind === 'GAP') {
      const p = e.payload as { id: string; error: string };
      if (!p.id || !p.error || this.gaps.has(p.id)) throw new Error('capture: malformed/duplicate gap');
      this.gaps.add(p.id); this.failures++; this.error = p.error;
    } else if (e.kind === 'RESOLVE') {
      const p = e.payload as { id: string; recoveredCursors: number[] };
      if (!this.gaps.has(p.id) || !p.recoveredCursors.length || p.recoveredCursors.some(c => !this.frames.has(c))) throw new Error('capture: gap resolution requires durable exact source replay');
      // A generic supplied list cannot authenticate which missing transaction was recovered.
      // Keep source-loss gaps unresolved; only cursor publication failures are recoverable.
      if (!p.id.startsWith('cursor-publication:')) throw new Error('capture: source-loss gap requires independently reviewed source recovery receipt');
      this.gaps.delete(p.id);
    } else if (e.kind === 'FAIL') { this.state = 'FAILED'; this.failures++; this.error = String(e.payload); }
    else if (e.kind === 'SEAL') {
      if (!this.activation || !this.end || this.gaps.size || canonical(e.payload) !== canonical({ endReceiptSha256: digest(this.end), sourceCursor: this.frames.size })) throw new Error('capture: incomplete/unresolved seal');
      this.state = 'SEALED';
    } else throw new Error('capture: unknown journal entry');
  }
  private append(kind: Entry['kind'], payload: unknown): void {
    if (this.unusable) throw new Error('capture: sink latched; restart required');
    const entry: Entry = { version: 1, seq: this.entryCount + 1, previousSha256: this.lastEntry ? digest(this.lastEntry) : null, kind, payload };
    // Validate only the new transition against disk-backed complete derived state.
    // Roll back both index writes and scalar transitions before authoritative append.
    const scalars={eligibleTradeCount:this.eligibleTradeCount,activation:this.activation,end:this.end,state:this.state,failures:this.failures,error:this.error,lastSuccess:this.lastSuccess};
    this.index.db.exec('SAVEPOINT validate_entry');
    try { this.apply(entry); }
    finally { this.index.db.exec('ROLLBACK TO validate_entry; RELEASE validate_entry'); Object.assign(this,scalars); }
    const line = canonical(entry) + '\n';
    try { this.io.append(this.path, line); }
    catch (error) { this.unusable = true; this.state = 'FAILED'; this.failures++; this.error = String(error); this.bestEffortHealth(); throw error; }
    try { this.apply(entry); this.entryCount++; this.lastEntry=entry; this.journalHash.update(line); }
    catch (error) {this.unusable=true; this.state='FAILED'; this.error=String(error); this.bestEffortHealth(); throw error;}
  }
  gapPage(after: string | null=null, limit=100): string[] {
    if (!Number.isInteger(limit)||limit<1||limit>1000) throw new Error('capture: page limit 1..1000');
    return this.index.db.prepare('SELECT key FROM gaps WHERE key>? ORDER BY key LIMIT ?').all(JSON.stringify(after??''),limit).map(r=>JSON.parse(String(r.key)) as string);
  }
  private rowCount(): number {
    return this.eligibleTradeCount;
  }
  close(): void { this.index.close(); }
  health(): CaptureHealth {
    return { state: this.state, quality: this.unusable || this.gaps.size || this.state === 'FAILED' ? 'AT_RISK' : 'HEALTHY', lastSuccessUtc: this.lastSuccess, cursor: this.frames.size,
      endCoverage: !!this.end && !this.gaps.size && !this.unusable, failures: this.failures, gaps: this.gapPage(), gapCount: this.gaps.size, gapsTruncated: this.gaps.size>100, count: this.rowCount(), error: this.error, archiveState: this.state === 'SEALED' ? 'SEALED' : 'INCOMPLETE',
      incompleteProperty: this.end && !this.gaps.size && !this.unusable ? null : 'NO_FUTURE_IN_WINDOW_INGESTIONS_AND_RELEVANT_INITIAL_DECISIONS_AFTER_FINAL_READ' };
  }
  private bestEffortHealth(): void { try { this.io.publish(this.healthPath, canonical({ version: 1, binding: this.binding, bindingSha256: digest(this.binding), ...this.health() })); } catch { /* independent status may also fail; never trading control */ } }
  private publish(): void {
    try { this.io.publish(join(this.dir, 'poly2_capture_cursor.json'), canonical({ version: 1, bindingSha256: digest(this.binding), cursor: this.frames.size, journalSha256: this.journalHash.copy().digest('hex') })); this.io.publish(this.healthPath, canonical({ version: 1, binding: this.binding, bindingSha256: digest(this.binding), ...this.health() })); }
    catch (error) { this.unusable = true; this.state = 'FAILED'; this.error = String(error); this.failures++; this.bestEffortHealth(); throw error; }
  }
  accept(frame: SourceFrame): boolean {
    if (this.unusable || this.state === 'FAILED') throw new Error('capture: not writable');
    const old = this.frames.get(frame.cursor);
    if (old) { if (canonical(old) !== canonical(frame)) throw new Error('capture: conflicting replay'); return false; }
    if (this.state === 'SEALED') throw new Error('capture: source record after sealed fence');
    try { this.append('SOURCE', frame); }
    catch (error) {
      if (!this.unusable) this.gap(`source:${frame.cursor}`, String(error));
      throw error;
    }
    this.publish(); return true;
  }
  gap(id: string, error: string): void { if (this.gaps.has(id)) return; this.append('GAP', { id, error }); this.publish(); }
  fail(error: string): void { this.append('FAIL', error); this.publish(); }
  /** Cursor-file failure after append is repaired by journal rebuild, not re-ingestion. */
  resolveCursorPublication(id: string, recoveredCursors: number[]): void { this.append('RESOLVE', { id, recoveredCursors }); this.publish(); }
  rows(): (Poly2ExportRow & { sourceRecordId: string | number; sourceEventId: string; paperRecordId?: string | number })[] {
    const b = this.binding;
    // Retain only the frozen eligible population, not every disk-backed trade.
    const eligible: TradeFact[] = [];
    for (const t of this.trades.values()) {
      if (b.cohort.includes(t.wallet) && inWindow(t.ingestedUtc, b.window)) eligible.push(t);
    }
    return eligible
      .sort((a, c) => canonical(a.sourceRecordId).localeCompare(canonical(c.sourceRecordId), 'en'))
      .map(t => {
        const d = this.decisions.get(t.sourceEventId), p = t.sourceEventId.split(':');
        return { wallet: t.wallet, txHash: p[0] === 'data-api' ? p[1]! : null, asset: t.asset, conditionId: t.conditionId, side: t.side, size: t.size,
          price: null, sourceTs: t.sourceTs, sourceEpochMicros: t.tradedAtUtc === null ? null : utc(t.tradedAtUtc).toString(), tradedAtUtc: t.tradedAtUtc, ingestedUtc: t.ingestedUtc, normalizedUtc: null, decisionUtc: d?.decisionUtc ?? null,
          signalUtc: null, source: p[0]!, freshnessAgeSec: null, freshnessRejection: d?.rejectionReason === 'stale_signal' ? 'stale_signal' : null,
          policyEligible: null, copyabilityOutcome: null, rejectionReason: d?.rejectionReason ?? null, paperOutcome: null,
          sourceRecordId: t.sourceRecordId, sourceEventId: t.sourceEventId, ...(d ? { paperRecordId: d.paperRecordId } : {}) };
      });
  }
  seal(): ProspectiveArchive {
    if (this.unusable || this.state === 'FAILED') throw new Error('capture: failed sink/source cannot seal');
    if (this.state !== 'SEALED') { this.append('SEAL', { endReceiptSha256: this.end ? digest(this.end) : null, sourceCursor: this.frames.size }); this.publish(); }
    return this.archive();
  }
  private summary():Omit<ProspectiveArchive,'evidence'> {
    const rows = this.rows(), clocks = rows.map(r => r.ingestedUtc).sort((a,b) => clockOrder(a,b));
    const payload = { window: this.binding.window, rows };
    validatePoly2Export(payload);
    return { ...payload, manifest: { schemaVersion: 4, version: VERSION, binding: this.binding, bindingSha256: digest(this.binding), journalSha256: this.journalHash.copy().digest('hex'), payloadSha256: digest(payload),
      rowCount: rows.length, sourceCursor: this.frames.size, minTimestampUtc: clocks[0] ?? null, maxTimestampUtc: clocks.at(-1) ?? null,
      activationUtc: this.activation!, endReceiptSha256: digest(this.end), gaps: [...this.gaps].sort(), failures: this.failures,
      completenessScope: 'COMMITTED_POLY2_INGESTIONS_IN_FROZEN_WINDOW_NOT_UPSTREAM_REST' } };
  }
  private *clockAudit():Generator<ReturnType<typeof clockEvidence>> {
    yield clockEvidence(this.binding.window,['startUtc','endUtc']);
    for (const f of this.frames.values()) {
      yield clockEvidence(f as unknown as Record<string,unknown>,['observedUtc','commitBeforeUtc','commitAfterUtc']);
      for(const t of f.trades)yield clockEvidence(t as unknown as Record<string,unknown>,['ingestedUtc','tradedAtUtc']);
      for(const d of f.decisions)yield clockEvidence(d as unknown as Record<string,unknown>,['decisionUtc','sourceIngestedUtc']);
    }
  }
  private archive(journal?:string):ProspectiveArchive {
    return {...this.summary(),evidence:{journal:journal??readFileSync(this.path,'utf8'),clockAudit:[...this.clockAudit()]}};
  }
  /** File-oriented seal: authority and audit history are serialized incrementally. */
  sealToFile(outputPath:string):ProspectiveArchive['manifest'] {
    if(this.unusable||this.state==='FAILED')throw new Error('capture: failed sink/source cannot seal');
    if(this.state!=='SEALED'){this.append('SEAL',{endReceiptSha256:this.end?digest(this.end):null,sourceCursor:this.frames.size});this.publish();}
    const summary=this.summary(),fd=openSync(outputPath+'.pending','wx',0o600);
    const write=(s:string):void=>{const b=Buffer.from(s);let n=0;while(n<b.length){const k=writeSync(fd,b,n,b.length-n);if(k<=0)throw new Error('short archive write');n+=k;}};
    try {
      write('{"window":'+canonical(summary.window)+',"rows":'+canonical(summary.rows)+',"manifest":'+canonical(summary.manifest)+',"evidence":{"journal":"');
      const hash=createHash('sha256');
      for(const line of journalLines(this.path)){hash.update(line+'\n');write(JSON.stringify(line+'\n').slice(1,-1));}
      if(hash.digest('hex')!==summary.manifest.journalSha256)throw new Error('capture: authority changed during serialization');
      write('","clockAudit":[');let first=true;
      for(const value of this.clockAudit()){write((first?'':',')+canonical(value));first=false;}
      write(']}}');fsyncSync(fd);
    } finally {closeSync(fd);}
    linkSync(outputPath+'.pending',outputPath);
    // A visible link is not yet durable. On failure preserve published/pending
    // evidence and throw; retries must never overwrite an existing archive.
    const directory=join(outputPath,'..');
    syncDirectory(directory);
    unlinkSync(outputPath+'.pending');
    syncDirectory(directory);
    return summary.manifest;
  }
  static validateFile(path:string,cohort:string[],window:Binding['window'],allowSynthetic=false,expectedBinding?:Binding):Omit<ProspectiveArchive,'evidence'> {
    const dir=mkdtempSync(join(tmpdir(),'poly2-capture-replay-')),cursor=new JsonCursor(path);
    let manifest:ProspectiveArchive['manifest']|undefined,archiveWindow:Binding['window']|undefined;
    const rows:Poly2ExportRow[]=[],auditHash=createHash('sha256').update('[');let audits=0,probe:ProspectiveCapture|undefined;
    try {
      cursor.object(key=>{
        if(key==='window')archiveWindow=cursor.value() as Binding['window'];
        else if(key==='manifest')manifest=cursor.value() as ProspectiveArchive['manifest'];
        else if(key==='rows')cursor.array(row=>rows.push(row as Poly2ExportRow));
        else if(key==='evidence')cursor.object(field=>{
          if(field==='journal'){
            const fd=openSync(join(dir,JOURNAL),'wx',0o600);
            try {for(const chunk of cursor.stringChunks()){const b=Buffer.from(chunk);let n=0;while(n<b.length)n+=writeSync(fd,b,n,b.length-n);}}finally{closeSync(fd);}
          } else if(field==='clockAudit')cursor.array(value=>auditHash.update((audits++?',':'')+canonical(value)));
          else throw new Error('capture: unexpected evidence field');
        });else throw new Error('capture: unexpected archive field');
      });cursor.finish();
      const b=manifest?.binding;
      if(!b||manifest?.schemaVersion!==4||canonical(b.window)!==canonical(window)||canonical([...b.cohort].sort())!==canonical([...cohort].sort())||canonical(archiveWindow)!==canonical(window))throw new Error('capture: archive binding mismatch');
      checkBinding(b);
      if(b.evidenceKind==='synthetic'&&!allowSynthetic)throw new Error('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: synthetic receipts are not producer proof');
      if(b.evidenceKind==='observational'&&(!expectedBinding||canonical(b)!==canonical(expectedBinding)))throw new Error('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: independently pinned run/source enrollment binding required');
      if(!existsSync(join(dir,JOURNAL)))throw new Error('capture: missing full lifecycle evidence');
      probe=new ProspectiveCapture(dir,b);
      const expected=probe.summary(),expectedHash=createHash('sha256').update('[');let count=0;
      for(const value of probe.clockAudit())expectedHash.update((count++?',':'')+canonical(value));
      if(probe.state!=='SEALED'||canonical(manifest)!==canonical(expected.manifest)||canonical(rows)!==canonical(expected.rows)||auditHash.update(']').digest('hex')!==expectedHash.update(']').digest('hex'))throw new Error('capture: archive replay/count/hash/cursor/seal mismatch');
      return expected;
    } finally {probe?.close();cursor.close();rmSync(dir,{recursive:true,force:true});}
  }
  static validate(value: unknown, cohort: string[], window: Binding['window'], allowSynthetic = false, expectedBinding?: Binding): ProspectiveArchive {
    const a = value as ProspectiveArchive, b = a?.manifest?.binding;
    if (a?.manifest?.schemaVersion !== 4 || !a.evidence || !b || canonical(b.window) !== canonical(window) || canonical([...b.cohort].sort()) !== canonical([...cohort].sort())) throw new Error('capture: archive binding mismatch');
    checkBinding(b);
    if (b.evidenceKind === 'synthetic' && !allowSynthetic) throw new Error('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: synthetic receipts are not producer proof');
    if (b.evidenceKind === 'observational' && (!expectedBinding || canonical(b) !== canonical(expectedBinding))) throw new Error('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: independently pinned run/source enrollment binding required; embedded self-signed key is insufficient');
    const probe = Object.create(ProspectiveCapture.prototype) as ProspectiveCapture;
    const index=new DiskIndex();
    Object.assign(probe, { binding: b, path:null, index, journalHash:createHash('sha256'), eligibleTradeCount:0, entryCount:0, lastEntry:null, frames: new DiskMap(index,'frames'), seenTransactions: new DiskSet(index,'transactions'), trades: new DiskMap(index,'trades'), decisions: new DiskMap(index,'decisions'), sourceIds: new DiskMap(index,'source_ids'), gaps: new DiskSet(index,'gaps'), activation: null, end: null, state: 'ARMED', failures: 0, error: null, lastSuccess: null, unusable: false });
    function* lines(): Generator<string> {
      let start=0,end:number;
      while ((end=a.evidence.journal.indexOf('\n',start))>=0) {yield a.evidence.journal.slice(start,end);start=end+1;}
      if (start!==a.evidence.journal.length) throw new Error('capture: torn journal; immutable bytes preserved, recovery refused');
    }
    try {
      probe.restore(lines());
      // Legacy archive input already contains journal bytes; no second retained copy.
      const expected=probe.archive(a.evidence.journal);
      if (probe.state !== 'SEALED' || canonical(a) !== canonical(expected)) throw new Error('capture: archive replay/count/hash/cursor/seal mismatch');
      return a;
    } finally {index.close();}
  }
}
