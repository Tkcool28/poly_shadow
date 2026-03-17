/**
 * Scalp Market Maker — Paper Mode Quoting Engine
 *
 * Simulates market making on Polymarket sports markets without placing real orders.
 * In paper mode:
 *   1. Calculates hypothetical bid/ask quotes around fair value (VWAP of recent trades)
 *   2. Monitors the CLOB WebSocket for real trades
 *   3. When a real trade executes at or beyond our hypothetical price, records a "paper fill"
 *   4. Tracks inventory, PnL, spread capture, and round trips
 *
 * Integrates with game feeds (soccer, NBA, etc.) for event-based quote cancellation —
 * when a goal/scoring event is detected, quotes are instantly pulled and paused until
 * the market settles at a new fair value.
 */

import type { ClobTradeEvent } from '../clob-market-stream';
import type { GameEvent } from './scalp-types';
import { RiskLimits, type RiskLimitsConfig } from './scalp-risk-limits';
import { HeartbeatManager, type HeartbeatConfig } from './scalp-heartbeat';
import type { ClobClient } from '@polymarket/clob-client';

// ─── Configuration ───

export interface MMConfig {
  /** Total spread width in price units (e.g. 0.04 = 4c spread, 2c each side) */
  spreadWidth: number;
  /** USD size per side (e.g. 10 = $10 bid + $10 ask) */
  orderSize: number;
  /** Maximum one-sided inventory in USD before skewing aggressively */
  maxInventory: number;
  /** Paper mode — no real orders placed */
  isPaper: boolean;
  /** Inventory skew coefficient: price adjustment per share of inventory (default 0.001) */
  skewCoefficient?: number;
  /** Number of recent trades for VWAP calculation (default 20) */
  vwapWindow?: number;
  /** Pause duration in ms after a game event before resuming quotes (default 30000) */
  eventPauseMs?: number;
  /** Tick size for rounding prices (default 0.01) */
  tickSize?: number;
  /** Minimum price for fair value to be considered valid (default 0.05) */
  minFairValue?: number;
  /** Maximum price for fair value to be considered valid (default 0.95) */
  maxFairValue?: number;
  /** Minimum trades needed to establish fair value (default 5) */
  minTradesForFairValue?: number;
  /** Heartbeat interval in ms for live mode placeholder (default 8000) */
  heartbeatIntervalMs?: number;
  /** Warm-up period in ms: minimum time before quoting starts (default 10000) */
  warmUpMs?: number;
  /** Maximum price standard deviation (across VWAP window) to consider fair value stable (default 0.03) */
  maxPriceStdDev?: number;
  /**
   * Queue position modeling: estimated USD of resting orders ahead of us at our price level.
   * 0 = disabled (100% fill on price cross, legacy behavior).
   * When > 0, fill probability = tradeUsd / (queueAheadUsd + tradeUsd).
   * Use a value based on observed order book depth (e.g., 500 = $500 of orders ahead).
   * Default: 0 (disabled — for initial paper testing to see raw fill counts first).
   */
  queueDepthAheadUsd?: number;
  /** Risk limits configuration (optional — uses defaults if not provided) */
  riskLimits?: Partial<RiskLimitsConfig>;
  /** CLOB client for live heartbeat (null/undefined for paper mode) */
  clobClient?: ClobClient | null;
  /** Heartbeat configuration overrides */
  heartbeatConfig?: Partial<HeartbeatConfig>;
}

export interface MMState {
  // Current quotes
  bidPrice: number;
  askPrice: number;
  bidSize: number;
  askSize: number;

  // Inventory tracking
  position: number;          // net shares held (positive = long, negative = short)
  avgEntryPrice: number;     // volume-weighted average entry price of current position

  // PnL tracking
  realizedPnl: number;       // from completed round trips
  unrealizedPnl: number;     // from open inventory at mark-to-market
  totalFills: number;
  totalBidFills: number;
  totalAskFills: number;
  totalRoundTrips: number;

  // State
  isQuoting: boolean;        // whether we're actively quoting
  lastFairValue: number;     // current VWAP fair value
  quotingPausedUntil: number; // timestamp — pause quoting after events
  lastQuoteUpdateAt: number; // when quotes were last recalculated
}

