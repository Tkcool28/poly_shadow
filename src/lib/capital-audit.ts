import { prisma } from './prisma';
import { createJobLogger } from './logger';

const log = createJobLogger('capital-audit');

export interface AllocationAudit {
  id: string;
  proxyWallet: string;
  isPaper: boolean;
  initialCapital: number;
  // Actual DB values
  actualCC: number;
  actualDC: number;
  // Computed values
  computedCC: number;
  computedDC: number;
  // Deltas
  deltaCC: number;
  deltaDC: number;
}

/**
 * Audit a single allocation by replaying trade history to compute expected capital.
 *
 * Capital flow:
 *   BUY fill:    cc -= min(cost, cc);  dc += min(cost, cc)
 *   SELL fill:   cc += proceeds;       dc -= min(proceeds, dc)
 *   Settlement:  cc += settlementValue; dc -= min(costBasis, dc)
 */
export async function auditAllocation(allocationId: string): Promise<AllocationAudit> {
  const allocation = await prisma.followAllocation.findUniqueOrThrow({
    where: { id: allocationId },
  });

  // Get all trades ordered chronologically
  const trades = await prisma.copyTrade.findMany({
    where: {
      followAllocationId: allocationId,
      status: { in: ['FILLED', 'SETTLED'] },
    },
    select: {
      id: true,
      side: true,
      status: true,
      requestedAmount: true,
      filledSize: true,
      filledPrice: true,
      settlementValue: true,
      settlementPnl: true,
      failReason: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  let cc = allocation.initialCapital;
  let dc = 0;

  for (const trade of trades) {
    const cost = (trade.filledSize != null && trade.filledPrice != null)
      ? trade.filledSize * trade.filledPrice
      : trade.requestedAmount;

    if (trade.side === 'BUY') {
      // BUY: deduct from available capital (capped to prevent negative)
      const deducted = Math.min(cost, Math.max(cc, 0));
      cc -= deducted;
      dc += deducted;
    } else {
      // SELL: return proceeds
      cc += cost;
      dc -= Math.min(cost, dc);
    }

    // Settlement: credit settlement value, release deployed capital
    if (trade.status === 'SETTLED' && trade.side === 'BUY') {
      let settleValue = trade.settlementValue;

      // Fallback: parse from failReason if new fields not populated
      if (settleValue == null && trade.failReason) {
        const match = trade.failReason.match(/value=\$([\d.]+)/);
        if (match) settleValue = parseFloat(match[1]);
      }

      if (settleValue != null && Number.isFinite(settleValue)) {
        cc += settleValue;
        // Release the cost basis from deployed (capped)
        dc -= Math.min(cost, dc);
      } else {
        log.warn('Settlement value missing for SETTLED BUY trade', {
          tradeId: trade.id, allocationId,
          hasSettlementValue: trade.settlementValue != null,
          hasFailReason: trade.failReason != null,
        });
      }
    }
  }

  // Also account for POOLED trades (capital reserved but not yet executed)
  const pooledSum = await prisma.copyTrade.aggregate({
    where: { followAllocationId: allocationId, side: 'BUY', status: 'POOLED' },
    _sum: { requestedAmount: true },
  });
  const pooled = pooledSum._sum.requestedAmount ?? 0;
  dc += pooled;

  // Compute deployed from aggregates (cross-check)
  const [filledBuySum, filledSellSum] = await Promise.all([
    prisma.copyTrade.aggregate({
      where: { followAllocationId: allocationId, side: 'BUY', status: 'FILLED' },
      _sum: { requestedAmount: true },
    }),
    prisma.copyTrade.aggregate({
      where: { followAllocationId: allocationId, side: 'SELL', status: 'FILLED' },
      _sum: { requestedAmount: true },
    }),
  ]);
  const aggregateDC = Math.max(
    (filledBuySum._sum.requestedAmount ?? 0) - (filledSellSum._sum.requestedAmount ?? 0) + pooled,
    0,
  );

  return {
    id: allocation.id,
    proxyWallet: allocation.proxyWallet,
    isPaper: allocation.isPaper,
    initialCapital: allocation.initialCapital,
    actualCC: allocation.currentCapital,
    actualDC: allocation.deployedCapital,
    computedCC: cc,
    computedDC: aggregateDC, // use aggregate for deployed (more reliable)
    deltaCC: Math.abs(cc - allocation.currentCapital),
    deltaDC: Math.abs(aggregateDC - allocation.deployedCapital),
  };
}

/**
 * Audit all live (non-paper) allocations. Returns array of audits with discrepancies.
 */
export async function auditAllAllocations(options?: {
  isPaper?: boolean;
  threshold?: number;
}): Promise<AllocationAudit[]> {
  const threshold = options?.threshold ?? 1.0; // $1 tolerance
  const allocations = await prisma.followAllocation.findMany({
    where: options?.isPaper != null ? { isPaper: options.isPaper } : {},
    select: { id: true },
  });

  const results: AllocationAudit[] = [];
  for (const alloc of allocations) {
    try {
      const audit = await auditAllocation(alloc.id);
      results.push(audit);
    } catch (err: any) {
      log.warn(`Audit failed for allocation ${alloc.id}`, { error: err.message });
    }
  }

  const discrepancies = results.filter(r => r.deltaCC > threshold || r.deltaDC > threshold);
  if (discrepancies.length > 0) {
    log.warn(`Capital audit: ${discrepancies.length}/${results.length} allocations have discrepancies > $${threshold}`, {
      discrepancies: discrepancies.map(d => ({
        wallet: d.proxyWallet.slice(0, 10),
        deltaCC: d.deltaCC.toFixed(2),
        deltaDC: d.deltaDC.toFixed(2),
      })),
    });
  } else {
    log.info(`Capital audit: ${results.length} allocations checked, all within $${threshold} tolerance`);
  }

  return results;
}
