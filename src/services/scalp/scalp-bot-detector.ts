import { EventEmitter } from 'events';
import { createJobLogger } from '../../lib/logger';
import { RtdsTradeStream, type RtdsTradePayload } from '../ws-trade-stream';
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
  private stream: RtdsTradeStream;
  private esportsTokens: Set<string> = new Set();
  private clusters: Map<string, TradeCluster> = new Map();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;
  private ownWallets: Set<string> = new Set(); // our proxy wallets to ignore

  constructor() {
    super();
    this.stream = new RtdsTradeStream(this.onTrade.bind(this));
  }

  /**
   * Update the set of esports token IDs to monitor.
   */
  updateTokens(tokenIds: Set<string>): void {
    this.esportsTokens = tokenIds;
    log.info('Bot detector tokens updated', { count: tokenIds.size });
  }

  /**
   * Add our own proxy wallet addresses so we can ignore our own trades.
   */
  addOwnWallet(wallet: string): void {
    this.ownWallets.add(wallet.toLowerCase());
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

  private onTrade(payload: RtdsTradePayload): void {
    // Only care about esports tokens
    if (!this.esportsTokens.has(payload.asset)) return;

    // Ignore our own trades
    if (this.ownWallets.has(payload.proxyWallet.toLowerCase())) return;

    // Only track BUYs
    if (payload.side !== 'BUY') return;

    const size = parseFloat(payload.size);
    const price = parseFloat(payload.price);
    if (size <= 0 || price <= 0) return;

    const usdValue = size * price;
    const now = Date.now();

    // Get or create cluster for this tokenId
    let cluster = this.clusters.get(payload.asset);
    if (!cluster || now - cluster.firstTradeAt > CLUSTER_WINDOW_MS) {
      // Start new cluster
      cluster = {
        tokenId: payload.asset,
        buys: [],
        firstTradeAt: now,
        totalBuyUsd: 0,
        minPrice: price,
        maxPrice: price,
      };
      this.clusters.set(payload.asset, cluster);
    }

    cluster.buys.push({ price, size, timestamp: now });
    cluster.totalBuyUsd += usdValue;
    cluster.minPrice = Math.min(cluster.minPrice, price);
    cluster.maxPrice = Math.max(cluster.maxPrice, price);

    // Check signal conditions
    const market = getMarketByTokenId(payload.asset);
    const liquidity = market?.liquidity ?? 10_000;
    const threshold = Math.max(DEFAULT_MIN_CLUSTER_USD, liquidity * 0.0005);

    if (
      cluster.buys.length >= MIN_CLUSTER_TRADES &&
      cluster.totalBuyUsd >= threshold &&
      cluster.maxPrice > cluster.minPrice // price moved up (not ghost FOK)
    ) {
      const avgPrice = cluster.buys.reduce((s, b) => s + b.price * b.size, 0) /
                        cluster.buys.reduce((s, b) => s + b.size, 0);

      const signal: BotSignal = {
        tokenId: payload.asset,
        side: 'BUY',
        avgPrice,
        totalUsd: cluster.totalBuyUsd,
        tradeCount: cluster.buys.length,
        confidence: 'MEDIUM',
        timestamp: new Date(),
      };

      log.info('Bot signal detected', {
        tokenId: payload.asset.slice(0, 20) + '...',
        totalUsd: signal.totalUsd.toFixed(2),
        tradeCount: signal.tradeCount,
        avgPrice: signal.avgPrice.toFixed(4),
        slug: market?.slug ?? 'unknown',
      });

      this.emit('botSignal', signal);

      // Reset cluster after emitting signal (prevent duplicate signals)
      this.clusters.delete(payload.asset);
    }
  }

  private pruneExpiredClusters(): void {
    const now = Date.now();
    for (const [tokenId, cluster] of this.clusters) {
      if (now - cluster.firstTradeAt > CLUSTER_WINDOW_MS * 2) {
        this.clusters.delete(tokenId);
      }
    }
  }
}
