import Decimal from 'decimal.js';

export interface ProfitabilityMetrics {
  totalPnl: number;
  realizedPnl: number;
  unrealizedPnl: number;
  roi: number;
  avgProfitPerTrade: number;
}

interface ClosedPositionInput {
  realizedPnl: number;
  totalBought: number;
}

interface PositionInput {
  cashPnl: number | null;
  initialValue: number | null;
}

export function computeProfitability(
  closedPositions: ClosedPositionInput[],
  openPositions: PositionInput[],
): ProfitabilityMetrics {
  // Realized P&L from closed positions
  const realizedPnl = closedPositions.reduce(
    (sum, cp) => sum.plus(cp.realizedPnl),
    new Decimal(0),
  );

  // Total capital invested (sum of totalBought across closed positions)
  const totalInvested = closedPositions.reduce(
    (sum, cp) => sum.plus(cp.totalBought),
    new Decimal(0),
  );

  // Unrealized P&L from open positions
  const unrealizedPnl = openPositions.reduce(
    (sum, p) => sum.plus(p.cashPnl ?? 0),
    new Decimal(0),
  );

  // Capital in open positions
  const openCapital = openPositions.reduce(
    (sum, p) => sum.plus(p.initialValue ?? 0),
    new Decimal(0),
  );

  const totalPnl = realizedPnl.plus(unrealizedPnl);
  const totalCapital = totalInvested.plus(openCapital);

  // ROI = total P&L / total capital invested
  const roi = totalCapital.isZero()
    ? 0
    : totalPnl.div(totalCapital).toNumber();

  // Average profit per closed position
  const avgProfitPerTrade = closedPositions.length === 0
    ? 0
    : realizedPnl.div(closedPositions.length).toNumber();

  return {
    totalPnl: totalPnl.toNumber(),
    realizedPnl: realizedPnl.toNumber(),
    unrealizedPnl: unrealizedPnl.toNumber(),
    roi,
    avgProfitPerTrade,
  };
}
