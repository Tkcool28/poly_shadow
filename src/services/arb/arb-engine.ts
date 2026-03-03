import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { ArbCycleStatus } from '../../../prisma/generated/prisma/client/enums';
import { config } from '../../config/env';
import { CryptoPriceFeed } from './crypto-price-feed';
import { discoverMarket, buildSlug } from './market-discovery';
import { arbExecuteOrder, arbGetOrderBook } from './arb-executor';
import { computeConfidence, type ConfidenceConfig } from './confidence';
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
export function calculateFee(shares: number, price: number): number {
  if (config.ARB_FEE_RATE <= 0 || shares <= 0) return 0;
  return shares * config.ARB_FEE_RATE * Math.pow(price * (1 - price), config.ARB_FEE_EXPONENT);
}

export class ArbEngine {
  private log;
  private marketConfig: ArbMarketConfig;
  private priceFeed: CryptoPriceFeed;
  private isPaper: boolean;
  private strategy: string;
  private get isContrarian(): boolean { return this.strategy.startsWith('contrarian'); }
  private get isEveryNth(): boolean { return this.strategy === 'contrarian-every3'; }
  private get isAntiMart(): boolean { return this.strategy === 'contrarian-antimart'; }
  private get isCooldown(): boolean { return this.strategy === 'contrarian-cooldown'; }

  // Current candle state
  private currentCandle: CandleState | null = null;
  private lastCandleStartMs = 0;

  // Strategy variant state
  private candleCount = 0;                              // every-Nth counter
  private lastCycleWasLoss = false;                     // anti-martingale
  private cooldownSkipRemaining = 0;                    // cooldown skip counter
  private lastCooldownTriggerCycleId: string | null = null; // prevent re-triggering

  constructor(marketConfig: ArbMarketConfig, priceFeed: CryptoPriceFeed, isPaper: boolean, strategy = 'standard') {
    this.marketConfig = marketConfig;
    this.priceFeed = priceFeed;
    this.isPaper = isPaper;
    this.strategy = strategy;
    this.log = createJobLogger(`arb-engine-${marketConfig.type}-${strategy}`);
  }

  /**
   * Called every ~1 second from the worker loop.
   * Manages the lifecycle of each candle window.
   */
  async runCycle(): Promise<void> {
    const now = Date.now();
    const candle = getCandleInfo(now, this.marketConfig.candleDurationMs, this.marketConfig.epochOffsetMs);

    // New candle? Reset state. Settlement handled by background sweep.
    if (candle.candleStartMs !== this.lastCandleStartMs) {
      this.currentCandle = null;
      this.lastCandleStartMs = candle.candleStartMs;
      this.candleCount++;
    }

    // Every-Nth: skip non-Nth candles entirely (no entry, no skip record)
    if (this.isEveryNth && this.candleCount % 3 !== 0) {
      return;
    }

    // Cooldown: skip candles after consecutive losses
    if (this.isCooldown && this.cooldownSkipRemaining > 0) {
      this.cooldownSkipRemaining--;
      return;
    }

    // Phase 1: Begin candle (initialize if not yet done for this candle).
    if (!this.currentCandle) {
      await this.beginCandle(candle);
    }

    // Phase 2: Entry window
    if (candle.elapsedMs >= this.marketConfig.entryStartMs
        && candle.elapsedMs <= this.marketConfig.entryEndMs
        && this.currentCandle
        && !this.currentCandle.entered) {
      await this.evaluateAndEnter(candle);
    }

    // Record SKIPPED when entry window expires without entry
    if (candle.elapsedMs > this.marketConfig.entryEndMs
        && this.currentCandle
        && !this.currentCandle.entered) {
      let reason: string;
      if (!this.currentCandle.marketInfo) {
        reason = 'market not found';
      } else if (this.currentCandle.permanentSkipReason) {
        reason = this.currentCandle.permanentSkipReason;
      } else if (this.currentCandle.lastConfidence) {
        const conf = this.currentCandle.lastConfidence;
        reason = `low confidence: ${conf.score.toFixed(3)} (move=${conf.signals.priceMovePct.toFixed(4)}, mom=${conf.signals.momentum.toFixed(2)}, vol=${conf.signals.volatility.toFixed(2)})`;
      } else {
        reason = `${this.marketConfig.asset.toUpperCase()} price flat`;
      }
      const conf = this.currentCandle.lastConfidence;
      await this.recordSkip(reason, conf?.score ?? null, conf ? JSON.stringify(conf.signals) : null);
    }

    // Phase 3: Settlement handled by background sweep (arb-settlement.ts).
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
      permanentSkipChecked: false,
      permanentSkipReason: null,
      lastConfidence: null,
    };

    if (!marketInfo) {
      this.log.debug(`Market not yet available for ${slug}, will retry`);
    }

