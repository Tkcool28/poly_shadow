/**
 * Chain watcher — observation-only Polygon log subscriber.
 *
 * Design ported (patterns, not decoder) from upstream chain-trade-watcher.ts:
 * WSS subscribe + heartbeat/stale reconnect + eth_getLogs backfill/verify.
 *
 * Completeness-first subscription policy (PHASE1_ASSESSMENT §4): subscribe
 * FULL emitter + topic0 sets for both V2 exchanges and both V2 events;
 * watched-wallet filtering happens post-decode. Topic2 funded-owner filtering
 * is NOT used until fixture-proven complete.
 *
 * Evidence-safety contract (consolidated exit audit):
 * - Removal notices bypass dedup and are always tombstoned (blockHash-aware).
 * - Every raw identity gets a DURABLE disposition (append-only):
 *   OBSERVED | COMPLETED_NO_OBSERVATION | TERMINAL_QUARANTINE | PENDING.
 *   Startup rebuilds in-memory dedup from that index and replays only
 *   PENDING identities — restart delivery is idempotent, valid terminal
 *   rows are never replayed, and no observation is ever stranded.
 * - seenRaw is marked only after full commit; concurrent deliveries of the
 *   same blockHash-aware identity are serialized through an in-flight map.
 * - Reorg recovery is fork-aware: dense checkpoints (spacing < lookback) let
 *   a common ancestor be PROVED against stored hashes. With no provable
 *   ancestor, recovery FAILS CLOSED (recoveryRequired quarantine; cursor not
 *   advanced; no automatic resume). A removal/reorg/HASH_CONFLICT tombstone
 *   dominates any PENDING disposition for that exact identity forever —
 *   only a new raw row under a NEW blockHash is new evidence.
 * - Recovery/scan/validation are single-flight (serialized); a generation
 *   counter invalidates handlers that were mid-flight across a rewind.
 * - First start: live coverage begins only after the subscription is
 *   acknowledged; backfill overlaps a bounded window so handshake-gap
 *   events are captured (native dedup removes double-delivery).
 * - Observations record raw ARRIVAL time (discovery latency) separately
 *   from completion time; arrival survives retries and restart replay.
 */

import WebSocket from 'ws';
import { EvidenceIndexError } from './storage.js';
import { decodeV2Log, classifyFill, normalizeGross, crossCheckAggregate } from './decoder.js';
import type { DecodedOrderFilled, DecodedOrdersMatched, RawLog } from './decoder.js';
import { V2_SUBSCRIBE_TOPICS, V2_EXCHANGES } from './v2constants.js';
import { assertAllowedUrl, rpcCall } from './egress.js';
import type { ShadowConfig } from './config.js';
import type { Disposition, ShadowStore } from './storage.js';
import { cgroupMemory } from './memory.js';
import { OperationalEvidence, rpcRequestId } from './operational-evidence.js';

interface BlockRef { number: number; hash: string; timestamp: number }

type RpcFn = typeof rpcCall;

/** Thrown when the provider's block hash conflicts with the log's block. */
export class ReorgSignal extends Error {
  constructor(public readonly blockNumber: number) {
    super(`block hash conflict at ${blockNumber}`);
    this.name = 'ReorgSignal';
  }
}

/** Provider lag only: six attempts; 100/200/400/800/1600ms (3.1s total). */
const PROVIDER_LAG_ATTEMPTS = 6;
class ProviderLagError extends Error {}

/** How far back common-ancestor search may walk (blocks). */
const REORG_LOOKBACK = 128;
/**
 * Block-hash checkpoint spacing while scanning. Guaranteed < REORG_LOOKBACK
 * so a common ancestor within the supported reorg depth can always be
 * PROVED against a genuinely stored hash (≥ lookback/spacing checkpoints
 * inside any walk window).
 */
const CHECKPOINT_SPACING = 16;
/** First-start backfill overlap: covers the subscribe-handshake window. */
const FIRST_START_OVERLAP_BLOCKS = 64;
/** Bounds for in-memory diagnostic maps (Phase 2 bounded-run foundation). */
const MATCHED_CACHE_MAX = 1024;
const BLOCK_CACHE_MAX = 512;
const RPC_PARENT_LINEAGE_MAX = 256;

/** FIFO-bounded Map: oldest entries evicted past `max`. */
class BoundedMap<K, V> extends Map<K, V> {
  constructor(private max: number, private onEvict: () => void = () => {}) { super(); }
  override set(key: K, value: V): this {
    if (this.has(key)) this.delete(key);
    super.set(key, value);
    while (this.size > this.max) {
      this.delete(this.keys().next().value as K);
      this.onEvict();
    }
    return this;
  }
}