export interface MMFill {
  side: 'BID' | 'ASK';
  price: number;
  size: number;            // shares
  usdValue: number;        // price * size
  timestamp: number;
  triggerTradePrice: number; // the real trade price that triggered this fill
  triggerTradeSide: string;  // BUY or SELL
}

export interface MMStats {
  state: MMState;
  fills: MMFill[];
  tokenId: string;
  label: string;
  uptimeMs: number;
  tradesProcessed: number;
  fillRate: number;          // fills per hour
  roundTripRate: number;     // round trips per hour
  avgSpreadCapture: number;  // average PnL per round trip
}

// ─── Internal types ───

interface RecentTrade {
  price: number;
  size: number;
  side: string;
  timestamp: number;
}

// ─── Formatting helpers ───

function tsShort(): string {
  const d = new Date();
  return d.toTimeString().split(' ')[0];
}

function fmtPrice(p: number): string {
  return p.toFixed(3);
}

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}

function fmtCents(spread: number): string {
  return `${(spread * 100).toFixed(0)}c`;
}

// ─── Internal resolved config (excludes complex optional fields handled separately) ───

type ResolvedMMConfig = Required<Omit<MMConfig, 'riskLimits' | 'clobClient' | 'heartbeatConfig'>>;

// ─── Market Maker ───

export class ScalpMarketMaker {
  private config: ResolvedMMConfig;
  private tokenId: string;
  private label: string;

  // State
  private state: MMState;
  private fills: MMFill[] = [];
  private recentTrades: RecentTrade[] = [];
  private startedAt = 0;
  private tradesProcessed = 0;

  // Warm-up tracking
  private firstTradeAt = 0;

  // Fill cooldown — prevent rapid one-sided accumulation
  private lastBidFillAt = 0;
  private lastAskFillAt = 0;
  private static readonly FILL_COOLDOWN_MS = 5_000; // 5 seconds between fills on same side

  // Queue position tracking
  private queueSkippedFills = 0;   // fills that would have happened but queue probability said no
  private queueAccumulatedProb = 0; // accumulated fill probability for deterministic fills

  // Risk management
  private riskLimits: RiskLimits;
  private heartbeat: HeartbeatManager;

  // Callbacks for external logging/monitoring
  private onLog: (msg: string) => void;

  constructor(
    config: MMConfig,
    tokenId: string,
    label: string,
    onLog?: (msg: string) => void,
  ) {
    this.config = {
      spreadWidth: config.spreadWidth,
      orderSize: config.orderSize,
      maxInventory: config.maxInventory,
      isPaper: config.isPaper,
      skewCoefficient: config.skewCoefficient ?? 0.002,
      vwapWindow: config.vwapWindow ?? 20,
      eventPauseMs: config.eventPauseMs ?? 30_000,
      tickSize: config.tickSize ?? 0.01,
      minFairValue: config.minFairValue ?? 0.05,
      maxFairValue: config.maxFairValue ?? 0.95,
      minTradesForFairValue: config.minTradesForFairValue ?? 5,
      heartbeatIntervalMs: config.heartbeatIntervalMs ?? 8_000,
      warmUpMs: config.warmUpMs ?? 10_000,
      maxPriceStdDev: config.maxPriceStdDev ?? 0.03,
      queueDepthAheadUsd: config.queueDepthAheadUsd ?? 0,
    };

    this.tokenId = tokenId;
    this.label = label;
    this.onLog = onLog ?? ((msg: string) => console.log(msg));

    this.state = {
      bidPrice: 0,
      askPrice: 0,
      bidSize: 0,
      askSize: 0,
      position: 0,
      avgEntryPrice: 0,
      realizedPnl: 0,
      unrealizedPnl: 0,
      totalFills: 0,
      totalBidFills: 0,
      totalAskFills: 0,
      totalRoundTrips: 0,
      isQuoting: false,
      lastFairValue: 0,
      quotingPausedUntil: 0,
      lastQuoteUpdateAt: 0,
    };

    // Initialize risk limits
    this.riskLimits = new RiskLimits(config.riskLimits, (msg) => this.log(`RISK | ${msg}`));

    // Initialize heartbeat manager
    this.heartbeat = new HeartbeatManager(
      {
        isPaper: config.isPaper,
        intervalMs: config.heartbeatConfig?.intervalMs ?? config.heartbeatIntervalMs ?? 5_000,
        maxConsecutiveFailures: config.heartbeatConfig?.maxConsecutiveFailures ?? 3,
      },
      config.clobClient ?? null,
      (msg) => this.log(`HEARTBEAT | ${msg}`),
    );

    // Wire heartbeat critical failure to emergency halt
    this.heartbeat.onCritical(() => {
      this.log('EMERGENCY: Heartbeat critical failure — halting all quoting');
      this.state.isQuoting = false;
      this.state.bidPrice = 0;
      this.state.askPrice = 0;
      this.state.bidSize = 0;
      this.state.askSize = 0;
    });
  }

