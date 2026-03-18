import 'dotenv/config';
import https from 'https';
import axios from 'axios';
import pLimit from 'p-limit';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import {
  initialize as initExecutor, isLiveReady, getWalletBalance,
  resetBalancePause, preWarmMetadata, isBalancePaused, CLOB_MIN_ORDER_USD,
} from '../services/trade-executor';
import { executeMarketOrder as realExecute } from '../services/trade-executor';
import { executeMarketOrder as paperExecute } from '../services/paper-executor';
import type { ExecuteOrderResult } from '../services/trade-executor';
import {
  processCopyTrade, isInSellCooldown, recordSellFill,
  isInSellFailureCooldown, recordSellFailure,
  isInBuyFailureCooldown, recordBuyFailure,
  createSkippedRecord,
} from '../services/copy-trade-worker';
import type { DetectedTradeRow } from '../services/copy-trade-worker';
import { addToPool } from '../services/order-pool';
import { startPortfolioRefresh, stopPortfolioRefresh } from '../services/portfolio-cache';
import { rehydratePool, sweepPool } from '../services/order-pool';
// Settlement + market refresh sweeps moved to ipc-bridge.ts
import { reconcileStalePending, reconcileSkippedGhostFills } from '../services/clob-reconciler';
import { sweepPreResolutionSells } from '../services/pre-resolution-seller';
import { resolveMarkets } from '../services/market-resolver';
import { computeSellCostBasis } from '../lib/cost-basis';
import { scheduleDelayedOrderPoll, scheduleGtcFallbackPoll, type DelayedOrderContext } from '../services/delayed-order-poller';
import { auditAllAllocations, auditPhantomPositions, cleanupPhantomPositions, checkCircuitBreakers } from '../lib/capital-audit';
import { initMidpointCache, closeMidpointCache, ensureSubscribed } from '../services/midpoint-cache';
import { getOrCreateMutex } from '../lib/allocation-mutex';
import { PgListener } from '../lib/pg-listen';
import { recordTraderBuy, getMajoritySide, pruneAccumulator, seedAccumulator, clearAccumulator } from '../services/majority-accumulator';

const JOB_NAME = 'copy-trader';
const log = createJobLogger(JOB_NAME);
const CAPITAL_AUDIT_INTERVAL_MS = 3_600_000; // 1 hour

// ─── Pipeline infrastructure (Change 5) ───

const clobLimiter = pLimit(15);
const MAX_DRAIN_BATCH_SIZE = 200;

// ─── DrainCache (Change 3) ───

interface CachedPosition { netShares: number; netUsd: number; buyCost: number; buyShares: number; }

interface DrainCache {
  getPosition(tokenId: string, allocationId: string, isPaper: boolean): CachedPosition;
  getOppositeTokenId(conditionId: string, currentAsset: string): string | null;
  addPending(tokenId: string, allocationId: string, isPaper: boolean,
             usd: number, shares: number, side: 'BUY' | 'SELL'): void;
  getPendingCapital(allocationId: string): number;
  getDailySpend(isPaper: boolean): number;
  isMarketClosed(conditionId: string): boolean;
  getMarketEndDate(conditionId: string): Date | null;
  getMarketEventSlug(conditionId: string): string | null;
  getMarketTitle(conditionId: string): string | null;
}

async function buildDrainCache(
  conditionIds: string[],
  batchTokenMap: Map<string, Set<string>>,
): Promise<DrainCache> {
  // Queries 1-3: Positions, pending capital, daily spend — run in parallel (no data dependencies)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [positionRows, pendingCapitalRows, dailySpendRows] = await Promise.all([
    prisma.$queryRaw<Array<{
      tokenId: string; followAllocationId: string; isPaper: boolean;
      netShares: number; netUsd: number; buyCost: number; buyShares: number;
    }>>`
      SELECT "tokenId", "followAllocationId", "isPaper",
        SUM(CASE
          WHEN side='BUY' THEN COALESCE("filledSize", "requestedAmount" / NULLIF("requestedPrice", 0), 0)
          ELSE -COALESCE("filledSize", "requestedAmount" / NULLIF("requestedPrice", 0), 0)
        END)::float as "netShares",
        SUM(CASE
          WHEN side='BUY' THEN COALESCE("filledSize" * "filledPrice", "requestedAmount", 0)
          ELSE -COALESCE("filledSize" * "filledPrice", "requestedAmount", 0)
        END)::float as "netUsd",
        SUM(CASE WHEN side='BUY' THEN COALESCE("filledSize" * "filledPrice", "requestedAmount", 0) ELSE 0 END)::float as "buyCost",
        SUM(CASE WHEN side='BUY' THEN COALESCE("filledSize", "requestedAmount" / NULLIF("requestedPrice", 0), 0) ELSE 0 END)::float as "buyShares"
      FROM "CopyTrade" WHERE status IN ('FILLED', 'PENDING')
      GROUP BY "tokenId", "followAllocationId", "isPaper"
    `,
    prisma.$queryRaw<Array<{
      followAllocationId: string; pendingCapital: number;
    }>>`
      SELECT "followAllocationId", SUM("requestedAmount")::float as "pendingCapital"
      FROM "CopyTrade" WHERE status = 'PENDING' AND side = 'BUY' AND "followAllocationId" IS NOT NULL
      GROUP BY "followAllocationId"
    `,
    prisma.$queryRaw<Array<{
      isPaper: boolean; dailySpend: number;
    }>>`
      SELECT "isPaper", SUM("requestedAmount")::float as "dailySpend"
      FROM "CopyTrade"
      WHERE status IN ('FILLED', 'POOLED', 'PENDING') AND side = 'BUY'
        AND "createdAt" >= ${todayStart}
      GROUP BY "isPaper"
    `,
  ]);

  const positionCache = new Map<string, CachedPosition>();
  for (const row of positionRows) {
    const key = `${row.tokenId}:${row.followAllocationId}:${row.isPaper}`;
    const clampShares = Math.max(row.netShares ?? 0, 0);
    const clampUsd = Math.max(row.netUsd ?? 0, 0);
    positionCache.set(key, {
      netShares: clampShares < 0.01 ? 0 : clampShares,
      netUsd: clampUsd < 0.01 ? 0 : clampUsd,
      buyCost: Math.max(row.buyCost ?? 0, 0),
      buyShares: Math.max(row.buyShares ?? 0, 0),
    });
  }

  const pendingCapitalMap = new Map<string, number>();
  for (const row of pendingCapitalRows) {
    pendingCapitalMap.set(row.followAllocationId, row.pendingCapital ?? 0);
  }

  const dailySpendMap = new Map<string, number>();
  for (const row of dailySpendRows) {
    dailySpendMap.set(row.isPaper ? 'paper' : 'live', row.dailySpend ?? 0);
  }

  // Query 3: Market status
  const uniqueConditionIds = [...new Set(conditionIds)];
  const markets = await prisma.market.findMany({
    where: { conditionId: { in: uniqueConditionIds } },
    select: { conditionId: true, closed: true, endDate: true, eventSlug: true, question: true },
  });
  const marketClosedMap = new Map<string, boolean>();
  const marketEndDateMap = new Map<string, Date | null>();
  const marketEventSlugMap = new Map<string, string | null>();
  const marketQuestionMap = new Map<string, string | null>();
  for (const m of markets) {
    marketClosedMap.set(m.conditionId, m.closed);
    marketEndDateMap.set(m.conditionId, m.endDate);
    marketEventSlugMap.set(m.conditionId, m.eventSlug ?? null);
    marketQuestionMap.set(m.conditionId, m.question ?? null);
  }

  // Resolve missing markets from Gamma API
  const missing = uniqueConditionIds.filter(id => !marketClosedMap.has(id));
  if (missing.length > 0) {
    try {
      await resolveMarkets(missing);
      const resolved = await prisma.market.findMany({
        where: { conditionId: { in: missing } },
        select: { conditionId: true, closed: true, endDate: true, eventSlug: true, question: true },
      });
      for (const m of resolved) {
        marketClosedMap.set(m.conditionId, m.closed);
        marketEndDateMap.set(m.conditionId, m.endDate);
        marketEventSlugMap.set(m.conditionId, m.eventSlug ?? null);
        marketQuestionMap.set(m.conditionId, m.question ?? null);
      }
    } catch (err: any) {
      log.warn(`DrainCache: resolveMarkets failed (fail-open): ${err.message}`);
    }
  }

  // Build opposite token map: conditionId → Set<tokenId>
  // Start from batch trades (zero-cost), then fill gaps from DB
  const oppositeTokenMap = new Map<string, Set<string>>();
  for (const [cid, tokens] of batchTokenMap) {
    oppositeTokenMap.set(cid, new Set(tokens));
  }
  const needDbLookup = uniqueConditionIds.filter(cid => {
    const s = oppositeTokenMap.get(cid);
    return !s || s.size < 2;
  });
  if (needDbLookup.length > 0) {
    const knownTokenRows = await prisma.detectedTrade.findMany({
      where: { conditionId: { in: needDbLookup } },
      distinct: ['conditionId', 'asset'],
      select: { conditionId: true, asset: true },
    });
    for (const row of knownTokenRows) {
      const set = oppositeTokenMap.get(row.conditionId) ?? new Set();
      set.add(row.asset);
      oppositeTokenMap.set(row.conditionId, set);
    }
  }

  return {
    getPosition(tokenId, allocationId, isPaper) {
      const key = `${tokenId}:${allocationId}:${isPaper}`;
      return positionCache.get(key) ?? { netShares: 0, netUsd: 0, buyCost: 0, buyShares: 0 };
    },

    getOppositeTokenId(conditionId, currentAsset) {
      const tokens = oppositeTokenMap.get(conditionId);
      if (!tokens) return null;
      for (const t of tokens) {
        if (t !== currentAsset) return t;
      }
      return null;
    },

    addPending(tokenId, allocationId, isPaper, usd, shares, side) {
      const key = `${tokenId}:${allocationId}:${isPaper}`;
      const pos = positionCache.get(key) ?? { netShares: 0, netUsd: 0, buyCost: 0, buyShares: 0 };
      if (side === 'BUY') {
        pos.netShares += shares;
        pos.netUsd += usd;
        pos.buyCost += usd;
        pos.buyShares += shares;
      } else {
        pos.netShares -= shares;
        pos.netUsd -= usd;
      }
      positionCache.set(key, {
        netShares: Math.max(pos.netShares, 0),
        netUsd: Math.max(pos.netUsd, 0),
        buyCost: pos.buyCost,
        buyShares: pos.buyShares,
      });
      if (side === 'BUY') {
        pendingCapitalMap.set(allocationId, (pendingCapitalMap.get(allocationId) ?? 0) + usd);
        const dsKey = isPaper ? 'paper' : 'live';
        dailySpendMap.set(dsKey, (dailySpendMap.get(dsKey) ?? 0) + usd);
      }
    },

    getPendingCapital(allocationId) {
      return pendingCapitalMap.get(allocationId) ?? 0;
    },

    getDailySpend(isPaper) {
      return dailySpendMap.get(isPaper ? 'paper' : 'live') ?? 0;
    },

    isMarketClosed(conditionId) {
      return marketClosedMap.get(conditionId) ?? false; // fail-open
    },

    getMarketEndDate(conditionId) {
      return marketEndDateMap.get(conditionId) ?? null;
    },

    getMarketEventSlug(conditionId) {
      return marketEventSlugMap.get(conditionId) ?? null;
    },

    getMarketTitle(conditionId) {
      return marketQuestionMap.get(conditionId) ?? null;
    },
  };
}

