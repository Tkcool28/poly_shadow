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
 */

import WebSocket from 'ws';
import { decodeV2Log, classifyFill, normalizeGross, crossCheckAggregate } from './decoder.js';
import type { DecodedOrderFilled, DecodedOrdersMatched, RawLog } from './decoder.js';
import { canonicalTradeId } from './canonical.js';
import { V2_SUBSCRIBE_TOPICS, V2_EXCHANGES, TOPIC_ORDER_FILLED_V2 } from './v2constants.js';
import { rpcCall } from './egress.js';
import type { ShadowConfig } from './config.js';
import type { ShadowStore } from './storage.js';

interface BlockRef { number: number; hash: string; timestamp: number }

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
  private seenRaw = new Set<string>(); // chainId:emitter:txHash:logIndex dedup (raw-level)

  constructor(
    private cfg: ShadowConfig,
    private store: ShadowStore,
    private nowIso: () => string = () => new Date().toISOString(),
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
    const ws = new WebSocket(this.cfg.polygonWsRpcUrl);
    this.ws = ws;
    this.lastMessageAt = Date.now();

    ws.on('open', () => {
      this.reconnectDelayMs = 1000;
      // Full emitter + topic0 subscriptions (completeness-first)
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', { address: [...V2_EXCHANGES], topics: [[...V2_SUBSCRIBE_TOPICS]] }],
      }));
      this.startHeartbeat();
      void this.backfillFromCursor().catch(() => {});
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.lastMessageAt = Date.now();
      try {
        const msg = JSON.parse(data.toString());
        if (msg.method === 'eth_subscription' && msg.params?.result) {
          void this.handleLog(msg.params.result as RawLog & { blockHash: string });
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
        this.ws?.terminate(); // -> close -> reconnect
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

  /** Handle one raw log from WSS or backfill. Raw evidence is committed FIRST. */
  async handleLog(log: RawLog & { blockHash: string }): Promise<void> {
    const blockNumber = Number(log.blockNumber);
    const logIndex = Number(log.logIndex);
    const dedupKey = `${this.cfg.chainId}:${log.address.toLowerCase()}:${log.transactionHash}:${logIndex}`;
    if (this.seenRaw.has(dedupKey)) return;
    this.seenRaw.add(dedupKey);

    // Tombstone path: removed logs are evidence too, never a silent drop.
    if (log.removed === true) {
      this.store.appendTombstone({
        chainId: this.cfg.chainId, emitter: log.address.toLowerCase(),
        txHash: log.transactionHash, logIndex, blockHash: log.blockHash,
        removedAtUtc: this.nowIso(), reason: 'REMOVED_FLAG',
      });
      return;
    }

    this.store.appendRawLog({
      chainId: this.cfg.chainId,
      emitter: log.address.toLowerCase(),
      blockNumber,
      blockHash: log.blockHash,
      txHash: log.transactionHash,
      logIndex,
      topic0: log.topics[0]?.toLowerCase() ?? '',
      topics: log.topics,
      data: log.data,
      firstSeenUtc: this.nowIso(),
    });

    let decoded;
    try {
      decoded = decodeV2Log(log);
    } catch (err) {
      this.store.appendQuarantine({
        kind: 'AMBIGUOUS_FILL',
        detail: { txHash: log.transactionHash, logIndex, error: String(err) },
        firstSeenUtc: this.nowIso(),
      });
      return;
    }
    if (!decoded) return;

    if (decoded.kind === 'OrdersMatched') {
      this.matchedByHash.set(decoded.takerOrderHash.toLowerCase(), decoded);
      return; // cross-check only — never a trade record
    }

    const cls = classifyFill(decoded, this.cfg.watchedWallets);
    if (!cls) return;
    if (cls.role === 'TAKER_LEG_REDUNDANT') return; // covered by the aggregate; raw row kept

    const block = await this.blockRef(blockNumber, log.blockHash);
    const norm = normalizeGross(decoded);

    // OrdersMatched cross-check for taker aggregates (same-hash twin must agree)
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

    const canonicalKey = canonicalTradeId({
      transactionHash: log.transactionHash,
      proxyWallet: cls.wallet,
      asset: decoded.tokenId,
      shares: norm.shares,
      price10: norm.price10,
      blockTimestamp: block.timestamp,
    });

    this.store.appendObservation({
      canonicalKey,
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
  }

  private async blockRef(blockNumber: number, blockHash: string): Promise<BlockRef> {
    const cached = this.blockCache.get(blockNumber);
    if (cached && cached.hash === blockHash) return cached;
    const b = await rpcCall<{ hash: string; timestamp: string }>(
      this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber',
      ['0x' + blockNumber.toString(16), false],
    );
    if (b.hash.toLowerCase() !== blockHash.toLowerCase()) {
      // Provider disagreement / reorg signal — record, don't repair.
      this.store.appendQuarantine({
        kind: 'REORG_ANOMALY',
        detail: { blockNumber, expectedHash: blockHash, providerHash: b.hash },
        firstSeenUtc: this.nowIso(),
      });
    }
    const ref: BlockRef = { number: blockNumber, hash: b.hash, timestamp: parseInt(b.timestamp, 16) };
    this.blockCache.set(blockNumber, ref);
    return ref;
  }

  /** Resume from durable cursor; then periodic verification backfill. */
  private async backfillFromCursor(): Promise<void> {
    const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
    const latestHex = await rpcCall<string>(this.cfg.polygonHttpRpcUrl, 'eth_blockNumber', []);
    const latest = parseInt(latestHex, 16);
    const from = cursor ? cursor.blockNumber + 1 : latest;
    await this.scanRange(from, latest);
    this.startVerifier();
  }

  private startVerifier(): void {
    if (this.verifier) clearInterval(this.verifier);
    this.verifier = setInterval(() => {
      void (async () => {
        const cursor = this.store.readCursor(this.cfg.polygonHttpRpcUrl);
        if (!cursor) return;
        const latestHex = await rpcCall<string>(this.cfg.polygonHttpRpcUrl, 'eth_blockNumber', []);
        await this.scanRange(cursor.blockNumber + 1, parseInt(latestHex, 16));
      })().catch(() => {});
    }, this.cfg.verifyIntervalMs);
  }

  /** Scan [from, to] with eth_getLogs; cursor advances only after commit. */
  async scanRange(from: number, to: number): Promise<void> {
    const chunk = this.cfg.backfillChunkBlocks;
    for (let start = from; start <= to; start += chunk) {
      const end = Math.min(start + chunk - 1, to);
      const logs = await rpcCall<Array<RawLog & { blockHash: string }>>(
        this.cfg.polygonHttpRpcUrl, 'eth_getLogs',
        [{
          address: [...V2_EXCHANGES],
          topics: [[...V2_SUBSCRIBE_TOPICS]],
          fromBlock: '0x' + start.toString(16),
          toBlock: '0x' + end.toString(16),
        }],
      );
      for (const log of logs) {
        if (log.topics[0]?.toLowerCase() === TOPIC_ORDER_FILLED_V2 ||
            V2_SUBSCRIBE_TOPICS.includes(log.topics[0]?.toLowerCase() ?? '')) {
          await this.handleLog(log);
        }
      }
      // Cursor advances even for empty chunks — empty blocks are scanned blocks.
      const head = await rpcCall<{ hash: string }>(
        this.cfg.polygonHttpRpcUrl, 'eth_getBlockByNumber', ['0x' + end.toString(16), false],
      );
      this.store.advanceCursor({
        provider: this.cfg.polygonHttpRpcUrl,
        blockNumber: end,
        blockHash: head.hash,
        updatedAtUtc: this.nowIso(),
      });
    }
  }
}
