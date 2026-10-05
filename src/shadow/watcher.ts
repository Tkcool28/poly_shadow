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
 * Evidence-safety rules (independent re-review findings):
 * - Removed logs are handled BEFORE any dedup gate — a removal notice is
 *   always recorded as a tombstone, never swallowed by seenRaw.
 * - Dedup keys include blockHash: the same (tx, logIndex) re-included in a
 *   different block after a reorg is new evidence, not a duplicate.
 * - seenRaw is only marked AFTER raw evidence + observation commit. A
 *   transient failure (RPC error, block-hash conflict) leaves the event
 *   retryable; failures are recorded in quarantine (visible, never silent)
 *   and replayed from a retry queue.
 * - Startup and periodic cursor validation: stored cursor/block hashes are
 *   checked against the provider; on mismatch we walk back to the common
 *   ancestor, tombstone everything above it, rewind the cursor, and rescan.
 */

import WebSocket from 'ws';
import { decodeV2Log, classifyFill, normalizeGross, crossCheckAggregate } from './decoder.js';
import type { DecodedOrdersMatched, RawLog } from './decoder.js';
import { V2_SUBSCRIBE_TOPICS, V2_EXCHANGES, TOPIC_ORDER_FILLED_V2 } from './v2constants.js';
import { assertAllowedUrl, rpcCall } from './egress.js';
import type { ShadowConfig } from './config.js';
import type { ShadowStore } from './storage.js';

interface BlockRef { number: number; hash: string; timestamp: number }

type RpcFn = typeof rpcCall;

/** Thrown when the provider's block hash conflicts with the log's block. */
export class ReorgSignal extends Error {
  constructor(public readonly blockNumber: number) {
    super(`block hash conflict at ${blockNumber}`);
    this.name = 'ReorgSignal';
  }
}

/** How far back common-ancestor search may walk (blocks). */
const REORG_LOOKBACK = 128;

export class ChainWatcher {
  private ws: WebSocket | null = null;
  private reconnectDelayMs = 1000;
  private shouldReconnect = true;
  private lastMessageAt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private verifier: ReturnType<typeof setInterval> | null = null;
  private blockCache = new Map<number, BlockRef>();
  /** OrdersMatched cross-check buffer: orderHash -> decoded */
  private matchedByHash = new Map<string, DecodedOrdersMatched>();
  /** chainId:emitter:txHash:logIndex:blockHash — set only after full commit */
  private seenRaw = new Set<string>();
  /** chainId:emitter:txHash:logIndex — removal notices already tombstoned */
  private seenRemoved = new Set<string>();
  /** raw evidence rows already committed (retry must not duplicate them) */
  private rawCommitted = new Set<string>();
  /** logs awaiting replay after a transient failure */
  private retryQueue: Array<RawLog & { blockHash: string }> = [];
  private reorgRecoveryInFlight = false;

  constructor(
    private cfg: ShadowConfig,
    private store: ShadowStore,
    private nowIso: () => string = () => new Date().toISOString(),
    private rpc: RpcFn = rpcCall,
  ) {}

  start(): void {
    this.shouldReconnect = true;
    this.connect();
  }

