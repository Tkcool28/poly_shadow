/**
 * Shared cost-basis computation for SELL trades.
 *
 * Uses average cost method: avgCostPerShare = totalBuyCost / totalBuyShares
 * Cost basis of sold shares = avgCostPerShare * soldShares
 *
 * This matches the settlement path in position-settlement.ts:183-186.
 */

export interface FillRecord {
  side: string;
  filledSize: number | null;
  filledPrice: number | null;
  requestedAmount: number;
}

export interface CostBasisResult {
  totalBuyShares: number;
  totalBuyCost: number;
  totalSellShares: number;
  netShares: number;
  avgCostPerShare: number;
  costBasisOfSoldShares: number;
}

/** Estimate share count from a fill, guarding against zero/null price → Infinity. */
function estimateShares(fill: FillRecord): number {
  if (fill.filledSize != null) return fill.filledSize;
  if (fill.filledPrice && fill.filledPrice > 0) return fill.requestedAmount / fill.filledPrice;
  return fill.requestedAmount; // no price info: treat requestedAmount as 1:1 share estimate
}

/**
 * Compute the cost basis of shares being sold, using the average cost method.
 *
 * @param fills - All FILLED trades for this token+allocation (excluding the current SELL being processed)
 * @param soldShares - Number of shares being sold in the current trade
 */
export function computeSellCostBasis(fills: FillRecord[], soldShares: number): CostBasisResult {
  let totalBuyShares = 0;
  let totalBuyCost = 0;
  let totalSellShares = 0;

  for (const fill of fills) {
    if (fill.side === 'BUY') {
      totalBuyShares += estimateShares(fill);
      totalBuyCost += (fill.filledSize != null && fill.filledPrice != null)
        ? fill.filledSize * fill.filledPrice
        : fill.requestedAmount;
    } else {
      totalSellShares += fill.filledSize ?? 0;
    }
  }

  const netShares = Math.max(totalBuyShares - totalSellShares, 0);
  const avgCostPerShare = totalBuyShares > 0 ? totalBuyCost / totalBuyShares : 0;

  // Cap soldShares to netShares to prevent over-release (floating-point drift safety)
  const effectiveSoldShares = Math.min(soldShares, netShares);
  const costBasisOfSoldShares = avgCostPerShare * effectiveSoldShares;

  return {
    totalBuyShares,
    totalBuyCost,
    totalSellShares,
    netShares,
    avgCostPerShare,
    costBasisOfSoldShares,
  };
}
