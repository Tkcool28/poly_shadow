import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { scalpGetOrderBook } from './scalp-executor';
import { getMarketByTokenId } from './scalp-market-discovery';
import type { EnhancedBotSignal } from './scalp-types';

const log = createJobLogger('scalp-signal-logger');

/**
 * Logs enhanced bot signals to ScalpSignalLog and schedules forward price snapshots
 * at T+30s, T+1m, T+5m, and T+10m to evaluate signal quality after the fact.
 */
export class ScalpSignalLogger {
  private pendingTimers = new Set<ReturnType<typeof setTimeout>>();

  /**
   * Log a signal to the database and schedule forward price snapshots.
   */
  async logSignal(signal: EnhancedBotSignal): Promise<void> {
    try {
      // Get current orderbook for spread info
      const book = await scalpGetOrderBook(signal.tokenId);
      // CLOB API: bids ascending (last = best), asks descending (last = best)
      const bestBid = parseFloat(book?.bids?.length ? book.bids[book.bids.length - 1].price : '0');
      const bestAsk = parseFloat(book?.asks?.length ? book.asks[book.asks.length - 1].price : '0');
      const spread = bestAsk && bestBid ? bestAsk - bestBid : null;
      const market = getMarketByTokenId(signal.tokenId);

      // Use avgBuyPrice as baseline when spread is too wide (illiquid book)
      // A spread > 0.10 means the orderbook is empty and bestAsk is meaningless
      const meaningfulAsk = spread !== null && spread < 0.10 ? bestAsk : 0;
      const priceAtSignal = meaningfulAsk || signal.avgPrice;

      const row = await prisma.scalpSignalLog.create({
        data: {
          tokenId: signal.tokenId,
          slug: market?.slug ?? null,
          game: market?.game ?? null,
          signalType: 'flow_imbalance',
          buyVolumeUsd: signal.buyVolumeUsd,
          sellVolumeUsd: signal.sellVolumeUsd,
          netImbalance: signal.netImbalance,
          tradeCount: signal.tradeCount,
          avgBuyPrice: signal.avgPrice,
          priceAtSignal,
          bidAtSignal: bestBid || null,
          spreadAtSignal: spread,
          confidenceScore: signal.confidenceScore,
        },
      });

      this.scheduleSnapshots(row.id, signal.tokenId);
    } catch (err: any) {
      log.error(`Failed to log signal for ${signal.tokenId.slice(0, 20)}: ${err.message}`);
    }
  }

  /**
   * Schedule forward price snapshots at 30s, 1m, 5m, and 10m after signal.
   */
  private scheduleSnapshots(signalId: string, tokenId: string): void {
    const intervals = [
      { field: '30s' as const, delayMs: 30_000 },
      { field: '1m' as const, delayMs: 60_000 },
      { field: '5m' as const, delayMs: 300_000 },
      { field: '10m' as const, delayMs: 600_000 },
    ];

    for (const { field, delayMs } of intervals) {
      const timer = setTimeout(async () => {
        this.pendingTimers.delete(timer);
        await this.recordSnapshot(signalId, tokenId, field);
      }, delayMs);
      timer.unref(); // Don't keep process alive
      this.pendingTimers.add(timer);
    }
  }

  /**
   * Record a single price snapshot for a signal at a given time offset.
   */
  private async recordSnapshot(
    signalId: string,
    tokenId: string,
    field: '30s' | '1m' | '5m' | '10m',
  ): Promise<void> {
    try {
      const book = await scalpGetOrderBook(tokenId);
      // CLOB API: bids ascending (last = best), asks descending (last = best)
      const rawAsk = parseFloat(book?.asks?.length ? book.asks[book.asks.length - 1].price : '0');
      const bid = parseFloat(book?.bids?.length ? book.bids[book.bids.length - 1].price : '0') || null;
      const spread = rawAsk && bid ? rawAsk - bid : null;
      // Use bid as price reference for BUY signals (can we sell at a profit?)
      // Fall back to ask only when spread is tight (liquid book)
      const price = (spread !== null && spread < 0.10 ? rawAsk : bid) || null;

      const priceField = `priceAt${field}` as const;
      const bidField = `bidAt${field}` as const;

      const updateData: Record<string, any> = {};
      updateData[priceField] = price;
      updateData[bidField] = bid;

      // On last snapshot (10m), compute derived outcome fields
      if (field === '10m') {
        const row = await prisma.scalpSignalLog.findUnique({ where: { id: signalId } });
        if (row) {
          const prices = [row.priceAt30s, row.priceAt1m, row.priceAt5m, price].filter(
            (p): p is number => p !== null && p > 0,
          );
          if (prices.length > 0) {
            updateData.maxPriceAfter = Math.max(...prices);
            updateData.minPriceAfter = Math.min(...prices);
            updateData.wouldHaveWon = Math.max(...prices) > row.priceAtSignal;
          }
        }
      }

      await prisma.scalpSignalLog.update({
        where: { id: signalId },
        data: updateData,
      });
    } catch (err: any) {
      // Non-critical — snapshot failure is acceptable
      log.warn(`Snapshot ${field} failed for signal ${signalId.slice(0, 12)}: ${err.message}`);
    }
  }

  /**
   * Clear all pending snapshot timers (for graceful shutdown).
   */
  clearPendingTimers(): void {
    for (const timer of this.pendingTimers) {
      clearTimeout(timer);
    }
    this.pendingTimers.clear();
  }
}
