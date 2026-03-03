import { prisma } from '../../lib/prisma';
import { createJobLogger } from '../../lib/logger';
import { ArbCycleStatus } from '../../../prisma/generated/prisma/client/enums';
import { config } from '../../config/env';
import { getMarketBySlug } from '../../api/gamma-api';
import { isShuttingDown } from '../../lib/shutdown';
import { calculateFee } from './arb-engine';
import { arbExecuteOrder } from './arb-executor';
import { pruneCache } from './market-discovery';

const log = createJobLogger('arb-settlement');

const PRUNE_INTERVAL_MS = 3_600_000; // 1 hour
let lastPruneAt = 0;

// Stop-loss cooldown: prevents repeated SELL orders when FOK fails (API spam guard)
const stopLossAttemptedAt = new Map<string, number>(); // cycleId → last attempt ms
const STOP_LOSS_COOLDOWN_MS = 60_000; // 1 min between retry attempts per position

/**
 * Background settlement sweep — runs periodically from arb-worker.
 *
 * 1. Queries all ArbCycle with status=ENTERED for current mode (paper/live)
 * 2. Batch-fetches markets via Promise.allSettled (one API failure doesn't block others)
 * 3. Settles resolved markets atomically (ArbCapital + ArbCycle in one transaction)
 * 4. Times out cycles that exceed ARB_SETTLEMENT_TIMEOUT_MS
 */
