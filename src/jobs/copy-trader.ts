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
  checkApiPositionExists, createSkippedRecord,
} from '../services/copy-trade-worker';
import type { DetectedTradeRow } from '../services/copy-trade-worker';
import { addToPool } from '../services/order-pool';
import { startPortfolioRefresh, stopPortfolioRefresh } from '../services/portfolio-cache';
import { rehydratePool, sweepPool } from '../services/order-pool';
import { sweepPositionSettlements, sweepUnclaimedSettledPositions } from '../services/position-settlement';
import { reconcileStalePending, reconcileSkippedGhostFills } from '../services/clob-reconciler';
import { sweepPreResolutionSells } from '../services/pre-resolution-seller';
import { resolveMarkets } from '../services/market-resolver';
import { computeSellCostBasis } from '../lib/cost-basis';
import { auditAllAllocations, auditPhantomPositions, cleanupPhantomPositions, checkCircuitBreakers } from '../lib/capital-audit';
import { initMidpointCache, closeMidpointCache, ensureSubscribed } from '../services/midpoint-cache';
import { getOrCreateMutex } from '../lib/allocation-mutex';
import { PgListener } from '../lib/pg-listen';

const JOB_NAME = 'copy-trader';
const log = createJobLogger(JOB_NAME);
const CAPITAL_AUDIT_INTERVAL_MS = 3_600_000; // 1 hour

// ─── Pipeline infrastructure (Change 5) ───

const clobLimiter = pLimit(10);

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
}

