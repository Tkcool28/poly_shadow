import { SCORING_WEIGHTS, INVERTED_METRICS, MIN_TRADES_THRESHOLD } from '../config/constants';
import { logger } from '../lib/logger';

interface ScoreInput {
  proxyWallet: string;
  roi: number;
  totalPnl: number;
  avgProfitPerTrade: number;
  winRate: number;
  returnStdDev: number;
  maxDrawdown: number;
  totalTrades: number;
  totalMarkets: number;
  tradeFrequency: number;
  concentrationScore: number;
  avgRelativePositionSize: number;
  recentPnl30d: number;
  recentWinRate30d: number;
  trendDirection: number;
}

export interface CompositeResult {
  proxyWallet: string;
  compositeScore: number;
  rank: number;
}

type MetricKey = keyof typeof SCORING_WEIGHTS;

const invertedSet = new Set<string>(INVERTED_METRICS);

/**
 * Binary search: count of elements <= val in a sorted array.
 * O(log n) instead of O(n) filter.
 */
function countLessOrEqual(sorted: number[], val: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] <= val) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export function computeCompositeScores(traders: ScoreInput[]): CompositeResult[] {
  if (traders.length === 0) return [];

  if (traders.length < 5) {
    logger.warn(
      `Scoring only ${traders.length} traders — percentile rankings may not be meaningful`,
    );
  }

  // Step 1: Compute percentile rank for each metric
  const metricKeys = Object.keys(SCORING_WEIGHTS) as MetricKey[];
  const percentiles = new Map<string, Map<MetricKey, number>>();

  for (const key of metricKeys) {
    const values = traders.map(t => t[key]);
    const sorted = [...values].sort((a, b) => a - b);

    for (const trader of traders) {
      const val = trader[key];
      // Percentile = fraction of values <= this value (binary search)
      const rank = countLessOrEqual(sorted, val);
      let percentile = rank / sorted.length;

      // Invert for metrics where lower = better
      if (invertedSet.has(key)) {
        percentile = 1 - percentile;
      }

      if (!percentiles.has(trader.proxyWallet)) {
        percentiles.set(trader.proxyWallet, new Map());
      }
      percentiles.get(trader.proxyWallet)!.set(key, percentile);
    }
  }

  // Step 2: Compute weighted composite score
  const results: CompositeResult[] = [];

  for (const trader of traders) {
    const traderPercentiles = percentiles.get(trader.proxyWallet)!;
    let score = 0;

    for (const key of metricKeys) {
      score += traderPercentiles.get(key)! * SCORING_WEIGHTS[key];
    }

    // Activity penalty: traders with fewer than MIN_TRADES_THRESHOLD get 0.5x
    if (trader.totalTrades < MIN_TRADES_THRESHOLD) {
      score *= 0.5;
    }

    results.push({
      proxyWallet: trader.proxyWallet,
      compositeScore: Math.round(score * 10000) / 10000,
      rank: 0, // assigned below
    });
  }

  // Step 3: Assign ranks (1 = best)
  results.sort((a, b) => b.compositeScore - a.compositeScore);
  for (let i = 0; i < results.length; i++) {
    results[i].rank = i + 1;
  }

  return results;
}
