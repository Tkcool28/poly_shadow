export interface RiskMetrics {
  avgRelativePositionSize: number;
  concentrationScore: number; // HHI index (0-1, lower = more diversified)
}

interface TradeInput {
  conditionId: string;
  size: number;
  price: number;
}

export function computeRisk(trades: TradeInput[]): RiskMetrics {
  if (trades.length === 0) {
    return { avgRelativePositionSize: 0, concentrationScore: 0 };
  }

  // Calculate USD value per trade
  const tradeValues = trades.map(t => t.size * t.price);
  const totalValue = tradeValues.reduce((s, v) => s + v, 0);

  // Average relative position size (each trade's share of total volume)
  const avgRelativePositionSize = totalValue > 0
    ? tradeValues.reduce((s, v) => s + v / totalValue, 0) / tradeValues.length
    : 0;

  // Concentration: HHI by market (conditionId)
  // Sum up total value per market, then compute HHI
  const valueByMarket = new Map<string, number>();
  for (const t of trades) {
    const val = t.size * t.price;
    valueByMarket.set(t.conditionId, (valueByMarket.get(t.conditionId) ?? 0) + val);
  }

  let hhi = 0;
  if (totalValue > 0) {
    for (const marketValue of valueByMarket.values()) {
      const share = marketValue / totalValue;
      hhi += share * share;
    }
  }

  return {
    avgRelativePositionSize,
    concentrationScore: hhi,
  };
}
