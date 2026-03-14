import { EventEmitter } from 'events';
import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { ClobMarketStream, type ClobTradeEvent } from '../clob-market-stream';
import { getMarketByTokenId } from './scalp-market-discovery';
import type { EnhancedBotSignal } from './scalp-types';

const log = createJobLogger('scalp-flow-tracker');

const FLOW_WINDOW_MS = 60_000; // 60s rolling trade window
const SIGNAL_WINDOW_MS = 30_000; // 30s for signal detection
const SELL_PRESSURE_WINDOW_MS = 15_000; // 15s for recent sell pressure
const TRAILING_WINDOW_INTERVAL_MS = 30_000; // snapshot every 30s
const TRAILING_WINDOW_COUNT = 10; // keep last 10 windows (5 min)
const TRADE_LOG_FLUSH_INTERVAL_MS = 5_000; // batch-write to DB every 5s
const STATS_LOG_INTERVAL_MS = 60_000; // log stats every 60s
const HOURLY_PRUNE_INTERVAL_MS = 3_600_000; // prune old DB records every hour
const TRADE_LOG_RETENTION_MS = 48 * 3_600_000; // 48h retention for ScalpTradeLog
const DEFAULT_MIN_CLUSTER_USD = 50;
const SIGNAL_COOLDOWN_MS = 300_000; // 5 min cooldown per token after signal

interface FlowTrade {
  side: 'BUY' | 'SELL';
  usdValue: number;
  price: number;
  ts: number;
}

interface TokenFlowState {
  tokenId: string;
  trades: FlowTrade[];
  trailingWindows: { total: number; ts: number }[];
}

interface PendingTradeLog {
  tokenId: string;
  slug: string | null;
  side: string;
  price: number;
  size: number;
  usdValue: number;
  txHash: string | null;
  clobTimestamp: bigint;
}

export class ScalpFlowTracker extends EventEmitter {
  private stream: ClobMarketStream;
  private flowStates: Map<string, TokenFlowState> = new Map();
  private pendingTradeLogBatch: PendingTradeLog[] = [];
  private pendingPersistenceChecks: Set<string> = new Set();
  private lastSignalAt: Map<string, number> = new Map(); // per-token cooldown

  // Timers
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private tradeLogFlushTimer: ReturnType<typeof setInterval> | null = null;
  private trailingWindowTimer: ReturnType<typeof setInterval> | null = null;
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private hourlyPruneTimer: ReturnType<typeof setInterval> | null = null;

  // Stats
  private tradesReceived = 0;
  private signalsEmitted = 0;

  constructor() {
    super();
    this.stream = new ClobMarketStream(this.onTrade.bind(this));
  }

  /**
   * Update the set of token IDs to monitor via the underlying WebSocket stream.
   */
  updateTokens(tokenIds: Set<string>): void {
    this.stream.setTokenIds([...tokenIds]);
    log.info('Flow tracker tokens updated', { count: tokenIds.size });
  }

  /**
   * Start the WebSocket stream and all periodic timers.
   */
  start(): void {
    this.stream.connect();

    // Cleanup expired trades every 10s
    this.cleanupTimer = setInterval(() => this.pruneExpiredTrades(), 10_000);

    // Flush trade log batch to DB every 5s
    this.tradeLogFlushTimer = setInterval(() => this.flushTradeLogBatch(), TRADE_LOG_FLUSH_INTERVAL_MS);

    // Snapshot trailing volume windows every 30s
    this.trailingWindowTimer = setInterval(() => this.snapshotTrailingWindows(), TRAILING_WINDOW_INTERVAL_MS);

    // Stats logging every 60s
    this.statsTimer = setInterval(() => this.logStats(), STATS_LOG_INTERVAL_MS);

    // Hourly prune of old DB records
    this.hourlyPruneTimer = setInterval(() => this.pruneOldTradeLogRecords(), HOURLY_PRUNE_INTERVAL_MS);

    log.info('Flow tracker started');
  }

