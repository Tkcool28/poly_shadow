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

export async function calculateAllScores(): Promise<number> {
  // Only score traders with completed backfill
  const traders = await prisma.trader.findMany({
    where: { backfillStatus: 'COMPLETED' },
    select: { proxyWallet: true },
  });

  logger.info(`Scoring ${traders.length} traders with completed backfill`);

  if (traders.length === 0) return 0;

  // Fetch markets once for all traders (Critical #1 fix)
  const markets = await prisma.market.findMany({
    select: { conditionId: true, category: true },
  });

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
      const metrics = await computeTraderMetrics(proxyWallet);
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

  // Update isMonitored: top N traders (atomically via transaction — Suggestion #9)
  await updateMonitoredTraders(config.TOP_N_THRESHOLD);

  // Prune old data
  await pruneData();

  logger.info(`Scoring complete. Top trader score: ${compositeResults[0]?.compositeScore ?? 'N/A'}`);
  return traderScores.length;
}

async function computeTraderMetrics(proxyWallet: string) {
  const [trades, closedPositions, positions] = await Promise.all([
    prisma.trade.findMany({
      where: { proxyWallet },
      select: { conditionId: true, size: true, price: true, timestamp: true, side: true },
    }),
    prisma.closedPosition.findMany({
      where: { proxyWallet },
      select: { conditionId: true, realizedPnl: true, totalBought: true, timestamp: true },
    }),
    prisma.position.findMany({
      where: { proxyWallet },
      select: { cashPnl: true, initialValue: true },
    }),
  ]);

  if (trades.length === 0 && closedPositions.length === 0) return null;

  const profitability = computeProfitability(closedPositions, positions);
  const consistency = computeConsistency(closedPositions);
  const activity = computeActivity(trades, closedPositions);
  const risk = computeRisk(trades);
  const recency = computeRecency(closedPositions);

  return { proxyWallet, profitability, consistency, activity, risk, recency, closedPositions };
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

  // Delete old category scores for this trader, then insert fresh (Warning #5 fix)
  await prisma.categoryScore.deleteMany({ where: { proxyWallet } });

  const categoryScores = computeCategoryScores(closedPositions, markets);
  for (const cs of categoryScores) {
    await prisma.categoryScore.create({
      data: {
        proxyWallet,
        ...cs,
      },
    });
  }
}

async function updateMonitoredTraders(topN: number) {
  // Atomic update via transaction (Suggestion #9 fix)
  await prisma.$transaction(async (tx) => {
    await tx.trader.updateMany({
      where: { isMonitored: true },
      data: { isMonitored: false },
    });

    const topScores = await tx.traderScore.findMany({
      orderBy: { compositeScore: 'desc' },
      take: topN,
      select: { proxyWallet: true },
    });

    if (topScores.length > 0) {
      await tx.trader.updateMany({
        where: { proxyWallet: { in: topScores.map(s => s.proxyWallet) } },
        data: { isMonitored: true },
      });
    }

    // Protect manually followed traders — always keep them monitored
    const activeFollows = await tx.followAllocation.findMany({
      where: { isActive: true },
      select: { proxyWallet: true },
    });
    if (activeFollows.length > 0) {
      await tx.trader.updateMany({
        where: { proxyWallet: { in: activeFollows.map(f => f.proxyWallet) } },
        data: { isMonitored: true },
      });
    }

    const uniqueWallets = new Set([
      ...topScores.map(s => s.proxyWallet),
      ...activeFollows.map(f => f.proxyWallet),
    ]);
    logger.info(`Updated monitored traders: ${topScores.length} by score + ${activeFollows.length} by follow allocation = ${uniqueWallets.size} unique`);
  });
}

async function pruneData() {
  const retentionDays = config.DATA_RETENTION_DAYS;
  const cutoff = new Date(Date.now() - retentionDays * 86400 * 1000);

  // Prune old detected trades
  const deletedTrades = await prisma.detectedTrade.deleteMany({
    where: { detectedAt: { lt: cutoff } },
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
