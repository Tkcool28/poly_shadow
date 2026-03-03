import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { getMarketsByConditionIds } from '../api/gamma-api';
import { executeMarketOrder } from './trade-executor';
import { executeMarketOrder as paperExecute } from './paper-executor';

const log = createJobLogger('pre-resolution-seller');

export async function sweepPreResolutionSells(): Promise<void> {
  if (!config.PRE_RESOLUTION_SELL_ENABLED) return;

  // Find open positions (same query as settlement)
  const openPositions = await prisma.$queryRaw<{
    tokenId: string; followAllocationId: string; isPaper: boolean;
  }[]>`
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

  if (openPositions.length === 0) return;

  // Get condition IDs for these positions
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

  const uniqueConditionIds = [...new Set([...tokenMeta.values()].map(m => m.conditionId))];
  if (uniqueConditionIds.length === 0) return;

  // Get market end dates from Gamma
  const markets = await getMarketsByConditionIds(uniqueConditionIds);
  const nearEndMarkets = new Map<string, { endDate: Date }>();
  const now = Date.now();

  for (const market of markets) {
    if (market.closed) continue; // Already closed — settlement handles these
    if (!market.endDate) continue;
    const endDate = new Date(market.endDate);
    const timeToEnd = endDate.getTime() - now;
    if (timeToEnd > 0 && timeToEnd <= config.PRE_RESOLUTION_SELL_WINDOW_MS) {
      nearEndMarkets.set(market.conditionId, { endDate });
    }
  }

  if (nearEndMarkets.size === 0) return;

  log.info(`Pre-resolution scan: ${nearEndMarkets.size} markets approaching resolution`);

  // Sell positions in markets nearing resolution
  let soldCount = 0;
  for (const pos of openPositions) {
    const meta = tokenMeta.get(pos.tokenId);
    if (!meta) continue;
    if (!nearEndMarkets.has(meta.conditionId)) continue;

    // Calculate held shares
    const fills = await prisma.copyTrade.findMany({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        status: 'FILLED',
      },
      select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
      orderBy: { filledAt: 'asc' },
    });

    let netShares = 0;
    let lastPrice = 0;
    for (const fill of fills) {
      if (fill.side === 'BUY') {
        netShares += fill.filledSize ?? (fill.requestedAmount / (fill.filledPrice ?? 1));
        lastPrice = fill.filledPrice ?? lastPrice;
      } else {
        netShares -= fill.filledSize ?? 0;
      }
    }
    netShares = Math.max(netShares, 0);

    if (netShares <= 0 || lastPrice <= 0) continue;

    const estimatedUsd = netShares * lastPrice;
    if (estimatedUsd < 0.01) continue;

    // Execute sell
    const executeFn = pos.isPaper ? paperExecute : executeMarketOrder;

    // Create PENDING record (synthetic detectedTradeId — no real DetectedTrade)
    const copyTrade = await prisma.copyTrade.create({
      data: {
        detectedTradeId: `pre-resolution-${pos.tokenId}-${pos.followAllocationId}-${Date.now()}`,
        tokenId: pos.tokenId,
        side: 'SELL',
        requestedAmount: estimatedUsd,
        requestedPrice: lastPrice,
        status: 'PENDING',
        isPaper: pos.isPaper,
        followAllocationId: pos.followAllocationId,
      },
    });

    try {
      const result = await executeFn({
        tokenId: pos.tokenId,
        side: 'SELL',
        amount: netShares,
        detectedPrice: lastPrice,
      });

      const usdValue = (result.filledSize && result.filledPrice)
        ? result.filledSize * result.filledPrice
        : estimatedUsd;

      await prisma.$transaction(async (tx) => {
        await tx.copyTrade.update({
          where: { id: copyTrade.id },
          data: {
            orderId: result.orderId,
            status: result.status,
            filledPrice: result.filledPrice,
            filledSize: result.filledSize,
            failReason: result.failReason
              ? `pre-resolution: ${result.failReason}`
              : 'pre-resolution auto-sell',
            latencyMs: Date.now() - copyTrade.createdAt.getTime(),
            filledAt: result.status === 'FILLED' ? new Date() : null,
          },
        });

        if (result.status === 'FILLED') {
          const fresh = await tx.followAllocation.findUniqueOrThrow({
            where: { id: pos.followAllocationId },
          });
          await tx.followAllocation.update({
            where: { id: pos.followAllocationId },
            data: {
              currentCapital: { increment: usdValue },
              deployedCapital: { decrement: Math.min(usdValue, fresh.deployedCapital) },
            },
          });
        }
      });

      if (result.status === 'FILLED') {
        soldCount++;
        log.info('PRE-RESOLUTION SELL', {
          tokenId: pos.tokenId.slice(0, 20) + '...',
          shares: netShares.toFixed(4),
          usdValue: usdValue.toFixed(2),
          isPaper: pos.isPaper,
        });
      }
    } catch (err: any) {
      await prisma.copyTrade.update({
        where: { id: copyTrade.id },
        data: {
          status: 'FAILED',
          failReason: `pre-resolution sell failed: ${err.message?.slice(0, 300)}`,
        },
      });
      log.warn('Pre-resolution sell failed', {
        tokenId: pos.tokenId.slice(0, 20),
        error: err.message,
      });
    }
  }

  if (soldCount > 0) {
    log.info(`Pre-resolution sweep: ${soldCount} positions sold`);
  }
}