  // ─── Lifecycle ───

  async start(): Promise<void> {
    this.startedAt = Date.now();
    this.log(`MM started | ${this.label} | waiting for ${this.config.minTradesForFairValue} trades to establish fair value...`);

    // Start risk session timer
    this.riskLimits.startSession();

    // Start heartbeat kill-switch
    await this.heartbeat.start();
  }

  stop(): void {
    this.state.isQuoting = false;

    // Stop heartbeat — server will auto-cancel remaining orders in ~10s
    this.heartbeat.stop();

    this.log(`MM stopped | ${this.label} | ${this.getSummaryLine()}`);
    this.log(`MM stopped | ${this.label} | ${this.riskLimits.getSummary()}`);
  }

  // ─── Trade Processing ───

  /**
   * Called for each CLOB WebSocket trade event. Updates fair value,
   * checks for paper fills against our hypothetical quotes, and requotes.
   */
  onTrade(event: ClobTradeEvent): void {
    // Only process trades for our token
    if (event.asset_id !== this.tokenId) return;

    const price = parseFloat(event.price);
    const size = parseFloat(event.size);
    const side = event.side;
    const tradeTs = event.timestamp ? parseInt(event.timestamp, 10) : Date.now();

    if (isNaN(price) || isNaN(size) || size <= 0) return;

    this.tradesProcessed++;

    // Track first trade time for warm-up
    if (this.firstTradeAt === 0) {
      this.firstTradeAt = Date.now();
    }

    // Filter out extreme settlement-range prices
    if (price < this.config.minFairValue || price > this.config.maxFairValue) {
      return;
    }

    // Add to recent trades buffer
    this.recentTrades.push({ price, size, side, timestamp: tradeTs });

    // Trim buffer to vwapWindow
    if (this.recentTrades.length > this.config.vwapWindow * 3) {
      this.recentTrades = this.recentTrades.slice(-this.config.vwapWindow);
    }

    // Update fair value
    const prevFairValue = this.state.lastFairValue;
    this.state.lastFairValue = this.calculateVwap();

    // Update unrealized PnL at new mark
    this.updateUnrealizedPnl();

    // Check if we're paused (event-based)
    if (Date.now() < this.state.quotingPausedUntil) {
      return;
    }

    // Need enough trades to establish fair value
    if (this.recentTrades.length < this.config.minTradesForFairValue) {
      return;
    }

    // Warm-up gate: don't start quoting until enough time has passed AND VWAP is stable
    const warmedUp = (Date.now() - this.firstTradeAt) >= this.config.warmUpMs;
    const priceStdDev = this.calculatePriceStdDev();
    const isStable = priceStdDev <= this.config.maxPriceStdDev;

    // Resume quoting if we were paused and pause has expired
    if (!this.state.isQuoting && this.state.quotingPausedUntil > 0 && Date.now() >= this.state.quotingPausedUntil) {
      // After event pause, require stability but not full warm-up
      if (!isStable) return;
      this.state.isQuoting = true;
      this.state.quotingPausedUntil = 0;
      this.updateQuotes();
      this.log(`RESUME | fair=${fmtPrice(this.state.lastFairValue)} bid=${fmtPrice(this.state.bidPrice)} ask=${fmtPrice(this.state.askPrice)} stdDev=${fmtPrice(priceStdDev)}`);
      return;
    }

    // Start quoting if we have enough data, warm-up complete, and VWAP stable
    if (!this.state.isQuoting && this.state.quotingPausedUntil === 0) {
      if (!warmedUp || !isStable) return;
      this.state.isQuoting = true;
      this.updateQuotes();
      this.log(`MM active | ${this.label} | fair=${fmtPrice(this.state.lastFairValue)} bid=${fmtPrice(this.state.bidPrice)} ask=${fmtPrice(this.state.askPrice)} spread=${fmtCents(this.state.askPrice - this.state.bidPrice)} stdDev=${fmtPrice(priceStdDev)}`);
      return;
    }

    if (!this.state.isQuoting) return;

    // ─── Risk check before processing fills ───
    const riskDecision = this.riskLimits.checkRisk(
      this.state.realizedPnl,
      this.state.unrealizedPnl,
      this.state.position,
      this.state.lastFairValue,
    );

    if (riskDecision.action === 'HALT') {
      this.state.isQuoting = false;
      this.state.bidPrice = 0;
      this.state.askPrice = 0;
      this.state.bidSize = 0;
      this.state.askSize = 0;
      this.log(`RISK HALT | ${riskDecision.reason}`);
      return;
    }

    // Apply risk-driven size reduction (e.g., when inventory is 75%+ of max)
    if (riskDecision.action === 'REDUCE_SIZE' && riskDecision.sizeFactor !== undefined) {
      const factor = riskDecision.sizeFactor;
      this.state.bidSize = Math.floor(this.state.bidSize * factor);
      this.state.askSize = Math.floor(this.state.askSize * factor);
    }

    // Check for paper fills BEFORE updating quotes
    this.checkFill(price, size, side, tradeTs);

    // Requote if fair value moved by at least half a tick
    const fairDelta = Math.abs(this.state.lastFairValue - prevFairValue);
    if (fairDelta >= this.config.tickSize / 2) {
      this.updateQuotes();
      this.log(`REQUOTE | fair=${fmtPrice(this.state.lastFairValue)} bid=${fmtPrice(this.state.bidPrice)} ask=${fmtPrice(this.state.askPrice)}`);
    }
  }

