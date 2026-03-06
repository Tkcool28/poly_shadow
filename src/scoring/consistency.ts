import Decimal from 'decimal.js';

export interface ConsistencyMetrics {
  winRate: number;
  maxWinStreak: number;
  maxLossStreak: number;
  returnStdDev: number;
  maxDrawdown: number;
}

interface ClosedPositionInput {
  realizedPnl: number;
  timestamp: number;
}

export function computeConsistency(
  closedPositions: ClosedPositionInput[],
): ConsistencyMetrics {
  if (closedPositions.length === 0) {
    return { winRate: 0, maxWinStreak: 0, maxLossStreak: 0, returnStdDev: 0, maxDrawdown: 0 };
  }

  // Win rate
  const wins = closedPositions.filter(cp => cp.realizedPnl > 0).length;
  const winRate = wins / closedPositions.length;

  // Streaks
  let maxWinStreak = 0;
  let maxLossStreak = 0;
  let currentWinStreak = 0;
  let currentLossStreak = 0;

  // Sort by timestamp for chronological analysis
  const sorted = [...closedPositions].sort((a, b) => a.timestamp - b.timestamp);

  for (const cp of sorted) {
    if (cp.realizedPnl > 0) {
      currentWinStreak++;
      currentLossStreak = 0;
      maxWinStreak = Math.max(maxWinStreak, currentWinStreak);
    } else if (cp.realizedPnl < 0) {
      currentLossStreak++;
      currentWinStreak = 0;
      maxLossStreak = Math.max(maxLossStreak, currentLossStreak);
    }
  }

  // Return standard deviation
  const returns = closedPositions.map(cp => cp.realizedPnl);
  const returnStdDev = computeStdDev(returns);

  // Max drawdown from equity curve
  const maxDrawdown = computeMaxDrawdown(sorted);

  return { winRate, maxWinStreak, maxLossStreak, returnStdDev, maxDrawdown };
}

function computeStdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function computeMaxDrawdown(sortedPositions: ClosedPositionInput[]): number {
  if (sortedPositions.length === 0) return 0;

  // Bin realized P&L by calendar day (UTC) to eliminate arbitrary intra-day ordering.
  // Multiple positions closing on the same day are aggregated into a single daily sum,
  // matching how portfolio P&L charts display performance.
  const dailyPnl = new Map<string, Decimal>();
  for (const cp of sortedPositions) {
    const day = new Date(cp.timestamp * 1000).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? new Decimal(0)).plus(cp.realizedPnl));
  }

  // ISO date strings sort lexicographically → chronological order
  const sortedDays = [...dailyPnl.entries()].sort((a, b) => a[0].localeCompare(b[0]));

  // Pass 1: find the eventual positive peak of cumulative PnL
  let cumPnl = new Decimal(0);
  let eventualPeak = new Decimal(0);
  for (const [, pnl] of sortedDays) {
    cumPnl = cumPnl.plus(pnl);
    if (cumPnl.gt(eventualPeak)) eventualPeak = cumPnl;
  }

  // All-losses case: equity never went positive but ended negative → 100% drawdown
  if (eventualPeak.lte(0) && cumPnl.lt(0)) {
    return 1.0;
  }

  // Pass 2: compute max drawdown including underwater periods
  cumPnl = new Decimal(0);
  let runningPeak = new Decimal(0);
  let maxDrawdown = new Decimal(0);

  for (const [, pnl] of sortedDays) {
    cumPnl = cumPnl.plus(pnl);
    if (cumPnl.gt(runningPeak)) runningPeak = cumPnl;

    if (runningPeak.gt(0)) {
      // Standard drawdown from positive running peak
      const drawdown = runningPeak.minus(cumPnl).div(runningPeak);
      if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
    } else if (cumPnl.lt(0) && eventualPeak.gt(0)) {
      // Underwater period: equity below starting $0 but trader eventually recovers.
      // Express depth relative to eventual peak to capture the risk.
      const drawdown = cumPnl.abs().div(eventualPeak);
      if (drawdown.gt(maxDrawdown)) maxDrawdown = drawdown;
    }
  }

  // Cap at 1.0 (100%)
  return Math.min(maxDrawdown.toNumber(), 1.0);
}
