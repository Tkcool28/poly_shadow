export interface ActivityMetrics {
  totalTrades: number;
  totalMarkets: number;
  avgPositionSize: number;
  avgHoldDuration: number | null;
  tradeFrequency: number; // trades per day
  activeDays: number;
}

interface TradeInput {
  conditionId: string;
  size: number;
  price: number;
  timestamp: number;
}

interface ClosedPositionInput {
  conditionId: string;
  timestamp: number; // close timestamp
}

export function computeActivity(
  trades: TradeInput[],
  closedPositions: ClosedPositionInput[],
): ActivityMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      totalMarkets: 0,
      avgPositionSize: 0,
      avgHoldDuration: null,
      tradeFrequency: 0,
      activeDays: 0,
    };
  }

  const totalTrades = trades.length;

  // Unique markets traded
  const uniqueMarkets = new Set(trades.map(t => t.conditionId));
  const totalMarkets = uniqueMarkets.size;

  // Average position size (USD value = size * price)
  const totalValue = trades.reduce((sum, t) => sum + t.size * t.price, 0);
  const avgPositionSize = totalValue / totalTrades;

  // Active days (unique days with trades)
  const uniqueDays = new Set(
    trades.map(t => new Date(t.timestamp * 1000).toISOString().slice(0, 10)),
  );
  const activeDays = uniqueDays.size;

  // Trade frequency: trades per day over the active period
  const timestamps = trades.map(t => t.timestamp);
  const firstTrade = Math.min(...timestamps);
  const lastTrade = Math.max(...timestamps);
  const daySpan = Math.max(1, (lastTrade - firstTrade) / 86400);
  const tradeFrequency = totalTrades / daySpan;

  // Average hold duration: estimate from first buy to close for each market
  const avgHoldDuration = estimateAvgHoldDuration(trades, closedPositions);

  return { totalTrades, totalMarkets, avgPositionSize, avgHoldDuration, tradeFrequency, activeDays };
}

function estimateAvgHoldDuration(
  trades: TradeInput[],
  closedPositions: ClosedPositionInput[],
): number | null {
  if (closedPositions.length === 0) return null;

  // Build a map of earliest trade per conditionId
  const firstTradeByMarket = new Map<string, number>();
  for (const t of trades) {
    const existing = firstTradeByMarket.get(t.conditionId);
    if (existing === undefined || t.timestamp < existing) {
      firstTradeByMarket.set(t.conditionId, t.timestamp);
    }
  }

  // Calculate hold duration for closed positions that have a matching first trade
  const durations: number[] = [];
  for (const cp of closedPositions) {
    const firstTradeTs = firstTradeByMarket.get(cp.conditionId);
    if (firstTradeTs !== undefined && cp.timestamp > firstTradeTs) {
      durations.push(cp.timestamp - firstTradeTs);
    }
  }

  if (durations.length === 0) return null;

  // Return average in hours
  const avgSeconds = durations.reduce((s, d) => s + d, 0) / durations.length;
  return avgSeconds / 3600;
}