export class ChainWatcher {
  private ws: WebSocket | null = null;
  private reconnectDelayMs = 1000;
  private shouldReconnect = true;
  private lastMessageAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private verifier: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptionAcked = false;
  private blockCache = new BoundedMap<number, BlockRef>(BLOCK_CACHE_MAX);
  /** OrdersMatched cross-check buffers, keyed by order hash (both arrival
   *  orders reconciled; bounded FIFO). */
  private matchedByHash = new BoundedMap<string, DecodedOrdersMatched>(MATCHED_CACHE_MAX);
  private aggregateByHash = new BoundedMap<string, DecodedOrderFilled & { logIndex: number; txHash: string }>(MATCHED_CACHE_MAX);
  /** Exact durable identity membership: no lifetime JS sets or finite horizon. */
  private committed(key:string):boolean {
    const s=this.store.identityState(key);
    // A canonical row alone is not completion: publication may still be pending.
    return s.disposition ? s.disposition !== 'PENDING' : s.observed;
  }
  private removed(key:string):boolean {return this.store.identityState(key).removed;}
  private rawCommitted(key:string):boolean {return this.store.identityState(key).raw;}
  /** blockHash-aware identity -> in-flight commit promise */
  private inflight = new Map<string, Promise<void>>();
  /** transient failures awaiting replay (arrival time preserved) */
  private retryQueue: Array<{ log: RawLog & { blockHash: string }; arrivedUtc: string }> = [];
  /** Bumped on every rewind: handlers from an older generation abort commit. */
  private generation = 0;
  /** Single-flight chain for validate/scan/replay/recovery transitions. */
  private exclusive: Promise<void> = Promise.resolve();
  private exclusiveDepth=0;
  /**
   * Hard recovery-required state: set when no PROVED common ancestor exists
   * within the supported window. Automatic recovery STOPS — the cursor is
   * not advanced to an unverified provider hash and scanning does not
   * resume. A bounded manual/explicit recovery is a later operator action.
   */
  recoveryRequired = false;
  private replayActive=false;
  private replayRows=0;
  private lastProgressUtc: string | null=null;
  private filteredLogs=0;
  memoryTelemetry() {
    const m=process.memoryUsage();
    return {pid:process.pid, atUtc:this.nowIso(), rssBytes:m.rss, heapUsedBytes:m.heapUsed,
      heapTotalBytes:m.heapTotal, externalBytes:m.external, ...cgroupMemory(), ...this.store.indexTelemetry(),
      inflight:this.inflight.size, retryQueue:this.retryQueue.length, exclusiveDepth:this.exclusiveDepth, replayActive:this.replayActive,
      replayRows:this.replayRows, lastProgressUtc:this.lastProgressUtc,
      filteredLogs:this.filteredLogs, recoveryRequired:this.recoveryRequired,
      rpcParentLineages:this.rpcParents.size,rpcParentLineageCapacity:RPC_PARENT_LINEAGE_MAX,
      rpcParentLineageEvictions:this.rpcParentLineageEvictions,rpcParentHistoryTruncated:this.rpcParentHistoryTruncated,
      blockCache:this.blockCache.size, matchedCache:this.matchedByHash.size, aggregateCache:this.aggregateByHash.size};
  }
  /** Full valid ABI only. Unknown/malformed events and removals are evidence.
   * OrdersMatched remains retained for cross-checks even with wallet mismatch.
   * Already retained identities bypass this filter (including reorg/retries).
   */
  private irrelevant(log: RawLog & {blockHash:string}): boolean {
    if(log.removed) return false;
    if(!/^0x[0-9a-fA-F]{64}$/.test(log.transactionHash) || !/^0x[0-9a-fA-F]{64}$/.test(log.blockHash)
      || !Number.isSafeInteger(Number(log.blockNumber)) || Number(log.blockNumber)<0
      || !Number.isSafeInteger(Number(log.logIndex)) || Number(log.logIndex)<0) return false;
    const key=`${this.cfg.chainId}:${log.address.toLowerCase()}:${log.transactionHash}:${Number(log.logIndex)}:${log.blockHash.toLowerCase()}`;
    if(this.store.identityState(key).raw) return false;
    if(!log.topics.every(t=>/^0x[0-9a-fA-F]{64}$/.test(t)) || !/^0x[0-9a-fA-F]{448}$/.test(log.data)
      || !log.topics.slice(2).every(t=>/^0x0{24}/i.test(t))) return false;
    try {
      const d=decodeV2Log(log);
      return d?.kind==='OrderFilled' && d.makerAmountFilled>0n && d.takerAmountFilled>0n && !classifyFill(d,this.cfg.watchedWallets);
    } catch {return false;}
  }

  constructor(
    private cfg: ShadowConfig,
    private store: ShadowStore,
    private nowIso: () => string = () => new Date().toISOString(),
    private rpc: RpcFn = rpcCall,
    /**
     * PHASE 3 interface extension (documented): called synchronously after
     * each observation commits, so the source-racing layer can record
     * FIRST/CORROBORATOR membership. Default no-op — Phase 2 behavior and
     * tests are unchanged.
     */
    private onObservation: (obs: import('./storage.js').ObservationRow) => void = () => {},
    private operational?: OperationalEvidence,
  ) { this.operational?.onBroken(() => this.halt()); }

  private rpcParentLineageEvictions=0;
  private rpcParentHistoryTruncated=false;
  /** Recent exact-request retry links only; eviction is reported in telemetry. */
  private rpcParents = new BoundedMap<string,string>(RPC_PARENT_LINEAGE_MAX,()=>{
    this.rpcParentLineageEvictions++;
    this.rpcParentHistoryTruncated=true;
  });
  private async rpcObserved<T>(method: string, params: unknown[], reason: import('./operational-evidence.js').RpcReason = 'other', attempt = 1, retryParentRequestId: string | null = null): Promise<T> {
    this.operational?.assertUsable();
    if (!this.operational) return this.rpc<T>(this.cfg.polygonHttpRpcUrl, method, params);
    const key=`${method}:${JSON.stringify(params)}`;
    const parent=retryParentRequestId ?? this.rpcParents.get(key) ?? null;
    try {
      const value=await this.operational.rpc(() => this.rpc<T>(this.cfg.polygonHttpRpcUrl, method, params), {
        family: method, method, params, component: 'CHAIN', reason, attempt, retryParentRequestId:parent, timeoutMs: 15_000,
      });
      this.rpcParents.delete(key); return value;
    } catch (err) { const id=rpcRequestId(err); if(id) this.rpcParents.set(key,id); throw err; }
  }

  start(): void {
    this.operational?.assertUsable();
    this.shouldReconnect = true;
    this.connect();
  }

