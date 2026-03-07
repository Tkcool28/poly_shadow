import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { scalpExecuteOrder, scalpGetOrderBook } from './scalp-executor';
import {
  getMarketByTeamPair,
  getMarketByTokenId,
} from './scalp-market-discovery';
import { ScalpExitManager } from './scalp-exit-manager';
import { estimateSeriesFairValue, type GameEvent, type BotSignal, type ScalpSignal } from './scalp-types';
import { ScalpCycleStatus } from '../../../prisma/generated/prisma/client/enums';
import type { ScalpMarketWatchModel as ScalpMarketWatch } from '../../../prisma/generated/prisma/client/models/ScalpMarketWatch';

const log = createJobLogger('scalp-engine');

// Per-market processing lock to prevent double-entry
const processingLock = new Map<string, { cycleId: string; timestamp: number }>();
const LOCK_EXPIRY_MS = 30_000;

export class ScalpEngine {
  readonly exitManager = new ScalpExitManager();

  /**
   * Handle a game API event (map_win, series_end).
   */
  async onGameEvent(event: GameEvent): Promise<void> {
    const market = getMarketByTeamPair(event.winner, event.loser);
    if (!market) {
      log.debug('No market found for game event', {
        game: event.game,
        winner: event.winner,
        loser: event.loser,
      });
      return;
    }

    // Only trade series markets in Phase 1
    if (market.marketType !== 'series') return;

    // Find the winning team's token
    const tokenInfo = resolveWinnerToken(market, event.winner);
    if (!tokenInfo) {
      log.warn('Cannot resolve winner token', {
        slug: market.slug,
        winner: event.winner,
        outcomes: market.outcomes,
      });
      return;
    }

    // Check processing lock (prevent double-entry from bot + game API)
    const lockKey = tokenInfo.tokenId;
    const existingLock = processingLock.get(lockKey);
    if (existingLock && Date.now() - existingLock.timestamp < LOCK_EXPIRY_MS) {
      // Already processing or entered for this token — upgrade confidence if possible
      log.info('Lock exists, skipping duplicate entry', {
        slug: market.slug,
        existingCycleId: existingLock.cycleId.slice(0, 12),
      });

      // Try to upgrade signal source to 'both'
      try {
        await prisma.scalpCycle.updateMany({
          where: { id: existingLock.cycleId, signalSource: 'bot' },
          data: { signalSource: 'both', signalConfidence: 'HIGH' },
        });
      } catch {}
      return;
    }

    // Estimate fair value
    const currentPrice = await getCurrentPrice(tokenInfo.tokenId);
    if (currentPrice === null) {
      log.warn('Cannot get current price, skipping game event', { slug: market.slug });
      return;
    }
    const fairValue = estimateSeriesFairValue(
      event.seriesScore,
      event.seriesFormat,
      currentPrice,
    );

    await this.evaluateAndEnter({
      matchId: event.matchId,
      game: event.game,
      slug: market.slug,
      conditionId: market.conditionId,
      tokenId: tokenInfo.tokenId,
      outcomeLabel: tokenInfo.outcomeLabel,
      eventType: event.eventType,
      eventSequence: event.mapNumber,
      eventDetail: JSON.stringify({
        seriesScore: event.seriesScore,
        seriesFormat: event.seriesFormat,
        isDecisive: event.isSeriesDecisive,
      }),
      signalSource: 'game_api',
      signalConfidence: 'MEDIUM',
      estimatedFairValue: fairValue,
      currentAsk: currentPrice,
      estimatedEdge: (fairValue - currentPrice) * 100, // in cents
      timestamp: event.timestamp,
    });
  }