async function buildDrainCache(
  conditionIds: string[],
  batchTokenMap: Map<string, Set<string>>,
): Promise<DrainCache> {
  // Query 1: Positions (FILLED + PENDING) + BUY-side cost basis for hedge ratio
  const positionRows = await prisma.$queryRaw<Array<{
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
  `;

  const positionCache = new Map<string, CachedPosition>();
  for (const row of positionRows) {
    const key = `${row.tokenId}:${row.followAllocationId}:${row.isPaper}`;
    positionCache.set(key, {
      netShares: Math.max(row.netShares ?? 0, 0),
      netUsd: Math.max(row.netUsd ?? 0, 0),
      buyCost: Math.max(row.buyCost ?? 0, 0),
      buyShares: Math.max(row.buyShares ?? 0, 0),
    });
  }

  // Pending capital per allocation
  const pendingCapitalRows = await prisma.$queryRaw<Array<{
    followAllocationId: string; pendingCapital: number;
  }>>`
    SELECT "followAllocationId", SUM("requestedAmount")::float as "pendingCapital"
    FROM "CopyTrade" WHERE status = 'PENDING' AND side = 'BUY' AND "followAllocationId" IS NOT NULL
    GROUP BY "followAllocationId"
  `;

  const pendingCapitalMap = new Map<string, number>();
  for (const row of pendingCapitalRows) {
    pendingCapitalMap.set(row.followAllocationId, row.pendingCapital ?? 0);
  }

  // Query 2: Daily spend
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const dailySpendRows = await prisma.$queryRaw<Array<{
    isPaper: boolean; dailySpend: number;
  }>>`
    SELECT "isPaper", SUM("requestedAmount")::float as "dailySpend"
    FROM "CopyTrade"
    WHERE status IN ('FILLED', 'POOLED', 'PENDING') AND side = 'BUY'
      AND "createdAt" >= ${todayStart}
    GROUP BY "isPaper"
  `;

  const dailySpendMap = new Map<string, number>();
  for (const row of dailySpendRows) {
    dailySpendMap.set(row.isPaper ? 'paper' : 'live', row.dailySpend ?? 0);
  }

  // Query 3: Market status
  const uniqueConditionIds = [...new Set(conditionIds)];
  const markets = await prisma.market.findMany({
    where: { conditionId: { in: uniqueConditionIds } },
    select: { conditionId: true, closed: true },
  });
  const marketClosedMap = new Map<string, boolean>();
  for (const m of markets) {
    marketClosedMap.set(m.conditionId, m.closed);
  }

  // Resolve missing markets from Gamma API
  const missing = uniqueConditionIds.filter(id => !marketClosedMap.has(id));
  if (missing.length > 0) {
    try {
      await resolveMarkets(missing);
      const resolved = await prisma.market.findMany({
        where: { conditionId: { in: missing } },
        select: { conditionId: true, closed: true },
      });
      for (const m of resolved) {
        marketClosedMap.set(m.conditionId, m.closed);
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
  };
}

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
    copyTradePercent: number | null; maxPositionUsd: number | null; maxPredictionPositionUsd: number | null },
  cache: DrainCache,
): Promise<PhaseAResult | null> {
  const startMs = Date.now();
  const signalAgeMs = startMs - trade.timestamp * 1000;
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

  if (trade.side === 'BUY' && isInSellCooldown(allocation.id, trade.asset)) {
    await createSkippedRecord(trade, 'token sell cool-down active', allocation.id, isPaper);
    return null;
  }

  // Sizing
  let copyAmountUsd: number;
  let sellShares: number | null = null;
  let traderTradeUsd: number | null = null;

  if (trade.side === 'SELL') {
    const heldShares = cache.getPosition(trade.asset, allocation.id, isPaper).netShares;
    if (heldShares < 0.000001) {
      await createSkippedRecord(trade, 'no shares held to sell', allocation.id, isPaper);
      return null;
    }
    sellShares = Math.floor(heldShares * 100) / 100;
    if (sellShares < 0.01) {
      if (!isPaper) {
        const existsOnChain = await checkApiPositionExists(trade.asset);
        if (!existsOnChain) {
          await createSkippedRecord(trade, 'no shares held to sell (API-verified phantom)', allocation.id, isPaper);
          return null;
        }
      }
      await createSkippedRecord(trade, `dust position (${heldShares.toFixed(6)} shares): awaiting settlement`, allocation.id, isPaper);
      return null;
    }
    copyAmountUsd = sellShares * trade.price;
  } else {
    const availableCapital = allocation.currentCapital - cache.getPendingCapital(allocation.id);
    if (availableCapital <= 0) {
      await createSkippedRecord(trade, 'insufficient allocated capital (zero balance)', allocation.id, isPaper);
      return null;
    }

    traderTradeUsd = trade.size * trade.price;

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

  // Hedge guard (ratio-based): trade is a hedge if price < HEDGE_PRICE_RATIO * opposite avg buy price
  let hedgeMaxUsd = Infinity;
  // Pre-filter: since avgBuyPrice ≤ 1.0 on Polymarket, ratio * avgBuyPrice ≤ ratio.
  // Any trade priced at or above the ratio itself cannot be a hedge.
  if (trade.side === 'BUY' && config.HEDGE_PRICE_RATIO > 0 && trade.price < config.HEDGE_PRICE_RATIO) {
    const oppositeTokenId = cache.getOppositeTokenId(trade.conditionId, trade.asset);
    if (oppositeTokenId) {
      const oppositePos = cache.getPosition(oppositeTokenId, allocation.id, isPaper);
      const avgBuyPrice = oppositePos.buyShares > 0 ? oppositePos.buyCost / oppositePos.buyShares : 0;
      if (avgBuyPrice > 0 && trade.price < config.HEDGE_PRICE_RATIO * avgBuyPrice
          && oppositePos.netUsd >= 0.01) { // skip if opposite position fully exited
        if (oppositePos.netUsd < config.HEDGE_MIN_OPPOSITE_USD) {
          log.info('Hedge guard: blocked hedge without sufficient opposite position', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: avgBuyPrice.toFixed(3),
            threshold: (config.HEDGE_PRICE_RATIO * avgBuyPrice).toFixed(3),
            oppositeUsd: oppositePos.netUsd.toFixed(2),
            minRequired: config.HEDGE_MIN_OPPOSITE_USD,
            outcome: trade.outcome, title: trade.title?.slice(0, 50),
          });
          await createSkippedRecord(trade,
            `hedge guard: trade @${trade.price.toFixed(2)} < ${config.HEDGE_PRICE_RATIO} * opposite avg ${avgBuyPrice.toFixed(3)}, ` +
            `opposite position $${oppositePos.netUsd.toFixed(2)} < $${config.HEDGE_MIN_OPPOSITE_USD} minimum`,
            allocation.id, isPaper);
          return null;
        }
        hedgeMaxUsd = oppositePos.netUsd * config.HEDGE_MAX_RATIO;
        if (copyAmountUsd > hedgeMaxUsd) {
          copyAmountUsd = hedgeMaxUsd;
          log.info('Hedge guard: trimmed copy amount to max hedge ratio', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: avgBuyPrice.toFixed(3),
            oppositeUsd: oppositePos.netUsd.toFixed(2),
            maxHedgeUsd: hedgeMaxUsd.toFixed(2), hedgeMaxRatio: config.HEDGE_MAX_RATIO,
          });
        }
      }
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

      const latencyMs = Date.now() - res.startMs;
      let slippageBps: number | null = null;
      if (result.filledPrice && res.detectedPrice > 0) {
        slippageBps = Math.round(((result.filledPrice - res.detectedPrice) / res.detectedPrice) * 10000);
        if (res.side === 'SELL') slippageBps = -slippageBps;
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
          latencyMs, clobMs, signalAgeMs: res.signalAgeMs,
          allocationId: allocation.id, copyPercent: res.copyPercent,
          maxPerTrade: res.maxPerTrade, maxPerPrediction: res.maxPerPrediction,
        });
      } else if (result.status === 'SKIPPED') {
        log.info(`COPY TRADE SKIPPED [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10), mode,
          reason: result.failReason, side: res.side,
          title: res.tradeInfo.title?.slice(0, 50), signalAgeMs: res.signalAgeMs,
        });
      } else {
        log.warn(`COPY TRADE FAILED [${mode}]`, {
          trader: res.tradeInfo.proxyWallet.slice(0, 10), mode,
          reason: result.failReason, side: res.side,
          title: res.tradeInfo.title?.slice(0, 50),
          latencyMs, clobMs, signalAgeMs: res.signalAgeMs,
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
}

// ─── Parallel drain pipeline ───

async function drainParallel(
  pending: DetectedTradeRow[],
  isShutdown: () => boolean,
): Promise<number> {
  // 1. Build drain cache (3 bulk SQL queries + opposite token map)
  const conditionIds = pending.map(t => t.conditionId);
  const batchTokenMap = new Map<string, Set<string>>();
  for (const trade of pending) {
    const set = batchTokenMap.get(trade.conditionId) ?? new Set();
    set.add(trade.asset);
    batchTokenMap.set(trade.conditionId, set);
  }
  const drainCache = await buildDrainCache(conditionIds, batchTokenMap);

  // 2. Group trades by proxyWallet (preserves SELLs-first order within each group)
  const tradesByWallet = new Map<string, DetectedTradeRow[]>();
  for (const trade of pending) {
    const group = tradesByWallet.get(trade.proxyWallet) ?? [];
    group.push(trade);
    tradesByWallet.set(trade.proxyWallet, group);
  }

  // 3. Fetch allocations ONCE per proxyWallet
  const wallets = [...tradesByWallet.keys()];
  const allocations = await prisma.followAllocation.findMany({
    where: { proxyWallet: { in: wallets }, isActive: true },
  });
  const allocationByWallet = new Map(allocations.map(a => [a.proxyWallet, a]));

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
          }, drainCache),
        );
        if (result) {
          // Fire CLOB immediately (non-blocking, bounded by pLimit(10))
          const executeFn = result.isPaper ? paperExecute : realExecute;
          result.clobPromise = clobLimiter(async () => {
            const clobStart = Date.now();
            const clobResult = await executeFn({
              tokenId: result.tokenId,
              side: result.side,
              amount: result.executorAmount,
              detectedPrice: result.detectedPrice,
              detectionSource: result.detectionSource,
            });
            return { result: clobResult, clobMs: Date.now() - clobStart };
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
    if (drainScheduled || drainRunning) return;
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
        select: { proxyWallet: true, currentCapital: true, copyMakerFills: true },
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

      // ── Standard signals (CHAIN + POLL) — all active wallets ──
      const standardWhere = {
        copyTrade: null,
        detectedAt: { gte: staleCutoff },
        timestamp: { gte: Math.floor(staleCutoff.getTime() / 1000) },
        // LIVE_POLL is a gap-filler for monitoring only — too high latency for copy signals
        // CHAIN_MAKER = passive maker fills — excluded globally unless per-allocation override
        detectionSource: config.SKIP_CHAIN_MAKER_FILLS
          ? { notIn: ['LIVE_POLL', 'CHAIN_MAKER'] }
          : { not: 'LIVE_POLL' as const },
      };
      const pendingSells = await prisma.detectedTrade.findMany({
        where: { ...standardWhere, side: 'SELL', proxyWallet: { in: allActiveWallets } },
        orderBy: { detectedAt: 'asc' },
      });
      const pendingBuys = await prisma.detectedTrade.findMany({
        where: { ...standardWhere, side: 'BUY', proxyWallet: { in: buyEligibleWallets } },
        orderBy: { detectedAt: 'asc' },
      });

      // ── Maker-fill signals (CHAIN_MAKER) — only opted-in wallets ──
      let makerSells: typeof pendingSells = [];
      let makerBuys: typeof pendingBuys = [];

      if (config.SKIP_CHAIN_MAKER_FILLS && makerFillWallets.length > 0) {
        const makerWhere = {
          copyTrade: null,
          detectedAt: { gte: staleCutoff },
          timestamp: { gte: Math.floor(staleCutoff.getTime() / 1000) },
          detectionSource: 'CHAIN_MAKER',
        };

        makerSells = await prisma.detectedTrade.findMany({
          where: { ...makerWhere, side: 'SELL', proxyWallet: { in: makerFillWallets } },
          orderBy: { detectedAt: 'asc' },
        });

        const makerBuyWallets = makerFillWallets.filter(w => buyEligibleWallets.includes(w));
        if (makerBuyWallets.length > 0) {
          makerBuys = await prisma.detectedTrade.findMany({
            where: { ...makerWhere, side: 'BUY', proxyWallet: { in: makerBuyWallets } },
            orderBy: { detectedAt: 'asc' },
          });
        }
      }

      // SELLs first (exits are time-sensitive), then BUYs
      const pending = [...pendingSells, ...makerSells, ...pendingBuys, ...makerBuys];

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

      // Pre-warm CLOB metadata cache for all unique tokens in this batch
      const uniqueTokenIds = [...new Set(pending.map(t => t.asset))].filter(Boolean);
      await preWarmMetadata(uniqueTokenIds);

      // Feed tokenIds to midpoint WS cache for stale-signal guard
      if (uniqueTokenIds.length > 0) ensureSubscribed(uniqueTokenIds);

      if (parallelDrainEnabled) {
        processedCount = await drainParallel(pending, () => shuttingDown || isShuttingDown());
      } else {
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
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
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

  // Connect pg LISTEN for instant wake on DetectedTrade INSERT
  const listener = new PgListener('detected_trade_inserted', () => scheduleDrain('pg-notify'));
  await listener.connect();

  // Fallback poll: safety net if LISTEN connection drops
  const fallbackTimer = setInterval(() => scheduleDrain('fallback-poll'), config.COPY_TRADE_FALLBACK_POLL_MS);

  // Initial drain on startup (recover unprocessed trades from downtime)
  scheduleDrain('startup');

  // ─── Independent housekeeping timers ───
  // These run on their own schedules, never blocking trade processing.

  const settlementTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await sweepPositionSettlements();
    } catch (err: any) {
      log.warn(`Settlement sweep failed: ${err.message}`);
    }
  }, config.SETTLEMENT_SWEEP_INTERVAL_MS);

  const balanceTimer = isLiveReady() ? setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      const walletBal = await getWalletBalance();
      if (walletBal) {
        const dbCapital = (await prisma.followAllocation.aggregate({
          where: { isActive: true, isPaper: false },
          _sum: { currentCapital: true },
        }))._sum.currentCapital ?? 0;

        const diff = Math.abs(walletBal.balance - dbCapital);
        if (diff > config.BALANCE_MISMATCH_THRESHOLD) {
          log.warn('Balance mismatch: CLOB wallet vs DB capital', {
            clobBalance: walletBal.balance.toFixed(2),
            dbCurrentCapital: dbCapital.toFixed(2),
            diff: diff.toFixed(2),
          });
        } else {
          log.debug('Balance check OK', {
            clobBalance: walletBal.balance.toFixed(2),
            dbCurrentCapital: dbCapital.toFixed(2),
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

      // Sweep unclaimed settled positions (retry claims that failed or accumulated)
      await sweepUnclaimedSettledPositions();

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

  // Fire housekeeping once on startup (matches old behavior where lastX=0 triggered first cycle)
  // Chain unclaimed sweep after settlement to avoid overlap via shared sweepRunning guard
  sweepPositionSettlements()
    .then(() => sweepUnclaimedSettledPositions())
    .catch((err: any) => log.warn(`Settlement/claim sweep failed: ${err.message}`));
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
    clearInterval(settlementTimer);
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
