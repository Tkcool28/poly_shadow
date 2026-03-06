import { prisma } from '../lib/prisma';
import {
  getAllTrades,
  getAllClosedPositions,
  getAllPositions,
  getClosedPositionsSince,
} from '../api/data-api';
import { resolveMarkets } from './market-resolver';
import { logger } from '../lib/logger';
import { config } from '../config/env';
import {
  MAX_BACKFILL_RETRIES,
  BACKFILL_LOCK_TIMEOUT_MS,
} from '../config/constants';

export interface ClaimedTrader {
  proxyWallet: string;
  isRefresh: boolean;
}

/**
 * Atomically claim traders for backfill using lock-based concurrency.
 * Priority 1: PENDING/FAILED traders and IN_PROGRESS with expired locks (crash recovery).
 * Priority 2: Stale COMPLETED traders for data refresh (only when no new work exists).
 */
export async function claimTradersForBackfill(
  batchSize: number,
  refreshBatchSize = 0,
): Promise<ClaimedTrader[]> {
  const now = new Date();
  const lockExpiry = new Date(now.getTime() - BACKFILL_LOCK_TIMEOUT_MS);

  // Priority 1: PENDING/FAILED/stale-IN_PROGRESS (existing query, unchanged)
  const traders = await prisma.trader.findMany({
    where: {
      OR: [
        // Normal: PENDING/FAILED traders with no lock or expired lock
        {
          backfillStatus: { in: ['PENDING', 'FAILED'] },
          backfillRetries: { lt: MAX_BACKFILL_RETRIES },
          OR: [
            { backfillLockedAt: null },
            { backfillLockedAt: { lt: lockExpiry } },
          ],
        },
        // Recovery: IN_PROGRESS traders whose lock expired (crash recovery)
        {
          backfillStatus: 'IN_PROGRESS',
          backfillRetries: { lt: MAX_BACKFILL_RETRIES },
          backfillLockedAt: { lt: lockExpiry },
        },
      ],
    },
    select: { proxyWallet: true },
    take: batchSize,
    orderBy: { createdAt: 'asc' },
  });

  // Priority 2: Stale COMPLETED traders (refresh) — only when no new work exists
  const refreshWallets = new Set<string>();
  if (traders.length === 0 && refreshBatchSize > 0) {
    const refreshCutoff = new Date(now.getTime() - config.BACKFILL_REFRESH_AFTER_MS);
    const staleTraders = await prisma.trader.findMany({
      where: {
        backfillStatus: 'COMPLETED',
        backfillCompleted: { lt: refreshCutoff },
        OR: [
          { backfillLockedAt: null },
          { backfillLockedAt: { lt: lockExpiry } },
        ],
      },
      select: { proxyWallet: true },
      take: refreshBatchSize,
      orderBy: { backfillCompleted: 'asc' },  // oldest first = round-robin
    });
    traders.push(...staleTraders);
    for (const t of staleTraders) refreshWallets.add(t.proxyWallet);
  }

  // Atomically lock each trader (only if lock is still unclaimed or expired)
  const claimed: ClaimedTrader[] = [];

  for (const trader of traders) {
    const isRefresh = refreshWallets.has(trader.proxyWallet);

    const result = await prisma.trader.updateMany({
      where: {
        proxyWallet: trader.proxyWallet,
        // Skip retries check for refresh candidates (may have retries from initial backfill)
        ...(isRefresh ? {} : { backfillRetries: { lt: MAX_BACKFILL_RETRIES } }),
        OR: [
          { backfillLockedAt: null },
          { backfillLockedAt: { lt: lockExpiry } },
        ],
      },
      data: {
        backfillLockedAt: now,
        backfillStatus: 'IN_PROGRESS',
        backfillStarted: now,
        // Reset retries for refresh so failure handling works cleanly
        ...(isRefresh ? { backfillRetries: 0 } : {}),
      },
    });

    if (result.count > 0) {
      claimed.push({ proxyWallet: trader.proxyWallet, isRefresh });
    }
  }

  return claimed;
}

