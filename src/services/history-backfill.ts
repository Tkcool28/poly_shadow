import { prisma } from '../lib/prisma';
import {
  getAllTrades,
  getAllClosedPositions,
  getAllActivity,
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

/**
 * Backfill full trading history for a single wallet.
 */
export async function backfillTrader(proxyWallet: string): Promise<void> {
  const log = logger.child({ job: 'backfiller', wallet: proxyWallet.slice(0, 10) });

  try {
    log.info('Starting backfill');

    // 1. Fetch all trades
    log.info('Fetching trades...');
    const trades = await getAllTrades(proxyWallet);
    log.info(`Fetched ${trades.length} trades`);

    // 2. Fetch all closed positions
    log.info('Fetching closed positions...');
    const closedPositions = await getAllClosedPositions(proxyWallet);
    log.info(`Fetched ${closedPositions.length} closed positions`);

    // 3. Fetch current open positions
    log.info('Fetching current positions...');
    const positions = await getPositions({
      user: proxyWallet,
      limit: POSITIONS_PAGE_SIZE,
    });
    log.info(`Fetched ${positions.length} open positions`);

    // 4. Fetch activity (some wallets return 400, handle gracefully)
    let activities: Awaited<ReturnType<typeof getAllActivity>> = [];
    try {
      log.info('Fetching activity...');
      activities = await getAllActivity(proxyWallet);
      log.info(`Fetched ${activities.length} activities`);
    } catch (err: any) {
      log.warn(`Activity fetch failed (non-fatal): ${err.message}`);
    }

    // 5. Resolve market metadata for all unique conditionIds
    const conditionIds = new Set<string>();
    trades.forEach((t) => conditionIds.add(t.conditionId));
    closedPositions.forEach((cp) => conditionIds.add(cp.conditionId));
    positions.forEach((p) => conditionIds.add(p.conditionId));
    await resolveMarkets([...conditionIds]);

    // 6. Store trades (upsert to avoid duplicates)
    log.info('Storing trades...');
    let tradeCount = 0;
    for (const t of trades) {
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
      } catch (err: any) {
        if (!err.message?.includes('Unique constraint')) {
          log.warn(`Failed to upsert trade: ${err.message}`);
        }
      }
    }

    // 7. Store positions (upsert current state)
    log.info('Storing positions...');
    for (const p of positions) {
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
      } catch (err: any) {
        log.warn(`Failed to upsert position: ${err.message}`);
      }
    }

    // 8. Store closed positions
    log.info('Storing closed positions...');
    for (const cp of closedPositions) {
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
      } catch (err: any) {
        log.warn(`Failed to upsert closed position: ${err.message}`);
      }
    }

    // 9. Store activities
    log.info('Storing activities...');
    for (const a of activities) {
      try {
        await prisma.activity.upsert({
          where: {
            transactionHash_proxyWallet_conditionId_type_timestamp: {
              transactionHash: a.transactionHash,
              proxyWallet: a.proxyWallet,
              conditionId: a.conditionId,
              type: a.type,
              timestamp: a.timestamp,
            },
          },
          create: {
            proxyWallet: a.proxyWallet,
            timestamp: a.timestamp,
            conditionId: a.conditionId,
            type: a.type,
            size: a.size,
            usdcSize: a.usdcSize,
            transactionHash: a.transactionHash,
            price: a.price ?? null,
            asset: a.asset ?? null,
            side: a.side ?? null,
            outcomeIndex: a.outcomeIndex ?? null,
            title: a.title ?? null,
            eventSlug: a.eventSlug ?? null,
          },
          update: {},
        });
      } catch (err: any) {
        if (!err.message?.includes('Unique constraint')) {
          log.warn(`Failed to upsert activity: ${err.message}`);
        }
      }
    }

    // 10. Mark backfill as completed
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
      activities: activities.length,
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
