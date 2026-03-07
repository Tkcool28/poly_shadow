import { EventEmitter } from 'events';
import { createJobLogger } from '../../lib/logger';
import { ClobMarketStream, type ClobTradeEvent } from '../clob-market-stream';
import { getMarketByTokenId } from './scalp-market-discovery';
import type { BotSignal } from './scalp-types';

const log = createJobLogger('scalp-bot-detector');

const CLUSTER_WINDOW_MS = 5000; // 5 second window for clustering trades
const MIN_CLUSTER_TRADES = 2;   // minimum 2 trades in cluster
const DEFAULT_MIN_CLUSTER_USD = 50; // minimum USD in cluster (dynamic per market)

interface TradeCluster {
  tokenId: string;
  buys: { price: number; size: number; timestamp: number }[];
  firstTradeAt: number;
  totalBuyUsd: number;
  minPrice: number;
  maxPrice: number;
}

export class ScalpBotDetector extends EventEmitter {
  private stream: ClobMarketStream;
  private esportsTokens: Set<string> = new Set();
  private clusters: Map<string, TradeCluster> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ownTxHashes: Set<string> = new Set(); // our tx hashes to ignore
  private tradesReceived = 0;
  private tradesMatchedEsports = 0;
  private lastStatsLogAt = 0;

  constructor() {
    super();
    this.stream = new ClobMarketStream(this.onTrade.bind(this));
  }

  /**
   * Update the set of esports token IDs to monitor.
   * Also updates the CLOB WebSocket subscription.
   */
  updateTokens(tokenIds: Set<string>): void {
    this.esportsTokens = tokenIds;
    this.stream.setTokenIds([...tokenIds]);
    log.info('Bot detector tokens updated', { count: tokenIds.size });
  }

  /**
   * Register a transaction hash as our own so we can ignore it.
   */
  addOwnTxHash(txHash: string): void {
    this.ownTxHashes.add(txHash.toLowerCase());
    // Prevent unbounded growth: cap at 1000 entries
    if (this.ownTxHashes.size > 1000) {
      const toDelete = [...this.ownTxHashes].slice(0, 500);
      for (const h of toDelete) this.ownTxHashes.delete(h);
    }
  }

  start(): void {
    this.stream.connect();
    // Clean up expired clusters every 10s
    this.cleanupTimer = setInterval(() => this.pruneExpiredClusters(), 10_000);
    log.info('Bot detector started');
  }

  stop(): void {
    this.stream.close();
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
    this.clusters.clear();
    log.info('Bot detector stopped');
  }

  isHealthy(): boolean {
    return this.stream.state === 'connected';
  }

  private onTrade(event: ClobTradeEvent): void {
    this.tradesReceived++;

    // CLOB market stream delivers all events for subscribed tokens;
    // double-check against our esports set for safety
    if (!this.esportsTokens.has(event.asset_id)) return;

    this.tradesMatchedEsports++;

    // Ignore our own trades by tx hash
    if (event.transaction_hash && this.ownTxHashes.has(event.transaction_hash.toLowerCase())) return;

    // Only track BUYs
    if (event.side !== 'BUY') return;

    const size = parseFloat(event.size);
    const price = parseFloat(event.price);
    if (!size || !price || isNaN(size) || isNaN(price) || size <= 0 || price <= 0) return;

    const usdValue = size * price;
    const now = Date.now();

    // Get or create cluster for this tokenId
    let cluster = this.clusters.get(event.asset_id);
    if (!cluster || now - cluster.firstTradeAt > CLUSTER_WINDOW_MS) {
      // Start new cluster
      cluster = {
        tokenId: event.asset_id,
        buys: [],
        firstTradeAt: now,
        totalBuyUsd: 0,
        minPrice: price,
        maxPrice: price,
      };
      this.clusters.set(event.asset_id, cluster);
    }

    cluster.buys.push({ price, size, timestamp: now });
    cluster.totalBuyUsd += usdValue;
    cluster.minPrice = Math.min(cluster.minPrice, price);
    cluster.maxPrice = Math.max(cluster.maxPrice, price);

    // Check signal conditions
    const market = getMarketByTokenId(event.asset_id);
    const liquidity = market?.liquidity ?? 10_000;
    const threshold = Math.max(DEFAULT_MIN_CLUSTER_USD, liquidity * 0.0005);

    if (
      cluster.buys.length >= MIN_CLUSTER_TRADES &&
      cluster.totalBuyUsd >= threshold &&
      cluster.maxPrice > cluster.minPrice // price moved up (not ghost FOK)
    ) {
      const avgPrice = cluster.buys.reduce((s, b) => s + b.price * b.size, 0) /
                        cluster.buys.reduce((s, b) => s + b.size, 0);

      // Dynamic confidence based on cluster magnitude vs threshold
      const confidence: BotSignal['confidence'] =
        cluster.totalBuyUsd >= threshold * 10 ? 'HIGH' : 'MEDIUM';

      const signal: BotSignal = {
        tokenId: event.asset_id,
        side: 'BUY',
        avgPrice,
        totalUsd: cluster.totalBuyUsd,
        tradeCount: cluster.buys.length,
        confidence,
        timestamp: new Date(),
      };

      log.info('Bot signal detected', {
        tokenId: event.asset_id.slice(0, 20) + '...',
        totalUsd: signal.totalUsd.toFixed(2),
        tradeCount: signal.tradeCount,
        avgPrice: signal.avgPrice.toFixed(4),
        slug: market?.slug ?? 'unknown',
      });

      this.emit('botSignal', signal);

      // Reset cluster after emitting signal (prevent duplicate signals)
      this.clusters.delete(event.asset_id);
    }
  }

  private pruneExpiredClusters(): void {
    const now = Date.now();
    for (const [tokenId, cluster] of this.clusters) {
      if (now - cluster.firstTradeAt > CLUSTER_WINDOW_MS * 2) {
        this.clusters.delete(tokenId);
      }
    }

    // Periodic trade stats (every ~60s)
    if (now - this.lastStatsLogAt >= 60_000) {
      log.info('Bot detector stats', {
        tradesReceived: this.tradesReceived,
        tradesMatchedEsports: this.tradesMatchedEsports,
        activeClusters: this.clusters.size,
        watchedTokens: this.esportsTokens.size,
        streamState: this.stream.state,
        streamMessages: this.stream.messagesReceived,
        streamTrades: this.stream.tradesReceived,
      });
      this.lastStatsLogAt = now;
    }
  }
}
