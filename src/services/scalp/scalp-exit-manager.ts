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
      const isNewRead = !readTokens.has(exit.tokenId);
      if (isNewRead && uniqueReads >= 5) continue; // Defer to next tick

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
    const bestBid = parseFloat(book?.bids?.[0]?.price ?? '0');

    if (bestBid < config.SCALP_MIN_MEANINGFUL_BID) {
      log.debug('Bid below meaningful threshold, holding for settlement', {
        cycleId: cycleId.slice(0, 12),
        bestBid: bestBid.toFixed(4),
        threshold: config.SCALP_MIN_MEANINGFUL_BID,
      });
      return; // Skip stop-loss — let convergence timeout → settlement handle it
    }

    // Stop-loss check
    const stopLossPrice = exit.entryPrice - config.SCALP_STOP_LOSS_CENTS / 100;
    if (bestBid < stopLossPrice) {
      await this.executeExit(cycleId, exit, bestBid, 'stop_loss');
      return;
    }

    // Convergence sell check
    if (bestBid >= exit.targetSellPrice) {
      await this.executeExit(cycleId, exit, bestBid, 'convergence_sell');
      return;
    }

    // Timeout → hold for settlement
    if (Date.now() - exit.startedAt > config.SCALP_CONVERGENCE_SELL_TIMEOUT_MS) {
      log.info('Convergence timeout, holding for settlement', {
        cycleId: cycleId.slice(0, 12),
        elapsed: `${((Date.now() - exit.startedAt) / 1000).toFixed(0)}s`,
      });
      this.activeExits.delete(cycleId);
      // Cycle stays ENTERED — settlement sweep will handle it
    }
  }

  private async executeExit(
    cycleId: string,
    exit: ExitState,
    bidPrice: number,
    method: 'convergence_sell' | 'stop_loss',
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
