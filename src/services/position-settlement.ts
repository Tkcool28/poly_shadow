import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getMarketsByConditionIds } from '../api/gamma-api';

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
    HAVING SUM(CASE WHEN side = 'BUY' THEN 1 ELSE 0 END) >
           SUM(CASE WHEN side = 'SELL' THEN 1 ELSE 0 END)
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

    // Calculate net shares and cost basis
    let netShares = 0;
    let totalBuyCost = 0;
    for (const fill of fills) {
      if (fill.side === 'BUY') {
        netShares += fill.filledSize ?? (fill.requestedAmount / (fill.filledPrice ?? 1));
        totalBuyCost += fill.requestedAmount;
      } else {
        netShares -= fill.filledSize ?? 0;
      }
    }
    netShares = Math.max(netShares, 0);

    if (netShares <= 0) continue;

    const settlementValue = netShares * settlementPrice;
    const pnl = settlementValue - totalBuyCost;

    // Apply settlement in transaction
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: pos.followAllocationId },
      });

      await tx.followAllocation.update({
        where: { id: pos.followAllocationId },
        data: {
          currentCapital: { increment: settlementValue },
          deployedCapital: { decrement: Math.min(totalBuyCost, fresh.deployedCapital) },
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

    log.info(`SETTLEMENT: ${pos.tokenId.slice(0, 20)}...`, {
      settlementPrice,
      netShares: netShares.toFixed(4),
      settlementValue: settlementValue.toFixed(2),
      pnl: pnl.toFixed(2),
      followAllocationId: pos.followAllocationId,
      isPaper: pos.isPaper,
    });
  }

  log.info('Settlement sweep complete', {
    marketsChecked: uniqueConditionIds.length,
    marketsResolved: resolvedMarkets.size,
    positionsSettled: settledCount,
    tradesSettled: totalPositionsSettled,
  });
}
