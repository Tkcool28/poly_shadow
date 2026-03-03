import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getMarketsByConditionIds } from '../api/gamma-api';
import { redeemWinningPositions, type ClaimablePosition } from './position-claim';

const log = createJobLogger('position-settlement');

interface OpenPosition {
  tokenId: string;
  followAllocationId: string;
  isPaper: boolean;
}

export async function sweepPositionSettlements(): Promise<void> {
  // Step 1: Find all open positions (tokens with net BUY > SELL, status FILLED)
  const openPositions = await prisma.$queryRaw<OpenPosition[]>`
    SELECT "tokenId", "followAllocationId", "isPaper"
    FROM "CopyTrade"
    WHERE status = 'FILLED' AND "followAllocationId" IS NOT NULL
    GROUP BY "tokenId", "followAllocationId", "isPaper"
    HAVING SUM(CASE WHEN side = 'BUY'
               THEN COALESCE("filledSize", "requestedAmount" / NULLIF("filledPrice", 0))
               ELSE 0 END) >
           SUM(CASE WHEN side = 'SELL'
               THEN COALESCE("filledSize", 0)
               ELSE 0 END)
  `;

  if (openPositions.length === 0) {
    log.debug('Settlement sweep: no open positions');
    return;
  }

  // Step 2: Map tokenId → conditionId + outcome via DetectedTrade
  const uniqueTokenIds = [...new Set(openPositions.map(p => p.tokenId))];
  const tokenMeta = new Map<string, { conditionId: string; outcome: string }>();

  const detectedTrades = await prisma.detectedTrade.findMany({
    where: { asset: { in: uniqueTokenIds } },
    select: { asset: true, conditionId: true, outcome: true },
    distinct: ['asset'],
  });

  for (const dt of detectedTrades) {
    tokenMeta.set(dt.asset, { conditionId: dt.conditionId, outcome: dt.outcome });
  }

  // Step 3: Refresh market data from Gamma API and check resolution
  const uniqueConditionIds = [...new Set([...tokenMeta.values()].map(m => m.conditionId))];

  if (uniqueConditionIds.length === 0) {
    log.debug('Settlement sweep: no condition IDs to check');
    return;
  }

  const freshMarkets = await getMarketsByConditionIds(uniqueConditionIds);

  // Update cache (batched)
  if (freshMarkets.length > 0) {
    await prisma.$transaction(
      freshMarkets.map((market) =>
        prisma.market.updateMany({
          where: { conditionId: market.conditionId },
          data: {
            closed: market.closed,
            active: market.active,
            outcomePrices: market.outcomePrices ?? null,
          },
        })
      )
    );
  }

  // Build resolved market map: conditionId → market data
  const resolvedMarkets = new Map<string, { outcomes: string; outcomePrices: string }>();
  for (const market of freshMarkets) {
    if (market.closed && market.outcomePrices) {
      resolvedMarkets.set(market.conditionId, {
        outcomes: market.outcomes ?? '[]',
        outcomePrices: market.outcomePrices,
      });
    }
  }

  if (resolvedMarkets.size === 0) {
    log.debug(`Settlement sweep: checked ${uniqueConditionIds.length} markets, none resolved`);
    return;
  }

  // Step 4-5: Settle resolved positions
  let settledCount = 0;
  let totalPositionsSettled = 0;
  const claimablePositions: ClaimablePosition[] = [];

  for (const pos of openPositions) {
    const meta = tokenMeta.get(pos.tokenId);
    if (!meta) continue;

    const marketData = resolvedMarkets.get(meta.conditionId);
    if (!marketData) continue;

    // Determine settlement price
    let outcomePrices: number[];
    let outcomes: string[];
    try {
      outcomePrices = JSON.parse(marketData.outcomePrices).map(Number);
      outcomes = JSON.parse(marketData.outcomes);
    } catch {
      log.warn('Settlement: failed to parse market data', { conditionId: meta.conditionId });
      continue;
    }

    const normalizedOutcome = meta.outcome.trim().toLowerCase();
    const outcomeIndex = outcomes.findIndex(o => o.trim().toLowerCase() === normalizedOutcome);
    if (outcomeIndex < 0 || outcomeIndex >= outcomePrices.length) {
      log.warn('Settlement: outcome not found in market', {
        outcome: meta.outcome,
        outcomes,
        tokenId: pos.tokenId,
      });
      continue;
    }

    const settlementPrice = outcomePrices[outcomeIndex];
    if (!Number.isFinite(settlementPrice)) continue;

    // Get all FILLED CopyTrades for this position
    const fills = await prisma.copyTrade.findMany({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        status: 'FILLED',
      },
      select: { id: true, side: true, filledSize: true, requestedAmount: true, filledPrice: true },
    });

    // Calculate net shares and cost basis (average cost method — matches unrealized-pnl.ts)
    let totalBuyShares = 0;
    let totalBuyCost = 0;
    let totalSellShares = 0;
    for (const fill of fills) {
      if (fill.side === 'BUY') {
        totalBuyShares += fill.filledSize ?? (fill.requestedAmount / (fill.filledPrice ?? 1));
        // Prefer actual fill value over requested amount (accounts for slippage)
        totalBuyCost += (fill.filledSize != null && fill.filledPrice != null)
          ? fill.filledSize * fill.filledPrice
          : fill.requestedAmount;
      } else {
        totalSellShares += fill.filledSize ?? 0;
      }
    }
    const netShares = Math.max(totalBuyShares - totalSellShares, 0);

    if (netShares <= 0 || totalBuyShares <= 0) continue;

    // Guard: defer settlement if a recent SELL is in-flight — prevents double-credit
    // with pre-resolution seller. 120s recency window ensures stale PENDING SELLs
    // from prior crashes (handled by reconcileStalePending at startup) don't block
    // settlement permanently.
    const pendingSell = await prisma.copyTrade.findFirst({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        side: 'SELL',
        status: 'PENDING',
        createdAt: { gte: new Date(Date.now() - 120_000) },
      },
      select: { id: true },
    });
    if (pendingSell) {
      log.debug('Settlement: deferring — recent SELL in-flight', {
        tokenId: pos.tokenId.slice(0, 20),
        pendingSellId: pendingSell.id,
      });
      continue;
    }

    const avgCostPerShare = totalBuyCost / totalBuyShares;
    const remainingCostBasis = avgCostPerShare * netShares;
    const settlementValue = netShares * settlementPrice;
    const pnl = settlementValue - remainingCostBasis;

    // Apply settlement in transaction
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: pos.followAllocationId },
      });

      await tx.followAllocation.update({
        where: { id: pos.followAllocationId },
        data: {
          currentCapital: { increment: settlementValue },
          deployedCapital: { decrement: Math.min(remainingCostBasis, fresh.deployedCapital) },
        },
      });

      await tx.copyTrade.updateMany({
        where: {
          tokenId: pos.tokenId,
          followAllocationId: pos.followAllocationId,
          isPaper: pos.isPaper,
          status: 'FILLED',
        },
        data: {
          status: 'SETTLED',
          failReason: `market resolved: price=${settlementPrice.toFixed(4)}, value=$${settlementValue.toFixed(2)}, pnl=${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
        },
      });
    });

    settledCount++;
    totalPositionsSettled += fills.length;

    // Collect for on-chain claiming after all DB work is done
    if (!pos.isPaper && settlementPrice === 1.0) {
      claimablePositions.push({
        conditionId: meta.conditionId,
        outcomeIndex,
        netShares,
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
      });
    }

    log.info(`SETTLEMENT: ${pos.tokenId.slice(0, 20)}...`, {
      settlementPrice,
      netShares: netShares.toFixed(4),
      settlementValue: settlementValue.toFixed(2),
      pnl: pnl.toFixed(2),
      followAllocationId: pos.followAllocationId,
      isPaper: pos.isPaper,
    });
  }

  // Trigger on-chain redemption for winning positions (non-blocking on failure)
  await redeemWinningPositions(claimablePositions).catch((err: any) =>
    log.warn('Auto-claim batch failed', { error: err.message }),
  );

  log.info('Settlement sweep complete', {
    marketsChecked: uniqueConditionIds.length,
    marketsResolved: resolvedMarkets.size,
    positionsSettled: settledCount,
    tradesSettled: totalPositionsSettled,
  });
}