  /**
   * Stop the WebSocket stream and clear all timers.
   */
  stop(): void {
    this.stream.close();

    if (this.cleanupTimer) { clearInterval(this.cleanupTimer); this.cleanupTimer = null; }
    if (this.tradeLogFlushTimer) { clearInterval(this.tradeLogFlushTimer); this.tradeLogFlushTimer = null; }
    if (this.trailingWindowTimer) { clearInterval(this.trailingWindowTimer); this.trailingWindowTimer = null; }
    if (this.statsTimer) { clearInterval(this.statsTimer); this.statsTimer = null; }
    if (this.hourlyPruneTimer) { clearInterval(this.hourlyPruneTimer); this.hourlyPruneTimer = null; }

    this.flowStates.clear();
    this.pendingPersistenceChecks.clear();
    log.info('Flow tracker stopped');
  }

  /**
   * Health check: returns true if the WebSocket stream is connected.
   */
  isHealthy(): boolean {
    return this.stream.state === 'connected';
  }

  // ─── Trade handler ───

  private onTrade(event: ClobTradeEvent): void {
    this.tradesReceived++;

    const price = parseFloat(event.price);
    const size = parseFloat(event.size);
    if (!price || !size || isNaN(price) || isNaN(size) || price <= 0 || size <= 0) return;

    const side = event.side === 'BUY' ? 'BUY' : event.side === 'SELL' ? 'SELL' : null;
    if (!side) return;

    const usdValue = size * price;
    const now = Date.now();

    // Get or create flow state for this token
    let state = this.flowStates.get(event.asset_id);
    if (!state) {
      state = {
        tokenId: event.asset_id,
        trades: [],
        trailingWindows: [],
      };
      this.flowStates.set(event.asset_id, state);
    }

    // Add trade to rolling window
    state.trades.push({ side, usdValue, price, ts: now });

    // Add to pending DB batch
    const market = getMarketByTokenId(event.asset_id);
    this.pendingTradeLogBatch.push({
      tokenId: event.asset_id,
      slug: market?.slug ?? null,
      side,
      price,
      size,
      usdValue,
      txHash: event.transaction_hash || null,
      clobTimestamp: BigInt(event.timestamp || String(now)),
    });

    // Prune trades older than 60s from rolling window
    const cutoff = now - FLOW_WINDOW_MS;
    state.trades = state.trades.filter(t => t.ts >= cutoff);

    // Check signal conditions
    this.checkSignal(event.asset_id, state, now);
  }

  // ─── Signal detection ───

  private checkSignal(tokenId: string, state: TokenFlowState, now: number): void {
    // Per-token cooldown: skip if we signaled recently
    const lastSignal = this.lastSignalAt.get(tokenId) ?? 0;
    if (now - lastSignal < SIGNAL_COOLDOWN_MS) return;

    const trades30s = state.trades.filter(t => now - t.ts < SIGNAL_WINDOW_MS);
    const buys30s = trades30s.filter(t => t.side === 'BUY');
    const sells30s = trades30s.filter(t => t.side === 'SELL');

    const buyVol = buys30s.reduce((s, t) => s + t.usdValue, 0);
    const sellVol = sells30s.reduce((s, t) => s + t.usdValue, 0);
    const totalVol = buyVol + sellVol;
    const netImbalance = totalVol > 0 ? (buyVol - sellVol) / totalVol : 0;
    const buyCount = buys30s.length;

    // Filter out extreme prices: high prices have terrible risk/reward (lose 75c to win 25c),
    // low prices are near-settled outcomes with no tradeable edge
    const avgBuyPrice = buys30s.length > 0
      ? buys30s.reduce((s, t) => s + t.usdValue, 0) / buys30s.reduce((s, t) => s + t.usdValue / t.price, 0)
      : 0;
    if (avgBuyPrice > 0.75 || avgBuyPrice < 0.05) return;

    // Trailing average from trailing windows
    const trailingAvg = state.trailingWindows.length > 0
      ? state.trailingWindows.reduce((s, w) => s + w.total, 0) / state.trailingWindows.length
      : totalVol;
    const volumeSpike = trailingAvg > 0 ? totalVol / trailingAvg : 1;

    // Check sell pressure in last 15s
    const sells15s = sells30s.filter(t => now - t.ts < SELL_PRESSURE_WINDOW_MS);
    const sellPressure = sells15s.reduce((s, t) => s + t.usdValue, 0) > buyVol;

    // Get market liquidity for dynamic threshold
    const market = getMarketByTokenId(tokenId);
    const threshold = Math.max(DEFAULT_MIN_CLUSTER_USD, (market?.liquidity ?? 10_000) * 0.0005);

    if (
      netImbalance > config.SCALP_MIN_NET_IMBALANCE &&
      buyVol >= threshold &&
      buyCount >= 2 &&
      volumeSpike > 2 &&
      !sellPressure
    ) {
      // Schedule price persistence check (debounce per token)
      this.schedulePersistenceCheck(tokenId, state, buys30s, sells30s, buyVol, sellVol, netImbalance, buyCount, volumeSpike);
    }
  }