let pruneCounter = 0;

// ─── PhaseA result ───

interface PhaseAResult {
  copyTradeId: string;
  tokenId: string;
  side: 'BUY' | 'SELL';
  executorAmount: number;
  detectedPrice: number;
  isPaper: boolean;
  copyAmountUsd: number;
  sellShares: number | null;
  startMs: number;
  signalAgeMs: number;
  clobPromise?: Promise<{ result: ExecuteOrderResult; clobMs: number }>;
  clobStartMs?: number;
  drainStartMs: number;
  traderTradeUsd: number | null;
  copyPercent: number;
  maxPerTrade: number;
  maxPerPrediction: number;
  tradeInfo: { proxyWallet: string; userName: string | null; outcome: string; title: string | null };
  detectionSource?: string;
}

// ─── Phase A: checks + PENDING create (under mutex) ───

async function phaseA(
  trade: DetectedTradeRow,
  allocation: { id: string; isPaper: boolean; currentCapital: number;
    copyTradePercent: number | null; maxPositionUsd: number | null; maxPredictionPositionUsd: number | null;
    minBuyPrice: number | null; excludeEventSlugPatterns: string | null; excludeTitlePatterns: string | null;
    majorityOnlyMode: boolean },
  cache: DrainCache,
  drainStartMs: number,
  preRecorded?: boolean,
): Promise<PhaseAResult | null> {
  const startMs = Date.now();
  const signalAgeMs = startMs - (trade.realTimestamp ?? trade.timestamp) * 1000;
  const isPaper = allocation.isPaper;

  const copyPercent = allocation.copyTradePercent ?? config.COPY_TRADE_PERCENT;
  const maxPerTrade = allocation.maxPositionUsd ?? config.MAX_POSITION_USD;
  const maxPerPrediction = allocation.maxPredictionPositionUsd ?? config.MAX_PREDICTION_POSITION_USD;

  if (copyPercent > 1.0 || copyPercent <= 0 || maxPerTrade <= 0 || maxPerPrediction < 0) {
    return null;
  }

  // Filter checks (all in-memory)
  if (!isPaper && trade.side === 'BUY' && isBalancePaused()) {
    await createSkippedRecord(trade, 'live trading paused: insufficient wallet balance', allocation.id, isPaper);
    return null;
  }

  if (trade.side === 'BUY' && config.MARKET_END_GATEKEEP_ENABLED && cache.isMarketClosed(trade.conditionId)) {
    await createSkippedRecord(trade, 'market already closed', allocation.id, isPaper);
    return null;
  }

  if (trade.side === 'BUY' && config.MARKET_END_GATEKEEP_ENABLED) {
    const eventSlug = cache.getMarketEventSlug(trade.conditionId);
    const isCryptoUpdown = eventSlug?.startsWith('btc-updown')
      || eventSlug?.startsWith('sol-updown')
      || eventSlug?.startsWith('eth-updown')
      || eventSlug?.startsWith('xrp-updown');
    if (isCryptoUpdown) {
      const endDate = cache.getMarketEndDate(trade.conditionId);
      if (endDate && Date.now() > endDate.getTime()) {
        await createSkippedRecord(trade, `crypto updown market expired (endDate: ${endDate.toISOString()})`, allocation.id, isPaper);
        return null;
      }
    }
  }

  // ── Majority accumulator: record every trader BUY (before per-allocation sizing/exclusion filters) ──
  // Skip when preRecorded=true (drain pre-pass already recorded all batch signals)
  if (trade.side === 'BUY' && !preRecorded) {
    recordTraderBuy(trade.proxyWallet, trade.conditionId, trade.outcome, trade.size * trade.price);
  }

  // ─── Signal age guard (live BUYs only) — AFTER accumulator recording ───
  if (!isPaper && trade.side === 'BUY' && config.MAX_SIGNAL_AGE_MS > 0 && signalAgeMs > config.MAX_SIGNAL_AGE_MS) {
    log.warn('Signal age guard: rejecting stale live BUY', {
      trader: trade.proxyWallet.slice(0, 10),
      signalAgeSec: (signalAgeMs / 1000).toFixed(1),
      maxAgeSec: (config.MAX_SIGNAL_AGE_MS / 1000).toFixed(0),
      title: trade.title?.slice(0, 50),
      price: trade.price,
    });
    await createSkippedRecord(
      trade,
      `signal too old: ${(signalAgeMs / 1000).toFixed(0)}s > ${(config.MAX_SIGNAL_AGE_MS / 1000).toFixed(0)}s max`,
      allocation.id,
      isPaper,
    );
    return null;
  }

  // Per-allocation min buy price filter
  if (allocation.minBuyPrice != null && trade.side === 'BUY' && trade.price < allocation.minBuyPrice - 0.001) {
    await createSkippedRecord(trade, `price ${trade.price} below minBuyPrice ${allocation.minBuyPrice}`, allocation.id, isPaper);
    return null;
  }

  // Per-allocation event slug exclusion filter (BUY only)
  if (allocation.excludeEventSlugPatterns != null && trade.side === 'BUY') {
    const eventSlug = trade.eventSlug ?? cache.getMarketEventSlug(trade.conditionId);
    if (eventSlug) {
      const patterns = allocation.excludeEventSlugPatterns.split(',').map(p => p.trim().toLowerCase());
      if (patterns.some(p => eventSlug.toLowerCase().includes(p))) {
        await createSkippedRecord(trade, `eventSlug "${eventSlug}" matches exclude pattern`, allocation.id, isPaper);
        return null;
      }
    } else {
      // Fail-closed: eventSlug unavailable from trade record and Market table — cannot verify exclusion
      await createSkippedRecord(trade, 'eventSlug unavailable (fail-closed for exclude filter)', allocation.id, isPaper);
      return null;
    }
  }

  // Per-allocation title exclusion filter (BUY only — never block exits)
  if (allocation.excludeTitlePatterns != null && trade.side === 'BUY') {
    const title = trade.title ?? cache.getMarketTitle(trade.conditionId);
    if (title) {
      const patterns = allocation.excludeTitlePatterns.split(',').map(p => p.trim().toLowerCase());
      if (patterns.some(p => title.toLowerCase().includes(p))) {
        await createSkippedRecord(trade, `title matches exclude pattern`, allocation.id, isPaper);
        return null;
      }
    } else {
      // Fail-closed: title unavailable — cannot verify exclusion
      await createSkippedRecord(trade, 'title unavailable (fail-closed for exclude filter)', allocation.id, isPaper);
      return null;
    }
  }

  // ── Majority gate (opt-in per allocation) ──
  // Self-exclusion: subtract current signal's USD so it can't tip its own majority check.
  // Both-sides: require signals from both outcomes before opening the gate.
  let majorityTotalUsd: number | null = null;
  if (trade.side === 'BUY' && allocation.majorityOnlyMode) {
    const tradeUsd = trade.size * trade.price;
    const majority = getMajoritySide(
      trade.proxyWallet, trade.conditionId,
      config.MAJORITY_MIN_USD, config.MAJORITY_MIN_RATIO,
      { outcome: trade.outcome, usd: tradeUsd },
    );
    if (!majority) {
      await createSkippedRecord(trade, 'majority accumulating: insufficient signal', allocation.id, isPaper);
      return null;
    }
    if (majority.numOutcomes < 2) {
      await createSkippedRecord(trade,
        `majority gate: only ${majority.numOutcomes} outcome(s) seen ($${majority.totalUsd.toFixed(0)}) — waiting for both sides`,
        allocation.id, isPaper);
      return null;
    }
    if (trade.outcome !== majority.outcome) {
      await createSkippedRecord(trade,
        `majority is "${majority.outcome}" (${(majority.ratio * 100).toFixed(0)}% of $${majority.totalUsd.toFixed(0)}, ${majority.totalTrades} trades) — skipping minority "${trade.outcome}"`,
        allocation.id, isPaper);
      return null;
    }
    majorityTotalUsd = majority.totalUsd;
    log.debug(`Majority confirmed: "${trade.outcome}" (${(majority.ratio * 100).toFixed(0)}% of $${majority.totalUsd.toFixed(0)}, ${majority.numOutcomes} outcomes)`, {
      conditionId: trade.conditionId, proxyWallet: trade.proxyWallet,
    });
  }

  // ── Committed side lock: once FILLED on one outcome, block opposite-side BUYs ──
  if (trade.side === 'BUY' && config.COMMITTED_SIDE_LOCK) {
    const oppositeTokenId = cache.getOppositeTokenId(trade.conditionId, trade.asset);
    if (oppositeTokenId) {
      const oppositePos = cache.getPosition(oppositeTokenId, allocation.id, isPaper);
      if (oppositePos.netUsd >= 0.01) {
        await createSkippedRecord(trade,
          `committed side lock: $${oppositePos.netUsd.toFixed(2)} already deployed on opposite outcome`,
          allocation.id, isPaper);
        return null;
      }
    }
  }

  if (trade.side === 'BUY' && isInSellCooldown(allocation.id, trade.asset)) {
    await createSkippedRecord(trade, 'token sell cool-down active', allocation.id, isPaper);
    return null;
  }

  if (trade.side === 'BUY' && isInBuyFailureCooldown(allocation.id, trade.asset)) {
    await createSkippedRecord(trade, 'buy failure cooldown active', allocation.id, isPaper);
    return null;
  }

  // ─── Disable SELL-copy for live trades (must mirror copy-trade-worker.ts guard) ───
  if (!isPaper && trade.side === 'SELL') {
    await createSkippedRecord(trade, 'live SELL-copy disabled (hold-to-settlement strategy)', allocation.id, isPaper);
    return null;
  }

  // Sizing
  let copyAmountUsd: number;
  let sellShares: number | null = null;
  let traderTradeUsd: number | null = null;

  if (trade.side === 'SELL') {
    // Short-circuit if a recent SELL on this tokenId already failed (market closed/dead)
    if (isInSellFailureCooldown(allocation.id, trade.asset)) {
      await createSkippedRecord(trade, 'sell failure cooldown active', allocation.id, isPaper);
      return null;
    }

    // Skip SELL if position is already settled — tokens redeemed on-chain, CLOB will reject
    const settledRecord = await prisma.copyTrade.findFirst({
      where: {
        tokenId: trade.asset,
        followAllocationId: allocation.id,
        isPaper,
        status: 'SETTLED',
      },
      select: { id: true },
    });
    if (settledRecord) {
      await createSkippedRecord(trade, 'position already settled (tokens redeemed)', allocation.id, isPaper);
      return null;
    }

    // cache.getPosition() rounds sub-penny amounts (< 0.01 shares) to 0 — these are
    // unsellable on CLOB (2dp floor → 0) and settle at market resolution.
    const heldShares = cache.getPosition(trade.asset, allocation.id, isPaper).netShares;
    if (heldShares === 0) {
      await createSkippedRecord(trade, 'no shares held to sell', allocation.id, isPaper);
      return null;
    }
    sellShares = Math.floor(heldShares * 100) / 100;
    copyAmountUsd = sellShares * trade.price;
  } else {
    const availableCapital = allocation.currentCapital - cache.getPendingCapital(allocation.id);
    if (availableCapital <= 0) {
      await createSkippedRecord(trade, 'insufficient allocated capital (zero balance)', allocation.id, isPaper);
      return null;
    }

    const fragmentUsd = trade.size * trade.price;
    traderTradeUsd = majorityTotalUsd ?? fragmentUsd;
    if (majorityTotalUsd != null && majorityTotalUsd !== fragmentUsd) {
      log.debug('Sizing from accumulator aggregate', {
        accumulatorUsd: majorityTotalUsd.toFixed(2),
        fragmentUsd: fragmentUsd.toFixed(2),
      });
    }

    if (trade.compositeScore !== null && trade.compositeScore < config.MIN_COMPOSITE_SCORE) {
      await createSkippedRecord(trade, `composite score ${trade.compositeScore.toFixed(4)} below minimum ${config.MIN_COMPOSITE_SCORE}`, allocation.id, isPaper);
      return null;
    }
    if (config.MIN_SIGNAL_TRADE_USD > 0 && traderTradeUsd < config.MIN_SIGNAL_TRADE_USD) {
      await createSkippedRecord(trade, `signal trade size $${traderTradeUsd.toFixed(2)} below minimum $${config.MIN_SIGNAL_TRADE_USD}`, allocation.id, isPaper);
      return null;
    }

    copyAmountUsd = traderTradeUsd * copyPercent;
    copyAmountUsd = Math.min(copyAmountUsd, maxPerTrade);
  }

  // Position lookup (BUY only, always)
  let positionUsd = 0;
  if (trade.side === 'BUY') {
    positionUsd = cache.getPosition(trade.asset, allocation.id, isPaper).netUsd;
  }

  // Per-prediction cap
  if (trade.side === 'BUY' && maxPerPrediction > 0) {
    const remaining = maxPerPrediction - positionUsd;
    if (remaining < 0.01) {
      await createSkippedRecord(trade, 'prediction position limit reached', allocation.id, isPaper);
      return null;
    }
    if (copyAmountUsd > remaining) copyAmountUsd = remaining;
  }

  // Hedge guard: block cheap naked BUY + cap hedge trades
  let hedgeMaxUsd = Infinity;
  // Pre-filter: since avgBuyPrice ≤ 1.0 on Polymarket, ratio * avgBuyPrice ≤ ratio.
  // Any trade priced at or above the ratio itself cannot be a hedge.
  if (trade.side === 'BUY' && config.HEDGE_PRICE_RATIO > 0 && trade.price < config.HEDGE_PRICE_RATIO) {
    const oppositeTokenId = cache.getOppositeTokenId(trade.conditionId, trade.asset);
    let hasOpposite = false;
    let avgBuyPrice = 0;
    let oppositeNetUsd = 0;

    if (oppositeTokenId) {
      const oppositePos = cache.getPosition(oppositeTokenId, allocation.id, isPaper);
      avgBuyPrice = oppositePos.buyShares > 0 ? oppositePos.buyCost / oppositePos.buyShares : 0;
      oppositeNetUsd = oppositePos.netUsd;
      hasOpposite = avgBuyPrice > 0 && oppositeNetUsd >= 0.01;
    }

    if (!hasOpposite) {
      // No opposite position — block only if price is very cheap (backup/hedge pattern)
      if (config.HEDGE_NAKED_MAX_PRICE > 0 && trade.price <= config.HEDGE_NAKED_MAX_PRICE) {
        log.info('Hedge guard: blocked cheap naked BUY — no opposite position', {
          trader: trade.proxyWallet.slice(0, 10),
          price: trade.price,
          nakedMaxPrice: config.HEDGE_NAKED_MAX_PRICE,
          outcome: trade.outcome, title: trade.title?.slice(0, 50),
        });
        await createSkippedRecord(trade,
          `hedge guard: naked BUY @${trade.price.toFixed(2)} ≤ ${config.HEDGE_NAKED_MAX_PRICE} with no opposite position`,
          allocation.id, isPaper);
        return null;
      }
      // Price above naked ceiling (e.g. 15¢) → allow through, could be legitimate cheap market
    } else {
      // Opposite exists — check if this trade qualifies as a hedge (price below ratio threshold)
      const isHedge = trade.price < config.HEDGE_PRICE_RATIO * avgBuyPrice;
      if (isHedge) {
        if (oppositeNetUsd < config.HEDGE_MIN_OPPOSITE_USD) {
          log.info('Hedge guard: blocked hedge — opposite position too small', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: avgBuyPrice.toFixed(3),
            threshold: (config.HEDGE_PRICE_RATIO * avgBuyPrice).toFixed(3),
            oppositeUsd: oppositeNetUsd.toFixed(2),
            minRequired: config.HEDGE_MIN_OPPOSITE_USD,
            outcome: trade.outcome, title: trade.title?.slice(0, 50),
          });
          await createSkippedRecord(trade,
            `hedge guard: trade @${trade.price.toFixed(2)} < ${config.HEDGE_PRICE_RATIO} * opposite avg ${avgBuyPrice.toFixed(3)}, ` +
            `opposite position $${oppositeNetUsd.toFixed(2)} < $${config.HEDGE_MIN_OPPOSITE_USD} minimum`,
            allocation.id, isPaper);
          return null;
        }
        hedgeMaxUsd = oppositeNetUsd * config.HEDGE_MAX_RATIO;
        if (copyAmountUsd > hedgeMaxUsd) {
          copyAmountUsd = hedgeMaxUsd;
          log.info('Hedge guard: trimmed copy amount to max hedge ratio', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: avgBuyPrice.toFixed(3),
            oppositeUsd: oppositeNetUsd.toFixed(2),
            maxHedgeUsd: hedgeMaxUsd.toFixed(2), hedgeMaxRatio: config.HEDGE_MAX_RATIO,
          });
        }
      }
      // else: hasOpposite but NOT a hedge (price above ratio threshold) → proceed normally
    }
  }

  // CLOB $1 minimum (live BUY only)
  if (trade.side === 'BUY' && !isPaper && copyAmountUsd < CLOB_MIN_ORDER_USD) {
    if (positionUsd < 0.01) {
      copyAmountUsd = Math.min(CLOB_MIN_ORDER_USD, hedgeMaxUsd);
      if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
        await createSkippedRecord(trade, `hedge guard cap $${hedgeMaxUsd.toFixed(2)} below CLOB minimum $${CLOB_MIN_ORDER_USD}`, allocation.id, isPaper);
        return null;
      }
    } else {
      // Sub-$1 add-on — pool it (skip dust)
      if (copyAmountUsd < 0.01) {
        await createSkippedRecord(trade, `dust amount $${copyAmountUsd.toFixed(6)} below pool minimum`, allocation.id, isPaper);
        return null;
      }
      cache.addPending(trade.asset, allocation.id, isPaper, copyAmountUsd, copyAmountUsd / trade.price, 'BUY');
      await addToPool(trade, copyAmountUsd, { id: allocation.id, isPaper });
      return null;
    }
  }

  // Daily limit
  if (trade.side === 'BUY') {
    const globalRemaining = config.MAX_DAILY_LOSS_USD - cache.getDailySpend(isPaper);
    if (globalRemaining <= 0) {
      await createSkippedRecord(trade, 'global daily loss limit reached', allocation.id, isPaper);
      return null;
    }
    if (copyAmountUsd > globalRemaining) copyAmountUsd = globalRemaining;
  }

  if (copyAmountUsd <= 0) return null;

  // Pool routing (paper + live)
  const poolThreshold = isPaper ? config.POOL_MIN_AMOUNT_USD : config.LIVE_POOL_MIN_AMOUNT_USD;
  if (trade.side === 'BUY' && copyAmountUsd < poolThreshold) {
    cache.addPending(trade.asset, allocation.id, isPaper, copyAmountUsd, copyAmountUsd / trade.price, 'BUY');
    await addToPool(trade, copyAmountUsd, { id: allocation.id, isPaper });
    return null;
  }

  // Capital check
  if (trade.side === 'BUY') {
    const availableCapital = allocation.currentCapital - cache.getPendingCapital(allocation.id);
    if (copyAmountUsd > availableCapital) {
      await createSkippedRecord(trade, 'insufficient allocated capital', allocation.id, isPaper);
      return null;
    }
  }

  const executorAmount = trade.side === 'BUY' ? copyAmountUsd : sellShares!;

  // Create PENDING record (P2002 handles dedup)
  let copyTradeId: string;
  try {
    const record = await prisma.copyTrade.create({
      data: {
        detectedTradeId: trade.id,
        tokenId: trade.asset,
        side: trade.side,
        requestedAmount: copyAmountUsd,
        requestedPrice: trade.price,
        status: 'PENDING',
        isPaper,
        followAllocationId: allocation.id,
        latencyMs: 0,
      },
    });
    copyTradeId = record.id;
  } catch (err: any) {
    if (err.code === 'P2002') return null;
    throw err;
  }

  // Update cache
  const shares = trade.side === 'BUY' ? copyAmountUsd / trade.price : sellShares!;
  cache.addPending(trade.asset, allocation.id, isPaper, copyAmountUsd, shares, trade.side as 'BUY' | 'SELL');

  return {
    copyTradeId,
    tokenId: trade.asset,
    side: trade.side as 'BUY' | 'SELL',
    executorAmount,
    detectedPrice: trade.price,
    isPaper,
    copyAmountUsd,
    sellShares,
    startMs,
    signalAgeMs,
    drainStartMs,
    traderTradeUsd,
    copyPercent,
    maxPerTrade,
    maxPerPrediction,
    tradeInfo: {
      proxyWallet: trade.proxyWallet,
      userName: trade.userName,
      outcome: trade.outcome,
      title: trade.title,
    },
    detectionSource: trade.detectionSource ?? undefined,
  };
}