  stop(): void {
    this.shouldReconnect = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.verifier) clearInterval(this.verifier);
    this.ws?.close(1000, 'shutdown');
  }

  private connect(): void {
    // The WSS connection goes through the SAME egress assertion as HTTP RPC.
    // The WS host must match the configured HTTP RPC host (or the public
    // allowlist) — passing the WS URL as its own allowance would be
    // tautological and assert nothing.
    assertAllowedUrl(this.cfg.polygonWsRpcUrl, [this.cfg.polygonHttpRpcUrl]);
    const ws = new WebSocket(this.cfg.polygonWsRpcUrl);
    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.on('open', () => {
      this.reconnectDelayMs = 1000;
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', { address: [...V2_EXCHANGES], topics: [[...V2_SUBSCRIBE_TOPICS]] }],
      }));
      this.startHeartbeat();
      void this.backfillFromCursor().catch((err) => this.recordFailure('backfill', err));
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'eth_subscription' && msg.params?.result) {
          void this.handleLog(msg.params.result as RawLog & { blockHash: string })
            .catch((err) => this.recordFailure('subscription-log', err));
        }
      } catch { /* malformed message ignored */ }
    });

    ws.on('close', () => { this.scheduleReconnect(); });
    ws.on('error', () => { /* close follows */ });
  }

  private startHeartbeat(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = setInterval(() => {
      if (Date.now() - this.lastMessageAt > this.cfg.staleMs) {
        this.ws?.terminate();
        return;
      }
      try { this.ws?.ping(); } catch { /* ignore */ }
    }, this.cfg.heartbeatMs);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    setTimeout(() => { if (this.shouldReconnect) this.connect(); }, delay);
  }

  /** Visible failure record — failures are evidence, never swallowed. */
  private recordFailure(where: string, err: unknown): void {
    this.store.appendQuarantine({
      kind: 'TRANSIENT_FAILURE',
      detail: { where, error: String(err) },
      firstSeenUtc: this.nowIso(),
    });
  }

  /**
   * Handle one raw log from WSS or backfill.
   * Ordering contract: removals first, dedup (with blockHash) second,
   * seenRaw marked only after full commit.
   */
  async handleLog(log: RawLog & { blockHash: string }): Promise<void> {
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const emitter = log.address.toLowerCase();
    const removedKey = `${this.cfg.chainId}:${emitter}:${log.transactionHash}:${logIndex}`;

    // 1) Removal notices bypass dedup entirely: they are always evidence.
    if (log.removed === true) {
      if (!this.seenRemoved.has(removedKey)) {
        this.seenRemoved.add(removedKey);
        this.store.appendTombstone({
          chainId: this.cfg.chainId, emitter,
          txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
          removedAtUtc: this.nowIso(), reason: 'REMOVED_FLAG',
        });
      }
      return;
    }

    // 2) Dedup includes blockHash — re-inclusion in a different block is new.
    const dedupKey = `${removedKey}:${log.blockHash.toLowerCase()}`;
    if (this.seenRaw.has(dedupKey)) return;

    try {
      // 3) Raw evidence first (guarded so retries don't duplicate the row).
      if (!this.rawCommitted.has(dedupKey)) {
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
          firstSeenUtc: this.nowIso(),
        });
        this.rawCommitted.add(dedupKey);
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
        this.seenRaw.add(dedupKey); // malformed is terminal, not transient
        return;
      }
      if (!decoded) { this.seenRaw.add(dedupKey); return; } // foreign event

      if (decoded.kind === 'OrdersMatched') {
        this.matchedByHash.set(decoded.takerOrderHash.toLowerCase(), decoded);
        this.seenRaw.add(dedupKey);
        return; // cross-check only — never a trade record
      }

      const cls = classifyFill(decoded, this.cfg.watchedWallets);
      if (!cls || cls.role === 'TAKER_LEG_REDUNDANT') {
        // Unwatched, or a leg covered by the same-tx aggregate. Raw row kept.
        this.seenRaw.add(dedupKey);
        return;
      }

      // May throw ReorgSignal (hash conflict) or a transient RPC error.
      const block = await this.blockRef(blockNumber, log.blockHash);
      const norm = normalizeGross(decoded);

      if (cls.role === 'TAKER_AGGREGATE') {
        const om = this.matchedByHash.get(decoded.orderHash.toLowerCase());
        if (om) {
          const errs = crossCheckAggregate(decoded, om);
          if (errs.length > 0) {
            this.store.appendQuarantine({
              kind: 'ORDERSMATCHED_MISMATCH',
              detail: { txHash: log.transactionHash, logIndex, errs },
              firstSeenUtc: this.nowIso(),
            });
          }
        }
      }

      // Native chain event identity is the primary key. Poly2 equivalence is
      // computed later, offline, by src/compare/poly2-adapter.ts — never here.
      const eventId = `${this.cfg.chainId}:${decoded.emitter}:${log.transactionHash}:${logIndex}`;

      this.store.appendObservation({
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
        firstSeenUtc: this.nowIso(),
        evidence: {
          chainId: this.cfg.chainId, emitter: decoded.emitter,
          txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
        },
      });

      // 4) Only now is the event fully committed.
      this.seenRaw.add(dedupKey);
    } catch (err) {
      if (err instanceof ReorgSignal) {
        // Do NOT emit with a conflicting timestamp. Record + recover.
        this.store.appendQuarantine({
          kind: 'REORG_ANOMALY',
          detail: { blockNumber, logBlockHash: log.blockHash, error: String(err) },
          firstSeenUtc: this.nowIso(),
        });
        await this.recoverFromReorg();
        return; // not marked seen — replay after recovery
      }
      // Transient: record visibly, queue for replay, leave retryable.
      this.recordFailure(`handleLog:${log.transactionHash}:${logIndex}`, err);
      this.retryQueue.push(log);
    }
  }

  /** Replay logs that failed transiently (called by the verifier tick). */
  async processRetries(): Promise<void> {
    if (this.retryQueue.length === 0) return;
    const pending = this.retryQueue;
    this.retryQueue = [];
    for (const log of pending) {
      await this.handleLog(log); // on repeated failure it re-queues itself
    }
  }

  private async blockRef(blockNumber: number, blockHash: string): Promise<BlockRef> {
    const cached = this.blockCache.get(blockNumber);
    if (cached && cached.hash.toLowerCase() === blockHash.toLowerCase()) return cached;
    const b = await this.rpc<{ hash: string; timestamp: string }>(
      this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber',
      ['0x' + blockNumber.toString(16), false],
    );
    if (b.hash.toLowerCase() !== blockHash.toLowerCase()) {
      throw new ReorgSignal(blockNumber); // caller records + recovers
    }
    const ref: BlockRef = { number: blockNumber, hash: b.hash, timestamp: parseInt(b.timestamp, 16) };
    this.blockCache.set(blockNumber, ref);
    return ref;
  }

  /**
   * Validate the stored cursor against the provider. On mismatch, walk back
   * to the common ancestor (using our append-only block-hash evidence),
   * tombstone everything above it, and rewind the cursor. Nothing is edited
   * or deleted; orphaned first-seen evidence is preserved.
   */
  async validateCursor(): Promise<void> {
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    if (!cursor) return;
    const head = await this.rpc<{ hash: string }>(
      this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber',
      ['0x' + cursor.blockNumber.toString(16), false],
    );
    if (head.hash.toLowerCase() === cursor.blockHash.toLowerCase()) return;

    // Mismatch: walk back to common ancestor using stored block hashes.
    const stored = this.store.latestBlockHashes();
    let ancestor = Math.max(0, cursor.blockNumber - REORG_LOOKBACK);
    for (let n = cursor.blockNumber - 1; n >= cursor.blockNumber - REORG_LOOKBACK && n > 0; n--) {
      const known = stored.get(n);
      if (!known) continue;
      const b = await this.rpc<{ hash: string }>(
        this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber',
        ['0x' + n.toString(16), false],
      );
      if (b.hash.toLowerCase() === known.toLowerCase()) { ancestor = n; break; }
    }

    const ancestorBlock = await this.rpc<{ hash: string }>(
      this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber',
      ['0x' + ancestor.toString(16), false],
    );
    this.store.appendQuarantine({
      kind: 'REORG_ANOMALY',
      detail: {
        cursorBlock: cursor.blockNumber, cursorHash: cursor.blockHash,
        providerHash: head.hash, ancestor,
      },
      firstSeenUtc: this.nowIso(),
    });
    this.store.tombstoneAboveBlock(this.cfg.chainId, ancestor, this.nowIso());
    this.store.advanceCursor({
      provider: this.cfg.polygonHttpRpcUrl,
      blockNumber: ancestor,
      blockHash: ancestorBlock.hash,
      updatedAtUtc: this.nowIso(),
    });
    // Post-rewind state must be re-observed from the rescan.
    this.seenRaw.clear();
    this.rawCommitted.clear();
    this.blockCache.clear();
  }

  private async recoverFromReorg(): Promise<void> {
    if (this.reorgRecoveryInFlight) return;
    this.reorgRecoveryInFlight = true;
    try {
      await this.validateCursor();
      await this.backfillFromCursor();
    } catch (err) {
      this.recordFailure('reorg-recovery', err);
    } finally {
      this.reorgRecoveryInFlight = false;
    }
  }

  /** Resume from durable cursor; then periodic verification backfill. */
  private async backfillFromCursor(): Promise<void> {
    await this.validateCursor();
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    const latestHex = await this.rpc<string>(this.cfg.polygonHttpRpcUrl, 'eth_blockNumber', []);
    const latest = parseInt(latestHex, 16);
    const from = cursor ? cursor.blockNumber + 1 : latest;
    await this.scanRange(from, latest);
    this.startVerifier();
  }

  private startVerifier(): void {
    if (this.verifier) clearInterval(this.verifier);
    this.verifier = setInterval(() => {
      void (async () => {
        await this.validateCursor();
        await this.processRetries();
        const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
        if (!cursor) return;
        const latestHex = await this.rpc<string>(this.cfg.polygonHttpRpcUrl, 'eth_blockNumber', []);
        await this.scanRange(cursor.blockNumber + 1, parseInt(latestHex, 16));
      })().catch((err) => this.recordFailure('verifier', err));
    }, this.cfg.verifyIntervalMs);
  }

  /** Scan [from, to] with eth_getLogs; cursor advances only after commit. */
  async scanRange(from: number, to: number): Promise<void> {
    const chunk = this.cfg.backfillChunkBlocks;
    for (let start = from; start <= to; start += chunk) {
      const end = Math.min(start + chunk - 1, to);
      const logs = await this.rpc<Array<RawLog & { blockHash: string }>>(
        this.cfg.polygonHttpRpcUrl, 'eth_getLogs',
        [{
          address: [...V2_EXCHANGES],
          topics: [[...V2_SUBSCRIBE_TOPICS]],
          fromBlock: '0x' + start.toString(16),
          toBlock: '0x' + end.toString(16),
        }],
      );
      for (const log of logs) {
        await this.handleLog(log);
      }
      const head = await this.rpc<{ hash: string }>(
        this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber', ['0x' + end.toString(16), false],
      );
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
    }
  }
}