  /**
   * Handle a bot detection signal (fast bot bought on trade stream).
   */
  async onBotSignal(signal: BotSignal): Promise<void> {
    const market = getMarketByTokenId(signal.tokenId);
    if (!market) return;

    if (market.marketType !== 'series') return;

    // Find which outcome this token is
    const tokenInfo = resolveTokenOutcome(market, signal.tokenId);
    if (!tokenInfo) return;

    // Check processing lock
    const existingLock = processingLock.get(signal.tokenId);
    if (existingLock && Date.now() - existingLock.timestamp < LOCK_EXPIRY_MS) {
      log.debug('Lock exists for bot signal, skipping', { slug: market.slug });
      return;
    }

    // For bot signals, edge estimation is simpler:
    // assume the bot knows the result and fair value is ~15-25% higher
    const currentAsk = signal.avgPrice;
    const estimatedFairValue = Math.min(currentAsk + 0.15, 0.95); // conservative: +15¢
    const estimatedEdge = (estimatedFairValue - currentAsk) * 100;

    await this.evaluateAndEnter({
      matchId: `bot-${signal.tokenId.slice(0, 16)}-${Date.now()}`,
      game: market.game as any,
      slug: market.slug,
      conditionId: market.conditionId,
      tokenId: signal.tokenId,
      outcomeLabel: tokenInfo.outcomeLabel,
      eventType: 'bot_signal' as any,
      eventSequence: 0,
      eventDetail: JSON.stringify({
        botTotalUsd: signal.totalUsd,
        botTradeCount: signal.tradeCount,
        botAvgPrice: signal.avgPrice,
      }),
      signalSource: 'bot',
      signalConfidence: 'MEDIUM',
      estimatedFairValue,
      currentAsk,
      estimatedEdge,
      timestamp: signal.timestamp,
    });
  }

