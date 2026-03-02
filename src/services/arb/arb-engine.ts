import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ArbCycleStatus } from '../../../prisma/generated/prisma/client/enums';
import { config } from '../../config/env';
import { getMarketBySlug } from '../../api/gamma-api';
import { CryptoPriceFeed } from './crypto-price-feed';
import { discoverMarket, buildSlug, pruneCache } from './market-discovery';
import { arbExecuteOrder, arbGetOrderBook } from './arb-executor';
import type { ArbMarketConfig, CandleInfo, CandleState } from './arb-types';

/**
 * Compute which candle window we are in for a given duration.
 * epochOffsetMs handles non-standard alignment (e.g., 4h candles start at 01:00 UTC, not 00:00).
 */
export function getCandleInfo(nowMs: number, durationMs: number, epochOffsetMs = 0): CandleInfo {
  const adjusted = nowMs - epochOffsetMs;
  const candleStartMs = Math.floor(adjusted / durationMs) * durationMs + epochOffsetMs;
  const candleEndMs = candleStartMs + durationMs;
  const elapsedMs = nowMs - candleStartMs;
  const slugTimestamp = Math.floor(candleStartMs / 1000);
  return { candleStartMs, candleEndMs, elapsedMs, slugTimestamp };
}

/**
 * Calculate Polymarket crypto fee.
 * fee = shares × feeRate × (price × (1 - price))^exponent
 */
function calculateFee(shares: number, price: number): number {
  if (config.ARB_FEE_RATE <= 0 || shares <= 0) return 0;
  return shares * config.ARB_FEE_RATE * Math.pow(price * (1 - price), config.ARB_FEE_EXPONENT);
}

export class ArbEngine {
  private log;
  private marketConfig: ArbMarketConfig;
  private priceFeed: CryptoPriceFeed;
  private isPaper: boolean;

  // Current candle state
  private currentCandle: CandleState | null = null;
  private lastCandleStartMs = 0;

  // Risk counters (reset daily)
  private dailyPnl = 0;
  private dailyResetDate = '';
  private consecutiveLosses = 0;

  constructor(marketConfig: ArbMarketConfig, priceFeed: CryptoPriceFeed, isPaper: boolean) {
    this.marketConfig = marketConfig;
    this.priceFeed = priceFeed;
    this.isPaper = isPaper;
    this.log = createJobLogger(`arb-engine-${marketConfig.type}`);
  }

  /**
   * Called every ~1 second from the worker loop.
   * Manages the lifecycle of each candle window.
   */
  async runCycle(): Promise<void> {
    const now = Date.now();
    const candle = getCandleInfo(now, this.marketConfig.candleDurationMs, this.marketConfig.epochOffsetMs);

    // Reset daily counters at midnight UTC
    const today = new Date().toISOString().slice(0, 10);
    if (today !== this.dailyResetDate) {
      this.dailyPnl = 0;
      this.dailyResetDate = today;
      pruneCache();
    }

    // New candle? Reset state.
    if (candle.candleStartMs !== this.lastCandleStartMs) {
      // If we have an unsettled candle from the previous window, settle it
      if (this.currentCandle?.entered) {
        await this.settleCandle();
      }
      this.currentCandle = null;
      this.lastCandleStartMs = candle.candleStartMs;
    }

    // Phase 1: Begin candle (initialize if not yet done for this candle).
    // No time gate — settlement polling can block past the first 30s, so we must
    // always attempt initialization when currentCandle is null.
    if (!this.currentCandle) {
      await this.beginCandle(candle);
    }

    // Phase 2: Entry window
    if (candle.elapsedMs >= this.marketConfig.entryStartMs
        && candle.elapsedMs <= this.marketConfig.entryEndMs
        && this.currentCandle
        && !this.currentCandle.entered) {
      await this.evaluateAndEnter();
    }

    // Phase 3: Settlement runs automatically when the next candle starts (line 68-72 above).
    // The new-candle transition detects unsettled entries and calls settleCandle().
  }

