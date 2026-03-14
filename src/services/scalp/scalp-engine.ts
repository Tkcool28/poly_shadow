import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { scalpExecuteOrder, scalpGetOrderBook } from './scalp-executor';
import {
  getMarketByTeamPair,
  getMarketByTokenId,
} from './scalp-market-discovery';
import { ScalpExitManager } from './scalp-exit-manager';
import { estimateSeriesFairValue, estimateInGameProbShift, type GameEvent, type BotSignal, type EnhancedBotSignal, type ScalpSignal } from './scalp-types';
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

    // Check processing lock (per-MARKET slug, not per-token)
    const lockKey = market.slug;
    const existingLock = processingLock.get(lockKey);
    if (existingLock && Date.now() - existingLock.timestamp < LOCK_EXPIRY_MS) {
      // Already processing or entered for this market — upgrade confidence if possible
      log.info('Market lock exists, skipping duplicate entry', {
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

    // Set lock EAGERLY before async work to prevent race condition
    processingLock.set(lockKey, { cycleId: `pending-${Date.now()}`, timestamp: Date.now() });

    // Estimate fair value
    const currentPrice = await getCurrentPrice(tokenInfo.tokenId);
    if (currentPrice === null) {
      log.warn('Cannot get current price, skipping game event', { slug: market.slug });
      processingLock.delete(lockKey); // Release eager lock on failure
      return;
    }

    let fairValue: number;
    if (event.eventType === 'baron_kill' || event.eventType === 'elder_dragon') {
      // In-game event: additive probability shift model
      const isDecisiveGame = (event.rawData?.isDecisiveGame as boolean) ?? false;
      const shift = estimateInGameProbShift(event.eventType, isDecisiveGame);
      fairValue = Math.max(Math.min(currentPrice + shift, 0.95), 0.05);
    } else {
      // Series-level event (map_win / series_end): binomial model
      fairValue = estimateSeriesFairValue(
        event.seriesScore,
        event.seriesFormat,
        currentPrice,
      );
    }

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
   * FOLLOW MODE: bot buys token A → we also buy token A.
   */
  async onBotSignal(signal: BotSignal | EnhancedBotSignal): Promise<void> {
    const market = getMarketByTokenId(signal.tokenId);
    if (!market) return;

    if (market.marketType !== 'series') return;

    // Find which outcome this token is
    const tokenInfo = resolveTokenOutcome(market, signal.tokenId);
    if (!tokenInfo) return;

    // Check processing lock (per-MARKET slug, not per-token)
    const lockKey = market.slug;
    const existingLock = processingLock.get(lockKey);
    if (existingLock && Date.now() - existingLock.timestamp < LOCK_EXPIRY_MS) {
      log.debug('Market lock exists for bot signal, skipping', { slug: market.slug });
      return;
    }

    // Set lock EAGERLY before async work to prevent race condition
    // (previously 3 signals in 71ms all passed lock check before any set it)
    processingLock.set(lockKey, { cycleId: `pending-${Date.now()}`, timestamp: Date.now() });

    // Get the actual current ask from orderbook (not bot's avg price)
    const currentAsk = await getCurrentPrice(signal.tokenId);
    if (currentAsk === null || currentAsk <= 0 || currentAsk >= 1) {
      log.debug('Cannot get current price, skipping', { slug: market.slug });
      processingLock.delete(lockKey); // Release eager lock on failure
      return;
    }

    // Reject high-price entries: risk/reward is terrible (e.g., buy at 0.80 → lose 80c if wrong, gain 20c if right)
    if (currentAsk > 0.75) {
      log.debug('Entry price too high, skipping', { slug: market.slug, currentAsk: currentAsk.toFixed(4) });
      processingLock.delete(lockKey);
      return;
    }

    // Dynamic edge from order flow analysis, or legacy hardcoded 15c
    let estimatedFairValue: number;
    let estimatedEdge: number;

    if (config.SCALP_DYNAMIC_EDGE && 'netImbalance' in signal) {
      const enhanced = signal as EnhancedBotSignal;
      // Reduced from 0.10 to 0.05: avg edge was 8c but avg max move is only 7.1c, making targets unreachable
      const imbalanceEdge = Math.max(enhanced.netImbalance, 0) * 0.05;
      const magnitudeEdge = Math.min(enhanced.totalUsd / 1000, 0.05);
      const rawEdge = (imbalanceEdge + magnitudeEdge) * enhanced.confidenceScore;
      estimatedFairValue = Math.min(currentAsk + rawEdge, 0.95);
      estimatedEdge = rawEdge * 100;
    } else if (config.SCALP_DYNAMIC_EDGE) {
      // SCALP_DYNAMIC_EDGE is on but signal lacks netImbalance (legacy BotSignal).
      // Reject: the hardcoded 15c fallback lets every signal through indiscriminately.
      log.debug('Rejecting legacy signal without netImbalance (SCALP_DYNAMIC_EDGE=true)', {
        slug: market.slug,
        tokenId: signal.tokenId.slice(0, 20),
      });
      processingLock.delete(lockKey);
      return;
    } else {
      estimatedFairValue = Math.min(currentAsk + 0.15, 0.95);
      estimatedEdge = (estimatedFairValue - currentAsk) * 100;
    }

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
      signalConfidence: signal.confidence === 'HIGH' ? 'HIGH' : 'MEDIUM',
      estimatedFairValue,
      currentAsk,
      estimatedEdge,
      timestamp: signal.timestamp,
      confidenceScore: 'confidenceScore' in signal ? (signal as EnhancedBotSignal).confidenceScore : undefined,
    });
  }

  /**
   * Core entry logic: check edge, check capital, execute order.
   */
  private async evaluateAndEnter(inputSignal: ScalpSignal): Promise<void> {
    let signal = inputSignal;
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

    // Entry delay: wait for price persistence confirmation
    if (config.SCALP_ENTRY_DELAY_MS > 0) {
      await new Promise((r) => setTimeout(r, config.SCALP_ENTRY_DELAY_MS));
      const freshAsk = await getCurrentPrice(signal.tokenId);
      if (freshAsk === null || freshAsk < signal.currentAsk - 0.02) {
        processingLock.delete(signal.slug);
        await recordCycle(signal, 'SKIPPED', `price faded after ${config.SCALP_ENTRY_DELAY_MS}ms delay`);
        return;
      }
      // Use fresh price for entry without mutating the original signal object
      signal = { ...signal, currentAsk: freshAsk };
    }

    // Daily loss check
    const capital = await prisma.scalpCapital.findFirst({
      where: { isPaper: config.SCALP_IS_PAPER },
    });
    if (!capital) {
      log.warn('No ScalpCapital record found');
      return;
    }

    // Reset daily loss at midnight UTC
    const now = new Date();
    if (capital.dailyLossResetAt.toISOString().slice(0, 10) !== now.toISOString().slice(0, 10)) {
      await prisma.scalpCapital.updateMany({
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

    // Bid-side spread check (applies to BOTH paper and live modes)
    const entryBook = await scalpGetOrderBook(signal.tokenId);
    if (!entryBook) {
      log.warn('Orderbook unavailable, skipping', { slug: signal.slug, tokenId: signal.tokenId.slice(0, 20) });
      await recordCycle(signal, 'SKIPPED', 'orderbook unavailable');
      return;
    }

    // CLOB API returns bids in ASCENDING order (lowest first).
    // Best (highest) bid is the LAST element.
    const bestBid = parseFloat(entryBook?.bids?.[entryBook.bids.length - 1]?.price ?? '0');
    if (bestBid < config.SCALP_MIN_MEANINGFUL_BID) {
      log.info('No bid liquidity, skipping', {
        slug: signal.slug,
        bestBid: bestBid.toFixed(2),
        currentAsk: signal.currentAsk.toFixed(2),
      });
      await recordCycle(signal, 'SKIPPED', `no bid liquidity: bestBid=${bestBid.toFixed(2)}`);
      return;
    }

    const spread = signal.currentAsk - bestBid;
    if (spread > config.SCALP_MAX_ENTRY_SPREAD) {
      log.info('Spread too wide, skipping', {
        slug: signal.slug,
        spread: spread.toFixed(2),
        bestBid: bestBid.toFixed(2),
        ask: signal.currentAsk.toFixed(2),
      });
      await recordCycle(signal, 'SKIPPED', `spread too wide: ${spread.toFixed(2)}`);
      return;
    }

    // Paper mode: ALSO check ask-side liquidity (uses same book, no extra API call)
    if (config.SCALP_IS_PAPER) {
      const availableShares = (entryBook.asks ?? [])
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
    let amount = config.SCALP_POSITION_SIZE_USD;
    if (config.SCALP_CONFIDENCE_SIZING && signal.confidenceScore != null) {
      amount = Math.max(
        Math.min(config.SCALP_POSITION_SIZE_USD * signal.confidenceScore, config.SCALP_MAX_POSITION_SIZE_USD),
        1, // absolute floor: CLOB minimum
      );
    }
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

      // Upgrade processing lock with real cycleId (replaces eager pending lock)
      processingLock.set(signal.slug, { cycleId: cycle.id, timestamp: Date.now() });

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
  // CLOB API returns asks in DESCENDING order (highest first).
  // Best (lowest) ask is the LAST element.
  return parseFloat(book.asks[book.asks.length - 1].price);
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
