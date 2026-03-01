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

  // Build cumulative P&L equity curve
  let cumPnl = new Decimal(0);
  let peak = new Decimal(0);
  let maxDrawdown = new Decimal(0);

  for (const cp of sortedPositions) {
    cumPnl = cumPnl.plus(cp.realizedPnl);

    if (cumPnl.gt(peak)) {
      peak = cumPnl;
    }

    if (peak.gt(0)) {
      const drawdown = peak.minus(cumPnl).div(peak);
      if (drawdown.gt(maxDrawdown)) {
        maxDrawdown = drawdown;
      }
    }
  }

  // Clamp to [0, 1] — cumulative P&L can go negative past the peak,
  // producing values > 1.0 which break percentile ranking assumptions.
  return Math.min(maxDrawdown.toNumber(), 1);
}
