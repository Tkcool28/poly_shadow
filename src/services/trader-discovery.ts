import { prisma } from '../lib/prisma';
import { getLeaderboard } from '../api/data-api';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { preScreenBatch } from './pre-screener';

export async function discoverFromLeaderboard(): Promise<{
  newTraders: number;
  updatedTraders: number;
  screenedOut: number;
  passedScreen: number;
}> {
  const categories = config.LEADERBOARD_CATEGORIES.split(',').map((s) => s.trim());
  const timePeriods = config.LEADERBOARD_TIME_PERIODS.split(',').map((s) => s.trim());
  const limit = config.LEADERBOARD_LIMIT;

  const seenWallets = new Set<string>();
  let newTraders = 0;
  let updatedTraders = 0;

  // Pre-load SCREENED_OUT traders' PnL before upserts overwrite it (Critical #1 fix)
  const screenedOutTraders = await prisma.trader.findMany({
    where: { backfillStatus: 'SCREENED_OUT' },
    select: { proxyWallet: true, leaderboardPnl: true },
  });
  const screenedOutPnl = new Map(
    screenedOutTraders.map((t) => [t.proxyWallet, t.leaderboardPnl]),
  );

  for (const category of categories) {
    for (const timePeriod of timePeriods) {
      // Paginate up to 200 results per combo (4 pages of 50)
      const maxOffset = 200;
      for (let offset = 0; offset < maxOffset; offset += limit) {
        const entries = await getLeaderboard({
          category,
          timePeriod,
          orderBy: 'PNL',
          limit,
          offset,
        });

        if (entries.length === 0) break;

        for (const entry of entries) {
          if (seenWallets.has(entry.proxyWallet)) continue;
          seenWallets.add(entry.proxyWallet);

          const rankNum = parseInt(entry.rank, 10) || null;

          // Check re-evaluation BEFORE upsert overwrites leaderboardPnl
          const oldPnl = screenedOutPnl.get(entry.proxyWallet);
          const shouldRescreen =
            oldPnl !== undefined &&
            oldPnl !== null &&
            entry.pnl > oldPnl * 1.5;

          const result = await prisma.trader.upsert({
            where: { proxyWallet: entry.proxyWallet },
            create: {
              proxyWallet: entry.proxyWallet,
              userName: entry.userName,
              xUsername: entry.xUsername || null,
              verifiedBadge: entry.verifiedBadge,
              profileImage: entry.profileImage || null,
              source: 'LEADERBOARD',
              backfillStatus: 'PENDING',
              leaderboardPnl: entry.pnl,
              leaderboardVol: entry.vol,
              leaderboardRank: rankNum,
            },
            update: {
              userName: entry.userName,
              verifiedBadge: entry.verifiedBadge,
              leaderboardPnl: entry.pnl,
              leaderboardVol: entry.vol,
              leaderboardRank: rankNum,
              // Reset SCREENED_OUT traders with significantly improved PnL
              ...(shouldRescreen
                ? { backfillStatus: 'PENDING' as const, screenedAt: null }
                : {}),
            },
            select: { createdAt: true, updatedAt: true },
          });

          // If createdAt equals updatedAt (within 1s), it's a new record
          if (Math.abs(result.createdAt.getTime() - result.updatedAt.getTime()) < 1000) {
            newTraders++;
          } else {
            updatedTraders++;

            if (shouldRescreen) {
              logger.info(
                `Re-evaluating ${entry.proxyWallet.slice(0, 10)}: PnL improved from ${oldPnl?.toFixed(0)} to ${entry.pnl.toFixed(0)}`,
              );
            }
          }
        }

        if (entries.length < limit) break;
      }
    }
  }

  logger.info(`Leaderboard scan complete`, {
    newTraders,
    updatedTraders,
    totalSeen: seenWallets.size,
  });

  // Pre-screen unscreened traders
  const unscreened = await prisma.trader.findMany({
    where: {
      backfillStatus: 'PENDING',
      screenedAt: null,
    },
    select: {
      proxyWallet: true,
      leaderboardPnl: true,
      leaderboardVol: true,
    },
  });

  let screenedOut = 0;
  let passedScreen = 0;

  if (unscreened.length > 0) {
    logger.info(`Pre-screening ${unscreened.length} traders`);

    const screenResult = await preScreenBatch(unscreened);
    screenedOut = screenResult.rejected;
    passedScreen = screenResult.passed;

    logger.info(`Pre-screen complete`, {
      passed: screenResult.passed,
      rejected: screenResult.rejected,
      errors: screenResult.errors,
    });
  }

  return { newTraders, updatedTraders, screenedOut, passedScreen };
}