  /**
   * Core entry logic: check edge, check capital, execute order.
   */
  private async evaluateAndEnter(signal: ScalpSignal): Promise<void> {
    const startMs = Date.now();

    // Edge check
    if (signal.estimatedEdge < config.SCALP_MIN_EDGE_CENTS) {
      log.debug('Edge too small, skipping', {
        slug: signal.slug,
        edge: signal.estimatedEdge.toFixed(1),
        minEdge: config.SCALP_MIN_EDGE_CENTS,
      });
      await recordCycle(signal, 'SKIPPED', `edge too small: ${signal.estimatedEdge.toFixed(1)}¢`);
      return;
    }

    // Daily loss check
    const capital = await prisma.scalpCapital.findUnique({
      where: { isPaper: config.SCALP_IS_PAPER },
    });
    if (!capital) {
      log.warn('No ScalpCapital record found');
      return;
    }

    // Reset daily loss at midnight UTC
    const now = new Date();
    if (capital.dailyLossResetAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
      await prisma.scalpCapital.update({
        where: { isPaper: config.SCALP_IS_PAPER },
        data: { dailyLossUsd: 0, dailyLossResetAt: now },
      });
    } else if (capital.dailyLossUsd >= config.SCALP_MAX_DAILY_LOSS_USD) {
      log.warn('Daily loss limit reached, skipping', { dailyLoss: capital.dailyLossUsd });
      await recordCycle(signal, 'SKIPPED', 'daily loss limit');
      return;
    }

    // Guard: invalid currentAsk would cause division-by-zero in liquidity check
    if (signal.currentAsk <= 0 || signal.currentAsk >= 1) {
      log.warn('Invalid currentAsk, skipping', { slug: signal.slug, currentAsk: signal.currentAsk });
      await recordCycle(signal, 'SKIPPED', `invalid price: ${signal.currentAsk}`);
      return;
    }

    // Paper mode: check real orderbook liquidity
    if (config.SCALP_IS_PAPER) {
      const book = await scalpGetOrderBook(signal.tokenId);
      if (!book) {
        log.warn('Orderbook unavailable, skipping', { slug: signal.slug, tokenId: signal.tokenId.slice(0, 20) });
        await recordCycle(signal, 'SKIPPED', 'orderbook unavailable');
        return;
      }
      const availableShares = (book.asks ?? [])
        .filter((a) => parseFloat(a.price) <= signal.currentAsk + 0.02)
        .reduce((sum, a) => sum + parseFloat(a.size), 0);
      const requiredShares = config.SCALP_POSITION_SIZE_USD / signal.currentAsk;
      if (availableShares < requiredShares) {
        log.info('Insufficient orderbook liquidity', {
          slug: signal.slug,
          available: availableShares.toFixed(0),
          required: requiredShares.toFixed(0),
        });
        await recordCycle(signal, 'SKIPPED', 'insufficient liquidity');
        return;
      }
    }

    // Atomic capital decrement FIRST (prevents over-deployment race)
    const amount = config.SCALP_POSITION_SIZE_USD;
    const reserved = await atomicDecrementCapital(amount);
    if (!reserved) {
      log.warn('Insufficient capital', { slug: signal.slug, amount });
      await recordCycle(signal, 'SKIPPED', 'insufficient capital');
      return;
    }

    try {
      // Execute order
      const result = await scalpExecuteOrder({
        tokenId: signal.tokenId,
        side: 'BUY',
        amount,
        price: signal.currentAsk + 0.01, // cross the spread by 1 tick
      });

      if (result.status !== 'FILLED' || !result.filledPrice || !result.filledSize) {
        // Refund capital on miss
        await atomicRefundCapital(amount);
        await recordCycle(signal, 'SKIPPED', result.failReason ?? 'not filled');
        return;
      }

      const latencyMs = Date.now() - startMs;

      // Record cycle
      const cycle = await prisma.scalpCycle.create({
        data: {
          game: signal.game,
          matchId: signal.matchId,
          slug: signal.slug,
          conditionId: signal.conditionId,
          marketQuestion: null,
          outcomeLabel: signal.outcomeLabel,
          tokenId: signal.tokenId,
          eventType: signal.eventType,
          eventSequence: signal.eventSequence,
          eventDetail: signal.eventDetail,
          signalSource: signal.signalSource,
          signalConfidence: signal.signalConfidence,
          entryPrice: result.filledPrice,
          entryShares: result.filledSize,
          entryAmountUsd: amount,
          entryOrderId: result.orderId,
          entryOrderType: 'FAK',
          entryLatencyMs: latencyMs,
          estimatedEdge: signal.estimatedEdge,
          status: ScalpCycleStatus.ENTERED,
          isPaper: config.SCALP_IS_PAPER,
          enteredAt: new Date(),
        },
      });

      // Set processing lock
      processingLock.set(signal.tokenId, { cycleId: cycle.id, timestamp: Date.now() });

      // Add to exit manager (pass exact amount decremented for capital accounting)
      this.exitManager.addPosition(
        cycle.id,
        signal.tokenId,
        result.filledPrice,
        result.filledSize,
        signal.estimatedEdge,
        amount,
      );

      log.info('ENTERED position', {
        cycleId: cycle.id.slice(0, 12),
        slug: signal.slug,
        outcome: signal.outcomeLabel,
        entryPrice: result.filledPrice.toFixed(4),
        shares: result.filledSize.toFixed(2),
        edge: `${signal.estimatedEdge.toFixed(1)}¢`,
        latency: `${latencyMs}ms`,
        signal: signal.signalSource,
        mode: config.SCALP_IS_PAPER ? 'PAPER' : 'LIVE',
      });
    } catch (err: any) {
      // Refund capital on error
      await atomicRefundCapital(amount);
      await recordCycle(signal, 'FAILED', err.message);
      log.error('Entry failed', { slug: signal.slug, error: err.message });
    }
  }
}

// ─── Helpers ───

async function getCurrentPrice(tokenId: string): Promise<number | null> {
  const book = await scalpGetOrderBook(tokenId);
  if (!book?.asks?.length) return null;
  return parseFloat(book.asks[0].price);
}