  // ─── Game Event Processing ───

  /**
   * Called when a game feed emits an event (goal, red card, scoring run, etc.).
   * Immediately cancels all quotes and pauses for the configured duration.
   */
  onGameEvent(event: GameEvent): void {
    const wasQuoting = this.state.isQuoting;
    this.state.isQuoting = false;
    this.state.bidPrice = 0;
    this.state.askPrice = 0;
    this.state.bidSize = 0;
    this.state.askSize = 0;
    this.state.quotingPausedUntil = Date.now() + this.config.eventPauseMs;

    // Clear recent trades so VWAP recalculates from post-event trades
    this.recentTrades = [];

    const eventLabel = event.eventType;
    const detail = event.rawData?.matchMinute
      ? ` at ${event.rawData.matchMinute}'`
      : '';
    const pauseSec = (this.config.eventPauseMs / 1000).toFixed(0);

    if (wasQuoting) {
      this.log(`EVENT ${eventLabel}${detail} | quotes CANCELLED | pausing ${pauseSec}s | ${event.winner} ${event.eventType === 'goal' ? 'scores' : 'benefits'}`);
    } else {
      this.log(`EVENT ${eventLabel}${detail} | already paused | extending pause ${pauseSec}s`);
    }
  }

  // ─── Stats ───

  getStats(): MMStats {
    const uptimeMs = this.startedAt > 0 ? Date.now() - this.startedAt : 0;
    const uptimeHours = uptimeMs / (1000 * 60 * 60);

    return {
      state: { ...this.state },
      fills: [...this.fills],
      tokenId: this.tokenId,
      label: this.label,
      uptimeMs,
      tradesProcessed: this.tradesProcessed,
      fillRate: uptimeHours > 0 ? this.state.totalFills / uptimeHours : 0,
      roundTripRate: uptimeHours > 0 ? this.state.totalRoundTrips / uptimeHours : 0,
      avgSpreadCapture: this.state.totalRoundTrips > 0
        ? this.state.realizedPnl / this.state.totalRoundTrips
        : 0,
    };
  }

  getState(): MMState {
    return { ...this.state };
  }

  // ─── Internal: Fair Value ───