// Chunk sizes for batched DB writes
const TRADE_BATCH_CHUNK = 500;
const UPSERT_BATCH_CHUNK = 200;

/**
 * Backfill full trading history for a single wallet.
 */
export async function backfillTrader(
  proxyWallet: string,
  options?: { isRefresh?: boolean },
): Promise<void> {
  const log = logger.child({ job: 'backfiller', wallet: proxyWallet.slice(0, 10) });

  try {
    log.info('Starting backfill');

    // 1-4. Fetch all data in parallel (different rate limiter pools)
    log.info('Fetching trades, positions, and closed positions in parallel...');

    const [tradesRes, closedRes, positionsRes] = await Promise.allSettled([
      getAllTrades(proxyWallet),
      getAllClosedPositions(proxyWallet),
      getAllPositions(proxyWallet),
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

    // Refresh failure: revert to COMPLETED, keep existing data, clear lock.
    // Bump backfillCompleted to now so this trader moves to the back of the
    // refresh queue — prevents infinite retry on persistently failing traders.
    if (options?.isRefresh) {
      await prisma.trader.update({
        where: { proxyWallet },
        data: {
          backfillStatus: 'COMPLETED',
          backfillLockedAt: null,
          backfillCompleted: new Date(),
          backfillError: `Refresh failed: ${err.message?.slice(0, 480)}`,
        },
      });
      log.warn('Refresh failed, reverted to COMPLETED (cooldown until next refresh window)');
      return;
    }

    const status = err.response?.status;
    const isClientError = status && status !== 429 && status >= 400 && status < 500;

    if (isClientError) {
      // Client errors (400, 403, 404, etc.) won't resolve on retry
      await prisma.trader.update({
        where: { proxyWallet },
        data: {
          backfillStatus: 'PERMANENTLY_FAILED',
          backfillLockedAt: null,
          backfillError: `HTTP ${status}: ${err.message?.slice(0, 480)}`,
        },
      });
      log.error(`Permanently failed due to client error (HTTP ${status})`);
      return;
    }

    // Server/network errors — increment retry counter
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

/**
 * Incrementally refresh ClosedPosition records for a monitored trader.
 * Fetches only positions settled after sinceTimestamp and upserts them.
 * Updates lastPositionSync on success. Returns the number of positions upserted.
 */
export async function refreshTraderClosedPositions(
  proxyWallet: string,
  sinceTimestamp: number,
): Promise<number> {
  const newPositions = await getClosedPositionsSince(proxyWallet, sinceTimestamp);
  if (newPositions.length === 0) return 0;

  for (let i = 0; i < newPositions.length; i += UPSERT_BATCH_CHUNK) {
    const chunk = newPositions.slice(i, i + UPSERT_BATCH_CHUNK);
    try {
      await prisma.$transaction(
        chunk.map((cp) =>
          prisma.closedPosition.upsert({
            where: {
              proxyWallet_asset_conditionId: {
                proxyWallet,
                asset: cp.asset,
                conditionId: cp.conditionId,
              },
            },
            create: {
              proxyWallet,
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
            update: { realizedPnl: cp.realizedPnl, curPrice: cp.curPrice },
          }),
        ),
      );
    } catch (err: any) {
      // Fallback: individual upserts so one bad record doesn't drop the whole chunk
      logger.warn(`Closed position refresh batch failed, falling back to individual upserts: ${err.message}`);
      for (const cp of chunk) {
        try {
          await prisma.closedPosition.upsert({
            where: {
              proxyWallet_asset_conditionId: {
                proxyWallet,
                asset: cp.asset,
                conditionId: cp.conditionId,
              },
            },
            create: {
              proxyWallet,
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
            update: { realizedPnl: cp.realizedPnl, curPrice: cp.curPrice },
          });
        } catch (innerErr: any) {
          logger.warn(`Failed to upsert closed position during refresh: ${innerErr.message}`);
        }
      }
    }
  }

  await prisma.trader.update({
    where: { proxyWallet },
    data: { lastPositionSync: new Date() },
  });

  return newPositions.length;
}