// ─── Batch Settlement ───

async function batchSettle(
  allocation: { id: string; isPaper: boolean },
  reservations: PhaseAResult[],
  clobResults: PromiseSettledResult<{ result: ExecuteOrderResult; clobMs: number }>[],
): Promise<void> {
  const delayedPolls: (DelayedOrderContext & { delayedReason?: string; amountUsd?: number })[] = [];

  await prisma.$transaction(async (tx) => {
    let totalBuyUsd = 0;
    let totalSellReturn = 0;
    let totalSellCostBasis = 0;

    for (let i = 0; i < reservations.length; i++) {
      const res = reservations[i];
      const settled = clobResults[i];
      const clobMs = settled.status === 'fulfilled' ? settled.value.clobMs : null;
      const result: ExecuteOrderResult = settled.status === 'fulfilled'
        ? settled.value.result
        : { orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
            failReason: (settled.reason as Error)?.message?.slice(0, 500), transactionHashes: [] };

      const queueMs = res.clobStartMs ? res.clobStartMs - res.startMs : null;
      const latencyMs = res.clobStartMs
        ? Date.now() - res.clobStartMs   // CLOB-only latency (accurate)
        : Date.now() - res.startMs;       // fallback for paper/edge cases
      const e2eMs = Date.now() - res.drainStartMs;
      const prePhaseMs = res.startMs - res.drainStartMs;
      let slippageBps: number | null = null;
      if (result.filledPrice && res.detectedPrice > 0) {
        slippageBps = Math.round(((result.filledPrice - res.detectedPrice) / res.detectedPrice) * 10000);
        if (res.side === 'SELL') slippageBps = -slippageBps;
      }

      // DELAYED: sports market 3s delay or GTC fallback — keep PENDING, poll in background
      // GTC fallback from HTTP 400 path has orderId=null (GTC poller creates its own order)
      if (result.status === 'DELAYED' && (result.orderId || result.delayedReason === 'gtc_fallback')) {
        const reason = result.delayedReason ?? 'sports';
        await tx.copyTrade.update({
          where: { id: res.copyTradeId },
          data: {
            ...(result.orderId ? { orderId: result.orderId } : {}),
            failReason: `delayed matching (${reason}): background poll scheduled`,
            latencyMs,
          },
        });
        delayedPolls.push({
          copyTradeId: res.copyTradeId,
          orderId: result.orderId ?? '',  // GTC fallback creates its own orderId
          allocationId: allocation.id,
          side: res.side,
          tokenId: res.tokenId,
          isPaper: res.isPaper,
          detectedPrice: res.detectedPrice,
          delayedReason: result.delayedReason,
          amountUsd: res.copyAmountUsd,
        });
        const mode = res.isPaper ? 'PAPER' : 'LIVE';
        log.info(`COPY TRADE DELAYED (${reason}) — background poll scheduled [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10),
          side: res.side, orderId: result.orderId ?? '(gtc-pending)',
          title: res.tradeInfo.title?.slice(0, 50),
        });
        continue;
      }

      await tx.copyTrade.update({
        where: { id: res.copyTradeId },
        data: {
          orderId: result.orderId,
          status: result.status,
          filledPrice: result.filledPrice,
          filledSize: result.filledSize,
          slippageBps,
          failReason: result.failReason,
          estimatedFee: result.estimatedFee ?? null,
          latencyMs,
          filledAt: result.status === 'FILLED' ? new Date() : null,
          requestedAmount: (result.status === 'FILLED' && result.filledSize && result.filledPrice)
            ? result.filledSize * result.filledPrice : undefined,
        },
      });

      if (result.status === 'FILLED') {
        const usdValue = (result.filledSize && result.filledPrice)
          ? result.filledSize * result.filledPrice : res.copyAmountUsd;

        if (res.side === 'BUY') {
          totalBuyUsd += usdValue;
        } else {
          totalSellReturn += usdValue;
          const costBasisFills = await tx.copyTrade.findMany({
            where: {
              tokenId: res.tokenId, followAllocationId: allocation.id,
              isPaper: res.isPaper, status: 'FILLED', id: { not: res.copyTradeId },
            },
            select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
          });
          const costBasis = computeSellCostBasis(costBasisFills, result.filledSize ?? res.sellShares!);
          totalSellCostBasis += costBasis.costBasisOfSoldShares;
        }

        if (res.side === 'SELL') recordSellFill(allocation.id, res.tokenId);
      }

      // Record SELL failure to prevent repeated attempts on dead/closed markets
      if (res.side === 'SELL' && (result.status === 'SKIPPED' || result.status === 'FAILED')) {
        recordSellFailure(allocation.id, res.tokenId);
      }

      // Record BUY failure to prevent FAK spam on illiquid markets
      if (res.side === 'BUY' && (result.status === 'SKIPPED' || result.status === 'FAILED')) {
        const reason = result.failReason ?? '';
        if (reason.includes('FAK unmatched') || reason.includes('not enough balance') || reason.includes('insufficient balance')) {
          recordBuyFailure(allocation.id, res.tokenId);
        }
      }

      // Per-trade log
      const mode = res.isPaper ? 'PAPER' : 'LIVE';
      if (result.status === 'FILLED') {
        log.info(`COPY TRADE EXECUTED [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10),
          mode, side: res.side, outcome: res.tradeInfo.outcome,
          title: res.tradeInfo.title?.slice(0, 50),
          signalTradeUsd: res.traderTradeUsd != null ? `$${res.traderTradeUsd.toFixed(2)}` : undefined,
          copyAmountUsd: res.copyAmountUsd.toFixed(2),
          filledPrice: result.filledPrice, filledSize: result.filledSize,
          slippageBps, estimatedFee: result.estimatedFee,
          latencyMs, clobMs, queueMs, e2eMs, prePhaseMs, signalAgeMs: res.signalAgeMs,
          allocationId: allocation.id, copyPercent: res.copyPercent,
          maxPerTrade: res.maxPerTrade, maxPerPrediction: res.maxPerPrediction,
        });
      } else if (result.status === 'SKIPPED') {
        log.info(`COPY TRADE SKIPPED [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10), mode,
          reason: result.failReason, side: res.side,
          title: res.tradeInfo.title?.slice(0, 50),
          latencyMs, clobMs, queueMs, e2eMs, prePhaseMs, signalAgeMs: res.signalAgeMs,
        });
      } else {
        log.warn(`COPY TRADE FAILED [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10), mode,
          reason: result.failReason, side: res.side,
          title: res.tradeInfo.title?.slice(0, 50),
          latencyMs, clobMs, queueMs, e2eMs, prePhaseMs, signalAgeMs: res.signalAgeMs,
        });
      }
    }

    // Single capital update for ALL fills in this batch
    if (totalBuyUsd > 0 || totalSellReturn > 0) {
      const fresh = await tx.followAllocation.findUniqueOrThrow({ where: { id: allocation.id } });

      const effectiveCapital = fresh.currentCapital + totalSellReturn;
      const safeDecrement = Math.min(totalBuyUsd, Math.max(effectiveCapital, 0));
      if (safeDecrement < totalBuyUsd) {
        log.warn('Batch settle: capping buy decrement to available capital', {
          available: fresh.currentCapital, sellReturn: totalSellReturn,
          effectiveCapital, required: totalBuyUsd, allocationId: allocation.id,
        });
      }

      const afterBuysDeployed = fresh.deployedCapital + safeDecrement;
      const sellRelease = Math.min(totalSellCostBasis, afterBuysDeployed);

      await tx.followAllocation.update({
        where: { id: allocation.id },
        data: {
          currentCapital: { increment: totalSellReturn - safeDecrement },
          deployedCapital: { increment: safeDecrement - sellRelease },
        },
      });
    }
  });

  // Schedule background polls for delayed orders (after transaction commits)
  for (const ctx of delayedPolls) {
    if (ctx.delayedReason === 'gtc_fallback' && ctx.amountUsd != null) {
      scheduleGtcFallbackPoll({ ...ctx, amountUsd: ctx.amountUsd });
    } else {
      scheduleDelayedOrderPoll(ctx);
    }
  }
}

