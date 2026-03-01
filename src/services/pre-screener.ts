import { prisma } from '../lib/prisma';
import { getPositions } from '../api/data-api';
import { config } from '../config/env';
import { logger } from '../lib/logger';
import { PRESCREEN_POSITIONS_LIMIT } from '../config/constants';

export interface PreScreenResult {
  proxyWallet: string;
  passed: boolean;
  positionCount: number;
  winRate: number;
  estimatedRoi: number;
  reason?: string;
}

/**
 * Pre-screen a single trader using leaderboard data + lightweight positions fetch.
 */
export async function preScreenTrader(
  proxyWallet: string,
  leaderboardPnl: number | null,
  leaderboardVol: number | null,
): Promise<PreScreenResult> {
  // Gate 1: Leaderboard data (zero API calls)
  if (leaderboardPnl !== null && leaderboardPnl < config.PRESCREEN_MIN_PNL) {
    return {
      proxyWallet,
      passed: false,
      positionCount: 0,
      winRate: 0,
      estimatedRoi: 0,
      reason: `PnL ${leaderboardPnl.toFixed(2)} < ${config.PRESCREEN_MIN_PNL}`,
    };
  }

  if (leaderboardVol !== null && leaderboardVol < config.PRESCREEN_MIN_VOLUME) {
    return {
      proxyWallet,
      passed: false,
      positionCount: 0,
      winRate: 0,
      estimatedRoi: 0,
      reason: `Volume ${leaderboardVol.toFixed(2)} < ${config.PRESCREEN_MIN_VOLUME}`,
    };
  }

  // Gate 2: Fetch positions (1 API request)
  const positions = await getPositions({
    user: proxyWallet,
    sizeThreshold: 0,
    limit: PRESCREEN_POSITIONS_LIMIT,
  });

  const positionCount = positions.length;

  if (positionCount < config.PRESCREEN_MIN_POSITIONS) {
    return {
      proxyWallet,
      passed: false,
      positionCount,
      winRate: 0,
      estimatedRoi: 0,
      reason: `Positions ${positionCount} < ${config.PRESCREEN_MIN_POSITIONS}`,
    };
  }

  // Compute win rate from positions with realizedPnl data
  const resolved = positions.filter(
    (p) => p.realizedPnl !== null && p.realizedPnl !== undefined,
  );
  const wins = resolved.filter((p) => (p.realizedPnl ?? 0) > 0).length;
  const winRate = resolved.length > 0 ? wins / resolved.length : 0;

  // Estimate ROI from positions data
  let totalPnl = 0;
  let totalInvested = 0;
  for (const p of positions) {
    totalPnl += (p.realizedPnl ?? 0) + (p.cashPnl ?? 0);
    totalInvested += p.initialValue ?? p.size * p.avgPrice;
  }
  const estimatedRoi = totalInvested > 0 ? totalPnl / totalInvested : 0;

  const passed = winRate >= config.PRESCREEN_MIN_WIN_RATE;

  return {
    proxyWallet,
    passed,
    positionCount,
    winRate,
    estimatedRoi,
    reason: passed
      ? undefined
      : `Win rate ${(winRate * 100).toFixed(1)}% < ${(config.PRESCREEN_MIN_WIN_RATE * 100).toFixed(1)}%`,
  };
}

/**
 * Pre-screen a batch of traders concurrently.
 * Updates each trader's record with screen results and backfillStatus.
 * Fail-open: API errors leave trader as PENDING for the backfiller.
 */
export async function preScreenBatch(
  traders: Array<{
    proxyWallet: string;
    leaderboardPnl: number | null;
    leaderboardVol: number | null;
  }>,
): Promise<{ passed: number; rejected: number; errors: number }> {
  let passed = 0;
  let rejected = 0;
  let errors = 0;

  const concurrency = config.PRESCREEN_CONCURRENCY;

  for (let i = 0; i < traders.length; i += concurrency) {
    const chunk = traders.slice(i, i + concurrency);

    const results = await Promise.allSettled(
      chunk.map((t) =>
        preScreenTrader(t.proxyWallet, t.leaderboardPnl, t.leaderboardVol),
      ),
    );

    // Separate successful screens from API errors
    const screens: PreScreenResult[] = [];
    for (const result of results) {
      if (result.status === 'rejected') {
        errors++;
        logger.warn(`Pre-screen API error: ${result.reason}`);
      } else {
        screens.push(result.value);
      }
    }

    // Persist screen results in parallel (independent DB writes)
    await Promise.all(
      screens.map(async (screen) => {
        await prisma.trader.update({
          where: { proxyWallet: screen.proxyWallet },
          data: {
            screenPositionCount: screen.positionCount,
            screenWinRate: screen.winRate,
            screenRoi: screen.estimatedRoi,
            screenedAt: new Date(),
            ...(screen.passed ? {} : { backfillStatus: 'SCREENED_OUT' }),
          },
        });

        if (screen.passed) {
          passed++;
        } else {
          rejected++;
          logger.debug(
            `Screened out ${screen.proxyWallet.slice(0, 10)}: ${screen.reason}`,
          );
        }
      }),
    );
  }

  return { passed, rejected, errors };
}
