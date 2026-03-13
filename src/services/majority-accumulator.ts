import { createJobLogger } from '../lib/logger';

const log = createJobLogger('majority-accumulator');

interface OutcomeStats {
  count: number;
  totalUsd: number;
  lastSeenMs: number;
}

// Key: `${proxyWallet}:${conditionId}`  →  outcome → stats
const accumulator = new Map<string, Map<string, OutcomeStats>>();

/** Record a trader BUY signal. Must be called for ALL BUYs, even those skipped by other filters. */
export function recordTraderBuy(proxyWallet: string, conditionId: string, outcome: string, usd: number): void {
  const key = `${proxyWallet}:${conditionId}`;
  let outcomes = accumulator.get(key);
  if (!outcomes) {
    outcomes = new Map();
    accumulator.set(key, outcomes);
  }
  const stats = outcomes.get(outcome) ?? { count: 0, totalUsd: 0, lastSeenMs: 0 };
  stats.count++;
  stats.totalUsd += usd;
  stats.lastSeenMs = Date.now();
  outcomes.set(outcome, stats);
}

/** Returns the majority outcome (by USD volume) if detection threshold met, else null. */
export function getMajoritySide(
  proxyWallet: string, conditionId: string,
  minTrades: number, minRatio: number,
): { outcome: string; ratio: number; totalTrades: number; totalUsd: number } | null {
  const outcomes = accumulator.get(`${proxyWallet}:${conditionId}`);
  if (!outcomes) return null;
  let totalCount = 0;
  let totalUsd = 0;
  let maxUsd = 0;
  let majorityOutcome = '';
  for (const [outcome, stats] of outcomes) {
    totalCount += stats.count;
    totalUsd += stats.totalUsd;
    if (stats.totalUsd > maxUsd) {
      maxUsd = stats.totalUsd;
      majorityOutcome = outcome;
    }
  }
  if (totalCount < minTrades) return null;       // timing gate: still count-based
  const ratio = totalUsd > 0 ? maxUsd / totalUsd : 0;
  if (ratio < minRatio) return null;
  return { outcome: majorityOutcome, ratio, totalTrades: totalCount, totalUsd };
}

/** Prune stale entries. Default 25h — covers daily-timeframe markets. */
export function pruneAccumulator(maxAgeMs = 25 * 60 * 60 * 1000): void {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;
  for (const [key, outcomes] of accumulator) {
    let latestSeen = 0;
    for (const stats of outcomes.values()) {
      if (stats.lastSeenMs > latestSeen) latestSeen = stats.lastSeenMs;
    }
    if (latestSeen < cutoff) {
      accumulator.delete(key);
      pruned++;
    }
  }
  if (pruned > 0) log.debug(`Pruned ${pruned} stale accumulator entries (${accumulator.size} remaining)`);
}

/** Seed from DB on startup. Prevents cold-start miss for active markets. */
export function seedAccumulator(trades: Array<{ proxyWallet: string; conditionId: string; outcome: string | null; size: number; price: number }>): void {
  for (const trade of trades) {
    if (trade.conditionId && trade.outcome) {
      recordTraderBuy(trade.proxyWallet, trade.conditionId, trade.outcome, trade.size * trade.price);
    }
  }
}
