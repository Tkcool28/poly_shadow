export interface RecencyMetrics {
  recentPnl30d: number;
  recentWinRate30d: number;
  trendDirection: number; // positive = improving, negative = declining
}

interface ClosedPositionInput {
  realizedPnl: number;
  timestamp: number;
}

export function computeRecency(
  closedPositions: ClosedPositionInput[],
  nowEpoch: number = Math.floor(Date.now() / 1000),
): RecencyMetrics {
  const thirtyDaysAgo = nowEpoch - 30 * 86400;
  const sixtyDaysAgo = nowEpoch - 60 * 86400;

  const recent = closedPositions.filter(cp => cp.timestamp >= thirtyDaysAgo);
  const prior = closedPositions.filter(
    cp => cp.timestamp >= sixtyDaysAgo && cp.timestamp < thirtyDaysAgo,
  );

  // Recent 30-day P&L
  const recentPnl30d = recent.reduce((s, cp) => s + cp.realizedPnl, 0);

  // Recent 30-day win rate
  const recentWins = recent.filter(cp => cp.realizedPnl > 0).length;
  const recentWinRate30d = recent.length > 0 ? recentWins / recent.length : 0;

  // Trend direction: compare recent 30d vs prior 30d P&L
  const priorPnl = prior.reduce((s, cp) => s + cp.realizedPnl, 0);
  let trendDirection = 0;
  if (prior.length > 0 && recent.length > 0) {
    // Normalize by number of positions to compare rates
    const recentAvg = recentPnl30d / recent.length;
    const priorAvg = priorPnl / prior.length;
    const denom = Math.max(Math.abs(priorAvg), 1);
    trendDirection = (recentAvg - priorAvg) / denom;
    // Clamp to [-1, 1]
    trendDirection = Math.max(-1, Math.min(1, trendDirection));
  } else if (recent.length > 0 && prior.length === 0) {
    // New activity → slightly positive
    trendDirection = 0.5;
  }

  return { recentPnl30d, recentWinRate30d, trendDirection };
}