  private calculateVwap(): number {
    const trades = this.recentTrades.slice(-this.config.vwapWindow);
    if (trades.length === 0) return this.state.lastFairValue;

    let sumPriceVolume = 0;
    let sumVolume = 0;

    for (const t of trades) {
      sumPriceVolume += t.price * t.size;
      sumVolume += t.size;
    }

    if (sumVolume === 0) return this.state.lastFairValue;
    return sumPriceVolume / sumVolume;
  }

  /**
   * Calculate the standard deviation of recent trade prices.
   * Used to determine if VWAP is stable enough to start quoting.
   */
  private calculatePriceStdDev(): number {
    const trades = this.recentTrades.slice(-this.config.vwapWindow);
    if (trades.length < 2) return Infinity;

    const mean = trades.reduce((s, t) => s + t.price, 0) / trades.length;
    const variance = trades.reduce((s, t) => s + (t.price - mean) ** 2, 0) / trades.length;
    return Math.sqrt(variance);
  }

  // ─── Internal: Quote Calculation ───

  private updateQuotes(): void {
    const fair = this.state.lastFairValue;
    if (fair <= 0) return;

    const halfSpread = this.config.spreadWidth / 2;

    // Base quotes
    let bid = fair - halfSpread;
    let ask = fair + halfSpread;

    // Inventory skew: if long, lower both prices to encourage sells
    // If short, raise both prices to encourage buys
    const skew = this.state.position * this.config.skewCoefficient;
    bid -= skew;
    ask -= skew;

    // Inventory-based size reduction: reduce size on the riskier side
    // when approaching max inventory
    let bidSize = this.config.orderSize;
    let askSize = this.config.orderSize;

    const inventoryUsd = Math.abs(this.state.position * this.state.lastFairValue);
    if (inventoryUsd > 0) {
      const utilizationRatio = inventoryUsd / this.config.maxInventory;
      if (this.state.position > 0) {
        // Long: reduce bid size (don't want to buy more)
        bidSize *= Math.max(0, 1 - utilizationRatio);
      } else {
        // Short: reduce ask size (don't want to sell more)
        askSize *= Math.max(0, 1 - utilizationRatio);
      }
    }

    // Round to tick size
    bid = this.roundToTick(bid);
    ask = this.roundToTick(ask);

    // Clamp to valid price range
    const minPrice = this.config.tickSize;
    const maxPrice = 1 - this.config.tickSize;
    bid = Math.max(minPrice, Math.min(maxPrice, bid));
    ask = Math.max(minPrice, Math.min(maxPrice, ask));

    // Ensure bid < ask (at least one tick apart)
    if (bid >= ask) {
      bid = this.roundToTick(fair - this.config.tickSize);
      ask = this.roundToTick(fair + this.config.tickSize);
    }

    // Calculate sizes in shares
    this.state.bidPrice = bid;
    this.state.askPrice = ask;
    this.state.bidSize = bid > 0 ? Math.floor(bidSize / bid) : 0;
    this.state.askSize = ask > 0 ? Math.floor(askSize / ask) : 0;
    this.state.lastQuoteUpdateAt = Date.now();
  }

  // ─── Internal: Paper Fill Detection ───

  private checkFill(tradePrice: number, tradeSize: number, tradeSide: string, tradeTs: number): void {
    if (!this.state.isQuoting) return;
    const now = Date.now();

    // A real BUY trade at price >= our ask means a taker lifted our offer (we sold)
    // A real SELL trade at price <= our bid means a taker hit our bid (we bought)

    // Cap fill size to min(ourOrderShares, triggerTradeShares) for realistic simulation.
    // In reality, the taker trade may be smaller than our resting order.

    if (tradeSide === 'BUY' && tradePrice >= this.state.askPrice && this.state.askSize > 0) {
      // Cooldown: don't take multiple ASK fills in rapid succession
      if (now - this.lastAskFillAt < ScalpMarketMaker.FILL_COOLDOWN_MS) return;

      // Queue position gate: probabilistic fill based on estimated queue depth
      if (!this.passesQueueCheck(tradePrice, tradeSize, 'ASK')) return;

      this.lastAskFillAt = now;
      const fillShares = Math.min(this.state.askSize, tradeSize);
      this.recordFill('ASK', this.state.askPrice, fillShares, tradePrice, tradeSide, tradeTs);
    }

    if (tradeSide === 'SELL' && tradePrice <= this.state.bidPrice && this.state.bidSize > 0) {
      // Cooldown: don't take multiple BID fills in rapid succession
      if (now - this.lastBidFillAt < ScalpMarketMaker.FILL_COOLDOWN_MS) return;

      // Queue position gate: probabilistic fill based on estimated queue depth
      if (!this.passesQueueCheck(tradePrice, tradeSize, 'BID')) return;

      this.lastBidFillAt = now;
      const fillShares = Math.min(this.state.bidSize, tradeSize);
      this.recordFill('BID', this.state.bidPrice, fillShares, tradePrice, tradeSide, tradeTs);
    }
  }