    // Anti-martingale: check once per candle if last cycle was a loss
    if (this.isAntiMart) {
      const lastCycle = await prisma.arbCycle.findFirst({
        where: {
          isPaper: this.isPaper,
          strategy: this.strategy,
          status: { in: [ArbCycleStatus.WON, ArbCycleStatus.LOST, ArbCycleStatus.STOPPED] },
        },
        orderBy: { createdAt: 'desc' },
        select: { status: true },
      });
      this.lastCycleWasLoss = lastCycle?.status === ArbCycleStatus.LOST
        || lastCycle?.status === ArbCycleStatus.STOPPED;
    }

    // Cooldown: check if 3 consecutive losses should trigger a skip period
    if (this.isCooldown) {
      const recentCycles = await prisma.arbCycle.findMany({
        where: {
          isPaper: this.isPaper,
          strategy: this.strategy,
          status: { in: [ArbCycleStatus.WON, ArbCycleStatus.LOST, ArbCycleStatus.STOPPED] },
        },
        orderBy: { createdAt: 'desc' },
        take: 3,
        select: { id: true, status: true },
      });
      const allLosses = recentCycles.length >= 3
        && recentCycles.every((c) => c.status === ArbCycleStatus.LOST || c.status === ArbCycleStatus.STOPPED);
      const triggerCycleId = recentCycles[2]?.id ?? null;
      if (allLosses && triggerCycleId !== this.lastCooldownTriggerCycleId) {
        this.cooldownSkipRemaining = 2;
        this.lastCooldownTriggerCycleId = triggerCycleId;
        this.log.info('Cooldown triggered: 3 consecutive losses, skipping 2 candles', {
          market: this.marketConfig.type,
        });
      }
    }
  }

  // ─── Phase 2: Evaluate and enter ───

  private async evaluateAndEnter(candleInfo: CandleInfo): Promise<void> {
    const candle = this.currentCandle!;

    // 1. Retry market discovery if it failed earlier (allow retry next tick)
    //    Contrarian mode: always refresh prices (outcome prices change each tick)
    if (!candle.marketInfo || this.isContrarian) {
      const slug = buildSlug(this.marketConfig, candle.slugTimestamp);
      candle.marketInfo = await discoverMarket(slug, this.isContrarian);
      if (!candle.marketInfo) {
        return; // No entered=true — retry next tick
      }
    }

    // 2. Permanent checks: circuit breakers + capital (run once per candle)
    if (!candle.permanentSkipChecked) {
      const skip = await this.shouldSkip();
      if (skip) {
        candle.permanentSkipChecked = true;
        candle.permanentSkipReason = skip;
        return; // Window-expiry handler records SKIPPED
      }

      const capital = await this.getCapital();
      let requiredCapital = this.isContrarian
        ? config.ARB_CONTRARIAN_POSITION_SIZE_USD
        : config.ARB_POSITION_SIZE_USD;
      // Anti-martingale: halve required capital when last cycle was a loss
      if (this.isAntiMart && this.lastCycleWasLoss) {
        requiredCapital = Math.max(1, requiredCapital / 2);
      }
      if (!capital || capital.currentCapital < requiredCapital) {
        const reason = `insufficient capital: $${capital?.currentCapital.toFixed(2) ?? 0}`;
        candle.permanentSkipChecked = true;
        candle.permanentSkipReason = reason;
        return;
      }

      candle.permanentSkipChecked = true;
    }

    // Already permanently skipped — wait for window expiry to record
    if (candle.permanentSkipReason) return;

    // 3. Confidence scoring (runs every tick during entry window)
    const windowMs = Math.min(
      (this.marketConfig.entryEndMs - this.marketConfig.entryStartMs) + 30_000,
      120_000,
    );
    const snapshots = this.priceFeed.getSnapshotsInWindow(windowMs);

    const confidenceConfig: ConfidenceConfig = {
      priceScale: config.ARB_CONFIDENCE_PRICE_SCALE,
      volScale: config.ARB_CONFIDENCE_VOL_SCALE,
      minPriceChange: config.ARB_MIN_PRICE_CHANGE,
    };

    const confidence = computeConfidence({
      openPrice: candle.openPrice,
      currentPrice: this.priceFeed.lastPrice,
      candleDurationMs: this.marketConfig.candleDurationMs,
      elapsedMs: candleInfo.elapsedMs,
      snapshots,
      config: confidenceConfig,
    });

    candle.lastConfidence = confidence;

    if (confidence.direction === 'FLAT' || confidence.score < config.ARB_MIN_CONFIDENCE) {
      this.log.debug(`Confidence: ${confidence.score.toFixed(3)} (move=${confidence.signals.priceMovePct.toFixed(4)}, mom=${confidence.signals.momentum.toFixed(2)}, vol=${confidence.signals.volatility.toFixed(2)}, time=${confidence.signals.timeScore.toFixed(2)})`, { market: this.marketConfig.type });
      return; // Low confidence — allow retry next tick
    }

    const modelDirection = confidence.direction;

    // Select token and sizing based on mode
    let entryDirection: 'UP' | 'DOWN';
    let tokenId: string;
    let positionSize: number;
    let detectedPrice: number;

    if (this.isContrarian) {
      // Contrarian: buy the OPPOSITE token at low price
      entryDirection = modelDirection === 'UP' ? 'DOWN' : 'UP';
      tokenId = modelDirection === 'UP'
        ? candle.marketInfo.downTokenId
        : candle.marketInfo.upTokenId;

      const oppositePrice = modelDirection === 'UP'
        ? candle.marketInfo.downPrice
        : candle.marketInfo.upPrice;

      if (!oppositePrice || !Number.isFinite(oppositePrice)
          || oppositePrice > config.ARB_CONTRARIAN_MAX_PRICE) {
        return; // Too expensive or no price — retry next tick
      }

      positionSize = config.ARB_CONTRARIAN_POSITION_SIZE_USD;
      // Anti-martingale: halve position after loss, restore after win
      if (this.isAntiMart && this.lastCycleWasLoss) {
        positionSize = Math.max(1, positionSize / 2);
      }
      detectedPrice = oppositePrice;
    } else {
      // Standard: buy predicted direction at high price
      entryDirection = modelDirection;
      tokenId = modelDirection === 'UP'
        ? candle.marketInfo.upTokenId
        : candle.marketInfo.downTokenId;
      positionSize = config.ARB_POSITION_SIZE_USD;
      detectedPrice = config.ARB_MAX_ENTRY_PRICE;
    }

    // Optional order book check (only available with own wallet)
    const orderBook = await arbGetOrderBook(tokenId);
    if (orderBook) {
      const maxPrice = this.isContrarian ? detectedPrice : config.ARB_MAX_ENTRY_PRICE;
      const availableLiquidity = (orderBook.asks ?? [])
        .filter((a: { price: string }) => parseFloat(a.price) <= maxPrice)
        .reduce((sum: number, a: { size: string }) => sum + parseFloat(a.size), 0);

      const requiredShares = positionSize / maxPrice;
      if (availableLiquidity < requiredShares) {
        await this.recordSkip(
          `low liquidity: ${availableLiquidity.toFixed(0)} < ${requiredShares.toFixed(0)} required`,
          confidence.score,
          JSON.stringify(confidence.signals),
        );
        return;
      }
    }

    // Execute order
    const result = await arbExecuteOrder({
      tokenId,
      side: 'BUY',
      amount: positionSize,
      detectedPrice,
    });

    if (result.status !== 'FILLED' || !result.filledSize || !result.filledPrice) {
      await this.recordSkip(
        result.failReason ?? 'order not filled',
        confidence.score,
        JSON.stringify(confidence.signals),
      );
      return;
    }

    // Calculate fee
    const estimatedFee = calculateFee(result.filledSize, result.filledPrice);
    const entryAmountUsd = result.filledSize * result.filledPrice;

    // Atomic: capital decrement + cycle creation in single transaction
    let cycle;
    try {
      cycle = await prisma.$transaction(async (tx) => {
        const capitalKey = { isPaper_strategy: { isPaper: this.isPaper, strategy: this.strategy } };
        const fresh = await tx.arbCapital.findUnique({ where: capitalKey });
        if (!fresh || fresh.currentCapital < entryAmountUsd) {
          throw new Error('Insufficient capital at execution time');
        }
        await tx.arbCapital.update({
          where: capitalKey,
          data: {
            currentCapital: { decrement: entryAmountUsd },
            deployedCapital: { increment: entryAmountUsd },
          },
        });
        return tx.arbCycle.create({
          data: {
            marketType: this.marketConfig.type,
            candleStartMs: BigInt(candle.candleStartMs),
            slug: buildSlug(this.marketConfig, candle.slugTimestamp),
            conditionId: candle.marketInfo!.conditionId,
            btcOpenPrice: candle.openPrice,
            btcEntryPrice: this.priceFeed.lastPrice,
            direction: entryDirection,
            tokenId,
            entryPrice: result.filledPrice,
            entryShares: result.filledSize,
            entryAmountUsd,
            orderId: result.orderId,
            estimatedFee,
            confidenceScore: confidence.score,
            confidenceSignals: JSON.stringify({
              ...confidence.signals,
              modelDirection,
              contrarian: this.isContrarian,
            }),
            status: ArbCycleStatus.ENTERED,
            isPaper: this.isPaper,
            strategy: this.strategy,
            enteredAt: new Date(),
          },
        });
      });
    } catch (err: any) {
      // Handle dedup (unique constraint violation)
      if (err.code === 'P2002') {
        this.log.warn('Duplicate cycle detected, skipping', { market: this.marketConfig.type });
        candle.entered = true;
        return;
      }
      // Transaction failed after live order was placed — log for manual reconciliation
      this.log.error('Entry transaction failed AFTER order fill', {
        market: this.marketConfig.type,
        orderId: result.orderId,
        filledSize: result.filledSize,
        filledPrice: result.filledPrice,
        error: err.message,
      });
      candle.entered = true; // Prevent re-entry
      return;
    }

    // Update candle state
    candle.entered = true;
    candle.entryDirection = entryDirection;
    candle.entryTokenId = tokenId;
    candle.entryPrice = result.filledPrice;
    candle.entryShares = result.filledSize;
    candle.entryAmountUsd = entryAmountUsd;
    candle.orderId = result.orderId;
    candle.cycleId = cycle.id;

    const modeLabel = this.isContrarian ? 'CONTRARIAN' : 'ENTERED';
    this.log.info(`${modeLabel} ${entryDirection}`, {
      market: this.marketConfig.type,
      ...(this.isContrarian ? { modelSaid: modelDirection } : {}),
      confidence: confidence.score.toFixed(3),
      price: result.filledPrice.toFixed(4),
      shares: result.filledSize.toFixed(2),
      usd: entryAmountUsd.toFixed(2),
      fee: estimatedFee.toFixed(4),
    });
  }

  // ─── Helpers ───

  /**
   * DB-backed circuit breakers (crash-resilient, no in-memory state).
   * - Daily PnL: GLOBAL across all market types (protects total arb exposure)
   * - Consecutive losses: PER-ENGINE (each market type has independent streaks)
   */
  private async shouldSkip(): Promise<string | null> {
    // Price feed checks (fast, no DB)
    if (this.priceFeed.priceAge > 5000) {
      return `${this.marketConfig.asset.toUpperCase()} price feed stale`;
    }
    if (this.priceFeed.state !== 'connected') {
      return `${this.marketConfig.asset.toUpperCase()} feed: ${this.priceFeed.state}`;
    }

    // Daily loss: GLOBAL across all market types
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayStats = await prisma.arbCycle.aggregate({
      where: {
        isPaper: this.isPaper,
        createdAt: { gte: todayStart },
        status: { in: [ArbCycleStatus.WON, ArbCycleStatus.LOST, ArbCycleStatus.STOPPED] },
      },
      _sum: { pnl: true },
    });
    const dailyPnl = todayStats._sum.pnl ?? 0;
    if (dailyPnl <= -config.ARB_MAX_DAILY_LOSS_USD) {
      return `daily loss limit: $${dailyPnl.toFixed(2)}`;
    }

    // Consecutive losses: per-engine per-strategy (each market+strategy has independent streaks)
    const recentCycles = await prisma.arbCycle.findMany({
      where: {
        isPaper: this.isPaper,
        strategy: this.strategy,
        marketType: this.marketConfig.type,
        status: { in: [ArbCycleStatus.WON, ArbCycleStatus.LOST, ArbCycleStatus.STOPPED] },
      },
      orderBy: { createdAt: 'desc' },
      take: config.ARB_MAX_CONSECUTIVE_LOSSES,
      select: { status: true },
    });
    const firstWinIdx = recentCycles.findIndex((c) => c.status === ArbCycleStatus.WON);
    const consecutiveLosses = firstWinIdx === -1 ? recentCycles.length : firstWinIdx;
    if (consecutiveLosses >= config.ARB_MAX_CONSECUTIVE_LOSSES) {
      return `circuit breaker: ${consecutiveLosses} consecutive losses`;
    }

    return null;
  }

  private async getCapital() {
    return prisma.arbCapital.findUnique({
      where: { isPaper_strategy: { isPaper: this.isPaper, strategy: this.strategy } },
    });
  }

  private async recordSkip(
    reason: string,
    confidenceScore?: number | null,
    confidenceSignals?: string | null,
  ): Promise<void> {
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
          confidenceScore: confidenceScore ?? undefined,
          confidenceSignals: confidenceSignals ?? undefined,
          status: ArbCycleStatus.SKIPPED,
          failReason: reason,
          isPaper: this.isPaper,
          strategy: this.strategy,
        },
      });
    } catch {
      // Non-critical — skip recording errors silently (includes P2002 dedup)
    }

    this.currentCandle.entered = true; // Prevent re-entry attempts
    this.log.info(`Skipped: ${reason}`, { market: this.marketConfig.type });
  }
}