  // ─── Phase 1: Begin candle ───

  private async beginCandle(candle: CandleInfo): Promise<void> {
    // Snapshot asset opening price
    this.priceFeed.markCandleOpen(this.marketConfig.candleDurationMs);
    const openPrice = this.priceFeed.lastPrice;

    if (openPrice <= 0) {
      this.log.debug('Skipping candle — no price available yet');
      return;
    }

    // Discover market
    const slug = buildSlug(this.marketConfig, candle.slugTimestamp);
    const marketInfo = await discoverMarket(slug);

    this.currentCandle = {
      candleStartMs: candle.candleStartMs,
      candleEndMs: candle.candleEndMs,
      slugTimestamp: candle.slugTimestamp,
      openPrice,
      marketInfo,
      entered: false,
      entryDirection: null,
      entryTokenId: null,
      entryPrice: null,
      entryShares: null,
      entryAmountUsd: null,
      orderId: null,
      cycleId: null,
    };

    if (!marketInfo) {
      this.log.debug(`Market not yet available for ${slug}, will retry`);
    }
  }

  // ─── Phase 2: Evaluate and enter ───

  private async evaluateAndEnter(): Promise<void> {
    const candle = this.currentCandle!;

    // Retry market discovery if it failed earlier
    if (!candle.marketInfo) {
      const slug = buildSlug(this.marketConfig, candle.slugTimestamp);
      candle.marketInfo = await discoverMarket(slug);
      if (!candle.marketInfo) {
        this.log.debug(`Still no market for ${slug}, skipping entry`);
        await this.recordSkip('market not found');
        return;
      }
    }

    // Circuit breakers
    const skip = this.shouldSkip();
    if (skip) {
      await this.recordSkip(skip);
      return;
    }

    // Check capital
    const capital = await this.getCapital();
    if (!capital || capital.currentCapital < config.ARB_POSITION_SIZE_USD) {
      await this.recordSkip(`insufficient capital: $${capital?.currentCapital.toFixed(2) ?? 0}`);
      return;
    }

    // Determine direction
    const direction = this.priceFeed.getDirection(
      this.marketConfig.candleDurationMs,
      config.ARB_MIN_PRICE_CHANGE,
    );
    if (direction === 'FLAT') {
      await this.recordSkip(`${this.marketConfig.asset.toUpperCase()} price flat`);
      return;
    }

    // Select token
    const tokenId = direction === 'UP'
      ? candle.marketInfo.upTokenId
      : candle.marketInfo.downTokenId;

    // Optional order book check (only available with own wallet)
    const orderBook = await arbGetOrderBook(tokenId);
    if (orderBook) {
      const availableLiquidity = (orderBook.asks ?? [])
        .filter((a: { price: string }) => parseFloat(a.price) <= config.ARB_MAX_ENTRY_PRICE)
        .reduce((sum: number, a: { size: string }) => sum + parseFloat(a.size), 0);

      const requiredShares = config.ARB_POSITION_SIZE_USD / config.ARB_MAX_ENTRY_PRICE;
      if (availableLiquidity < requiredShares) {
        await this.recordSkip(`low liquidity: ${availableLiquidity.toFixed(0)} < ${requiredShares.toFixed(0)} required`);
        return;
      }
    }

    // Execute order
    const result = await arbExecuteOrder({
      tokenId,
      side: 'BUY',
      amount: config.ARB_POSITION_SIZE_USD,
      detectedPrice: config.ARB_MAX_ENTRY_PRICE,
    });

    if (result.status !== 'FILLED' || !result.filledSize || !result.filledPrice) {
      await this.recordSkip(result.failReason ?? 'order not filled');
      return;
    }

    // Calculate fee
    const estimatedFee = calculateFee(result.filledSize, result.filledPrice);
    const entryAmountUsd = result.filledSize * result.filledPrice;

    // Update capital (decrement available, increment deployed)
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.arbCapital.findUnique({ where: { isPaper: this.isPaper } });
      if (!fresh || fresh.currentCapital < entryAmountUsd) {
        throw new Error('Insufficient capital at execution time');
      }
      await tx.arbCapital.update({
        where: { isPaper: this.isPaper },
        data: {
          currentCapital: { decrement: entryAmountUsd },
          deployedCapital: { increment: entryAmountUsd },
        },
      });
    });

    // Record cycle
    const cycle = await prisma.arbCycle.create({
      data: {
        marketType: this.marketConfig.type,
        candleStartMs: BigInt(candle.candleStartMs),
        slug: buildSlug(this.marketConfig, candle.slugTimestamp),
        conditionId: candle.marketInfo.conditionId,
        btcOpenPrice: candle.openPrice,
        btcEntryPrice: this.priceFeed.lastPrice,
        direction,
        tokenId,
        entryPrice: result.filledPrice,
        entryShares: result.filledSize,
        entryAmountUsd,
        orderId: result.orderId,
        estimatedFee,
        status: ArbCycleStatus.ENTERED,
        isPaper: this.isPaper,
        enteredAt: new Date(),
      },
    });

    // Update candle state
    candle.entered = true;
    candle.entryDirection = direction;
    candle.entryTokenId = tokenId;
    candle.entryPrice = result.filledPrice;
    candle.entryShares = result.filledSize;
    candle.entryAmountUsd = entryAmountUsd;
    candle.orderId = result.orderId;
    candle.cycleId = cycle.id;

    this.log.info(`ENTERED ${direction}`, {
      market: this.marketConfig.type,
      price: result.filledPrice.toFixed(4),
      shares: result.filledSize.toFixed(2),
      usd: entryAmountUsd.toFixed(2),
      fee: estimatedFee.toFixed(4),
    });
  }

  // ─── Phase 3: Settlement ───

  private async settleCandle(): Promise<void> {
    const candle = this.currentCandle;
    if (!candle?.entered || !candle.cycleId || !candle.marketInfo) {
      this.currentCandle = null;
      return;
    }

    const slug = buildSlug(this.marketConfig, candle.slugTimestamp);

    // Poll for resolution (max 180s — Polymarket BTC markets can take 1-3 min to resolve)
    let resolved = false;
    let settlementPrice = 0;
    const maxWait = 180_000;
    const pollInterval = 5_000;
    const start = Date.now();

    while (Date.now() - start < maxWait) {
      const market = await getMarketBySlug(slug);
      if (market?.closed && market.outcomePrices) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const prices: number[] = JSON.parse(market.outcomePrices).map(Number);
          const ourOutcome = candle.entryDirection === 'UP' ? 'up' : 'down';
          const idx = outcomes.findIndex((o) => o.toLowerCase() === ourOutcome);
          if (idx !== -1) {
            settlementPrice = prices[idx];
            resolved = true;
            break;
          }
        } catch {
          // Parse error — retry
        }
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    if (!resolved) {
      this.log.warn(`Market ${slug} not resolved after ${maxWait / 1000}s`);
      await prisma.arbCycle.update({
        where: { id: candle.cycleId },
        data: { status: ArbCycleStatus.FAILED, failReason: 'resolution timeout' },
      });
      // Refund capital
      await this.refundCapital(candle.entryAmountUsd!);
      this.currentCandle = null;
      return;
    }

    // Calculate P&L
    const settlementValue = (candle.entryShares ?? 0) * settlementPrice;
    const estimatedFee = calculateFee(candle.entryShares ?? 0, candle.entryPrice ?? 0);
    const pnl = settlementValue - (candle.entryAmountUsd ?? 0) - estimatedFee;
    const won = settlementPrice >= 0.95;

    // Update capital
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.arbCapital.findUniqueOrThrow({ where: { isPaper: this.isPaper } });
      await tx.arbCapital.update({
        where: { isPaper: this.isPaper },
        data: {
          currentCapital: { increment: settlementValue },
          deployedCapital: { decrement: Math.min(candle.entryAmountUsd!, fresh.deployedCapital) },
          totalPnl: { increment: pnl },
          totalCycles: { increment: 1 },
          totalWins: { increment: won ? 1 : 0 },
        },
      });
    });

    // Update cycle record
    await prisma.arbCycle.update({
      where: { id: candle.cycleId },
      data: {
        status: won ? ArbCycleStatus.WON : ArbCycleStatus.LOST,
        settlementPrice,
        pnl,
        estimatedFee,
        btcClosePrice: this.priceFeed.lastPrice,
        resolvedAt: new Date(),
      },
    });

    // Update risk counters
    if (won) {
      this.consecutiveLosses = 0;
    } else {
      this.consecutiveLosses++;
    }
    this.dailyPnl += pnl;

    this.log.info(`${won ? 'WON' : 'LOST'} ${candle.entryDirection}`, {
      market: this.marketConfig.type,
      settlementPrice: settlementPrice.toFixed(4),
      pnl: `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`,
      dailyPnl: `$${this.dailyPnl.toFixed(2)}`,
      consecutiveLosses: this.consecutiveLosses,
    });

    this.currentCandle = null;
  }

  // ─── Helpers ───

  private shouldSkip(): string | null {
    if (this.consecutiveLosses >= config.ARB_MAX_CONSECUTIVE_LOSSES) {
      return `circuit breaker: ${this.consecutiveLosses} consecutive losses`;
    }
    if (this.dailyPnl <= -config.ARB_MAX_DAILY_LOSS_USD) {
      return `daily loss limit: $${this.dailyPnl.toFixed(2)}`;
    }
    if (this.priceFeed.priceAge > 5000) {
      return `${this.marketConfig.asset.toUpperCase()} price feed stale`;
    }
    if (this.priceFeed.state !== 'connected') {
      return `${this.marketConfig.asset.toUpperCase()} feed: ${this.priceFeed.state}`;
    }
    return null;
  }

  private async getCapital() {
    return prisma.arbCapital.findUnique({ where: { isPaper: this.isPaper } });
  }

  private async refundCapital(amount: number): Promise<void> {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.arbCapital.findUniqueOrThrow({ where: { isPaper: this.isPaper } });
        await tx.arbCapital.update({
          where: { isPaper: this.isPaper },
          data: {
            currentCapital: { increment: amount },
            deployedCapital: { decrement: Math.min(amount, fresh.deployedCapital) },
          },
        });
      });
    } catch (err: any) {
      this.log.error(`Capital refund failed: ${err.message}`);
    }
  }

  private async recordSkip(reason: string): Promise<void> {
    if (!this.currentCandle) return;

    // Only record skips that had a market (avoid spamming DB for early discovery failures)
    if (!this.currentCandle.marketInfo) {
      this.currentCandle.entered = true; // Prevent re-entry attempts
      return;
    }

    try {
      await prisma.arbCycle.create({
        data: {
          marketType: this.marketConfig.type,
          candleStartMs: BigInt(this.currentCandle.candleStartMs),
          slug: buildSlug(this.marketConfig, this.currentCandle.slugTimestamp),
          conditionId: this.currentCandle.marketInfo?.conditionId,
          btcOpenPrice: this.currentCandle.openPrice,
          btcEntryPrice: this.priceFeed.lastPrice,
          status: ArbCycleStatus.SKIPPED,
          failReason: reason,
          isPaper: this.isPaper,
        },
      });
    } catch {
      // Non-critical — skip recording errors silently
    }

    this.currentCandle.entered = true; // Prevent re-entry attempts
    this.log.debug(`Skipped: ${reason}`, { market: this.marketConfig.type });
  }
}