export async function sweepArbSettlements(): Promise<void> {
  // Prune stale market discovery cache (throttled to once per hour)
  const now = Date.now();
  if (now - lastPruneAt >= PRUNE_INTERVAL_MS) {
    pruneCache();
    lastPruneAt = now;
  }

  const enteredCycles = await prisma.arbCycle.findMany({
    where: {
      status: ArbCycleStatus.ENTERED,
      isPaper: config.ARB_IS_PAPER,
    },
  });

  if (enteredCycles.length === 0) return;

  // Collect unique slugs and batch-fetch markets
  const uniqueSlugs = [...new Set(enteredCycles.map((c) => c.slug))];
  const marketResults = await Promise.allSettled(
    uniqueSlugs.map((slug) => getMarketBySlug(slug)),
  );

  // Build slug → market data map
  const marketMap = new Map<string, { closed: boolean; outcomes: string; outcomePrices?: string | null }>();
  for (let i = 0; i < uniqueSlugs.length; i++) {
    const result = marketResults[i];
    if (result.status === 'fulfilled' && result.value) {
      marketMap.set(uniqueSlugs[i], result.value);
    }
  }

  let settled = 0;
  let pending = 0;
  let timedOut = 0;
  let stopLossCount = 0;

  for (const cycle of enteredCycles) {
    if (isShuttingDown()) break;

    const market = marketMap.get(cycle.slug);

    // Check if market is resolved
    if (market?.closed && market.outcomePrices) {
      try {
        const outcomes: string[] = JSON.parse(market.outcomes);
        const prices: number[] = JSON.parse(market.outcomePrices).map(Number);
        const ourOutcome = cycle.direction === 'UP' ? 'up' : 'down';
        const idx = outcomes.findIndex((o) => o.toLowerCase() === ourOutcome);

        if (idx === -1 || idx >= prices.length) {
          log.warn(`Outcome "${ourOutcome}" not found in market ${cycle.slug}`, { outcomes });
          continue;
        }

        const settlementPrice = prices[idx];
        if (!Number.isFinite(settlementPrice)) continue;

        const settlementValue = (cycle.entryShares ?? 0) * settlementPrice;
        const estimatedFee = calculateFee(cycle.entryShares ?? 0, cycle.entryPrice ?? 0);
        const pnl = settlementValue - (cycle.entryAmountUsd ?? 0) - estimatedFee;
        const won = settlementPrice >= 0.95;

        // Atomic: update capital + cycle status
        const didSettle = await prisma.$transaction(async (tx) => {
          // Guard: only settle if still ENTERED (prevents double-exit with stop-loss)
          const current = await tx.arbCycle.findUnique({
            where: { id: cycle.id },
            select: { status: true },
          });
          if (current?.status !== ArbCycleStatus.ENTERED) return false;

          const fresh = await tx.arbCapital.findUniqueOrThrow({
            where: { isPaper: cycle.isPaper },
          });

          await tx.arbCapital.update({
            where: { isPaper: cycle.isPaper },
            data: {
              currentCapital: { increment: settlementValue },
              deployedCapital: { decrement: Math.min(cycle.entryAmountUsd ?? 0, fresh.deployedCapital) },
              totalPnl: { increment: pnl },
              totalCycles: { increment: 1 },
              totalWins: { increment: won ? 1 : 0 },
            },
          });

          await tx.arbCycle.update({
            where: { id: cycle.id },
            data: {
              status: won ? ArbCycleStatus.WON : ArbCycleStatus.LOST,
              settlementPrice,
              pnl,
              estimatedFee,
              resolvedAt: new Date(),
            },
          });

          return true;
        });

        if (didSettle) {
          settled++;
          log.info(`${won ? 'WON' : 'LOST'} ${cycle.direction}`, {
            market: cycle.marketType,
            slug: cycle.slug,
            settlementPrice: settlementPrice.toFixed(4),
            pnl: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
          });
        }
      } catch (err: any) {
        log.error(`Settlement failed for ${cycle.slug}: ${err.message}`);
      }
      continue;
    }

    // Market not yet resolved — check stop-loss, then timeout

    // Stop-loss: sell early if outcome price dropped too far
    // Skip for contrarian/low-entry positions — max loss is already capped at entry price,
    // and the token price will always be below the stop-loss threshold (e.g., entry $0.05 < stop $0.50)
    if (config.ARB_STOP_LOSS_ENABLED
        && market && !market.closed && market.outcomePrices
        && cycle.tokenId && cycle.entryShares && cycle.entryShares > 0
        && cycle.entryPrice && cycle.entryPrice > config.ARB_STOP_LOSS_PRICE) {
      try {
        const outcomes: string[] = JSON.parse(market.outcomes);
        const prices: number[] = JSON.parse(market.outcomePrices).map(Number);
        const ourOutcome = cycle.direction === 'UP' ? 'up' : 'down';
        const idx = outcomes.findIndex((o) => o.toLowerCase() === ourOutcome);

        if (idx !== -1 && idx < prices.length) {
          const currentPrice = prices[idx];

          if (Number.isFinite(currentPrice) && currentPrice < config.ARB_STOP_LOSS_PRICE) {
            // Cooldown: don't retry SELL more than once per minute (prevents FOK spam)
            const lastAttempt = stopLossAttemptedAt.get(cycle.id);
            if (lastAttempt && Date.now() - lastAttempt < STOP_LOSS_COOLDOWN_MS) {
              pending++; // still watching, just cooling down
              continue;
            }
            stopLossAttemptedAt.set(cycle.id, Date.now());

            const sellResult = await arbExecuteOrder({
              tokenId: cycle.tokenId,
              side: 'SELL',
              amount: cycle.entryShares,
              detectedPrice: currentPrice,
            });

            if (sellResult.status === 'FILLED' && sellResult.filledSize && sellResult.filledPrice) {
              const saleProceeds = sellResult.filledSize * sellResult.filledPrice;
              const pnl = saleProceeds - (cycle.entryAmountUsd ?? 0);

              const updated = await prisma.$transaction(async (tx) => {
                const current = await tx.arbCycle.findUnique({
                  where: { id: cycle.id },
                  select: { status: true },
                });
                if (current?.status !== ArbCycleStatus.ENTERED) return false;

                const fresh = await tx.arbCapital.findUniqueOrThrow({
                  where: { isPaper: cycle.isPaper },
                });

                await tx.arbCapital.update({
                  where: { isPaper: cycle.isPaper },
                  data: {
                    currentCapital: { increment: saleProceeds },
                    deployedCapital: { decrement: Math.min(cycle.entryAmountUsd ?? 0, fresh.deployedCapital) },
                    totalPnl: { increment: pnl },
                    totalCycles: { increment: 1 },
                  },
                });

                await tx.arbCycle.update({
                  where: { id: cycle.id },
                  data: {
                    status: ArbCycleStatus.STOPPED,
                    settlementPrice: sellResult.filledPrice,
                    pnl,
                    failReason: `stop-loss: price $${currentPrice.toFixed(3)} < $${config.ARB_STOP_LOSS_PRICE} threshold`,
                    resolvedAt: new Date(),
                  },
                });

                return true;
              });

              if (updated) {
                stopLossAttemptedAt.delete(cycle.id); // clear cooldown on success
                stopLossCount++;
                log.info(`STOP-LOSS ${cycle.direction}`, {
                  market: cycle.marketType,
                  slug: cycle.slug,
                  outcomePrice: currentPrice.toFixed(4),
                  salePrice: sellResult.filledPrice.toFixed(4),
                  pnl: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
                  recovered: `$${saleProceeds.toFixed(2)}`,
                });
              }
              continue;
            } else {
              log.warn(`Stop-loss SELL failed for ${cycle.slug}`, {
                reason: sellResult.failReason,
              });
            }
          }
        }
      } catch (err: any) {
        log.error(`Stop-loss check failed for ${cycle.slug}: ${err.message}`);
      }
    }

    // Timeout check
    const now = new Date();

    if (!cycle.settlementStartedAt) {
      await prisma.arbCycle.update({
        where: { id: cycle.id },
        data: { settlementStartedAt: now },
      });
      pending++;
      continue;
    }

    const elapsed = now.getTime() - cycle.settlementStartedAt.getTime();
    if (elapsed > config.ARB_SETTLEMENT_TIMEOUT_MS) {
      try {
        const didTimeout = await prisma.$transaction(async (tx) => {
          const current = await tx.arbCycle.findUnique({
            where: { id: cycle.id },
            select: { status: true },
          });
          if (current?.status !== ArbCycleStatus.ENTERED) return false;

          const fresh = await tx.arbCapital.findUniqueOrThrow({
            where: { isPaper: cycle.isPaper },
          });
          const refundAmount = cycle.entryAmountUsd ?? 0;

          await tx.arbCapital.update({
            where: { isPaper: cycle.isPaper },
            data: {
              currentCapital: { increment: refundAmount },
              deployedCapital: { decrement: Math.min(refundAmount, fresh.deployedCapital) },
            },
          });

          await tx.arbCycle.update({
            where: { id: cycle.id },
            data: {
              status: ArbCycleStatus.FAILED,
              failReason: `resolution timeout (${Math.round(elapsed / 1000)}s)`,
            },
          });

          return true;
        });

        if (didTimeout) {
          timedOut++;
          log.warn(`Timeout: ${cycle.slug} unresolved after ${Math.round(elapsed / 1000)}s, refunded $${(cycle.entryAmountUsd ?? 0).toFixed(2)}`);
        }
      } catch (err: any) {
        log.error(`Timeout refund failed for ${cycle.slug}: ${err.message}`);
      }
    } else {
      pending++;
    }
  }

  if (settled > 0 || timedOut > 0 || pending > 0 || stopLossCount > 0) {
    log.info('Settlement sweep', { settled, pending, timedOut, stopLoss: stopLossCount });
  }
}