  private providerLagWaiters = new Set<{timer:ReturnType<typeof setTimeout>;reject:(error:unknown)=>void}>();
  private waitProviderLag(attempt:number):Promise<void> {
    this.operational?.assertUsable();
    return new Promise((resolve,reject)=>{
      const waiter={timer:setTimeout(()=>{this.providerLagWaiters.delete(waiter);resolve();},100*2**attempt),reject};
      this.providerLagWaiters.add(waiter);
    });
  }

  private halt(): void {
    this.shouldReconnect = false;
    if(this.operational && !this.operational.isUsable()) {
      let failure:unknown;
      try{this.operational.assertUsable();}catch(error){failure=error;}
      for(const waiter of this.providerLagWaiters){clearTimeout(waiter.timer);waiter.reject(failure);}
      this.providerLagWaiters.clear();
    }
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.verifier) clearInterval(this.verifier);
    this.heartbeat=null; this.verifier=null;
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.reconnectTimer=null;
    this.ws?.close(1000, 'shutdown');
  }

  stop(): void {
    this.halt(); // cleanup must precede a possibly failing tail-proof append
    if (this.operational && !this.operational.isUsable()) return;
    const cursor=this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    this.operational?.tailProof({component:'CHAIN',finalObservedHeadBlock:null,finalVerifiedBlock:cursor?.blockNumber ?? null,
      finalSuccessfulSelectedTopicScanRange:cursor ? {fromBlock:cursor.blockNumber,toBlock:cursor.blockNumber} : null,
      unresolvedTailRange:this.recoveryRequired ? {fromBlock:(cursor?.blockNumber ?? 0)+1,toBlock:null} : null,
      finalCursor:cursor ?? null,maximumRetainedRelevantRawBlock:cursor?.blockNumber ?? null,
      finalVerificationTimestamp:this.nowIso(),recoveryRequired:this.recoveryRequired});
  }

  /** Serialize scan/validate/replay/recovery: one transition at a time. */
  private runExclusive(fn: () => Promise<void>): Promise<void> {
    // Keep at most running + one follow-up transition. Excess notifications
    // coalesce: durable pending/tombstones/cursor remain for the next verifier.
    if(this.exclusiveDepth>=2) return Promise.resolve();
    this.exclusiveDepth++;
    const run = this.exclusive.then(fn, fn).finally(()=>{this.exclusiveDepth--;});
    this.exclusive = run.catch(() => {});
    return run;
  }

  private connect(): void {
    if (!this.shouldReconnect || (this.operational && !this.operational.isUsable())) return;
    // The WSS connection goes through the SAME egress assertion as HTTP RPC.
    // The WS host must match the configured HTTP RPC host (or the public
    // allowlist) — passing the WS URL as its own allowance would be
    // tautological and assert nothing.
    assertAllowedUrl(this.cfg.polygonWsRpcUrl, [this.cfg.polygonHttpRpcUrl]);
    const ws = new WebSocket(this.cfg.polygonWsRpcUrl);
    this.ws = ws;
    this.lastMessageAt = Date.now();
    this.subscriptionAcked = false;

    ws.on('open', () => {
      if (!this.shouldReconnect || (this.operational && !this.operational.isUsable())) { this.halt(); return; }
      this.reconnectDelayMs = 1000;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', { address: [...V2_EXCHANGES], topics: [[...V2_SUBSCRIBE_TOPICS]] }],
      }));
      this.startHeartbeat();
      // Backfill begins only after the subscription is ACKNOWLEDGED — see
      // the message handler for id===1. Live coverage before that moment is
      // not assumed; the first-start overlap window closes the gap.
    });

    ws.on('message', (data: WebSocket.Data) => {
      if (this.operational && !this.operational.isUsable()) { this.halt(); return; }
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.id === 1 && msg.error) { this.recordFailure('subscription-ack', new Error(JSON.stringify(msg.error))); return; }
        if (msg.id === 1 && msg.result) {
          // Subscription acknowledged: live coverage is now active.
          this.subscriptionAcked = true;
          void this.runExclusive(() => this.backfillFromCursor())
            .catch((err) => this.recordFailure('backfill', err));
          return;
        }
        if (msg.method === 'eth_subscription' && msg.params?.result) {
          void this.handleLog(msg.params.result as RawLog & { blockHash: string })
            .catch((err) => this.recordFailure('subscription-log', err));
        }
      } catch (err) { this.recordFailure('websocket-message', new Error(`malformed websocket message: ${String(err)}`)); }
    });

    // Liveness: any sign of life counts — subscription messages AND pongs.
    ws.on('pong', () => { this.lastMessageAt = Date.now(); });
    ws.on('close', () => { this.scheduleReconnect(); });
    ws.on('error', (err) => { this.recordFailure('websocket-error', err); });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.cfg.staleMs) {
        this.recordFailure('websocket-stale', new Error('websocket heartbeat stale'));
        this.ws?.terminate();
        return;
      }
      try { this.ws?.ping(); } catch (err) { this.recordFailure('websocket-ping', err); }
    }, this.cfg.heartbeatMs);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    if(this.reconnectTimer)clearTimeout(this.reconnectTimer);
    this.reconnectTimer=setTimeout(() => { this.reconnectTimer=null; if (this.shouldReconnect) this.connect(); }, delay);
  }

  /** Visible failure record — failures are evidence, never swallowed. */
  private recordFailure(where: string, err: unknown): void {
    if (this.operational && !this.operational.isUsable()) { this.halt(); return; }
    const atUtc=this.nowIso();
    // Independent operational evidence is attempted first so a ShadowStore index
    // failure itself remains visible; an unavailable operational index fails closed.
    try { this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:rpcRequestId(err),
      errorClass:OperationalEvidence.errorClass(err),reason:`${where}: ${String(err).slice(0,256)}`,
      eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true}); }
    catch { this.halt(); return; }
    if (err instanceof EvidenceIndexError || this.store.indexTelemetry().indexInvalid) return;
    this.store.appendQuarantine({
      kind: 'TRANSIENT_FAILURE',
      detail: { where, error: String(err) },
      firstSeenUtc: atUtc,
    });
  }

  /** Durable disposition for one blockHash-aware identity. */
  private recordDisposition(
    log: RawLog & { blockHash: string },
    disposition: Disposition,
  ): void {
    this.operational?.assertUsable();
    // PENDING is a durable stage, not a retry-attempt counter.
    const key=`${this.cfg.chainId}:${log.address.toLowerCase()}:${log.transactionHash}:${Number(log.logIndex)}:${log.blockHash.toLowerCase()}`;
    if(disposition==='PENDING' && this.store.identityState(key).disposition==='PENDING') return;
    this.store.appendDisposition({
      chainId: this.cfg.chainId,
      emitter: log.address.toLowerCase(),
      txHash: log.transactionHash,
      logIndex: Number(log.logIndex),
      blockHash: log.blockHash,
      disposition,
      atUtc: this.nowIso(),
    });
  }

  /**
   * Handle one raw log from WSS or backfill.
   * Ordering contract: removals first, dedup (with blockHash) second,
   * in-flight serialization third, durable disposition on every outcome.
   */
  async handleLog(
    log: RawLog & { blockHash: string },
    preservedArrivalUtc?: string,
  ): Promise<void> {
    this.operational?.assertUsable();
    try { this.store.assertUsable(); if (this.store.indexRebuildPending) await this.store.initializeIndex(); }
    catch (err) { this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:null,rawEvidenceRef:null,rpcRequestId:null,errorClass:'INDEX_ERROR',reason:`chain index preflight: ${String(err).slice(0,256)}`,eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:null,scientificImpactPossible:true}); throw err; }
    this.operational?.assertUsable();
    const logIndex = Number(log.logIndex);
    const emitter = log.address.toLowerCase();
    const removedKey = `${this.cfg.chainId}:${emitter}:${log.transactionHash}:${logIndex}`;

    // 1) Removal notices bypass dedup entirely: they are always evidence.
    //    Tombstone identity is block-aware: a distinct removal of the same
    //    (tx, logIndex) under a different blockHash is its own evidence.
    if (log.removed === true) {
      const removalKey = `${removedKey}:${log.blockHash.toLowerCase()}`;
      if (!this.removed(removalKey)) {
        this.store.appendTombstone({
          chainId: this.cfg.chainId, emitter,
          txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
          removedAtUtc: this.nowIso(), reason: 'REMOVED_FLAG',
        });
        // A removal DOMINATES any PENDING state for this exact identity,
        // durably — retry or restart replay can never turn it into a false
        // observation. Only a new raw row under a NEW blockHash is evidence.
        this.recordDisposition(log, 'REMOVED_INVALID');
        // Purge any queued in-memory retry for the removed identity.
        this.retryQueue = this.retryQueue.filter(
          (item) =>
            `${item.log.address.toLowerCase()}:${item.log.transactionHash}:` +
            `${Number(item.log.logIndex)}:${item.log.blockHash.toLowerCase()}` !==
            `${emitter}:${log.transactionHash}:${logIndex}:${log.blockHash.toLowerCase()}`,
        );
      }
      return;
    }

    // 2) Dedup includes blockHash — re-inclusion in a different block is new.
    const dedupKey = `${removedKey}:${log.blockHash.toLowerCase()}`;
    if(this.irrelevant(log)) {this.filteredLogs++; this.lastProgressUtc=this.nowIso(); return;}
    if (this.committed(dedupKey)) return;

    // 2a) Tombstone dominance: this exact identity was removed/rewound (or
    //    conflicted) — terminalize, never process. (Covers PENDING rows
    //    delivered again after a removal, and post-rewind redeliveries.)
    if (this.removed(dedupKey)) {
      this.recordDisposition(log, 'REMOVED_INVALID');
      return;
    }

    // 2b) Serialize concurrent deliveries of the same identity (WSS racing
    // backfill): the second caller awaits the in-flight work; the commit
    // path runs exactly once per identity.
    const existing = this.inflight.get(dedupKey);
    if (existing) return existing;
    if(this.inflight.size >= 256) {
      // Durable spill, not an unbounded JS wait queue. The verifier/reconnect
      // reads it back with its original arrival. No raw payload is lost.
      if(!this.rawCommitted(dedupKey)) this.store.appendRawLog({chainId:this.cfg.chainId,emitter,
        txHash:log.transactionHash,logIndex,blockHash:log.blockHash,blockNumber:Number(log.blockNumber),
        topic0:log.topics[0]?.toLowerCase() ?? '',topics:log.topics,data:log.data,firstSeenUtc:preservedArrivalUtc ?? this.nowIso()});
      this.recordDisposition(log,'PENDING');
      return;
    }
    const work = this.processLog(log, dedupKey, preservedArrivalUtc)
      .finally(() => { this.inflight.delete(dedupKey); });
    this.inflight.set(dedupKey, work);
    return work;
  }

  /** Commit path for one non-removed log. Only invoked via handleLog. */
  private async processLog(
    log: RawLog & { blockHash: string },
    dedupKey: string,
    preservedArrivalUtc?: string,
  ): Promise<void> {
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const emitter = log.address.toLowerCase();
    const gen = this.generation;
    // Discovery time of the RAW evidence — preserved across retries and
    // replays so latency measurement is never misrepresented by rework.
    const arrivedUtc = this.store.identityState(dedupKey).arrival ?? preservedArrivalUtc ?? this.nowIso();

    const finish = (d: Disposition): void => {
      this.recordDisposition(log, d);
      this.lastProgressUtc=this.nowIso();
    };

    try {
      // 3) Raw evidence first (guarded so retries don't duplicate the row).
      if (!this.rawCommitted(dedupKey)) {
        this.store.appendRawLog({
          chainId: this.cfg.chainId,
          emitter,
          blockNumber,
          blockHash: log.blockHash,
          txHash: log.transactionHash,
          logIndex,
          topic0: log.topics[0]?.toLowerCase() ?? '',
          topics: log.topics,
          data: log.data,
          firstSeenUtc: arrivedUtc,
        });
      }

      // Resume publication from the first persisted row, not a re-decoded row
      // with a new completion timestamp or a fresh provider dependency.
      const canonical = this.store.canonicalObservation(dedupKey);
      if (canonical) {
        this.onObservation(canonical);
        this.operational?.assertUsable();
        this.operational?.resolveQuarantinesForRaw(`raw:${dedupKey}`,'RECOVERED',`observation:${canonical.eventId}`,'OBSERVED',false);
        finish('OBSERVED');
        return;
      }

      let decoded;
      try {
        decoded = decodeV2Log(log);
      } catch (err) {
        this.store.appendQuarantine({
          kind: 'AMBIGUOUS_FILL',
          detail: { txHash: log.transactionHash, logIndex, error: String(err) },
          firstSeenUtc: this.nowIso(),
        });
        const q=this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:dedupKey,rawEvidenceRef:`raw:${dedupKey}`,rpcRequestId:rpcRequestId(err),
          errorClass:'MALFORMED_PAYLOAD',reason:String(err).slice(0,256),eventIdentityKnown:true,wallet:null,txHash:log.transactionHash,logIdentity:dedupKey,
          affectedRange:{fromBlock:blockNumber,toBlock:blockNumber},scientificImpactPossible:true});
        if(q) this.operational?.resolveQuarantine(q.quarantineId,'TERMINAL',null,'TERMINAL_QUARANTINE',true);
        finish('TERMINAL_QUARANTINE'); // malformed is terminal, not transient
        return;
      }
      if (!decoded) { finish('COMPLETED_NO_OBSERVATION'); return; } // foreign event

      if (decoded.kind === 'OrdersMatched') {
        // Cross-check only — never a trade record. Reconcile in EITHER
        // arrival order: if the aggregate arrived first, check now.
        this.matchedByHash.set(decoded.takerOrderHash.toLowerCase(), decoded);
        const agg = this.aggregateByHash.get(decoded.takerOrderHash.toLowerCase());
        if (agg) this.crossCheck(agg, decoded);
        finish('COMPLETED_NO_OBSERVATION');
        return;
      }

      const cls = classifyFill(decoded, this.cfg.watchedWallets);
      if (!cls || cls.role === 'TAKER_LEG_REDUNDANT') {
        // Unwatched, or a leg covered by the same-tx aggregate. Raw row kept.
        finish('COMPLETED_NO_OBSERVATION');
        return;
      }

      // May throw ReorgSignal (hash conflict) or a transient RPC error.
      const block = await this.blockRef(blockNumber, log.blockHash);
      this.operational?.assertUsable();

      // A rewind happened while we were awaiting the RPC: this handler is
      // stale. Leave the identity PENDING; post-rewind replay reprocesses.
      if (gen !== this.generation) {
        this.recordDisposition(log, 'PENDING');
        return;
      }

      // A removal/rewind tombstoned this exact identity while we awaited.
      if (this.removed(dedupKey)) {
        finish('REMOVED_INVALID');
        return;
      }

      const norm = normalizeGross(decoded);

      if (cls.role === 'TAKER_AGGREGATE') {
        const ctx = { ...decoded, logIndex, txHash: log.transactionHash };
        this.aggregateByHash.set(decoded.orderHash.toLowerCase(), ctx);
        const om = this.matchedByHash.get(decoded.orderHash.toLowerCase());
        if (om) this.crossCheck(ctx, om);
      }

      // Native chain event identity is the primary key. Poly2 equivalence is
      // computed later, offline, by src/compare/poly2-adapter.ts — never here.
      const eventId = `${this.cfg.chainId}:${decoded.emitter}:${log.transactionHash}:${logIndex}`;

      const obsRow: import('./storage.js').ObservationRow = {
        eventId,
        role: cls.role,
        wallet: cls.wallet,
        side: decoded.side,
        tokenId: decoded.tokenId,
        shares: norm.shares,
        price10: norm.price10,
        feeUnits: norm.feeUnits,
        blockTimestamp: block.timestamp,
        source: 'CHAIN',
        sourceFirstSeenUtc: arrivedUtc,
        firstSeenUtc: this.nowIso(),
        evidence: {
          chainId: this.cfg.chainId, emitter: decoded.emitter,
          txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
        },
      };
      // Persist the incomplete stage before any observation/publication append:
      // even a process death between stages must replay this canonical row.
      this.recordDisposition(log, 'PENDING');
      this.store.appendObservation(obsRow);
      this.onObservation(obsRow);
      this.operational?.assertUsable();
      // Recovery is justified only after downstream publication succeeds.
      this.operational?.resolveQuarantinesForRaw(`raw:${dedupKey}`,'RECOVERED',`observation:${eventId}`,'OBSERVED',false);

      // 4) Only now is the event fully committed.
      finish('OBSERVED');
    } catch (err) {
      if (this.operational && !this.operational.isUsable()) this.operational.assertUsable();
      if (err instanceof EvidenceIndexError) {
        // Shared-source failure also stops canonical recovery/cursor writes.
        this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:dedupKey,rawEvidenceRef:`raw:${dedupKey}`,rpcRequestId:null,errorClass:'INDEX_ERROR',reason:`chain index failure: ${String(err).slice(0,256)}`,eventIdentityKnown:true,wallet:null,txHash:log.transactionHash,logIdentity:dedupKey,affectedRange:{fromBlock:blockNumber,toBlock:blockNumber},scientificImpactPossible:true});
        this.store.invalidateIndex();
        throw err;
      }
      if (err instanceof ReorgSignal) {
        // Do NOT emit with a conflicting timestamp. Invalidate this raw
        // identity terminally so replay can never revive it, quarantine the
        // anomaly, and schedule serialized recovery.
        this.store.appendTombstone({
          chainId: this.cfg.chainId, emitter,
          txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
          removedAtUtc: this.nowIso(), reason: 'HASH_CONFLICT',
        });
        this.store.appendQuarantine({
          kind: 'REORG_ANOMALY',
          detail: { blockNumber, logBlockHash: log.blockHash, error: String(err) },
          firstSeenUtc: this.nowIso(),
        });
        const q=this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:dedupKey,rawEvidenceRef:`raw:${dedupKey}`,rpcRequestId:rpcRequestId(err),
          errorClass:'RPC_ERROR',reason:String(err).slice(0,256),eventIdentityKnown:true,wallet:null,txHash:log.transactionHash,logIdentity:dedupKey,
          affectedRange:{fromBlock:blockNumber,toBlock:blockNumber},scientificImpactPossible:true});
        if(q) this.operational?.resolveQuarantine(q.quarantineId,'TERMINAL',null,'TERMINAL_QUARANTINE',true);
        finish('TERMINAL_QUARANTINE');
        void this.runExclusive(() => this.recoverFromReorg())
          .catch((e) => this.recordFailure('reorg-recovery', e));
        return;
      }
      // Transient: record visibly, mark PENDING durably, queue in-memory
      // replay. If the process dies first, startup replay recovers it.
      this.recordFailure(`handleLog:${log.transactionHash}:${logIndex}`, err);
      this.operational?.assertUsable();
      this.recordDisposition(log, 'PENDING');
      if(this.retryQueue.length < 256) this.retryQueue.push({ log, arrivedUtc });
      // Overflow is still durably PENDING; processRetries replays the store.
    }
  }

  /** OrdersMatched vs aggregate cross-check (arrival-order independent). */
  private crossCheck(
    agg: DecodedOrderFilled & { logIndex: number; txHash: string },
    om: DecodedOrdersMatched,
  ): void {
    const errs = crossCheckAggregate(agg, om);
    if (errs.length > 0) {
      this.store.appendQuarantine({
        kind: 'ORDERSMATCHED_MISMATCH',
        detail: { txHash: agg.txHash, logIndex: agg.logIndex, errs },
        firstSeenUtc: this.nowIso(),
      });
      this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:`crosscheck:${agg.txHash}:${agg.logIndex}`,rawEvidenceRef:null,rpcRequestId:null,errorClass:'OTHER',reason:`OrdersMatched mismatch: ${errs.join('; ').slice(0,220)}`,eventIdentityKnown:true,wallet:null,txHash:agg.txHash,logIdentity:`${agg.txHash}:${agg.logIndex}`,affectedRange:null,scientificImpactPossible:true});
    }
  }

  /** Replay logs that failed transiently (called by the verifier tick). */
  async processRetries(): Promise<void> {
    this.operational?.assertUsable();
    this.retryQueue = [];
    await this.replayIncompleteFromStore();
  }

  /** Null is an unavailable block, never proof of a hash conflict. */
  private async providerBlock(blockNumber: number): Promise<{ hash: string; timestamp: string }> {
    for (let attempt = 0; attempt < PROVIDER_LAG_ATTEMPTS; attempt++) {
      const block = await this.rpcObserved<{ hash: string; timestamp: string } | null>(
        'eth_getBlockByNumber', ['0x' + blockNumber.toString(16), false], 'block_metadata_lookup', attempt + 1,
      );
      this.operational?.assertUsable();
      if (block) return block;
      if (attempt + 1 < PROVIDER_LAG_ATTEMPTS) await this.waitProviderLag(attempt);
    }
    throw new ProviderLagError(`block ${blockNumber} not yet available from provider after ${PROVIDER_LAG_ATTEMPTS} attempts`);
  }

  private async blockRef(blockNumber: number, blockHash: string): Promise<BlockRef> {
    const cached = this.blockCache.get(blockNumber);
    if (cached && cached.hash.toLowerCase() === blockHash.toLowerCase()) return cached;
    const b = await this.providerBlock(blockNumber);
    this.operational?.assertUsable();
    if (b.hash.toLowerCase() !== blockHash.toLowerCase()) {
      throw new ReorgSignal(blockNumber); // caller records + recovers
    }
    const ref: BlockRef = { number: blockNumber, hash: b.hash, timestamp: parseInt(b.timestamp, 16) };
    this.blockCache.set(blockNumber, ref);
    return ref;
  }

  /**
   * Validate the stored cursor against the provider. On mismatch, walk back
   * over stored checkpoint hashes to a PROVED common ancestor (checkpoint
   * spacing is guaranteed < REORG_LOOKBACK, so a routine shallow reorg
   * always has genuinely stored hashes inside the walk window).
   *
   * If NO stored checkpoint matches within the lookback, recovery FAILS
   * CLOSED: quarantine a hard recovery-required state and stop. The cursor
   * is NOT advanced to an unverified provider hash, nothing is tombstoned,
   * and automatic scanning does not resume — silently continuing from an
   * unproved point could leave stale old-fork evidence alive below the
   * rewind target. A bounded manual recovery is a later operator action.
   */
  async validateCursor(): Promise<void> {
    this.operational?.assertUsable();
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    if (!cursor) return;
    const head = await this.providerBlock(cursor.blockNumber);
    this.operational?.assertUsable();
    if (head.hash.toLowerCase() === cursor.blockHash.toLowerCase()) return;

    const stored = this.store.latestBlockHashes(cursor.blockNumber - REORG_LOOKBACK, cursor.blockNumber);
    let ancestor: number | null = null;
    for (let n = cursor.blockNumber - 1; n >= cursor.blockNumber - REORG_LOOKBACK && n > 0; n--) {
      const known = stored.get(n);
      if (!known) continue;
      const b = await this.providerBlock(n);
      this.operational?.assertUsable();
      if (b.hash.toLowerCase() === known.toLowerCase()) { ancestor = n; break; }
    }

    if (ancestor === null) {
      // Fail closed: no provable ancestor within the supported window.
      this.recoveryRequired = true;
      this.store.appendQuarantine({
        kind: 'REORG_ANOMALY',
        detail: {
          cursorBlock: cursor.blockNumber, cursorHash: cursor.blockHash,
          providerHash: head.hash, ancestorVerified: false,
          recoveryRequired: true, lookback: REORG_LOOKBACK,
          note: 'automatic recovery stopped; cursor NOT advanced to an '
            + 'unverified hash; bounded manual recovery required',
        },
        firstSeenUtc: this.nowIso(),
      });
      this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:`cursor:${cursor.blockNumber}`,rawEvidenceRef:null,rpcRequestId:null,errorClass:'RPC_ERROR',reason:'reorg recovery has no provable common ancestor',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:{fromBlock:Math.max(0,cursor.blockNumber-REORG_LOOKBACK),toBlock:cursor.blockNumber},scientificImpactPossible:true});
      return;
    }

    const target = ancestor;
    const targetBlock = await this.providerBlock(target);
    this.operational?.assertUsable();
    this.store.appendQuarantine({
      kind: 'REORG_ANOMALY',
      detail: {
        cursorBlock: cursor.blockNumber, cursorHash: cursor.blockHash,
        providerHash: head.hash, ancestor: target,
        ancestorVerified: true,
      },
      firstSeenUtc: this.nowIso(),
    });
    this.operational?.quarantine({component:'CHAIN',source:'CHAIN',sourceIdentity:`cursor:${cursor.blockNumber}:rewind:${target}`,rawEvidenceRef:null,rpcRequestId:null,errorClass:'RPC_ERROR',reason:'cursor reorg rewound to proved ancestor',eventIdentityKnown:false,wallet:null,txHash:null,logIdentity:null,affectedRange:{fromBlock:target+1,toBlock:cursor.blockNumber},scientificImpactPossible:true});
    this.store.tombstoneAboveBlock(this.cfg.chainId, target, this.nowIso());
    this.store.advanceCursor({
      provider: this.cfg.polygonHttpRpcUrl,
      blockNumber: target,
      blockHash: targetBlock.hash,
      updatedAtUtc: this.nowIso(),
    });
    // Rewind: invalidate in-flight handlers via generation bump; drop caches.
    // in-flight promises are NOT cleared — their generation check aborts
    // their commit, and awaiting callers still get a settled promise.
    this.generation++;
    this.blockCache.clear();
    // Tombstone dominance is read directly from the durable index.
  }

  private async recoverFromReorg(): Promise<void> {
    await this.validateCursor();
    if (this.recoveryRequired) return; // fail-closed: no automatic resume
    await this.replayIncompleteFromStore();
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    if (!cursor) return;
    const latestHex = await this.rpcObserved<string>('eth_blockNumber', [], 'verifier');
    await this.scanRange(cursor.blockNumber + 1, parseInt(latestHex, 16));
  }

  /** Durable recovery, at startup and on normal retry ticks.
   * Startup may stream authoritative NDJSON to rebuild the disposable index.
   * Every pass thereafter queries only its indexed current incomplete subset;
   * tombstones and all terminal dispositions are excluded before payload reads.
   * Legacy rows retain the existing latest-native/observation/quarantine guards.
   * Original raw append order and first arrival survive; existing canonical
   * partial observations are reused without inferring clocks or FIRST order.
   */
  async replayIncompleteFromStore(): Promise<number> {
    this.operational?.assertUsable();
    let replayed=0, examined=0;
    this.replayActive=true;
    try {
      await this.store.initializeIndex();
      for(const r of this.store.incompleteRawLogs()) {
        examined++; this.replayRows++;
        const key=`${r.chainId}:${r.emitter}:${r.txHash}:${r.logIndex}:${r.blockHash.toLowerCase()}`;
        if(!this.inflight.has(key)) {
          replayed++;
          await this.handleLog({address:r.emitter, topics:r.topics, data:r.data,
            transactionHash:r.txHash, logIndex:r.logIndex, blockNumber:r.blockNumber, blockHash:r.blockHash},r.firstSeenUtc);
        }
        if(examined % 256 === 0) {
          this.lastProgressUtc=this.nowIso();
          await new Promise<void>(resolve=>setImmediate(resolve));
        }
      }
      this.lastProgressUtc=this.nowIso();
      return replayed;
    } finally {this.replayActive=false;}
  }

  /** Resume from durable cursor; then periodic verification backfill.
   *  Public for tests; production entry is the subscription-ack handler. */
  async backfillFromCursor(): Promise<void> {
    try {
      await this.validateCursor();
    } catch (err) {
      if (err instanceof ProviderLagError) this.startVerifier(true);
      // ACK caller records the exhaustion once. Next tick must redo startup
      // validation and durable replay, never skip to an unvalidated scan.
      throw err;
    }
    if (this.recoveryRequired) return; // fail-closed: no automatic resume
    await this.replayIncompleteFromStore();
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    const latestHex = await this.rpcObserved<string>('eth_blockNumber', [], 'verifier');
    const latest = parseInt(latestHex, 16);
    // First start (no cursor): overlap a bounded window so events from the
    // subscribe-handshake gap are captured; native dedup absorbs any
    // double-delivery from the now-acknowledged live subscription.
    const from = cursor
      ? cursor.blockNumber + 1
      : Math.max(0, latest - FIRST_START_OVERLAP_BLOCKS);
    await this.scanRange(from, latest);
    this.operational?.assertUsable();
    this.startVerifier();
  }

  private startVerifier(retryStartup = false): void {
    this.operational?.assertUsable();
    if (this.verifier) clearInterval(this.verifier);
    this.verifier = setInterval(() => {
      void this.runExclusive(async () => {
        if (retryStartup) {
          await this.backfillFromCursor();
          return;
        }
        await this.validateCursor();
        if (this.recoveryRequired) return; // fail-closed: no automatic resume
        await this.processRetries();
        const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
        const latestHex = await this.rpcObserved<string>('eth_blockNumber', [], 'verifier');
        const latest = parseInt(latestHex, 16);
        // Initial lag may leave no committed cursor. Retry the same bounded
        // first-start overlap policy rather than making every tick a no-op.
        await this.scanRange(cursor ? cursor.blockNumber + 1 : Math.max(0, latest - FIRST_START_OVERLAP_BLOCKS), latest);
      }).catch((err) => this.recordFailure('verifier', err));
    }, this.cfg.verifyIntervalMs);
  }

  /** Scan [from, to] with eth_getLogs; cursor advances only after commit. */
  async scanRange(from: number, to: number): Promise<void> {
    this.operational?.assertUsable();
    try {
      await this.scanChunks(from, to);
    } catch (err) {
      if (!(err instanceof ProviderLagError)) throw err;
      // One visible failure per exhausted scan; verifier retries the cursor.
      this.recordFailure('scanRange', err);
    }
  }

  private async scanChunks(from: number, to: number): Promise<void> {
    if (from > to) return;
    const chunk = this.cfg.backfillChunkBlocks;
    for (let start = from; start <= to;) {
      let end = Math.min(start + chunk - 1, to);
      const params = (e: number) => [{
        address: [...V2_EXCHANGES],
        topics: [[...V2_SUBSCRIBE_TOPICS]],
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + e.toString(16),
      }];
      let logs: Array<RawLog & { blockHash: string }> = [];
      for (let attempt = 0; attempt < PROVIDER_LAG_ATTEMPTS; attempt++) {
        try {
          logs = await this.rpcObserved<Array<RawLog & { blockHash: string }>>('eth_getLogs', params(end), 'backfill', attempt + 1);
          break;
        } catch (err) {
          if (!/invalid block range/i.test(String(err))) throw err;
          // A different backend may answer the head request. Clamp on every
          // rejected range, never expand the current chunk during retries.
          const latestHex = await this.rpcObserved<string>('eth_blockNumber', [], 'verifier');
          const latest = parseInt(latestHex, 16);
          if (latest < start) return; // no safe work yet; last cursor stays
          end = Math.min(end, latest);
          if (attempt + 1 === PROVIDER_LAG_ATTEMPTS) {
            throw new ProviderLagError(`eth_getLogs exhausted ${PROVIDER_LAG_ATTEMPTS} attempts: ${String(err)}`);
          }
          await this.waitProviderLag(attempt);
        }
      }
      for (const log of logs) {
        await this.handleLog(log);
        const key = `${this.cfg.chainId}:${log.address.toLowerCase()}:` +
          `${log.transactionHash}:${Number(log.logIndex)}:${log.blockHash.toLowerCase()}`;
        // handleLog already recorded the failure and durable PENDING state.
        // Stop here rather than fetching the same missing block again and
        // emitting a duplicate failure or advancing past unavailable evidence.
        // Tombstoned/conflicting evidence must not advance the cursor before
        // queued reorg recovery validates the old cursor and proves ancestry.
        if ((!this.committed(key) && !this.irrelevant(log)) || this.removed(key)) return;
      }
      // Dense rolling checkpoints: spacing < REORG_LOOKBACK guarantees a
      // genuinely stored hash inside any ancestor-walk window, so a routine
      // shallow reorg can always be PROVED (never silently unverified).
      for (let n = start; n < end; n += CHECKPOINT_SPACING) {
        const cp = await this.providerBlock(n);
        this.operational?.assertUsable();
        this.store.appendBlockHash({
          chainId: this.cfg.chainId, blockNumber: n, blockHash: cp.hash,
          firstSeenUtc: this.nowIso(),
        });
      }
      const head = await this.providerBlock(end);
      this.operational?.assertUsable();
      // Append-only block-hash evidence for common-ancestor detection.
      this.store.appendBlockHash({
        chainId: this.cfg.chainId, blockNumber: end, blockHash: head.hash,
        firstSeenUtc: this.nowIso(),
      });
      // Cursor advances even for empty chunks — empty blocks are scanned blocks.
      this.store.advanceCursor({
        provider: this.cfg.polygonHttpRpcUrl,
        blockNumber: end,
        blockHash: head.hash,
        updatedAtUtc: this.nowIso(),
      });
      // Clamping may shorten a chunk: continue at its actual committed end.
      start = end + 1;
    }
  }
}
