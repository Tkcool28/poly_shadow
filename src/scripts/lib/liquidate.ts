/**
 * Shared liquidation logic used by liquidate-all.ts and liquidate-allocation.ts.
 */
import { prisma } from '../../lib/prisma';
import { initialize as initTradeExecutor, executeMarketOrder } from '../../services/trade-executor';
import { computeSellCostBasis } from '../../lib/cost-basis';
import * as readline from 'readline';

export interface OpenPosition {
  tokenId: string;
  followAllocationId: string;
  proxyWallet: string;
  isPaper: boolean;
  netShares: number;
  lastPrice: number;
  conditionId: string;
  outcome: string;
  title: string | null;
}

/**
 * Scan an allocation for net-positive token positions.
 */
export async function scanPositions(allocationId: string, isPaper: boolean, proxyWallet: string): Promise<OpenPosition[]> {
  const openTokens = await prisma.$queryRaw<{ tokenId: string }[]>`
    SELECT "tokenId"
    FROM "CopyTrade"
    WHERE status = 'FILLED'
      AND "followAllocationId" = ${allocationId}
      AND "isPaper" = ${isPaper}
    GROUP BY "tokenId"
    HAVING SUM(CASE WHEN side = 'BUY'
               THEN COALESCE("filledSize", "requestedAmount" / NULLIF("filledPrice", 0))
               ELSE 0 END) >
           SUM(CASE WHEN side = 'SELL'
               THEN COALESCE("filledSize", 0)
               ELSE 0 END) + 0.001
  `;

  const positions: OpenPosition[] = [];

  for (const tok of openTokens) {
    const fills = await prisma.copyTrade.findMany({
      where: {
        tokenId: tok.tokenId,
        followAllocationId: allocationId,
        isPaper,
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
    if (netShares < 0.01 || lastPrice <= 0) continue;

    const dt = await prisma.detectedTrade.findFirst({
      where: { asset: tok.tokenId },
      select: { conditionId: true, outcome: true, title: true },
    });
    if (!dt) {
      console.log(`  SKIP ${tok.tokenId.slice(0, 20)}...: no DetectedTrade found`);
      continue;
    }

    positions.push({
      tokenId: tok.tokenId,
      followAllocationId: allocationId,
      proxyWallet,
      isPaper,
      netShares,
      lastPrice,
      conditionId: dt.conditionId,
      outcome: dt.outcome,
      title: dt.title,
    });
  }

  return positions;
}

/**
 * Print a summary table of positions to sell and return estimated total USD.
 */
export function printPositionSummary(positions: OpenPosition[]): number {
  let totalEstUsd = 0;
  for (const p of positions) {
    const estUsd = p.netShares * p.lastPrice;
    totalEstUsd += estUsd;
    console.log(`  ${p.title || p.tokenId.slice(0, 30) + '...'}`);
    console.log(`    ${p.netShares.toFixed(4)} shares @ ~$${p.lastPrice.toFixed(4)} = ~$${estUsd.toFixed(2)} | ${p.outcome}`);
  }
  return totalEstUsd;
}

/**
 * Prompt the user for confirmation. Returns true if they confirm.
 */
export function confirm(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(`${message} [y/N] `, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/**
 * Execute SELL orders for all given positions via the CLOB.
 * Returns { soldCount, failCount, expiredCount, totalProceeds }.
 */
export async function executeLiquidation(positions: OpenPosition[]): Promise<{
  soldCount: number;
  failCount: number;
  expiredCount: number;
  totalProceeds: number;
}> {
  console.log('Initializing CLOB client...');
  await initTradeExecutor();
  console.log('CLOB client ready.\n');

  let soldCount = 0;
  let totalProceeds = 0;
  let failCount = 0;
  let expiredCount = 0;

  for (const pos of positions) {
    const label = `${pos.title || pos.tokenId.slice(0, 20)}`;
    console.log(`Selling ${pos.netShares.toFixed(4)} shares — ${label}...`);

    // Create synthetic DetectedTrade for FK constraint
    const syntheticTxHash = `liquidate-${pos.tokenId.slice(0, 16)}-${pos.followAllocationId.slice(-6)}-${Date.now()}`;
    let syntheticDetected;
    try {
      syntheticDetected = await prisma.detectedTrade.create({
        data: {
          proxyWallet: pos.proxyWallet,
          side: 'SELL',
          conditionId: pos.conditionId,
          asset: pos.tokenId,
          size: pos.netShares,
          price: pos.lastPrice,
          outcome: pos.outcome,
          transactionHash: syntheticTxHash,
          timestamp: Math.floor(Date.now() / 1000),
          detectionSource: 'LIQUIDATION',
        },
      });
    } catch (err: any) {
      console.error(`  Failed to create DetectedTrade: ${err.message}`);
      failCount++;
      continue;
    }

    const copyTrade = await prisma.copyTrade.create({
      data: {
        detectedTradeId: syntheticDetected.id,
        tokenId: pos.tokenId,
        side: 'SELL',
        requestedAmount: pos.netShares * pos.lastPrice,
        requestedPrice: pos.lastPrice,
        status: 'PENDING',
        isPaper: pos.isPaper,
        followAllocationId: pos.followAllocationId,
      },
    });

    try {
      const result = await executeMarketOrder({
        tokenId: pos.tokenId,
        side: 'SELL',
        amount: pos.netShares,
        detectedPrice: pos.lastPrice,
      });

      const usdValue = (result.filledSize && result.filledPrice)
        ? result.filledSize * result.filledPrice
        : pos.netShares * pos.lastPrice;

      // W2 fix: only set failReason when the trade did NOT fill
      const isExpired = result.status === 'SKIPPED'
        && result.failReason?.includes('orderbook does not exist');

      await prisma.$transaction(async (tx) => {
        await tx.copyTrade.update({
          where: { id: copyTrade.id },
          data: {
            orderId: result.orderId,
            status: result.status,
            filledPrice: result.filledPrice,
            filledSize: result.filledSize,
            failReason: result.status === 'FILLED' ? null : (result.failReason ?? null),
            latencyMs: Date.now() - copyTrade.createdAt.getTime(),
            filledAt: result.status === 'FILLED' ? new Date() : null,
          },
        });

        if (result.status === 'FILLED') {
          const fresh = await tx.followAllocation.findUniqueOrThrow({
            where: { id: pos.followAllocationId },
          });
          const costBasisFills = await tx.copyTrade.findMany({
            where: {
              tokenId: pos.tokenId,
              followAllocationId: pos.followAllocationId,
              isPaper: pos.isPaper,
              status: 'FILLED',
              id: { not: copyTrade.id },
            },
            select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
          });
          const costBasis = computeSellCostBasis(costBasisFills, result.filledSize ?? pos.netShares);

          await tx.followAllocation.update({
            where: { id: pos.followAllocationId },
            data: {
              currentCapital: { increment: usdValue },
              deployedCapital: { decrement: Math.min(costBasis.costBasisOfSoldShares, fresh.deployedCapital) },
            },
          });
        }
      });

      if (result.status === 'FILLED') {
        soldCount++;
        totalProceeds += usdValue;
        console.log(`  FILLED: ${result.filledSize?.toFixed(4)} shares @ $${result.filledPrice?.toFixed(4)} = $${usdValue.toFixed(2)}`);
      } else if (isExpired) {
        // S3 fix: expired/resolved markets are expected, not failures
        expiredCount++;
        console.log(`  EXPIRED: market resolved/closed — shares will auto-settle`);
      } else {
        failCount++;
        console.log(`  ${result.status}: ${result.failReason}`);
      }
    } catch (err: any) {
      failCount++;
      await prisma.copyTrade.update({
        where: { id: copyTrade.id },
        data: {
          status: 'FAILED',
          failReason: `liquidation failed: ${err.message?.slice(0, 300)}`,
        },
      });
      console.error(`  FAILED: ${err.message}`);
    }

    // Rate-limit delay between orders
    await new Promise(r => setTimeout(r, 500));
  }

  return { soldCount, failCount, expiredCount, totalProceeds };
}
