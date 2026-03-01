import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getTrades } from '../api/data-api';

export async function detectNewTrades(): Promise<number> {
  // Get monitored traders
  const traders = await prisma.trader.findMany({
    where: { isMonitored: true },
    select: {
      proxyWallet: true,
      userName: true,
      lastTradeSync: true,
      scores: { select: { compositeScore: true }, take: 1 },
    },
  });

  if (traders.length === 0) {
    logger.debug('No monitored traders to check');
    return 0;
  }

  logger.info(`Checking ${traders.length} monitored traders for new trades`);

  let totalDetected = 0;

  for (const trader of traders) {
    try {
      const detected = await checkTraderForNewTrades(
        trader.proxyWallet,
        trader.userName,
        trader.lastTradeSync,
        trader.scores[0]?.compositeScore ?? null,
      );
      totalDetected += detected;
    } catch (err: any) {
      logger.warn(
        `Failed to check trades for ${trader.proxyWallet.slice(0, 10)}: ${err.message}`,
      );
    }
  }

  return totalDetected;
}

async function checkTraderForNewTrades(
  proxyWallet: string,
  userName: string | null,
  lastSync: Date | null,
  compositeScore: number | null,
): Promise<number> {
  // Fetch recent trades (limit 100 should be enough for a 2-min window)
  const recentTrades = await getTrades({
    user: proxyWallet,
    limit: 100,
  });

  if (recentTrades.length === 0) return 0;

  // If lastSync is null (first monitor run), initialize to now and skip.
  // This avoids flooding DetectedTrade with the trader's entire history.
  if (!lastSync) {
    const maxTimestamp = Math.max(...recentTrades.map(t => t.timestamp));
    await prisma.trader.update({
      where: { proxyWallet },
      data: { lastTradeSync: new Date(maxTimestamp * 1000) },
    });
    logger.info(`Initialized lastTradeSync for ${proxyWallet.slice(0, 10)}, skipping historical trades`);
    return 0;
  }

  // Filter to only trades after lastSync
  const lastSyncEpoch = Math.floor(lastSync.getTime() / 1000);
  const newTrades = recentTrades.filter(t => t.timestamp > lastSyncEpoch);

  if (newTrades.length === 0) return 0;

  // Insert detected trades (skip duplicates via unique constraint)
  let insertedCount = 0;
  for (const trade of newTrades) {
    try {
      await prisma.detectedTrade.create({
        data: {
          proxyWallet,
          userName,
          side: trade.side,
          conditionId: trade.conditionId,
          asset: trade.asset,
          size: trade.size,
          price: trade.price,
          outcome: trade.outcome,
          title: trade.title ?? null,
          eventSlug: trade.eventSlug ?? null,
          transactionHash: trade.transactionHash,
          timestamp: trade.timestamp,
          compositeScore,
        },
      });
      insertedCount++;

      // Log the detected trade
      const usdValue = (trade.size * trade.price).toFixed(2);
      logger.info(`NEW TRADE DETECTED`, {
        trader: proxyWallet.slice(0, 10),
        userName,
        side: trade.side,
        outcome: trade.outcome,
        title: trade.title?.slice(0, 50),
        usdValue: `$${usdValue}`,
        price: trade.price,
        compositeScore,
      });
    } catch (err: any) {
      // Skip duplicate constraint violations
      if (err.code === 'P2002') continue;
      throw err;
    }
  }

  // Update lastTradeSync to the most recent trade timestamp
  const maxTimestamp = Math.max(...newTrades.map(t => t.timestamp));
  await prisma.trader.update({
    where: { proxyWallet },
    data: { lastTradeSync: new Date(maxTimestamp * 1000) },
  });

  if (insertedCount > 0) {
    logger.info(
      `Detected ${insertedCount} new trades from ${proxyWallet.slice(0, 10)} (${userName ?? 'unknown'})`,
    );
  }

  return insertedCount;
}