  private schedulePersistenceCheck(
    tokenId: string,
    state: TokenFlowState,
    buys30s: FlowTrade[],
    sells30s: FlowTrade[],
    buyVol: number,
    sellVol: number,
    netImbalance: number,
    buyCount: number,
    volumeSpike: number,
  ): void {
    // Prevent duplicate persistence checks for the same token
    if (this.pendingPersistenceChecks.has(tokenId)) return;
    this.pendingPersistenceChecks.add(tokenId);

    // Capture the max buy price at cluster detection time
    const clusterMaxBuyPrice = Math.max(...buys30s.map(t => t.price));

    const timer = setTimeout(async () => {
      this.pendingPersistenceChecks.delete(tokenId);

      try {
        // Re-read flow state after delay
        const freshState = this.flowStates.get(tokenId);
        if (!freshState) {
          // Token state was cleaned up — still emit with pricePersisted=false
          this.emitSignal(tokenId, buys30s, buyVol, sellVol, netImbalance, buyCount, volumeSpike, false);
          return;
        }

        const now = Date.now();
        const freshTrades30s = freshState.trades.filter(t => now - t.ts < SIGNAL_WINDOW_MS);
        const freshBuys = freshTrades30s.filter(t => t.side === 'BUY');
        const freshSells = freshTrades30s.filter(t => t.side === 'SELL');
        const freshBuyVol = freshBuys.reduce((s, t) => s + t.usdValue, 0);
        const freshSellVol = freshSells.reduce((s, t) => s + t.usdValue, 0);
        const freshTotal = freshBuyVol + freshSellVol;
        const freshImbalance = freshTotal > 0 ? (freshBuyVol - freshSellVol) / freshTotal : 0;

        // Check if price persisted at or above the cluster's max buy price
        const latestBuys = freshBuys.filter(t => t.ts > now - 5000); // last 5s of buys
        const latestPrice = latestBuys.length > 0
          ? Math.max(...latestBuys.map(t => t.price))
          : (freshBuys.length > 0 ? freshBuys[freshBuys.length - 1].price : 0);

        const pricePersisted = latestPrice >= clusterMaxBuyPrice && freshImbalance > 0;

        this.emitSignal(tokenId, buys30s, buyVol, sellVol, netImbalance, buyCount, volumeSpike, pricePersisted);
      } catch (err: any) {
        log.warn(`Persistence check failed for ${tokenId.slice(0, 20)}: ${err.message}`);
        // Emit anyway with pricePersisted=false
        this.emitSignal(tokenId, buys30s, buyVol, sellVol, netImbalance, buyCount, volumeSpike, false);
      }
    }, config.SCALP_ENTRY_DELAY_MS);

    timer.unref(); // Don't keep process alive for this timer
  }