function resolveWinnerToken(
  market: ScalpMarketWatch,
  winnerName: string,
): { tokenId: string; outcomeLabel: string } | null {
  try {
    const outcomes: string[] = JSON.parse(market.outcomes);
    const tokenIds: string[] = JSON.parse(market.clobTokenIds);

    const normalizedWinner = winnerName.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

    // First pass: exact match only
    for (let i = 0; i < outcomes.length; i++) {
      const normalizedOutcome = outcomes[i].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedOutcome === normalizedWinner) {
        return { tokenId: tokenIds[i], outcomeLabel: outcomes[i].trim() };
      }
    }

    // Second pass: fuzzy match for longer names only (>3 chars both sides)
    for (let i = 0; i < outcomes.length; i++) {
      const normalizedOutcome = outcomes[i].trim().toLowerCase().replace(/[^a-z0-9]/g, '');
      if (normalizedWinner.length > 3 && normalizedOutcome.length > 3) {
        if (normalizedOutcome.includes(normalizedWinner) || normalizedWinner.includes(normalizedOutcome)) {
          const overlap = Math.min(normalizedWinner.length, normalizedOutcome.length) /
                          Math.max(normalizedWinner.length, normalizedOutcome.length);
          if (overlap > 0.7) {
            log.warn('Fuzzy team match used', {
              winner: winnerName,
              matched: outcomes[i].trim(),
              overlap: overlap.toFixed(2),
            });
            return { tokenId: tokenIds[i], outcomeLabel: outcomes[i].trim() };
          }
        }
      }
    }
  } catch {}
  return null;
}

function resolveTokenOutcome(
  market: ScalpMarketWatch,
  tokenId: string,
): { outcomeLabel: string; outcomeIndex: number } | null {
  try {
    const outcomes: string[] = JSON.parse(market.outcomes);
    const tokenIds: string[] = JSON.parse(market.clobTokenIds);
    const idx = tokenIds.indexOf(tokenId);
    if (idx >= 0 && idx < outcomes.length) {
      return { outcomeLabel: outcomes[idx].trim(), outcomeIndex: idx };
    }
  } catch {}
  return null;
}

async function atomicDecrementCapital(amount: number): Promise<boolean> {
  const result = await prisma.scalpCapital.updateMany({
    where: {
      isPaper: config.SCALP_IS_PAPER,
      currentCapital: { gte: amount },
    },
    data: {
      currentCapital: { decrement: amount },
      deployedCapital: { increment: amount },
    },
  });
  return result.count > 0;
}

async function atomicRefundCapital(amount: number): Promise<void> {
  await prisma.scalpCapital.updateMany({
    where: { isPaper: config.SCALP_IS_PAPER },
    data: {
      currentCapital: { increment: amount },
      deployedCapital: { decrement: amount },
    },
  });
}

async function recordCycle(
  signal: ScalpSignal,
  status: 'SKIPPED' | 'FAILED',
  failReason: string,
): Promise<void> {
  try {
    await prisma.scalpCycle.create({
      data: {
        game: signal.game,
        matchId: signal.matchId,
        slug: signal.slug,
        conditionId: signal.conditionId,
        outcomeLabel: signal.outcomeLabel,
        tokenId: signal.tokenId,
        eventType: signal.eventType,
        eventSequence: signal.eventSequence,
        eventDetail: signal.eventDetail,
        signalSource: signal.signalSource,
        signalConfidence: signal.signalConfidence,
        estimatedEdge: signal.estimatedEdge,
        status: status === 'SKIPPED' ? ScalpCycleStatus.SKIPPED : ScalpCycleStatus.FAILED,
        failReason,
        isPaper: config.SCALP_IS_PAPER,
      },
    });
  } catch (err: any) {
    // Unique constraint violation = already recorded, which is fine
    if (!err.message?.includes('P2002')) {
      log.warn(`Failed to record ${status} cycle: ${err.message}`);
    }
  }
}

// Clean up stale processing locks periodically
export function cleanupProcessingLocks(): void {
  const now = Date.now();
  for (const [key, lock] of processingLock) {
    if (now - lock.timestamp > LOCK_EXPIRY_MS) {
      processingLock.delete(key);
    }
  }
}
