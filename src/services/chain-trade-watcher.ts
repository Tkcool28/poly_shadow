import WebSocket from 'ws';
import { ethers } from 'ethers';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('chain-trade-watcher');

// Both contracts emit OrderFilled — BTC/NegRisk markets use the second address
const CTF_EXCHANGE_ADDRESSES = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // standard CTFExchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a', // NegRiskCTFExchange (BTC price bands)
];
// keccak256('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)')
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const HEARTBEAT_INTERVAL_MS = 45_000;  // keepalive cadence (was 20s; reduced to save dRPC CU)
const STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3; // 135s without heartbeat response → reconnect
const INITIAL_RECONNECT_MS = 1000;

// ABI types for decoding OrderFilled event data (non-indexed params only)
// [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee]
const ORDER_FILLED_DATA_TYPES = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'];

/** Left-pad 20-byte address to 32-byte indexed-topic value */
function padAddress(addr: string): string {
  return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface ChainTradeData {
  proxyWallet: string;
  tokenId: string;       // conditional token ERC1155 ID
  side: 'BUY' | 'SELL';
  size: number;          // shares (6-decimal precision)
  price: number;         // USDC per share
  transactionHash: string;
  isNegRisk: boolean;
  contract: string;      // exchange contract address
}

export type ChainTradeCallback = (data: ChainTradeData) => Promise<void>;
export type ChainWatcherState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class ChainTradeWatcher {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private verifyTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private lastHeartbeatAt: Date | null = null;
  private onTradeDetected: ChainTradeCallback;
  private getLiveWallets: () => Set<string>; // returns only live-allocation wallets (~7)
  private subscribedWallets: Set<string> = new Set();
  private recentTxHashes: Map<string, number> = new Map(); // dedupKey → timestamp ms
  private heartbeatCount = 0;

  // Per-wallet subscription tracking: id → confirmed
  private pendingSubIds: Set<number> = new Set();
  private confirmedSubIds: Set<number> = new Set();
  private expectedSubCount = 0;
  private subscriptionSentAt: number = 0;
  private failedSubIds: Set<number> = new Set();
  private subIdToWallet: Map<number, { wallet: string; role: 'maker' | 'taker' }> = new Map();
  private degradedModeLogged = false;

  // Block tracking for eth_getLogs backfill
  private lastProcessedBlock: number | null = null;
  private lastVerifyBlock: number | null = null;
  private backfillRecovered = 0;

  state: ChainWatcherState = 'disconnected';
  lastEventAt: Date | null = null;
  eventsReceived = 0;
  triggeredDetections = 0;

  constructor(onTradeDetected: ChainTradeCallback, getLiveWallets: () => Set<string>) {
    this.onTradeDetected = onTradeDetected;
    this.getLiveWallets = getLiveWallets;
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.state = 'connecting';
    log.info('Connecting to Polygon WS RPC...', { url: config.POLYGON_WS_RPC_URL });
    this.createConnection();
  }

  close(): void {
    this.shouldReconnect = false;
    this.clearAllTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Shutting down');
      }
      this.ws = null;
    }
    this.state = 'disconnected';
    log.info('Connection closed');
  }

  private createConnection(): void {
    const disconnectedAtBlock = this.lastProcessedBlock;
    const ws = new WebSocket(config.POLYGON_WS_RPC_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'connected';
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      this.lastHeartbeatAt = new Date();
      log.info('Connected, subscribing to CTF Exchange OrderFilled events');

      this.subscribe(ws);
      this.startHeartbeat(ws);
      this.startPeriodicVerification();

      // Seed lastProcessedBlock so periodic verification works before first WSS event
      if (!this.lastProcessedBlock) {
        void this.fetchLatestBlockNumber().catch(() => {});
      }

      // Backfill events missed during disconnection
      if (disconnectedAtBlock) {
        void this.backfillFromBlock(disconnectedAtBlock).catch((err: any) =>
          log.warn('Backfill on reconnect failed', { error: err.message }),
        );
      }
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Heartbeat response (eth_chainId) — update liveness timestamp
        if (msg.id === 999 && (msg.result || msg.error)) {
          this.lastHeartbeatAt = new Date();
          return;
        }

        // Per-wallet subscription confirmed (ids start at 100)
        if (typeof msg.id === 'number' && msg.id >= 100 && this.pendingSubIds.has(msg.id)) {
          this.pendingSubIds.delete(msg.id);
          if (msg.result) {
            this.confirmedSubIds.add(msg.id);
            log.debug('Subscription confirmed', { id: msg.id, subId: msg.result });
            if (this.confirmedSubIds.size === this.expectedSubCount) {
              log.info('All per-wallet subscriptions confirmed', {
                count: this.confirmedSubIds.size,
              });
            }
          } else if (msg.error) {
            this.failedSubIds.add(msg.id);
            const info = this.subIdToWallet.get(msg.id);
            log.error('Per-wallet subscription failed', {
              id: msg.id,
              wallet: info?.wallet.slice(0, 10),
              role: info?.role,
              error: msg.error,
              confirmed: this.confirmedSubIds.size,
              failed: this.failedSubIds.size,
            });
          }
          return;
        }

        // Subscription event
        if (msg.method === 'eth_subscription' && msg.params?.result?.topics?.length >= 4) {
          this.processLogEvent(msg.params.result);
        }
      } catch {
        // Non-JSON / malformed messages ignored
      }
    });

    ws.on('pong', () => { this.lastHeartbeatAt = new Date(); });
    ws.on('ping', () => { this.lastHeartbeatAt = new Date(); });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      this.ws = null;
      log.warn('Connection closed', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('Connection error', { error: err.message });
      // 'close' event fires after 'error' — handles reconnection
    });
  }

  /** Process a single log event (from WSS subscription or eth_getLogs backfill) */
  private processLogEvent(logEntry: {
    transactionHash: string;
    logIndex: string;
    blockNumber: string;
    address: string;
    topics: string[];
    data: string;
    removed?: boolean;
  }): void {
    // Skip reorg'd events (chain reorganization invalidated this log)
    if (logEntry.removed === true) return;

    // Track block number for backfill
    const blockNum = parseInt(logEntry.blockNumber, 16);
    if (!isNaN(blockNum) && (this.lastProcessedBlock === null || blockNum > this.lastProcessedBlock)) {
      this.lastProcessedBlock = blockNum;
    }

    // Dedup: both maker/taker subs + backfill can deliver the same event
    const dedupKey = `${logEntry.transactionHash}:${logEntry.logIndex}`;
    if (this.recentTxHashes.has(dedupKey)) return;
    const now = Date.now();
    this.recentTxHashes.set(dedupKey, now);
    // Evict entries older than 10 min (covers backfill verify interval + margin)
    if (this.recentTxHashes.size > 500) {
      const cutoff = now - 600_000;
      for (const [key, ts] of this.recentTxHashes) {
        if (ts < cutoff) this.recentTxHashes.delete(key);
      }
    }

    this.eventsReceived++;
    this.lastEventAt = new Date();

    const topics: string[] = logEntry.topics;
    if (topics.length < 4) return;

    // topics[2] = maker address, topics[3] = taker address, padded to 32 bytes
    const makerAddress = '0x' + topics[2].slice(26).toLowerCase();
    const takerAddress = '0x' + topics[3].slice(26).toLowerCase();

    const liveWallets = this.getLiveWallets();
    const matchedWallet = liveWallets.has(makerAddress)
      ? makerAddress
      : liveWallets.has(takerAddress)
        ? takerAddress
        : null;

    if (matchedWallet) {
      this.triggeredDetections++;

      // Decode non-indexed params from data field to extract trade details
      try {
        const decoded = ethers.utils.defaultAbiCoder.decode(
          ORDER_FILLED_DATA_TYPES,
          logEntry.data,
        );
        const [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = decoded;
        const makerAmt = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
        const takerAmt = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
        const isMaker = matchedWallet === makerAddress;
        const makerIsUsdc = makerAssetId.isZero();
        const takerIsUsdc = takerAssetId.isZero();
        const isNegRisk = logEntry.address.toLowerCase() ===
          '0xc5d563a36ae78145c45a50134d48a1215220f80a';

        // Guard: both non-zero means token-to-token swap — not a standard CTF fill
        if (!makerIsUsdc && !takerIsUsdc) {
          log.warn('Unexpected token-to-token fill (no USDC side), skipping', {
            wallet: matchedWallet.slice(0, 10),
            makerAssetId: makerAssetId.toString().slice(0, 16),
            takerAssetId: takerAssetId.toString().slice(0, 16),
          });
          return;
        }

        let side: 'BUY' | 'SELL';
        let tokenId: string;
        let size: number;  // shares
        let price: number; // USDC per share

        if (isMaker) {
          // Maker offered makerAsset, received takerAsset
          side = makerIsUsdc ? 'BUY' : 'SELL';
          tokenId = makerIsUsdc ? takerAssetId.toString() : makerAssetId.toString();
          // BUY: paid USDC (makerAmt), received shares (takerAmt) → price = USDC/shares
          // SELL: gave shares (makerAmt), received USDC (takerAmt) → price = USDC/shares
          size = makerIsUsdc ? takerAmt : makerAmt;
          price = size > 0
            ? (makerIsUsdc ? makerAmt / takerAmt : takerAmt / makerAmt)
            : 0;
        } else {
          // Taker offered takerAsset, received makerAsset
          side = takerIsUsdc ? 'BUY' : 'SELL';
          tokenId = takerIsUsdc ? makerAssetId.toString() : takerAssetId.toString();
          // BUY: paid USDC (takerAmt), received shares (makerAmt) → price = USDC/shares
          // SELL: gave shares (takerAmt), received USDC (makerAmt) → price = USDC/shares
          size = takerIsUsdc ? makerAmt : takerAmt;
          price = size > 0
            ? (takerIsUsdc ? takerAmt / makerAmt : makerAmt / takerAmt)
            : 0;
        }

        log.debug('OrderFilled decoded', {
          wallet: matchedWallet.slice(0, 10),
          side,
          tokenId: tokenId.slice(0, 16),
          size: size.toFixed(4),
          price: price.toFixed(4),
          txHash: logEntry.transactionHash?.slice(0, 18),
          contract: isNegRisk ? 'NegRisk' : 'Standard',
        });

        void this.onTradeDetected({
          proxyWallet: matchedWallet,
          tokenId,
          side,
          size,
          price,
          transactionHash: logEntry.transactionHash,
          isNegRisk,
          contract: logEntry.address,
        }).catch((err: any) =>
          log.error('Trade detection handler error', { error: err.message }),
        );
      } catch (err: any) {
        log.warn('Failed to decode OrderFilled data, skipping', {
          wallet: matchedWallet.slice(0, 10),
          error: err.message,
          txHash: logEntry.transactionHash?.slice(0, 18),
        });
      }
    }
  }

  /**
   * Subscribe with per-wallet individual subscriptions.
   * Uses one subscription per wallet per role (maker/taker) — avoids dRPC topic array
   * OR-filter bugs that silently drop events for some wallets.
   * Total: walletCount × 2 subscriptions (same CU as array filter since delivered event count is identical).
   */
  private subscribe(ws: WebSocket): void {
    const wallets = this.getLiveWallets();
    this.subscribedWallets = new Set(wallets);
    this.pendingSubIds.clear();
    this.confirmedSubIds.clear();
    this.failedSubIds.clear();
    this.subIdToWallet.clear();
    this.degradedModeLogged = false;

    if (wallets.size === 0) {
      log.warn('No live wallets to watch — skipping subscription');
      this.expectedSubCount = 0;
      return;
    }

    let subId = 100; // start at 100 to avoid conflict with heartbeat id=999
    for (const wallet of wallets) {
      const padded = padAddress(wallet);

      // Sub: this wallet as maker (topics[2])
      const makerId = subId++;
      this.pendingSubIds.add(makerId);
      this.subIdToWallet.set(makerId, { wallet, role: 'maker' });
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: makerId, method: 'eth_subscribe',
        params: ['logs', {
          address: CTF_EXCHANGE_ADDRESSES,
          topics: [ORDER_FILLED_TOPIC, null, padded],
        }],
      }));

      // Sub: this wallet as taker (topics[3])
      const takerId = subId++;
      this.pendingSubIds.add(takerId);
      this.subIdToWallet.set(takerId, { wallet, role: 'taker' });
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: takerId, method: 'eth_subscribe',
        params: ['logs', {
          address: CTF_EXCHANGE_ADDRESSES,
          topics: [ORDER_FILLED_TOPIC, null, null, padded],
        }],
      }));
    }

    this.expectedSubCount = wallets.size * 2;
    this.subscriptionSentAt = Date.now();
    log.info('Subscribing per-wallet to OrderFilled events', {
      walletCount: wallets.size,
      subscriptions: this.expectedSubCount,
      wallets: [...wallets].map(w => w.slice(0, 10)),
    });
  }

  // ─── eth_getLogs backfill & periodic verification ───

  /**
   * Backfill missed events from a specific block using eth_getLogs (HTTP RPC).
   * Uses a BROAD filter (event + contract only, NO wallet topic filter) to
   * definitively catch everything the WSS subscription might have missed.
   * In-memory filtering then matches against live wallets.
   * CU cost: ~1 call per ~150 blocks; returns all OrderFilled events on our 2 contracts.
   */
  private async backfillFromBlock(fromBlock: number): Promise<void> {
    const wallets = this.getLiveWallets();
    if (wallets.size === 0) return;

    // Cap block range to ~500 blocks (~17 min) to avoid huge RPC responses.
    // If disconnected longer, we only catch recent misses; older trades are
    // covered by LIVE_POLL / bulk polling detection.
    if (this.lastProcessedBlock && fromBlock < this.lastProcessedBlock - 500) {
      fromBlock = this.lastProcessedBlock - 500;
    }

    // Broad filter: just contract + event topic — NO wallet filter.
    // This avoids any topic array bugs that might exist on the RPC provider.
    const filter = {
      address: CTF_EXCHANGE_ADDRESSES.map(a => a.toLowerCase()),
      topics: [ORDER_FILLED_TOPIC],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: 'latest',
    };

    const allLogs = await this.ethGetLogs(filter);
    let recovered = 0;
    for (const logEntry of allLogs) {
      // processLogEvent handles dedup via recentTxHashes + wallet matching
      const before = this.triggeredDetections;
      this.processLogEvent(logEntry);
      if (this.triggeredDetections > before) recovered++;
    }

    if (recovered > 0) {
      this.backfillRecovered += recovered;
      log.info('Backfill recovered missed events', {
        fromBlock,
        logsScanned: allLogs.length,
        recovered,
        totalRecovered: this.backfillRecovered,
      });
    } else {
      log.debug('Backfill scan clean', { fromBlock, logsScanned: allLogs.length });
    }
  }

  /**
   * Periodic verification: every CHAIN_VERIFY_INTERVAL_MS, cross-reference
   * eth_getLogs with what WSS delivered. Catches silent WSS delivery failures.
   */
  private startPeriodicVerification(): void {
    if (this.verifyTimer) return;

    this.verifyTimer = setInterval(async () => {
      if (this.state !== 'connected' || !this.lastProcessedBlock) return;

      try {
        // Verify the last ~150 blocks (≈5 min at 2s/block)
        const fromBlock = this.lastVerifyBlock ?? (this.lastProcessedBlock - 150);
        await this.backfillFromBlock(fromBlock);
        this.lastVerifyBlock = this.lastProcessedBlock;
      } catch (err: any) {
        log.warn('Periodic verification failed', { error: err.message });
      }
    }, config.CHAIN_VERIFY_INTERVAL_MS);
  }

  /** Make an eth_getLogs call via HTTP RPC */
  private async ethGetLogs(filter: Record<string, unknown>): Promise<Array<{
    transactionHash: string;
    logIndex: string;
    blockNumber: string;
    address: string;
    topics: string[];
    data: string;
    removed?: boolean;
  }>> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getLogs',
      params: [filter],
    });

    const res = await fetch(config.POLYGON_HTTP_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      throw new Error(`eth_getLogs HTTP ${res.status}: ${await res.text().catch(() => 'unknown')}`);
    }

    const json = await res.json() as { result?: unknown[]; error?: { message: string } };
    if (json.error) {
      throw new Error(`eth_getLogs RPC error: ${json.error.message}`);
    }

    return (json.result ?? []) as Array<{
      transactionHash: string;
      logIndex: string;
      blockNumber: string;
      address: string;
      topics: string[];
      data: string;
      removed?: boolean;
    }>;
  }

  /** Fetch the latest block number to seed lastProcessedBlock */
  private async fetchLatestBlockNumber(): Promise<void> {
    const res = await fetch(config.POLYGON_HTTP_RPC_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return;
    const json = await res.json() as { result?: string };
    if (json.result) {
      const blockNum = parseInt(json.result, 16);
      if (!isNaN(blockNum) && this.lastProcessedBlock === null) {
        this.lastProcessedBlock = blockNum;
        log.debug('Seeded lastProcessedBlock from eth_blockNumber', { block: blockNum });
      }
    }
  }

  // ─── Heartbeat & connection management ───

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Stale detection: force reconnect if no heartbeat response for STALE_THRESHOLD_MS
      if (this.lastHeartbeatAt &&
          Date.now() - this.lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS) {
        log.warn(`Connection stale (no heartbeat response in ${STALE_THRESHOLD_MS / 1000}s), forcing reconnect`);
        ws.terminate(); // → 'close' event → scheduleReconnect
        return;
      }

      // Check subscription health
      if (this.subscriptionSentAt > 0 && this.expectedSubCount > 0) {
        const allResponded = this.confirmedSubIds.size + this.failedSubIds.size;
        const stillPending = this.expectedSubCount - allResponded;

        if (stillPending > 0) {
          // Some subs haven't responded — check for timeout (dead connection)
          const elapsed = Date.now() - this.subscriptionSentAt;
          if (elapsed > 30_000) {
            log.warn('Subscriptions timed out (no response), reconnecting', {
              confirmed: this.confirmedSubIds.size,
              failed: this.failedSubIds.size,
              stillPending,
              elapsedMs: elapsed,
            });
            ws.terminate();
            return;
          }
        } else if (this.failedSubIds.size > 0 && !this.degradedModeLogged) {
          // All responded, some/all failed — degraded mode (do NOT reconnect)
          // Connection is alive; reconnecting would just get the same failures.
          // eth_getLogs periodic verification covers the failed wallets.
          const failedWallets = [...this.failedSubIds]
            .map(id => this.subIdToWallet.get(id)?.wallet?.slice(0, 10))
            .filter(Boolean);
          log.warn('Operating with degraded WSS coverage', {
            confirmed: this.confirmedSubIds.size,
            failed: this.failedSubIds.size,
            failedWallets,
          });
          this.degradedModeLogged = true;
        }
      }

      // Periodic status log (every 5th heartbeat ≈ every ~225s)
      this.heartbeatCount++;
      if (this.heartbeatCount % 5 === 1) {
        const failedWallets = this.failedSubIds.size > 0
          ? [...this.failedSubIds].map(id => this.subIdToWallet.get(id)?.wallet?.slice(0, 10)).filter(Boolean)
          : undefined;

        log.info('Chain watcher heartbeat', {
          eventsReceived: this.eventsReceived,
          triggeredDetections: this.triggeredDetections,
          backfillRecovered: this.backfillRecovered,
          confirmedSubs: this.confirmedSubIds.size,
          expectedSubs: this.expectedSubCount,
          liveWallets: this.getLiveWallets().size,
          lastBlock: this.lastProcessedBlock,
          lastEventAt: this.lastEventAt?.toISOString() ?? 'never',
          failedWallets,
        });
      }

      // Detect wallet set changes → reconnect with updated topic filters
      const currentWallets = this.getLiveWallets();
      if (!setsEqual(currentWallets, this.subscribedWallets)) {
        log.info('Live wallet set changed, reconnecting with new filters', {
          oldCount: this.subscribedWallets.size,
          newCount: currentWallets.size,
        });
        ws.terminate(); // → 'close' → scheduleReconnect with new wallet filters
        return;
      }

      // Keepalive: Polygon WS RPC uses JSON-RPC responses, not WebSocket protocol pings
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'eth_chainId', params: [] }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private clearAllTimers(): void {
    this.clearTimers();
    if (this.verifyTimer) { clearInterval(this.verifyTimer); this.verifyTimer = null; }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.state = 'reconnecting';
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, config.WS_RECONNECT_MAX_MS);
    log.info(`Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }
}
