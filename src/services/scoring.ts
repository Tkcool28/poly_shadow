import Bottleneck from 'bottleneck';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config/env';
import { computeProfitability } from '../scoring/profitability';
import { computeConsistency } from '../scoring/consistency';
import { computeActivity } from '../scoring/activity';
import { computeCategoryScores } from '../scoring/category';
import { computeRisk } from '../scoring/risk';
import { computeRecency } from '../scoring/recency';
import { computeCompositeScores } from '../scoring/composite';
import { partitionPositions } from '../scoring/expired-position-detector';
import { refreshTraderClosedPositions } from './history-backfill';
import { BACKFILL_HISTORY_DAYS } from '../config/constants';

export async function calculateAllScores(): Promise<number> {
  // Only score traders with completed backfill
  const traders = await prisma.trader.findMany({
    where: { backfillStatus: 'COMPLETED' },
    select: { proxyWallet: true, lastPositionSync: true, isMonitored: true },
  });

  logger.info(`Scoring ${traders.length} traders with completed backfill`);

  if (traders.length === 0) return 0;

  // Refresh ClosedPositions for stale monitored traders in parallel before scoring
  const refreshCutoff = new Date(Date.now() - config.SCORE_RECALC_INTERVAL_MS);
  const staleMonitored = traders.filter(
    (t) => t.isMonitored && (!t.lastPositionSync || t.lastPositionSync < refreshCutoff),
  );

  if (staleMonitored.length > 0) {
    logger.info(`Refreshing closed positions for ${staleMonitored.length} stale traders`);
    const limiter = new Bottleneck({ maxConcurrent: 10 });
    const refreshResults = await Promise.allSettled(
      staleMonitored.map((t) =>
        limiter.schedule(async () => {
          const sinceTs = t.lastPositionSync
            ? Math.floor(t.lastPositionSync.getTime() / 1000)
            : Math.floor(Date.now() / 1000) - BACKFILL_HISTORY_DAYS * 86400;
          const refreshed = await refreshTraderClosedPositions(t.proxyWallet, sinceTs);
          if (refreshed > 0) {
            logger.info(`Refreshed ${refreshed} closed positions for ${t.proxyWallet.slice(0, 10)}`);
          }
        }),
      ),
    );
    const failedRefreshes = refreshResults.filter((r) => r.status === 'rejected');
    if (failedRefreshes.length > 0) {
      logger.warn(
        `${failedRefreshes.length}/${staleMonitored.length} ClosedPosition refreshes failed before scoring`,
      );
    }
  }

  // Fetch markets once for all traders (Critical #1 fix)
  const markets = await prisma.market.findMany({
    select: { conditionId: true, category: true, closed: true },
  });

  // Pre-compute closed market set for expired position detection
  const closedMarketConditionIds = new Set(
    markets.filter(m => m.closed).map(m => m.conditionId),
  );

  // Compute individual metrics for each trader
  const traderScores: Array<{
    proxyWallet: string;
    profitability: ReturnType<typeof computeProfitability>;
    consistency: ReturnType<typeof computeConsistency>;
    activity: ReturnType<typeof computeActivity>;
    risk: ReturnType<typeof computeRisk>;
    recency: ReturnType<typeof computeRecency>;
    closedPositions: Array<{ conditionId: string; realizedPnl: number; totalBought: number; timestamp: number }>;
  }> = [];

  for (const { proxyWallet } of traders) {
    try {
      const metrics = await computeTraderMetrics(proxyWallet, closedMarketConditionIds);
      if (metrics) {
        traderScores.push(metrics);
      }
    } catch (err: any) {
      logger.warn(`Failed to compute metrics for ${proxyWallet.slice(0, 10)}: ${err.message}`);
    }
  }

  logger.info(`Computed metrics for ${traderScores.length} traders`);

  // Compute composite scores with percentile ranking
  const compositeInputs = traderScores.map(ts => ({
    proxyWallet: ts.proxyWallet,
    ...ts.profitability,
    ...ts.consistency,
    ...ts.activity,
    ...ts.risk,
    ...ts.recency,
  }));

  const compositeResults = computeCompositeScores(compositeInputs);

  // Build a map for quick lookup
  const compositeMap = new Map(compositeResults.map(r => [r.proxyWallet, r]));

  // Upsert scores, score history, and category scores
  for (const ts of traderScores) {
    const composite = compositeMap.get(ts.proxyWallet);
    if (!composite) continue;

    await upsertScores(ts, composite, markets);
  }

  // Update isMonitored: all COMPLETED traders
  await updateMonitoredTraders();

  // Prune old data
  await pruneData();

  logger.info(`Scoring complete. Top trader score: ${compositeResults[0]?.compositeScore ?? 'N/A'}`);
  return traderScores.length;
}

