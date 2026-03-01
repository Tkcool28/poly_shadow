import { prisma } from '../lib/prisma';
import {
  getAllTrades,
  getAllClosedPositions,
  getPositions,
} from '../api/data-api';
import { resolveMarkets } from './market-resolver';
import { logger } from '../lib/logger';
import {
  MAX_BACKFILL_RETRIES,
  BACKFILL_LOCK_TIMEOUT_MS,
  POSITIONS_PAGE_SIZE,
} from '../config/constants';

/**
 * Atomically claim a trader for backfill using lock-based concurrency.
 * Returns traders that are PENDING/FAILED and not locked by another process.
 */
export async function claimTradersForBackfill(batchSize: number): Promise<string[]> {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - BACKFILL_LOCK_TIMEOUT_MS);

  // Find unlocked traders that need backfill
  const traders = await prisma.trader.findMany({
    where: {
      backfillStatus: { in: ['PENDING', 'FAILED'] },
      backfillRetries: { lt: MAX_BACKFILL_RETRIES },
      OR: [
        { backfillLockedAt: null },
        { backfillLockedAt: { lt: lockExpiry } }, // stale lock recovery
      ],
    },
    select: { proxyWallet: true },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  });

  const wallets: string[] = [];

  // Atomically lock each trader
  for (const trader of traders) {
    const result = await prisma.trader.updateMany({
      where: {
        proxyWallet: trader.proxyWallet,
        OR: [
          { backfillLockedAt: null },
          { backfillLockedAt: { lt: lockExpiry } },
        ],
      },
      data: {
        backfillLockedAt: now,
        backfillStatus: 'IN_PROGRESS',
        backfillStarted: now,
      },
    });

    if (result.count > 0) {
      wallets.push(trader.proxyWallet);
    }
  }

  return wallets;
}

// Chunk sizes for batched DB writes
const TRADE_BATCH_CHUNK = 500;
const UPSERT_BATCH_CHUNK = 200;

/**
 * Backfill full trading history for a single wallet.
 */