  private emitSignal(
    tokenId: string,
    buys30s: FlowTrade[],
    buyVol: number,
    sellVol: number,
    netImbalance: number,
    buyCount: number,
    volumeSpike: number,
    pricePersisted: boolean,
  ): void {
    // Compute VWAP of buys
    const totalShares = buys30s.reduce((s, t) => s + t.usdValue / t.price, 0);
    const avgBuyPrice = totalShares > 0
      ? buys30s.reduce((s, t) => s + t.usdValue, 0) / totalShares
      : (buys30s.length > 0 ? buys30s[buys30s.length - 1].price : 0);

    // Composite confidence score
    const confidence =
      0.3 * Math.min(Math.max(netImbalance, 0), 1) +
      0.3 * Math.min(volumeSpike / 5, 1) +
      0.2 * Math.min(buyVol / 500, 1) +
      0.2 * (pricePersisted ? 1.0 : 0.0);

    // Map to legacy confidence string
    const legacyConfidence: 'LOW' | 'MEDIUM' | 'HIGH' =
      confidence < 0.3 ? 'LOW' : confidence < 0.6 ? 'MEDIUM' : 'HIGH';

    const market = getMarketByTokenId(tokenId);

    const signal: EnhancedBotSignal = {
      tokenId,
      side: 'BUY',
      avgPrice: avgBuyPrice,
      totalUsd: buyVol,
      tradeCount: buyCount,
      confidence: legacyConfidence,
      timestamp: new Date(),
      buyVolumeUsd: buyVol,
      sellVolumeUsd: sellVol,
      netImbalance,
      confidenceScore: confidence,
      volumeSpike,
      pricePersisted,
    };

    this.signalsEmitted++;
    this.lastSignalAt.set(tokenId, Date.now());

    log.info('Flow signal detected', {
      tokenId: tokenId.slice(0, 20) + '...',
      buyVol: buyVol.toFixed(2),
      sellVol: sellVol.toFixed(2),
      netImbalance: netImbalance.toFixed(3),
      confidence: confidence.toFixed(3),
      volumeSpike: volumeSpike.toFixed(2),
      pricePersisted,
      slug: market?.slug ?? 'unknown',
    });

    this.emit('signal', signal);
  }

  // ─── Periodic tasks ───

  private pruneExpiredTrades(): void {
    const now = Date.now();
    const cutoff = now - FLOW_WINDOW_MS;

    for (const [tokenId, state] of this.flowStates) {
      state.trades = state.trades.filter(t => t.ts >= cutoff);
      // Remove empty states to avoid unbounded growth
      if (state.trades.length === 0 && state.trailingWindows.length === 0) {
        this.flowStates.delete(tokenId);
      }
    }

    // Prune expired cooldowns
    for (const [tokenId, ts] of this.lastSignalAt) {
      if (now - ts > SIGNAL_COOLDOWN_MS * 2) {
        this.lastSignalAt.delete(tokenId);
      }
    }
  }

  private snapshotTrailingWindows(): void {
    const now = Date.now();

    for (const state of this.flowStates.values()) {
      // Sum all trades in the current 30s window
      const windowTrades = state.trades.filter(t => now - t.ts < TRAILING_WINDOW_INTERVAL_MS);
      const total = windowTrades.reduce((s, t) => s + t.usdValue, 0);

      state.trailingWindows.push({ total, ts: now });

      // Keep only last TRAILING_WINDOW_COUNT entries (5 min)
      if (state.trailingWindows.length > TRAILING_WINDOW_COUNT) {
        state.trailingWindows = state.trailingWindows.slice(-TRAILING_WINDOW_COUNT);
      }
    }
  }

  private async flushTradeLogBatch(): Promise<void> {
    if (this.pendingTradeLogBatch.length === 0) return;

    const batch = this.pendingTradeLogBatch.splice(0);

    try {
      await prisma.scalpTradeLog.createMany({
        data: batch.map(t => ({
          tokenId: t.tokenId,
          slug: t.slug,
          side: t.side,
          price: t.price,
          size: t.size,
          usdValue: t.usdValue,
          txHash: t.txHash,
          clobTimestamp: t.clobTimestamp,
        })),
        skipDuplicates: true,
      });
    } catch (err: any) {
      log.warn(`Trade log batch flush failed (${batch.length} records): ${err.message}`);
      // Clear batch on error — don't retry to avoid memory growth
    }
  }

  private async pruneOldTradeLogRecords(): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - TRADE_LOG_RETENTION_MS);
      const result = await prisma.scalpTradeLog.deleteMany({
        where: { receivedAt: { lt: cutoff } },
      });
      if (result.count > 0) {
        log.info('Pruned old trade log records', { count: result.count });
      }
    } catch (err: any) {
      log.warn(`Trade log prune failed: ${err.message}`);
    }
  }

  private logStats(): void {
    log.info('Flow tracker stats', {
      tradesReceived: this.tradesReceived,
      signalsEmitted: this.signalsEmitted,
      activeTokens: this.flowStates.size,
      pendingPersistenceChecks: this.pendingPersistenceChecks.size,
      streamState: this.stream.state,
      streamMessages: this.stream.messagesReceived,
      streamTrades: this.stream.tradesReceived,
    });
  }
}