async function computeTraderMetrics(
  proxyWallet: string,
  closedMarketConditionIds: Set<string>,
) {
  const arbPrice = config.ARB_FILTER_PRICE;

  const [trades, dbClosedPositions, positions] = await Promise.all([
    prisma.trade.findMany({
      where: {
        proxyWallet,
        // Exclude arb entries: BUY trades at >= threshold price
        NOT: { side: 'BUY', price: { gte: arbPrice } },
      },
      select: { conditionId: true, size: true, price: true, timestamp: true, side: true },
    }),
    prisma.closedPosition.findMany({
      where: {
        proxyWallet,
        // Exclude positions entered at arb prices
        avgPrice: { lt: arbPrice },
      },
      select: { asset: true, conditionId: true, realizedPnl: true, totalBought: true, timestamp: true },
    }),
    prisma.position.findMany({
      where: {
        proxyWallet,
        // Exclude open positions entered at arb prices
        avgPrice: { lt: arbPrice },
      },
      select: {
        asset: true, conditionId: true, cashPnl: true, initialValue: true,
        curPrice: true, currentValue: true, endDate: true, snapshotAt: true,
      },
    }),
  ]);

  if (trades.length === 0 && dbClosedPositions.length === 0 && positions.length === 0) return null;

  // Partition open positions into truly-open vs expired/resolved
  const dbClosedAssets = new Set(dbClosedPositions.map(cp => cp.asset));
  const { trulyOpen, syntheticClosed } = partitionPositions(
    positions, closedMarketConditionIds, dbClosedAssets,
  );

  if (syntheticClosed.length > 0) {
    logger.debug(
      `${proxyWallet.slice(0, 10)}: ${positions.length} open → ` +
      `${trulyOpen.length} truly open, ${syntheticClosed.length} expired/resolved`,
    );
  }

  // Merge DB closed positions + synthetic closed positions
  const allClosedPositions = [...dbClosedPositions, ...syntheticClosed];

  const profitability = computeProfitability(allClosedPositions, trulyOpen);
  const consistency = computeConsistency(allClosedPositions);
  const activity = computeActivity(trades, allClosedPositions);
  const risk = computeRisk(trades);
  const recency = computeRecency(allClosedPositions);

  return { proxyWallet, profitability, consistency, activity, risk, recency, closedPositions: allClosedPositions };
}

async function upsertScores(
  ts: NonNullable<Awaited<ReturnType<typeof computeTraderMetrics>>>,
  composite: { compositeScore: number; rank: number },
  markets: Array<{ conditionId: string; category: string | null }>,
) {
  const { proxyWallet, profitability, consistency, activity, risk, recency, closedPositions } = ts;

  // Upsert TraderScore
  await prisma.traderScore.upsert({
    where: { proxyWallet },
    create: {
      proxyWallet,
      ...profitability,
      ...consistency,
      totalTrades: activity.totalTrades,
      totalMarkets: activity.totalMarkets,
      avgPositionSize: activity.avgPositionSize,
      avgHoldDuration: activity.avgHoldDuration,
      tradeFrequency: activity.tradeFrequency,
      activeDays: activity.activeDays,
      ...risk,
      ...recency,
      compositeScore: composite.compositeScore,
      rank: composite.rank,
    },
    update: {
      ...profitability,
      ...consistency,
      totalTrades: activity.totalTrades,
      totalMarkets: activity.totalMarkets,
      avgPositionSize: activity.avgPositionSize,
      avgHoldDuration: activity.avgHoldDuration,
      tradeFrequency: activity.tradeFrequency,
      activeDays: activity.activeDays,
      ...risk,
      ...recency,
      compositeScore: composite.compositeScore,
      rank: composite.rank,
      calculatedAt: new Date(),
    },
  });

  // Append to score history
  await prisma.traderScoreHistory.create({
    data: {
      proxyWallet,
      compositeScore: composite.compositeScore,
      totalPnl: profitability.totalPnl,
      winRate: consistency.winRate,
      rank: composite.rank,
    },
  });

  // Delete old category scores and insert fresh atomically (prevents partial state on crash)
  await prisma.$transaction(async (tx) => {
    await tx.categoryScore.deleteMany({ where: { proxyWallet } });
    const categoryScores = computeCategoryScores(closedPositions, markets);
    for (const cs of categoryScores) {
      await tx.categoryScore.create({ data: { proxyWallet, ...cs } });
    }
  }, { timeout: 30000 });
}

async function updateMonitoredTraders() {
  await prisma.$transaction(async (tx) => {
    await tx.trader.updateMany({
      where: { isMonitored: true },
      data: { isMonitored: false },
    });

    const result = await tx.trader.updateMany({
      where: { backfillStatus: 'COMPLETED' },
      data: { isMonitored: true },
    });

    logger.info(`Updated monitored traders: ${result.count} (all COMPLETED)`);
  });
}

async function pruneData() {
  const retentionDays = config.DATA_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

  // Prune old detected trades that have no linked CopyTrade (FK-safe)
  const deletedTrades = await prisma.detectedTrade.deleteMany({
    where: { detectedAt: { lt: cutoff }, copyTrade: { is: null } },
  });
  if (deletedTrades.count > 0) {
    logger.info(`Pruned ${deletedTrades.count} detected trades older than ${retentionDays} days`);
  }

  // Cap score history at 30 per trader
  const tradersWithHistory = await prisma.traderScoreHistory.groupBy({
    by: ['proxyWallet'],
    _count: true,
  });

  for (const { proxyWallet, _count } of tradersWithHistory) {
    if (_count > 30) {
      const toKeep = await prisma.traderScoreHistory.findMany({
        where: { proxyWallet },
        orderBy: { calculatedAt: 'desc' },
        take: 30,
        select: { id: true },
      });
      const keepIds = new Set(toKeep.map(r => r.id));

      await prisma.traderScoreHistory.deleteMany({
        where: {
          proxyWallet,
          id: { notIn: [...keepIds] },
        },
      });
    }
  }
}