export async function backfillTrader(proxyWallet: string): Promise<void> {
  const log = logger.child({ job: 'backfiller', wallet: proxyWallet.slice(0, 10) });

  try {
    log.info('Starting backfill');

    // 1-4. Fetch all data in parallel (different rate limiter pools)
    log.info('Fetching trades, positions, and closed positions in parallel...');

    const [tradesRes, closedRes, positionsRes] = await Promise.allSettled([
      getAllTrades(proxyWallet),
      getAllClosedPositions(proxyWallet),
      getPositions({ user: proxyWallet, limit: POSITIONS_PAGE_SIZE }),
    ]);

    // Trades, closed positions, positions are critical — re-throw on failure
    if (tradesRes.status === 'rejected') {
      throw tradesRes.reason;
    }
    const trades = tradesRes.value;

    if (closedRes.status === 'rejected') {
      throw closedRes.reason;
    }
    const closedPositions = closedRes.value;

    if (positionsRes.status === 'rejected') {
      throw positionsRes.reason;
    }
    const positions = positionsRes.value;

    log.info(`Fetched: ${trades.length} trades, ${closedPositions.length} closed, ${positions.length} open`);

    // 5. Resolve market metadata for all unique conditionIds
    const conditionIds = new Set<string>();
    trades.forEach((t) => conditionIds.add(t.conditionId));
    closedPositions.forEach((cp) => conditionIds.add(cp.conditionId));
    positions.forEach((p) => conditionIds.add(p.conditionId));
    await resolveMarkets([...conditionIds]);

    // 6. Store trades (batched upserts via $transaction)
    log.info('Storing trades...');
    let tradeCount = 0;
    for (let i = 0; i < trades.length; i += TRADE_BATCH_CHUNK) {
      const chunk = trades.slice(i, i + TRADE_BATCH_CHUNK);
      try {
        await prisma.$transaction(
          chunk.map((t) =>
            prisma.trade.upsert({
              where: {
                transactionHash_proxyWallet_asset_side_size_price: {
                  transactionHash: t.transactionHash,
                  proxyWallet: t.proxyWallet,
                  asset: t.asset,
                  side: t.side,
                  size: t.size,
                  price: t.price,
                },
              },
              create: {
                proxyWallet: t.proxyWallet,
                side: t.side,
                asset: t.asset,
                conditionId: t.conditionId,
                size: t.size,
                price: t.price,
                timestamp: t.timestamp,
                outcome: t.outcome,
                outcomeIndex: t.outcomeIndex,
                transactionHash: t.transactionHash,
                title: t.title ?? null,
                eventSlug: t.eventSlug ?? null,
                usdValue: t.size * t.price,
              },
              update: {},
            })
          )
        );
        tradeCount += chunk.length;
      } catch (err: any) {
        // Fallback: process individually on batch failure
        log.warn(`Trade batch failed, falling back to individual upserts: ${err.message}`);
        for (const t of chunk) {
          try {
            await prisma.trade.upsert({
              where: {
                transactionHash_proxyWallet_asset_side_size_price: {
                  transactionHash: t.transactionHash,
                  proxyWallet: t.proxyWallet,
                  asset: t.asset,
                  side: t.side,
                  size: t.size,
                  price: t.price,
                },
              },
              create: {
                proxyWallet: t.proxyWallet,
                side: t.side,
                asset: t.asset,
                conditionId: t.conditionId,
                size: t.size,
                price: t.price,
                timestamp: t.timestamp,
                outcome: t.outcome,
                outcomeIndex: t.outcomeIndex,
                transactionHash: t.transactionHash,
                title: t.title ?? null,
                eventSlug: t.eventSlug ?? null,
                usdValue: t.size * t.price,
              },
              update: {},
            });
            tradeCount++;
          } catch (innerErr: any) {
            if (!innerErr.message?.includes('Unique constraint')) {
              log.warn(`Failed to upsert trade: ${innerErr.message}`);
            }
          }
        }
      }
    }

    // 7. Store positions (batched upserts via $transaction)
    log.info('Storing positions...');
    for (let i = 0; i < positions.length; i += UPSERT_BATCH_CHUNK) {
      const chunk = positions.slice(i, i + UPSERT_BATCH_CHUNK);
      try {
        await prisma.$transaction(
          chunk.map((p) =>
            prisma.position.upsert({
              where: {
                proxyWallet_asset: {
                  proxyWallet: p.proxyWallet,
                  asset: p.asset,
                },
              },
              create: {
                proxyWallet: p.proxyWallet,
                asset: p.asset,
                conditionId: p.conditionId,
                size: p.size,
                avgPrice: p.avgPrice,
                initialValue: p.initialValue ?? null,
                currentValue: p.currentValue ?? null,
                cashPnl: p.cashPnl ?? null,
                percentPnl: p.percentPnl ?? null,
                realizedPnl: p.realizedPnl ?? null,
                curPrice: p.curPrice ?? null,
                outcome: p.outcome,
                outcomeIndex: p.outcomeIndex,
                title: p.title ?? null,
                eventSlug: p.eventSlug ?? null,
                endDate: p.endDate ? new Date(p.endDate) : null,
              },
              update: {
                conditionId: p.conditionId,
                size: p.size,
                avgPrice: p.avgPrice,
                initialValue: p.initialValue ?? null,
                currentValue: p.currentValue ?? null,
                cashPnl: p.cashPnl ?? null,
                percentPnl: p.percentPnl ?? null,
                realizedPnl: p.realizedPnl ?? null,
                curPrice: p.curPrice ?? null,
                outcome: p.outcome,
                outcomeIndex: p.outcomeIndex,
                title: p.title ?? null,
                eventSlug: p.eventSlug ?? null,
                endDate: p.endDate ? new Date(p.endDate) : null,
                snapshotAt: new Date(),
              },
            })
          )
        );
      } catch (err: any) {
        log.warn(`Position batch failed, falling back to individual upserts: ${err.message}`);
        for (const p of chunk) {
          try {
            await prisma.position.upsert({
              where: {
                proxyWallet_asset: {
                  proxyWallet: p.proxyWallet,
                  asset: p.asset,
                },
              },
              create: {
                proxyWallet: p.proxyWallet,
                asset: p.asset,
                conditionId: p.conditionId,
                size: p.size,
                avgPrice: p.avgPrice,
                initialValue: p.initialValue ?? null,
                currentValue: p.currentValue ?? null,
                cashPnl: p.cashPnl ?? null,
                percentPnl: p.percentPnl ?? null,
                realizedPnl: p.realizedPnl ?? null,
                curPrice: p.curPrice ?? null,
                outcome: p.outcome,
                outcomeIndex: p.outcomeIndex,
                title: p.title ?? null,
                eventSlug: p.eventSlug ?? null,
                endDate: p.endDate ? new Date(p.endDate) : null,
              },
              update: {
                conditionId: p.conditionId,
                size: p.size,
                avgPrice: p.avgPrice,
                initialValue: p.initialValue ?? null,
                currentValue: p.currentValue ?? null,
                cashPnl: p.cashPnl ?? null,
                percentPnl: p.percentPnl ?? null,
                realizedPnl: p.realizedPnl ?? null,
                curPrice: p.curPrice ?? null,
                outcome: p.outcome,
                outcomeIndex: p.outcomeIndex,
                title: p.title ?? null,
                eventSlug: p.eventSlug ?? null,
                endDate: p.endDate ? new Date(p.endDate) : null,
                snapshotAt: new Date(),
              },
            });
          } catch (innerErr: any) {
            log.warn(`Failed to upsert position: ${innerErr.message}`);
          }
        }
      }
    }

    // 8. Store closed positions (batched upserts via $transaction)
    log.info('Storing closed positions...');
    for (let i = 0; i < closedPositions.length; i += UPSERT_BATCH_CHUNK) {
      const chunk = closedPositions.slice(i, i + UPSERT_BATCH_CHUNK);
      try {
        await prisma.$transaction(
          chunk.map((cp) =>
            prisma.closedPosition.upsert({
              where: {
                proxyWallet_asset_conditionId: {
                  proxyWallet: cp.proxyWallet,
                  asset: cp.asset,
                  conditionId: cp.conditionId,
                },
              },
              create: {
                proxyWallet: cp.proxyWallet,
                asset: cp.asset,
                conditionId: cp.conditionId,
                avgPrice: cp.avgPrice,
                totalBought: cp.totalBought,
                realizedPnl: cp.realizedPnl,
                curPrice: cp.curPrice,
                timestamp: cp.timestamp,
                outcome: cp.outcome,
                outcomeIndex: cp.outcomeIndex ?? null,
                title: cp.title ?? null,
                eventSlug: cp.eventSlug ?? null,
                endDate: cp.endDate ? new Date(cp.endDate) : null,
              },
              update: {
                realizedPnl: cp.realizedPnl,
                curPrice: cp.curPrice,
              },
            })
          )
        );
      } catch (err: any) {
        log.warn(`Closed position batch failed, falling back to individual upserts: ${err.message}`);
        for (const cp of chunk) {
          try {
            await prisma.closedPosition.upsert({
              where: {
                proxyWallet_asset_conditionId: {
                  proxyWallet: cp.proxyWallet,
                  asset: cp.asset,
                  conditionId: cp.conditionId,
                },
              },
              create: {
                proxyWallet: cp.proxyWallet,
                asset: cp.asset,
                conditionId: cp.conditionId,
                avgPrice: cp.avgPrice,
                totalBought: cp.totalBought,
                realizedPnl: cp.realizedPnl,
                curPrice: cp.curPrice,
                timestamp: cp.timestamp,
                outcome: cp.outcome,
                outcomeIndex: cp.outcomeIndex ?? null,
                title: cp.title ?? null,
                eventSlug: cp.eventSlug ?? null,
                endDate: cp.endDate ? new Date(cp.endDate) : null,
              },
              update: {
                realizedPnl: cp.realizedPnl,
                curPrice: cp.curPrice,
              },
            });
          } catch (innerErr: any) {
            log.warn(`Failed to upsert closed position: ${innerErr.message}`);
          }
        }
      }
    }

    // 9. Mark backfill as completed
    const latestTradeTs = trades.length > 0
      ? new Date(Math.max(...trades.map((t) => t.timestamp)) * 1000)
      : null;

    await prisma.trader.update({
      where: { proxyWallet },
      data: {
        backfillStatus: 'COMPLETED',
        backfillCompleted: new Date(),
        backfillLockedAt: null,
        backfillError: null,
        lastTradeSync: latestTradeTs,
        lastPositionSync: new Date(),
      },
    });

    log.info('Backfill completed', {
      trades: tradeCount,
      closedPositions: closedPositions.length,
      positions: positions.length,
    });
  } catch (err: any) {
    log.error(`Backfill failed: ${err.message}`);

    // Increment retry counter and unlock
    await prisma.trader.update({
      where: { proxyWallet },
      data: {
        backfillStatus: 'FAILED',
        backfillLockedAt: null,
        backfillError: err.message?.slice(0, 500),
        backfillRetries: { increment: 1 },
      },
    });

    // Check if max retries exceeded
    const trader = await prisma.trader.findUnique({
      where: { proxyWallet },
      select: { backfillRetries: true },
    });

    if (trader && trader.backfillRetries >= MAX_BACKFILL_RETRIES) {
      await prisma.trader.update({
        where: { proxyWallet },
        data: { backfillStatus: 'PERMANENTLY_FAILED' },
      });
      log.error(`Permanently failed after ${MAX_BACKFILL_RETRIES} retries`);
    }
  }
}