  /**
   * Queue position fill probability check.
   *
   * Models our position in the order queue. When queueDepthAheadUsd > 0, each
   * incoming trade at our price level has a probability of reaching us:
   *   P(fill) = tradeUsd / (queueAheadUsd + tradeUsd)
   *
   * Uses deterministic accumulation instead of random draws for reproducibility:
   * accumulate probability per price-crossing trade, fire a fill when accumulated >= 1.0.
   *
   * Returns true if the fill should proceed.
   */
  private passesQueueCheck(tradePrice: number, tradeSize: number, side: 'BID' | 'ASK'): boolean {
    const queueUsd = this.config.queueDepthAheadUsd;
    if (queueUsd <= 0) return true; // disabled — legacy 100% fill

    const tradeUsd = tradePrice * tradeSize;
    const fillProb = Math.min(1, tradeUsd / (queueUsd + tradeUsd));

    this.queueAccumulatedProb += fillProb;

    if (this.queueAccumulatedProb >= 1.0) {
      this.queueAccumulatedProb -= 1.0; // reset, keep remainder
      return true;
    }

    this.queueSkippedFills++;
    return false;
  }

  private recordFill(
    side: 'BID' | 'ASK',
    fillPrice: number,
    fillShares: number,
    triggerPrice: number,
    triggerSide: string,
    timestamp: number,
  ): void {
    const usdValue = fillPrice * fillShares;

    const fill: MMFill = {
      side,
      price: fillPrice,
      size: fillShares,
      usdValue,
      timestamp,
      triggerTradePrice: triggerPrice,
      triggerTradeSide: triggerSide,
    };

    this.fills.push(fill);
    this.state.totalFills++;

    // Track fill for risk rate-limiting
    this.riskLimits.recordFill();

    // Update inventory
    const prevPosition = this.state.position;
    const prevAvgEntry = this.state.avgEntryPrice;

    if (side === 'BID') {
      // We bought shares
      this.state.totalBidFills++;
      const newShares = fillShares;

      if (this.state.position >= 0) {
        // Adding to long position or opening new long
        const totalShares = this.state.position + newShares;
        this.state.avgEntryPrice = totalShares > 0
          ? (prevAvgEntry * this.state.position + fillPrice * newShares) / totalShares
          : fillPrice;
        this.state.position = totalShares;
      } else {
        // Closing short position (partially or fully), may flip to long
        const closedShares = Math.min(newShares, Math.abs(this.state.position));

        // Realize PnL on closed portion: sold at avgEntry, bought back at fillPrice
        const pnl = (prevAvgEntry - fillPrice) * closedShares;
        this.state.realizedPnl += pnl;
        this.state.totalRoundTrips++;

        this.state.position += newShares;
        if (this.state.position > 0) {
          // Flipped to long
          this.state.avgEntryPrice = fillPrice;
        } else if (this.state.position === 0) {
          this.state.avgEntryPrice = 0;
        }
        // else still short, avgEntry unchanged
      }

      this.log(`FILL BID | bought ${fillShares} @ ${fmtPrice(fillPrice)} ($${usdValue.toFixed(2)}) | trigger: SELL ${Math.round(triggerPrice * 1000) / 1000}x${Math.round(fillShares)} | inv=${this.state.position > 0 ? '+' : ''}${this.state.position} | PnL=${fmtUsd(this.state.realizedPnl)}${this.state.totalRoundTrips > 0 && side === 'BID' && prevPosition < 0 ? ` (RT#${this.state.totalRoundTrips})` : ''}`);

    } else {
      // We sold shares
      this.state.totalAskFills++;
      const soldShares = fillShares;

      if (this.state.position <= 0) {
        // Adding to short position or opening new short
        const totalShares = this.state.position - soldShares;
        this.state.avgEntryPrice = totalShares < 0
          ? (prevAvgEntry * Math.abs(this.state.position) + fillPrice * soldShares) / Math.abs(totalShares)
          : fillPrice;
        this.state.position = totalShares;
      } else {
        // Closing long position (partially or fully), may flip to short
        const closedShares = Math.min(soldShares, this.state.position);

        // Realize PnL on closed portion: bought at avgEntry, sold at fillPrice
        const pnl = (fillPrice - prevAvgEntry) * closedShares;
        this.state.realizedPnl += pnl;
        this.state.totalRoundTrips++;

        this.state.position -= soldShares;
        if (this.state.position < 0) {
          // Flipped to short
          this.state.avgEntryPrice = fillPrice;
        } else if (this.state.position === 0) {
          this.state.avgEntryPrice = 0;
        }
        // else still long, avgEntry unchanged
      }

      this.log(`FILL ASK | sold ${fillShares} @ ${fmtPrice(fillPrice)} ($${usdValue.toFixed(2)}) | trigger: BUY ${Math.round(triggerPrice * 1000) / 1000}x${Math.round(fillShares)} | inv=${this.state.position > 0 ? '+' : ''}${this.state.position} | PnL=${fmtUsd(this.state.realizedPnl)}${this.state.totalRoundTrips > 0 && side === 'ASK' && prevPosition > 0 ? ` (RT#${this.state.totalRoundTrips})` : ''}`);
    }

    // Update unrealized PnL
    this.updateUnrealizedPnl();

    // Requote after fill (quotes consumed)
    this.updateQuotes();
  }

  // ─── Internal: PnL ───

  private updateUnrealizedPnl(): void {
    if (this.state.position === 0 || this.state.lastFairValue <= 0) {
      this.state.unrealizedPnl = 0;
      return;
    }

    if (this.state.position > 0) {
      // Long: profit if fair value > avg entry
      this.state.unrealizedPnl = (this.state.lastFairValue - this.state.avgEntryPrice) * this.state.position;
    } else {
      // Short: profit if fair value < avg entry
      this.state.unrealizedPnl = (this.state.avgEntryPrice - this.state.lastFairValue) * Math.abs(this.state.position);
    }
  }

  // ─── Internal: Utilities ───

  private roundToTick(price: number): number {
    return Math.round(price / this.config.tickSize) * this.config.tickSize;
  }

  private log(msg: string): void {
    this.onLog(`[${tsShort()}] ${msg}`);
  }

  getSummaryLine(): string {
    const totalPnl = this.state.realizedPnl + this.state.unrealizedPnl;
    const queueInfo = this.config.queueDepthAheadUsd > 0
      ? ` queueSkip=${this.queueSkippedFills}`
      : '';
    return `fills=${this.state.totalFills} RTs=${this.state.totalRoundTrips} PnL=${fmtUsd(this.state.realizedPnl)} inventory=${this.state.position > 0 ? '+' : ''}${this.state.position} unrealized=${fmtUsd(this.state.unrealizedPnl)} total=${fmtUsd(totalPnl)}${queueInfo}`;
  }

  getQueueStats(): { skippedFills: number; accumulatedProb: number; queueDepthUsd: number } {
    return {
      skippedFills: this.queueSkippedFills,
      accumulatedProb: this.queueAccumulatedProb,
      queueDepthUsd: this.config.queueDepthAheadUsd,
    };
  }

  /**
   * Print a formatted stats summary line. Intended for periodic status output.
   */
  printStats(): void {
    this.log(`STATS | ${this.getSummaryLine()} | trades=${this.tradesProcessed} fair=${fmtPrice(this.state.lastFairValue)}`);
    this.log(`STATS | ${this.riskLimits.getSummary()} | heartbeat=${this.heartbeat.isHealthy() ? 'OK' : 'UNHEALTHY'}`);
  }

  /**
   * Get the risk limits instance for external inspection.
   */
  getRiskLimits(): RiskLimits {
    return this.riskLimits;
  }

  /**
   * Get the heartbeat manager instance for external inspection.
   */
  getHeartbeat(): HeartbeatManager {
    return this.heartbeat;
  }
}
