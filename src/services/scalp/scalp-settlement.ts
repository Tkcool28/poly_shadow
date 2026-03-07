import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { getMarketBySlug as gammaGetMarketBySlug } from '../../api/gamma-api';
import { ScalpCycleStatus } from '../../../prisma/generated/prisma/client/enums';

const log = createJobLogger('scalp-settlement');

/**
 * Sweep all ENTERED scalp cycles and check if their markets have resolved.
 * Follows the same race-guard pattern as arb-settlement.ts.
 */
export async function sweepScalpSettlements(): Promise<void> {
  const cycles = await prisma.scalpCycle.findMany({
    where: {
      status: ScalpCycleStatus.ENTERED,
      isPaper: config.SCALP_IS_PAPER,
    },
  });

  if (cycles.length === 0) return;

  let settled = 0;
  let timedOut = 0;

  for (const cycle of cycles) {
    try {
      // Check settlement timeout (24hr fail-safe)
      if (cycle.enteredAt && Date.now() - cycle.enteredAt.getTime() > config.SCALP_SETTLEMENT_TIMEOUT_MS) {
        await settleAsTimedOut(cycle);
        timedOut++;
        continue;
      }

      // Query Gamma API for market resolution
      const market = await gammaGetMarketBySlug(cycle.slug);
      if (!market) continue;

      // Market not yet resolved
      if (!market.closed) continue;

      // Market resolved — determine outcome
      const outcomePrices = market.outcomePrices;
      if (!outcomePrices) continue;

      let prices: number[];
      try {
        prices = JSON.parse(outcomePrices).map(Number);
      } catch {
        continue;
      }

      // Find which outcome index our token corresponds to
      let outcomes: string[];
      try {
        outcomes = JSON.parse(market.outcomes);
      } catch {
        continue;
      }

      const ourOutcomeIndex = outcomes.findIndex(
        (o) => o.trim().toLowerCase() === cycle.outcomeLabel?.trim().toLowerCase(),
      );
      if (ourOutcomeIndex < 0) {
        log.warn('Cannot match outcome label to market outcomes', {
          cycleId: cycle.id.slice(0, 12),
          outcomeLabel: cycle.outcomeLabel,
          marketOutcomes: outcomes,
        });
        continue;
      }

      const settlementPrice = prices[ourOutcomeIndex];
      if (settlementPrice === undefined || settlementPrice === null) continue;

      // Determine win/loss (settlement price ≥ 0.50 is a win for us)
      const won = settlementPrice >= 0.50;
      const pnl = cycle.entryShares
        ? cycle.entryShares * settlementPrice - (cycle.entryAmountUsd ?? 0)
        : 0;

      await prisma.$transaction(async (tx) => {
        // Race guard: re-read status inside transaction
        const fresh = await tx.scalpCycle.findUnique({ where: { id: cycle.id } });
        if (!fresh || fresh.status !== ScalpCycleStatus.ENTERED) return;

        await tx.scalpCycle.update({
          where: { id: cycle.id },
          data: {
            status: won ? ScalpCycleStatus.SETTLED_WON : ScalpCycleStatus.SETTLED_LOST,
            exitPrice: settlementPrice,
            exitShares: cycle.entryShares,
            exitMethod: 'settlement',
            pnl,
            exitedAt: new Date(),
          },
        });

        // Return capital + P&L
        const entryAmountUsd = cycle.entryAmountUsd ?? 0;
        await tx.scalpCapital.updateMany({
          where: { isPaper: config.SCALP_IS_PAPER },
          data: {
            currentCapital: { increment: entryAmountUsd + pnl },
            deployedCapital: { decrement: Math.min(entryAmountUsd, 999999) },
            totalPnl: { increment: pnl },
            totalCycles: { increment: 1 },
            totalWins: won ? { increment: 1 } : undefined,
            dailyLossUsd: pnl < 0 ? { increment: Math.abs(pnl) } : undefined,
          },
        });
      });

      settled++;

      log.info(`Settlement: ${won ? 'WON' : 'LOST'}`, {
        cycleId: cycle.id.slice(0, 12),
        slug: cycle.slug,
        outcomeLabel: cycle.outcomeLabel,
        settlementPrice,
        pnl: pnl.toFixed(4),
      });
    } catch (err: any) {
      log.warn(`Settlement check failed for ${cycle.slug}: ${err.message}`);
    }
  }

  if (settled > 0 || timedOut > 0) {
    log.info('Settlement sweep done', { settled, timedOut, checked: cycles.length });
  }
}

/**
 * Fail a cycle that exceeded SCALP_SETTLEMENT_TIMEOUT_MS and refund capital.
 */
async function settleAsTimedOut(cycle: { id: string; entryAmountUsd: number | null; slug: string }): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const fresh = await tx.scalpCycle.findUnique({ where: { id: cycle.id } });
    if (!fresh || fresh.status !== ScalpCycleStatus.ENTERED) return;

    await tx.scalpCycle.update({
      where: { id: cycle.id },
      data: {
        status: ScalpCycleStatus.FAILED,
        failReason: 'settlement timeout exceeded',
        exitedAt: new Date(),
      },
    });

    const entryAmountUsd = cycle.entryAmountUsd ?? 0;
    await tx.scalpCapital.updateMany({
      where: { isPaper: config.SCALP_IS_PAPER },
      data: {
        currentCapital: { increment: entryAmountUsd },
        deployedCapital: { decrement: entryAmountUsd },
      },
    });
  });

  log.warn('Cycle timed out, capital refunded', {
    cycleId: cycle.id.slice(0, 12),
    slug: cycle.slug,
    refunded: cycle.entryAmountUsd,
  });
}
