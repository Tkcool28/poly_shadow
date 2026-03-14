import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { scalpGetOrderBook, paperCalculateFee } from './scalp-executor';
import { ScalpCycleStatus } from '../../../prisma/generated/prisma/client/enums';

const log = createJobLogger('scalp-exit');

interface ExitState {
  cycleId: string;
  tokenId: string;
  entryPrice: number;
  entryShares: number;
  entryAmountUsd: number; // exact amount decremented from capital
  targetSellPrice: number;
  highWaterBid: number;
  startedAt: number;
  stopLossCooldownUntil?: number;
}

export class ScalpExitManager {
  private activeExits = new Map<string, ExitState>();
  private tickOffset = 0;

  /**
   * Track a new position for exit management.
   */
  addPosition(cycleId: string, tokenId: string, entryPrice: number, entryShares: number, estimatedEdge: number, entryAmountUsd: number): void {
    const rawTarget = entryPrice + (estimatedEdge / 100) - (config.SCALP_CONVERGENCE_SELL_DISCOUNT_CENTS / 100);
    // Floor at entryPrice + 1¢ to prevent selling at/below entry (guaranteed loss after fees)
    const targetSellPrice = Math.min(Math.max(rawTarget, entryPrice + 0.01), 0.99);

    this.activeExits.set(cycleId, {
      cycleId,
      tokenId,
      entryPrice,
      entryShares,
      entryAmountUsd,
      targetSellPrice,
      highWaterBid: entryPrice,
      startedAt: Date.now(),
    });

    log.info('Tracking position for exit', {
      cycleId: cycleId.slice(0, 12),
      tokenId: tokenId.slice(0, 20) + '...',
      entryPrice,
      targetSellPrice: targetSellPrice.toFixed(4),
    });
  }

  /**
   * Called every SCALP_ORDER_POLL_INTERVAL_MS (5s).
   * Checks real orderbook bids for convergence sell and stop-loss.
   * Uses round-robin to fairly distribute API reads across positions.
   */
  async tick(): Promise<void> {
    const entries = [...this.activeExits.entries()];
    if (entries.length === 0) return;

    // Rotate starting position each tick for fairness
    const startIdx = this.tickOffset % entries.length;
    this.tickOffset++;

    let uniqueReads = 0;
    const readTokens = new Set<string>();

    for (let i = 0; i < entries.length; i++) {
      const idx = (startIdx + i) % entries.length;
      const [cycleId, exit] = entries[idx];

      // Count only NEW orderbook reads (not cached duplicates)
      // Scale limit with active position count to avoid timeout-induced abandonment
      const maxReadsPerTick = Math.min(Math.max(Math.ceil(entries.length / 3), 5), 20);
      const isNewRead = !readTokens.has(exit.tokenId);
      if (isNewRead && uniqueReads >= maxReadsPerTick) continue; // Defer to next tick

      try {
        await this.checkExit(cycleId, exit);
        if (isNewRead) {
          readTokens.add(exit.tokenId);
          uniqueReads++;
        }
      } catch (err: any) {
        log.warn(`Exit check failed for ${cycleId.slice(0, 12)}: ${err.message}`);
      }
    }
  }

  getActiveCount(): number {
    return this.activeExits.size;
  }