// ─── Parallel drain pipeline ───

async function drainParallel(
  pending: DetectedTradeRow[],
  isShutdown: () => boolean,
  drainStartMs: number,
): Promise<number> {
  // 1. Build drain cache (3 bulk SQL queries + opposite token map)
  const conditionIds = pending.map(t => t.conditionId);
  const batchTokenMap = new Map<string, Set<string>>();
  for (const trade of pending) {
    const set = batchTokenMap.get(trade.conditionId) ?? new Set();
    set.add(trade.asset);
    batchTokenMap.set(trade.conditionId, set);
  }
  const uniqueTokenIds = [...new Set(pending.map(t => t.asset))].filter(Boolean);
  const [drainCache] = await Promise.all([
    buildDrainCache(conditionIds, batchTokenMap),
    preWarmMetadata(uniqueTokenIds),
  ]);

  // 2. Fetch allocations ONCE (used by position-limit pre-filter + per-wallet processing)
  const allWallets = [...new Set(pending.map(t => t.proxyWallet))];
  const allocations = await prisma.followAllocation.findMany({
    where: { proxyWallet: { in: allWallets }, isActive: true },
  });
  const allocationByWallet = new Map(allocations.map(a => [a.proxyWallet, a]));

  // 2b. Position-limit pre-filter: batch-skip BUY signals where prediction cap is already hit.
  // Saves ~300-500ms per signal of serial phaseA processing for guaranteed SKIPPED outcomes.
  const posLimitSkips: Array<{ trade: DetectedTradeRow; allocId: string }> = [];
  const posLimitKept: DetectedTradeRow[] = [];

  for (const trade of pending) {
    if (trade.side !== 'BUY') { posLimitKept.push(trade); continue; }
    const alloc = allocationByWallet.get(trade.proxyWallet);
    if (!alloc || alloc.isPaper) { posLimitKept.push(trade); continue; }
    const maxPerPrediction = alloc.maxPredictionPositionUsd ?? config.MAX_PREDICTION_POSITION_USD;
    if (maxPerPrediction <= 0) { posLimitKept.push(trade); continue; }
    const pos = drainCache.getPosition(trade.asset, alloc.id, false);
    if (pos.netUsd >= maxPerPrediction - 0.01) {
      posLimitSkips.push({ trade, allocId: alloc.id });
    } else {
      posLimitKept.push(trade);
    }
  }

  if (posLimitSkips.length > 0) {
    // Note: majority accumulator recording already handled by drain pre-pass
    // (all pending BUYs recorded before drainParallel is called).
    try {
      await prisma.copyTrade.createMany({
        data: posLimitSkips.map(({ trade, allocId }) => ({
          detectedTradeId: trade.id,
          tokenId: trade.asset,
          side: trade.side,
          requestedAmount: 0,
          requestedPrice: trade.price,
          status: 'SKIPPED',
          failReason: 'pre-filtered (prediction position limit)',
          isPaper: false,
          followAllocationId: allocId,
        })),
        skipDuplicates: true,
      });
    } catch (err: any) {
      log.warn(`Position-limit pre-filter batch skip failed: ${err.message}`);
    }
    log.info(`Position-limit pre-filter: ${posLimitSkips.length} batch-skipped (${posLimitKept.length} kept)`);
  }
  pending = posLimitKept;

  // 3. Group trades by proxyWallet (preserves SELLs-first order within each group)
  const tradesByWallet = new Map<string, DetectedTradeRow[]>();
  for (const trade of pending) {
    const group = tradesByWallet.get(trade.proxyWallet) ?? [];
    group.push(trade);
    tradesByWallet.set(trade.proxyWallet, group);
  }

  let totalProcessed = 0;

  // 4. Process each allocation group in parallel
  await Promise.all([...tradesByWallet.entries()].map(async ([wallet, trades]) => {
    const allocation = allocationByWallet.get(wallet);
    if (!allocation) return;

    const mutex = getOrCreateMutex(allocation.id);
    const reservations: PhaseAResult[] = [];

    // Phase A: sequential under mutex (~5ms per trade)
    for (const trade of trades) {
      if (isShutdown()) break;
      try {
        const result = await mutex.runExclusive(() =>
          phaseA(trade, {
            id: allocation.id,
            isPaper: allocation.isPaper,
            currentCapital: allocation.currentCapital,
            copyTradePercent: allocation.copyTradePercent,
            maxPositionUsd: allocation.maxPositionUsd,
            maxPredictionPositionUsd: allocation.maxPredictionPositionUsd,
            minBuyPrice: allocation.minBuyPrice,
            excludeEventSlugPatterns: allocation.excludeEventSlugPatterns,
            excludeTitlePatterns: allocation.excludeTitlePatterns,
            majorityOnlyMode: allocation.majorityOnlyMode,
          }, drainCache, drainStartMs, true),  // preRecorded=true: drain pre-pass already recorded
        );
        if (result) {
          // Fire CLOB immediately (non-blocking, bounded by pLimit(10))
          const executeFn = result.isPaper ? paperExecute : realExecute;
          result.clobPromise = clobLimiter(async () => {
            result.clobStartMs = Date.now();
            const clobResult = await executeFn({
              tokenId: result.tokenId,
              side: result.side,
              amount: result.executorAmount,
              detectedPrice: result.detectedPrice,
              detectionSource: result.detectionSource,
              signalAgeMs: result.signalAgeMs,
            });
            return { result: clobResult, clobMs: Date.now() - result.clobStartMs! };
          });
          reservations.push(result);
        }
        totalProcessed++;
      } catch (err: any) {
        log.error(`Phase A failed: ${err.message}`, {
          detectedTradeId: trade.id, stack: err.stack,
        });
      }
    }

    // Wait for all in-flight CLOBs to complete
    if (reservations.length === 0) return;

    const clobResults = await Promise.allSettled(
      reservations.map(r => r.clobPromise!),
    );

    // Batch settlement: 1 transaction for all fills
    if (!isShutdown()) {
      try {
        await batchSettle(
          { id: allocation.id, isPaper: allocation.isPaper },
          reservations,
          clobResults,
        );
      } catch (err: any) {
        log.error(`Batch settlement failed: ${err.message}`, {
          allocationId: allocation.id,
          reservationCount: reservations.length,
          stack: err.stack,
        });
        // Records stay PENDING → reconcileStalePending() handles after 60s
      }
    }
  }));

  return totalProcessed;
}

