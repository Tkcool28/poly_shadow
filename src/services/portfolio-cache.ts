import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { getValue } from '../api/data-api';

const log = createJobLogger('portfolio-cache');

let refreshTimer: ReturnType<typeof setInterval> | null = null;

export async function startPortfolioRefresh(): Promise<void> {
  // Initial fetch (non-fatal — interval still starts on failure)
  try {
    await refreshAllTraders();
  } catch (err: any) {
    log.warn(`Initial portfolio refresh failed: ${err.message}`);
  }

  // Periodic refresh (always set up regardless of initial fetch result)
  refreshTimer = setInterval(refreshAllTraders, config.PORTFOLIO_VALUE_REFRESH_MS);
  log.info(`Portfolio cache started (refresh every ${config.PORTFOLIO_VALUE_REFRESH_MS / 1000}s)`);
}

export function stopPortfolioRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
    log.info('Portfolio cache stopped');
  }
}

export async function refreshSingleTrader(proxyWallet: string): Promise<number | null> {
  try {
    const data = await getValue(proxyWallet);
    const value = data.value;

    await prisma.followAllocation.update({
      where: { proxyWallet },
      data: {
        traderPortfolioValue: value,
        portfolioValueAt: new Date(),
      },
    });

    log.debug(`Refreshed portfolio value for ${proxyWallet.slice(0, 10)}: $${value.toFixed(2)}`);
    return value;
  } catch (err: any) {
    log.warn(`Failed to fetch portfolio value for ${proxyWallet.slice(0, 10)}: ${err.message}`);
    return null;
  }
}

async function refreshAllTraders(): Promise<void> {
  const allocations = await prisma.followAllocation.findMany({
    where: { isActive: true },
    select: { proxyWallet: true, portfolioValueAt: true },
  });

  if (allocations.length === 0) return;

  let updated = 0;
  let failed = 0;

  for (const alloc of allocations) {
    const result = await refreshSingleTrader(alloc.proxyWallet);
    if (result !== null) {
      updated++;
    } else {
      failed++;
      // Log staleness warning if last value is >15 min old
      if (alloc.portfolioValueAt) {
        const ageMs = Date.now() - alloc.portfolioValueAt.getTime();
        if (ageMs > 15 * 60 * 1000) {
          log.warn(`Stale portfolio value for ${alloc.proxyWallet.slice(0, 10)}: ${Math.round(ageMs / 60000)}min old`);
        }
      }
    }
  }

  log.info(`Portfolio refresh: ${updated} updated, ${failed} failed (${allocations.length} total)`);
}