  private async checkExit(cycleId: string, exit: ExitState): Promise<void> {
    const book = await scalpGetOrderBook(exit.tokenId);
    // CLOB API returns bids in ASCENDING order (lowest first).
    // Best (highest) bid is the LAST element.
    const bestBid = parseFloat(book?.bids?.length ? book.bids[book.bids.length - 1].price : '0');

    // Stop-loss: cut position if bid dropped too far below entry
    if (config.SCALP_STOP_LOSS_ENABLED) {
      const lossCents = (exit.entryPrice - bestBid) * 100;
      if (lossCents >= config.SCALP_STOP_LOSS_CENTS) {
        if (!exit.stopLossCooldownUntil || Date.now() >= exit.stopLossCooldownUntil) {
          await this.executeExit(cycleId, exit, bestBid, 'stop_loss');
          return;
        }
      }
    }

    // Convergence sell: take profit when bid reaches target
    if (bestBid >= exit.targetSellPrice) {
      await this.executeExit(cycleId, exit, bestBid, 'convergence_sell');
      return;
    }

    // Trailing stop: lock in gains if price rallied then dropped
    exit.highWaterBid = Math.max(exit.highWaterBid, bestBid);
    const trailDropCents = (exit.highWaterBid - bestBid) * 100;
    const hasGain = exit.highWaterBid > exit.entryPrice + 0.01;
    if (hasGain && trailDropCents >= config.SCALP_TRAILING_STOP_CENTS) {
      await this.executeExit(cycleId, exit, bestBid, 'trailing_stop');
      return;
    }

    // Timeout → sell at current bid to prevent catastrophic settlement losses.
    // Previously this abandoned the position (removed from exit manager, stayed ENTERED in DB).
    // Orphan recovery would re-discover it hours later after match settlement at 0.01 → massive loss.
    if (Date.now() - exit.startedAt > config.SCALP_CONVERGENCE_SELL_TIMEOUT_MS) {
      log.info('Convergence timeout, selling at current bid', {
        cycleId: cycleId.slice(0, 12),
        bestBid: bestBid.toFixed(4),
        target: exit.targetSellPrice.toFixed(4),
        elapsed: `${((Date.now() - exit.startedAt) / 1000).toFixed(0)}s`,
      });
      if (bestBid > 0.01) {
        await this.executeExit(cycleId, exit, bestBid, 'convergence_sell');
      } else {
        // Bid is at floor — hold for settlement (better chance of recovery than selling at 1c)
        this.activeExits.delete(cycleId);
      }
    }
  }

  private async executeExit(
    cycleId: string,
    exit: ExitState,
    bidPrice: number,
    method: 'convergence_sell' | 'stop_loss' | 'trailing_stop',
  ): Promise<void> {
    // Paper mode: simulate sell at bid price with slippage + fees
    const slippage = bidPrice * (config.SCALP_PAPER_SLIPPAGE_FRACTION / 2);
    const sellPrice = Math.max(bidPrice - slippage, 0.01); // Floor at 1¢
    const grossUsd = exit.entryShares * sellPrice;
    const feeShares = paperCalculateFee(exit.entryShares, sellPrice);
    const fee = feeShares * sellPrice;
    const netUsd = grossUsd - fee;
    const pnl = netUsd - exit.entryAmountUsd;

    // Update cycle in DB
    await prisma.$transaction(async (tx) => {
      // Race guard: re-read status
      const fresh = await tx.scalpCycle.findUnique({ where: { id: cycleId } });
      if (!fresh || fresh.status !== ScalpCycleStatus.ENTERED) return;

      await tx.scalpCycle.update({
        where: { id: cycleId },
        data: {
          status: ScalpCycleStatus.SOLD,
          exitPrice: sellPrice,
          exitShares: exit.entryShares,
          exitMethod: method,
          pnl,
          exitedAt: new Date(),
        },
      });

      // Refund capital + P&L (use exact amount that was decremented)
      await tx.scalpCapital.updateMany({
        where: { isPaper: config.SCALP_IS_PAPER },
        data: {
          currentCapital: { increment: exit.entryAmountUsd + pnl },
          deployedCapital: { decrement: exit.entryAmountUsd },
          totalPnl: { increment: pnl },
          totalCycles: { increment: 1 },
          totalWins: pnl > 0 ? { increment: 1 } : undefined,
          dailyLossUsd: pnl < 0 ? { increment: Math.abs(pnl) } : undefined,
        },
      });
    });

    log.info(`Exit: ${method}`, {
      cycleId: cycleId.slice(0, 12),
      entryPrice: exit.entryPrice.toFixed(4),
      bestBid: bidPrice.toFixed(4),
      exitPrice: sellPrice.toFixed(4),
      pnl: pnl.toFixed(4),
      method,
    });

    this.activeExits.delete(cycleId);
  }
}