async function main() {
  let shuttingDown = false;

  // Reuse TCP connections for CLOB API calls (skips TLS handshake ~50-100ms per call)
  axios.defaults.httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 20, maxFreeSockets: 10 });

  // Early signal handler: covers the init window before full resources exist
  const earlyCleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} during init, shutting down...`);
    closeMidpointCache();
    stopPortfolioRefresh();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => earlyCleanup('SIGTERM'));
  process.on('SIGINT', () => earlyCleanup('SIGINT'));

  if (!config.COPY_TRADE_ENABLED) {
    log.info('Copy trading disabled (COPY_TRADE_ENABLED=false), exiting');
    return;
  }

  // Initialize CLOB client (only needed for live allocations)
  if (config.PRIVATE_KEY && config.CLOB_API_KEY && config.CLOB_API_SECRET
      && config.CLOB_API_PASSPHRASE && config.FUNDER_ADDRESS) {
    try {
      await initExecutor();
      if (config.MIDPOINT_CACHE_ENABLED) {
        initMidpointCache();
      }
      log.info('Copy-trader daemon started (live + paper trading available)');
    } catch (err: any) {
      log.error(`CLOB executor init failed — LIVE TRADING UNAVAILABLE: ${err.message}`);
    }
  } else {
    log.info('No CLOB credentials configured — only paper trading available');
  }

  // Check for live allocations without CLOB executor
  const liveAllocations = await prisma.followAllocation.findMany({
    where: { isActive: true, isPaper: false },
  });
  if (liveAllocations.length > 0) {
    const dbTotal = liveAllocations.reduce((s, a) => s + a.currentCapital, 0);
    if (!isLiveReady()) {
      log.error(`${liveAllocations.length} LIVE allocations exist but CLOB executor unavailable — live trades will NOT execute`, {
        dbCurrentCapital: dbTotal.toFixed(2),
      });
    } else {
      log.info('Live capital check', {
        dbCurrentCapital: dbTotal.toFixed(2),
        allocations: liveAllocations.length,
      });
    }
  }

  // IPC bridge moved to standalone ipc-bridge.ts process (runs as separate container)

  // Start portfolio value cache
  try {
    await startPortfolioRefresh();
  } catch (err: any) {
    log.warn(`Portfolio cache initial refresh failed: ${err.message}`);
  }

  // Rehydrate order pool from DB (recovers POOLED records across restarts)
  try {
    await rehydratePool();
  } catch (err: any) {
    log.warn(`Pool rehydration failed: ${err.message}`);
  }

  // Recover stale PENDING records via CLOB reconciliation
  try {
    await reconcileStalePending();
  } catch (err: any) {
    log.warn(`PENDING record reconciliation failed: ${err.message}`);
  }

  // Recover SKIPPED FAK trades that actually filled on-chain (ghost fills)
  try {
    await reconcileSkippedGhostFills();
  } catch (err: any) {
    log.warn(`Ghost fill reconciliation failed: ${err.message}`);
  }

  // ─── Event-driven trade processing ───
  // pg LISTEN/NOTIFY wakes us instantly on DetectedTrade INSERT.
  // Notification coalescing: multiple rapid notifications collapse into 1-2 drain cycles.
  // Sequential mode: processCopyTrade() runs one-at-a-time.
  // Parallel mode: phaseA() under per-allocation mutex → pLimit(10) CLOB → batchSettle().
  let drainScheduled = false;
  let drainRunning = false;
  let emptyDrainCount = 0;

  function scheduleDrain(source?: string) {
    if (drainScheduled) return;
    if (drainRunning) { drainScheduled = true; return; }
    drainScheduled = true;
    log.debug(`Drain scheduled (${source ?? 'unknown'})`);
    setImmediate(runDrain);
  }

  async function runDrain() {
    drainScheduled = false;
    if (drainRunning || shuttingDown || isShuttingDown()) return;
    drainRunning = true;
    try {
      await drainTrades();
    } finally {
      drainRunning = false;
      if (drainScheduled) setImmediate(runDrain);
    }
  }

  // Parallel drain enabled at runtime (validated at startup)
  let parallelDrainEnabled = config.PARALLEL_DRAIN_ENABLED && config.POSITION_CACHE_ENABLED;
  if (config.PARALLEL_DRAIN_ENABLED && !config.POSITION_CACHE_ENABLED) {
    log.error('PARALLEL_DRAIN_ENABLED=true requires POSITION_CACHE_ENABLED=true — falling back to sequential mode');
  }

  async function drainTrades() {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      // Get active followed wallets — split by buying power
      // SELLs need all wallets (must exit positions even at $0 capital)
      // BUYs only need wallets with buying power (filters out broke allocations)
      const allActiveAllocations = await prisma.followAllocation.findMany({
        where: { isActive: true },
        select: {
          id: true, proxyWallet: true, currentCapital: true, copyMakerFills: true,
          isPaper: true, minBuyPrice: true, excludeEventSlugPatterns: true,
        },
      });
      const allActiveWallets = allActiveAllocations.map(a => a.proxyWallet);
      const buyEligibleWallets = allActiveAllocations
        .filter(a => a.currentCapital > 0)
        .map(a => a.proxyWallet);
      // Wallets opted into receiving CHAIN_MAKER signals (per-allocation override)
      const makerFillWallets = allActiveAllocations
        .filter(a => a.copyMakerFills)
        .map(a => a.proxyWallet);

      if (allActiveWallets.length === 0) {
        const duration = Date.now() - start;
        await updateHealth(duration, 'success', 0);
        return;
      }

      // Fetch unprocessed detected trades (no linked CopyTrade, within stale cutoff window)
      // SELLs are processed first — exits are time-sensitive and must not wait behind a BUY backlog
      const staleCutoff = new Date(Date.now() - config.STALE_TRADE_CUTOFF_MS);

      const baseWhere = {
        copyTrade: null,
        detectedAt: { gte: staleCutoff },
        timestamp: { gte: Math.floor(staleCutoff.getTime() / 1000) },
      };

      // ── SELLs: never filter CHAIN_MAKER — exits are always safe ──
      // (if we don't hold shares, processCopyTrade skips with "no shares held to sell")
      let pendingSells = await prisma.detectedTrade.findMany({
        where: {
          ...baseWhere,
          side: 'SELL',
          proxyWallet: { in: allActiveWallets },
        },
        orderBy: { detectedAt: 'asc' },
      });

      // ── Pre-filter ALL SELLs for live allocations (SELL-copy disabled, no value in drain processing) ──
      // Live SELL-copy is disabled (phaseA line 446-450, copy-trade-worker line 260-269).
      // ALL SELLs for live allocations are guaranteed SKIPPED — batch-skip them here.
      // If SELL-copy is re-enabled, remove this block. No majority accumulator concern (BUYs only).
      {
        const liveWallets = new Set(
          allActiveAllocations.filter(a => !a.isPaper).map(a => a.proxyWallet),
        );
        const sellsToSkip: Array<{ trade: typeof pendingSells[0]; alloc: typeof allActiveAllocations[0] }> = [];
        const keptSells: typeof pendingSells = [];

        for (const t of pendingSells) {
          if (liveWallets.has(t.proxyWallet)) {
            const alloc = allActiveAllocations.find(a => a.proxyWallet === t.proxyWallet)!;
            sellsToSkip.push({ trade: t, alloc });
          } else {
            keptSells.push(t);
          }
        }

        if (sellsToSkip.length > 0) {
          try {
            await prisma.copyTrade.createMany({
              data: sellsToSkip.map(({ trade: t, alloc }) => ({
                detectedTradeId: t.id,
                tokenId: t.asset,
                side: t.side,
                requestedAmount: 0,
                requestedPrice: t.price,
                status: 'SKIPPED',
                isPaper: false,
                failReason: 'pre-filtered (live SELL-copy disabled)',
                latencyMs: 0,
                followAllocationId: alloc.id,
              })),
              skipDuplicates: true,
            });
          } catch (err: any) {
            log.warn(`SELL pre-filter batch skip failed: ${err.message}`);
          }
          log.info(`SELL pre-filter: ${sellsToSkip.length} batch-skipped for live wallets (${keptSells.length} kept for paper)`);
        }
        pendingSells = keptSells;
      }

      // ── BUYs: filter CHAIN_MAKER globally, allow for copyMakerFills opt-in ──
      const buyWhere = {
        ...baseWhere,
        side: 'BUY' as const,
        ...(config.SKIP_CHAIN_MAKER_FILLS
          ? { detectionSource: { notIn: ['CHAIN_MAKER'] } }
          : {}),
      };
      const pendingBuys = await prisma.detectedTrade.findMany({
        where: { ...buyWhere, proxyWallet: { in: buyEligibleWallets } },
        orderBy: { detectedAt: 'asc' },
      });

      // ── Maker-fill BUYs — only for opted-in wallets ──
      let makerBuys: typeof pendingBuys = [];
      if (config.SKIP_CHAIN_MAKER_FILLS && makerFillWallets.length > 0) {
        const makerBuyWallets = makerFillWallets.filter(w => buyEligibleWallets.includes(w));
        if (makerBuyWallets.length > 0) {
          makerBuys = await prisma.detectedTrade.findMany({
            where: {
              ...baseWhere,
              side: 'BUY',
              proxyWallet: { in: makerBuyWallets },
              detectionSource: 'CHAIN_MAKER',
            },
            orderBy: { detectedAt: 'asc' },
          });
        }
      }

      // ── Pre-filter makerBuys: batch-skip obvious no-ops, preserve majority accumulation ──
      // 1. Feed recordTraderBuy() for ALL signals (majority accumulator contract)
      // 2. Filter out signals that fail minBuyPrice / eventSlug checks
      // 3. Batch-create SKIPPED records for filtered signals (prevents re-fetch on next drain)
      // Qualifying signals proceed to phaseA/processCopyTrade which calls recordTraderBuy again —
      // but that's fine because filtered signals get SKIPPED records and won't appear in future drains.
      if (makerBuys.length > 0) {
        const qualifying: typeof makerBuys = [];
        const preFiltered: Array<{ trade: typeof makerBuys[0]; alloc: typeof allActiveAllocations[0] }> = [];

        for (const t of makerBuys) {
          const alloc = allActiveAllocations.find(a => a.proxyWallet === t.proxyWallet);
          let dominated = false;

          if (t.side === 'BUY' && alloc) {
            // minBuyPrice pre-filter (covers ~74% of skips)
            if (alloc.minBuyPrice != null && t.price < alloc.minBuyPrice - 0.001) {
              dominated = true;
            }
            // eventSlug pre-filter — fail-closed when slug unavailable (mirrors phaseA line 376-379)
            if (!dominated && alloc.excludeEventSlugPatterns != null) {
              if (!t.eventSlug) {
                dominated = true;  // fail-closed: can't verify exclusion without slug
              } else {
                const patterns = alloc.excludeEventSlugPatterns.split(',').map(p => p.trim().toLowerCase());
                if (patterns.some(p => t.eventSlug!.toLowerCase().includes(p))) {
                  dominated = true;
                }
              }
            }
            // Signal age pre-filter (live BUYs only) — mirrors phaseA line 305
            if (!dominated && !alloc.isPaper && config.MAX_SIGNAL_AGE_MS > 0) {
              const signalAgeMs = Date.now() - (t.realTimestamp ?? t.timestamp) * 1000;
              if (signalAgeMs > config.MAX_SIGNAL_AGE_MS) {
                dominated = true;
              }
            }
          }

          if (dominated) {
            // Feed majority accumulator so getMajoritySide() sees full signal volume
            recordTraderBuy(t.proxyWallet, t.conditionId, t.outcome, t.size * t.price);
            preFiltered.push({ trade: t, alloc: alloc! });
          } else {
            qualifying.push(t);
          }
        }

        // Batch-create SKIPPED records — prevents re-fetch on next drain cycle
        // (without this, pre-filtered signals stay copyTrade:null and get re-fetched every 7s)
        if (preFiltered.length > 0) {
          try {
            await prisma.copyTrade.createMany({
              data: preFiltered.map(({ trade: t, alloc }) => ({
                detectedTradeId: t.id,
                tokenId: t.asset,
                side: t.side,
                requestedAmount: 0,
                requestedPrice: t.price,
                status: 'SKIPPED',
                isPaper: alloc.isPaper,
                failReason: 'CHAIN_MAKER pre-filtered (price/slug)',
                latencyMs: 0,
                followAllocationId: alloc.id,
              })),
              skipDuplicates: true,
            });
          } catch (err: any) {
            // Non-fatal: if batch insert fails, signals will be re-fetched and processed normally
            log.warn(`CHAIN_MAKER pre-filter batch skip failed: ${err.message}`);
          }
          log.info(`CHAIN_MAKER pre-filter: ${preFiltered.length}/${makerBuys.length} batch-skipped (${qualifying.length} qualifying)`);
        }
        makerBuys = qualifying;
      }

      // SELLs first (exits are time-sensitive), then BUYs
      const pending = [...pendingSells, ...pendingBuys, ...makerBuys];

      // Pre-pass: record ALL pending BUYs into accumulator before any phaseA
      // majority check. This ensures the accumulator sees full batch data
      // (CHAIN + CHAIN_MAKER), matching backtest behavior (chronological single-pass).
      // Runs BEFORE batch cap so even capped-out signals feed the accumulator.
      for (const t of pending) {
        if (t.side === 'BUY') {
          recordTraderBuy(t.proxyWallet, t.conditionId, t.outcome, t.size * t.price);
        }
      }

      if (pending.length > MAX_DRAIN_BATCH_SIZE) {
        log.info(`Drain batch capped: ${pending.length} pending, processing first ${MAX_DRAIN_BATCH_SIZE}`);
        pending.length = MAX_DRAIN_BATCH_SIZE;
        drainScheduled = true;
      }

      if (pending.length === 0) {
        emptyDrainCount++;
        if (emptyDrainCount % 20 === 1) {
          log.debug(`Drain empty (×${emptyDrainCount}), ${allActiveAllocations.length} allocs, ${makerFillWallets.length} maker-fill`);
        }
        await sweepPool();
        const duration = Date.now() - start;
        await updateHealth(duration, 'success', 0);
        return;
      }
      emptyDrainCount = 0;

      // Feed tokenIds to midpoint WS cache for stale-signal guard
      const uniqueTokenIds = [...new Set(pending.map(t => t.asset))].filter(Boolean);
      if (uniqueTokenIds.length > 0) ensureSubscribed(uniqueTokenIds);

      if (parallelDrainEnabled) {
        // preWarmMetadata runs inside drainParallel in parallel with buildDrainCache
        processedCount = await drainParallel(pending, () => shuttingDown || isShuttingDown(), start);
      } else {
        await preWarmMetadata(uniqueTokenIds); // sequential fallback still pre-warms
        // Sequential fallback: existing processCopyTrade() loop
        for (const trade of pending) {
          if (shuttingDown || isShuttingDown()) break;
          try {
            await processCopyTrade(trade);
            processedCount++;
          } catch (err: any) {
            log.error(`Failed to process copy trade: ${err.message}`, {
              detectedTradeId: trade.id,
              stack: err.stack,
            });
          }
        }
      }

      // Sweep pool: burn expired FIFO entries (fast, trade-related)
      await sweepPool();

      // Periodic pruning of stale majority accumulator entries
      if (++pruneCounter % 100 === 0) pruneAccumulator(config.MAJORITY_PRUNE_AGE_MS);
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      emptyDrainCount = 0;
      log.error(`Copy-trader drain failed: ${err.message}`, { stack: err.stack });
    }

    const duration = Date.now() - start;
    await updateHealth(duration, result, processedCount, errorMessage);
    if (processedCount > 0 || duration > 1000) {
      log.info(`Drain complete: ${processedCount} trades in ${duration}ms`, {
        mode: parallelDrainEnabled ? 'parallel' : 'sequential',
      });
    }
  }

  // Seed majority accumulator from recent DetectedTrades to survive restart
  {
    const seedCutoff = new Date(Date.now() - config.MAJORITY_PRUNE_AGE_MS);
    const recentBuys = await prisma.detectedTrade.findMany({
      where: { side: 'BUY', detectedAt: { gte: seedCutoff } },
      select: { proxyWallet: true, conditionId: true, outcome: true, size: true, price: true },
      orderBy: { detectedAt: 'asc' },
    });
    seedAccumulator(recentBuys);
    log.info(`Majority accumulator seeded: ${recentBuys.length} recent BUYs`);
  }

  // Connect pg LISTEN for instant wake on DetectedTrade INSERT
  const listener = new PgListener('detected_trade_inserted', () => scheduleDrain('pg-notify'));
  await listener.connect();

  // Fallback poll: safety net if LISTEN connection drops
  const fallbackTimer = setInterval(() => scheduleDrain('fallback-poll'), config.COPY_TRADE_FALLBACK_POLL_MS);

  // Initial drain on startup (recover unprocessed trades from downtime)
  scheduleDrain('startup');

  // Post-startup re-seed: close the race window between seedAccumulator() and PgListener.
  // Trades detected by chain watcher during that gap are now in DB.
  setTimeout(async () => {
    try {
      const seedCutoff = new Date(Date.now() - config.MAJORITY_PRUNE_AGE_MS);
      const recentBuys = await prisma.detectedTrade.findMany({
        where: { side: 'BUY', detectedAt: { gte: seedCutoff } },
        select: { proxyWallet: true, conditionId: true, outcome: true, size: true, price: true },
        orderBy: { detectedAt: 'asc' },
      });
      clearAccumulator();
      seedAccumulator(recentBuys);
      log.info(`Post-startup re-seed complete: ${recentBuys.length} BUYs`);
    } catch (err: any) {
      log.warn(`Post-startup re-seed failed: ${err.message}`);
    }
  }, 10_000);

  // ─── Independent housekeeping timers ───
  // These run on their own schedules, never blocking trade processing.

  // Settlement sweeps moved to standalone ipc-bridge.ts process

  const balanceTimer = isLiveReady() ? setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      const walletBal = await getWalletBalance();
      if (walletBal) {
        // Sum CC across ALL non-paper allocations (wallet holds capital for active + inactive)
        const dbCapital = (await prisma.followAllocation.aggregate({
          where: { isPaper: false },
          _sum: { currentCapital: true },
        }))._sum.currentCapital ?? 0;

        // Only warn on deficit (wallet < expected CC) — surplus is normal
        // from unclaimed settlements, inactive allocation residuals, and P&L
        const deficit = dbCapital - walletBal.balance;
        if (deficit > config.BALANCE_MISMATCH_THRESHOLD) {
          log.warn('Balance deficit: wallet USDC below total DB currentCapital', {
            clobBalance: walletBal.balance.toFixed(2),
            dbTotalCC: dbCapital.toFixed(2),
            deficit: deficit.toFixed(2),
          });
        } else {
          log.debug('Balance check OK', {
            clobBalance: walletBal.balance.toFixed(2),
            dbTotalCC: dbCapital.toFixed(2),
            surplus: Math.max(-deficit, 0).toFixed(2),
          });
        }
        // Any successful wallet fetch clears the balance pause.
        // The circuit breaker re-engages immediately if the next live trade still fails.
        resetBalancePause();
      }
    } catch (err: any) {
      log.warn(`Balance check failed: ${err.message}`);
    }
  }, config.BALANCE_CHECK_INTERVAL_MS) : null;

  const capitalAuditTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await auditAllAllocations({ isPaper: false, threshold: 1.0 });

      // Phantom position auto-cleanup (or detection-only fallback)
      if (config.PHANTOM_AUTO_CLEANUP_ENABLED && config.FUNDER_ADDRESS) {
        const result = await cleanupPhantomPositions(config.FUNDER_ADDRESS);
        if (result.cleaned > 0) {
          log.info('Phantom auto-cleanup completed', {
            tradesCleaned: result.cleaned,
            allocationsFixed: result.capitalCorrections,
          });
        }
      } else if (config.FUNDER_ADDRESS) {
        // Fallback: detection-only (original behavior)
        const phantomResults = await auditPhantomPositions(config.FUNDER_ADDRESS);
        const confirmedPhantoms = phantomResults.filter(p => p.isPhantom);
        if (confirmedPhantoms.length > 0) {
          log.error(`Phantom positions detected: ${confirmedPhantoms.length} tokens with no on-chain position`, {
            phantoms: confirmedPhantoms.map(p => ({
              token: p.tokenId.slice(0, 16),
              allocation: p.followAllocationId,
              dbShares: p.dbShares.toFixed(4),
              dbCost: p.dbCostBasis.toFixed(2),
            })),
          });
        }
      }

      // Per-allocation circuit breaker (live only)
      if (config.ALLOCATION_CIRCUIT_BREAKER_ENABLED) {
        const tripped = await checkCircuitBreakers(config.ALLOCATION_CIRCUIT_BREAKER_THRESHOLD);
        if (tripped.length > 0) {
          log.warn(`Circuit breaker: ${tripped.length} allocation(s) deactivated`, {
            traders: tripped.map(t => t.traderName ?? t.proxyWallet.slice(0, 10)),
          });
        }
      }

      // Unclaimed settled position sweeps moved to ipc-bridge.ts

      // Recover SKIPPED FAK ghost fills (catches any that slipped past inline verification)
      await reconcileSkippedGhostFills();
    } catch (err: any) {
      log.warn(`Capital audit failed: ${err.message}`);
    }
  }, CAPITAL_AUDIT_INTERVAL_MS);

  const preResTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await sweepPreResolutionSells();
    } catch (err: any) {
      log.warn(`Pre-resolution sweep failed: ${err.message}`);
    }
  }, config.SETTLEMENT_SWEEP_INTERVAL_MS);

  // Market refresh sweeps moved to ipc-bridge.ts

  // Fire housekeeping once on startup
  auditAllAllocations({ isPaper: false, threshold: 1.0 }).catch((err: any) => log.warn(`Capital audit failed: ${err.message}`));
  sweepPreResolutionSells().catch((err: any) => log.warn(`Pre-resolution sweep failed: ${err.message}`));

  // ─── Upgrade shutdown handler: now all resources exist ───
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(fallbackTimer);
    if (balanceTimer) clearInterval(balanceTimer);
    clearInterval(capitalAuditTimer);
    clearInterval(preResTimer);
    stopPortfolioRefresh();
    await listener.close();
    // Wait for in-flight drain to complete before disconnecting DB
    if (drainRunning) {
      log.info('Waiting for in-flight drain to complete...');
      await new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (!drainRunning) { clearInterval(check); resolve(); }
        }, 50);
        // Safety timeout: don't hang forever
        setTimeout(() => { clearInterval(check); resolve(); }, 10_000);
      });
    }
    closeMidpointCache();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  log.info('Event-driven copy-trader ready', {
    fallbackPollMs: config.COPY_TRADE_FALLBACK_POLL_MS,
    drainMode: parallelDrainEnabled ? 'parallel' : 'sequential',
  });
}

async function updateHealth(
  duration: number,
  result: string,
  processedCount: number,
  errorMessage?: string,
) {
  try {
    await prisma.systemHealth.upsert({
      where: { jobName: JOB_NAME },
      create: {
        jobName: JOB_NAME,
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: result,
        processedCount,
        errorMessage: errorMessage ?? null,
      },
      update: {
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: result,
        processedCount,
        errorMessage: errorMessage ?? null,
      },
    });
  } catch {}
}

main();
