import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { executeMarketOrder as realExecute, isBalancePaused, CLOB_MIN_ORDER_USD } from './trade-executor';
import { executeMarketOrder as paperExecute } from './paper-executor';
import type { ExecuteOrderResult } from './trade-executor';
import { addToPool } from './order-pool';
import { resolveMarkets } from './market-resolver';
import { computeSellCostBasis } from '../lib/cost-basis';
import { scheduleDelayedOrderPoll } from './delayed-order-poller';

const log = createJobLogger('copy-trade-worker');

// ─── Per-token SELL cool-down: tracks last SELL fill time per (allocation, token) ───
// Prevents rapid BUY re-entry after a SELL that creates market-making spread loss.
const lastSellAt = new Map<string, number>();

function sellCooldownKey(allocationId: string, tokenId: string): string {
  return `${allocationId}:${tokenId}`;
}

export function isInSellCooldown(allocationId: string, tokenId: string): boolean {
  if (config.TOKEN_SELL_COOLDOWN_MS <= 0) return false;
  const key = sellCooldownKey(allocationId, tokenId);
  const ts = lastSellAt.get(key);
  if (!ts) return false;
  return Date.now() - ts < config.TOKEN_SELL_COOLDOWN_MS;
}

export function recordSellFill(allocationId: string, tokenId: string): void {
  const key = sellCooldownKey(allocationId, tokenId);
  lastSellAt.set(key, Date.now());
  // Prune old entries to prevent unbounded growth
  if (lastSellAt.size > 1000) {
    const cutoff = Date.now() - config.TOKEN_SELL_COOLDOWN_MS * 2;
    for (const [k, v] of lastSellAt) {
      if (v < cutoff) lastSellAt.delete(k);
    }
  }
}

export interface DetectedTradeRow {
  id: string;
  proxyWallet: string;
  userName: string | null;
  side: string;
  conditionId: string;
  asset: string;
  size: number;
  price: number;
  outcome: string;
  title: string | null;
  transactionHash: string;
  timestamp: number;
  realTimestamp: number | null;
  compositeScore: number | null;
  detectedAt: Date;
  detectionSource: string | null;
}

export async function processCopyTrade(trade: DetectedTradeRow): Promise<void> {
  const startMs = Date.now();
  const signalAgeMs = startMs - (trade.realTimestamp ?? trade.timestamp) * 1000;

  // ─── Filter checks ───

  // Already copied?
  const existing = await prisma.copyTrade.findUnique({
    where: { detectedTradeId: trade.id },
  });
  if (existing) return;

  // Look up FollowAllocation for this trader
  const allocation = await prisma.followAllocation.findUnique({
    where: { proxyWallet: trade.proxyWallet },
  });
  if (!allocation || !allocation.isActive) {
    await createSkippedRecord(trade, 'no active follow allocation', null, false);
    return;
  }

  const isPaper = allocation.isPaper;

  // Resolve per-allocation sizing overrides (null = global default)
  const copyPercent = allocation.copyTradePercent ?? config.COPY_TRADE_PERCENT;
  const maxPerTrade = allocation.maxPositionUsd ?? config.MAX_POSITION_USD;
  const maxPerPrediction = allocation.maxPredictionPositionUsd ?? config.MAX_PREDICTION_POSITION_USD;

  // Sanity guard: reject obviously invalid overrides (DB typo protection)
  if (copyPercent > 1.0 || copyPercent <= 0 || maxPerTrade <= 0 || maxPerPrediction < 0) {
    log.error('Invalid per-allocation sizing override, skipping trade', {
      allocationId: allocation.id, copyPercent, maxPerTrade, maxPerPrediction,
    });
    return;
  }

  // Skip live BUYs when wallet balance is insufficient — SELLs and paper allocations continue normally
  if (!isPaper && trade.side === 'BUY' && isBalancePaused()) {
    await createSkippedRecord(trade, 'live trading paused: insufficient wallet balance', allocation.id, isPaper);
    return;
  }

  // ─── Market closed gatekeep (BUY only) ───
  const closedSkip = await checkMarketClosed(trade.conditionId, trade.side);
  if (closedSkip) {
    await createSkippedRecord(trade, closedSkip, allocation.id, isPaper);
    return;
  }

  // ─── Per-token cool-down: prevent rapid re-BUY after SELL (market-making cycle guard) ───
  if (trade.side === 'BUY' && isInSellCooldown(allocation.id, trade.asset)) {
    await createSkippedRecord(trade, 'token sell cool-down active', allocation.id, isPaper);
    return;
  }

  // ─── Sizing ───

  let copyAmountUsd: number;
  let sellShares: number | null = null;
  let traderTradeUsd: number | null = null;

  if (trade.side === 'SELL') {
    const heldShares = await getHeldShares(trade.asset, allocation.id, isPaper);
    // getHeldShares() rounds sub-penny amounts (< 0.01 shares) to 0 — these are
    // unsellable on CLOB (2dp floor → 0) and settle at market resolution. This
    // catches both phantom dust (DB rounding artifacts) and real micro-dust.
    if (heldShares === 0) {
      await createSkippedRecord(trade, 'no shares held to sell', allocation.id, isPaper);
      return;
    }
    // Full position close — when trader sells, we exit entirely.
    // Floor to 2 decimal places: CLOB rounds SELL fills to 2dp, leaving dust
    // (e.g., send 2.409635 → fills 2.40, leaving 0.009635 orphaned).
    // By flooring upfront, the fill matches exactly what we send — zero dust created.
    sellShares = Math.floor(heldShares * 100) / 100;
    copyAmountUsd = sellShares * trade.price;
  } else {
    // Guard: negative or zero capital means no buying power
    if (allocation.currentCapital <= 0) {
      await createSkippedRecord(trade, 'insufficient allocated capital (zero balance)', allocation.id, isPaper);
      return;
    }

    traderTradeUsd = trade.size * trade.price;

    // ─── Quality gates ───
    if (trade.compositeScore !== null && trade.compositeScore < config.MIN_COMPOSITE_SCORE) {
      await createSkippedRecord(trade,
        `composite score ${trade.compositeScore.toFixed(4)} below minimum ${config.MIN_COMPOSITE_SCORE}`,
        allocation.id, isPaper);
      return;
    }
    if (config.MIN_SIGNAL_TRADE_USD > 0 && traderTradeUsd < config.MIN_SIGNAL_TRADE_USD) {
      await createSkippedRecord(trade,
        `signal trade size $${traderTradeUsd.toFixed(2)} below minimum $${config.MIN_SIGNAL_TRADE_USD}`,
        allocation.id, isPaper);
      return;
    }

    // ─── Trade-proportional sizing ───
    copyAmountUsd = traderTradeUsd * copyPercent;
    // Absolute dollar cap
    copyAmountUsd = Math.min(copyAmountUsd, maxPerTrade);
  }

  // ─── Position lookup (BUY only) ───
  // ALWAYS look up position for BUY (needed by CLOB min check + pool routing),
  // not just when maxPerPrediction > 0 (was a bug: positionUsd stayed 0, causing
  // every sub-$1 trade to be bumped to $1 instead of routing to pool).
  let positionUsd = 0;
  if (trade.side === 'BUY') {
    positionUsd = await getNetPositionUsd(trade.asset, allocation.id, isPaper);
  }

  // ─── Per-prediction position cap (BUY only, when enabled) ───
  // Prevents stacking beyond MAX_PREDICTION_POSITION_USD in a single tokenId.
  // On partial room: trim to the gap rather than skip entirely.
  // Net position = BUY fills minus SELL fills, so re-entries after exits are allowed.
  if (trade.side === 'BUY' && maxPerPrediction > 0) {
    const remaining = maxPerPrediction - positionUsd;
    if (remaining < 0.01) {
      await createSkippedRecord(trade, 'prediction position limit reached', allocation.id, isPaper);
      return;
    }
    if (copyAmountUsd > remaining) {
      copyAmountUsd = remaining;
      log.debug('Position cap: trimmed copy amount to remaining room', {
        tokenId: trade.asset,
        positionUsd: positionUsd.toFixed(2),
        remaining: remaining.toFixed(2),
        allocationId: allocation.id,
      });
    }
  }

  // ─── Hedge guard: block cheap naked BUY + cap hedge trades ───
  let hedgeMaxUsd = Infinity;
  // Pre-filter: since avgBuyPrice ≤ 1.0 on Polymarket, ratio * avgBuyPrice ≤ ratio.
  // Any trade priced at or above the ratio itself cannot be a hedge.
  if (trade.side === 'BUY' && config.HEDGE_PRICE_RATIO > 0 && trade.price < config.HEDGE_PRICE_RATIO) {
    const oppositePos = await getOppositePosition(trade.conditionId, trade.asset, allocation.id, isPaper);
    const hasOpposite = oppositePos.avgBuyPrice > 0 && oppositePos.netUsd >= 0.01;

    if (!hasOpposite) {
      // No opposite position — block only if price is very cheap (backup/hedge pattern)
      if (config.HEDGE_NAKED_MAX_PRICE > 0 && trade.price <= config.HEDGE_NAKED_MAX_PRICE) {
        log.info('Hedge guard: blocked cheap naked BUY — no opposite position', {
          trader: trade.proxyWallet.slice(0, 10),
          price: trade.price,
          nakedMaxPrice: config.HEDGE_NAKED_MAX_PRICE,
          outcome: trade.outcome, title: trade.title?.slice(0, 50),
        });
        await createSkippedRecord(
          trade,
          `hedge guard: naked BUY @${trade.price.toFixed(2)} ≤ ${config.HEDGE_NAKED_MAX_PRICE} with no opposite position`,
          allocation.id,
          isPaper,
        );
        return;
      }
      // Price above naked ceiling (e.g. 15¢) → allow through, could be legitimate cheap market
    } else {
      // Opposite exists — check if this trade qualifies as a hedge (price below ratio threshold)
      const isHedge = trade.price < config.HEDGE_PRICE_RATIO * oppositePos.avgBuyPrice;
      if (isHedge) {
        if (oppositePos.netUsd < config.HEDGE_MIN_OPPOSITE_USD) {
          log.info('Hedge guard: blocked hedge — opposite position too small', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: oppositePos.avgBuyPrice.toFixed(3),
            threshold: (config.HEDGE_PRICE_RATIO * oppositePos.avgBuyPrice).toFixed(3),
            oppositeUsd: oppositePos.netUsd.toFixed(2),
            minRequired: config.HEDGE_MIN_OPPOSITE_USD,
            outcome: trade.outcome, title: trade.title?.slice(0, 50),
          });
          await createSkippedRecord(
            trade,
            `hedge guard: trade @${trade.price.toFixed(2)} < ${config.HEDGE_PRICE_RATIO} * opposite avg ${oppositePos.avgBuyPrice.toFixed(3)}, ` +
            `opposite position $${oppositePos.netUsd.toFixed(2)} < $${config.HEDGE_MIN_OPPOSITE_USD} minimum`,
            allocation.id,
            isPaper,
          );
          return;
        }
        hedgeMaxUsd = oppositePos.netUsd * config.HEDGE_MAX_RATIO;
        if (copyAmountUsd > hedgeMaxUsd) {
          copyAmountUsd = hedgeMaxUsd;
          log.info('Hedge guard: trimmed copy amount to max hedge ratio', {
            trader: trade.proxyWallet.slice(0, 10),
            price: trade.price, avgBuyPrice: oppositePos.avgBuyPrice.toFixed(3),
            oppositeUsd: oppositePos.netUsd.toFixed(2),
            maxHedgeUsd: hedgeMaxUsd.toFixed(2), hedgeMaxRatio: config.HEDGE_MAX_RATIO,
          });
        }
      }
      // else: hasOpposite but NOT a hedge (price above ratio threshold) → proceed normally
    }
  }

  // ─── CLOB $1 minimum (live BUY only) ───
  // Smart bump: only bump to CLOB minimum on FIRST entry (no existing position).
  // On subsequent entries, natural size < $1 means the cumulative signal is small;
  // the initial bump already covered the market entry overhead — skip instead of
  // over-deploying (e.g. $0.60 bumped to $1 + $0.30 bumped to $1 = $2 for $0.90 intent).
  if (trade.side === 'BUY' && !isPaper && copyAmountUsd < CLOB_MIN_ORDER_USD) {
    if (positionUsd < 0.01) {
      // First entry: bump to CLOB minimum, but respect hedge guard cap
      copyAmountUsd = Math.min(CLOB_MIN_ORDER_USD, hedgeMaxUsd);
      if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
        await createSkippedRecord(
          trade,
          `hedge guard cap $${hedgeMaxUsd.toFixed(2)} below CLOB minimum $${CLOB_MIN_ORDER_USD}`,
          allocation.id,
          isPaper,
        );
        return;
      }
    } else {
      // Subsequent entry: natural size too small for CLOB — pool it (skip dust)
      if (copyAmountUsd < 0.01) {
        await createSkippedRecord(trade, `dust amount $${copyAmountUsd.toFixed(6)} below pool minimum`, allocation.id, isPaper);
        return;
      }
      await addToPool(trade, copyAmountUsd, { id: allocation.id, isPaper });
      return;
    }
  }

  // ─── Global daily backstop (BUY only) ───
  // Per-allocation budget is managed via currentCapital; this is a cross-allocation safety net.

  if (trade.side === 'BUY') {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    // Global daily backstop (across all allocations, scoped by paper/live)
    const globalSpend = await prisma.copyTrade.aggregate({
      where: {
        status: { in: ['FILLED', 'POOLED', 'PENDING'] },
        side: 'BUY',
        createdAt: { gte: todayStart },
        isPaper,
      },
      _sum: { requestedAmount: true },
    });
    const globalRemaining = config.MAX_DAILY_LOSS_USD - (globalSpend._sum.requestedAmount ?? 0);
    if (globalRemaining <= 0) {
      await createSkippedRecord(trade, 'global daily loss limit reached', allocation.id, isPaper);
      return;
    }
    if (copyAmountUsd > globalRemaining) {
      copyAmountUsd = globalRemaining;
    }
  }
  // Guard: skip if amount is effectively zero (can happen after position-cap trim on tiny signal trades)
  if (copyAmountUsd <= 0) return;

  // Pool if below threshold (paper uses POOL_MIN_AMOUNT_USD, live uses LIVE_POOL_MIN_AMOUNT_USD)
  const poolThreshold = isPaper ? config.POOL_MIN_AMOUNT_USD : config.LIVE_POOL_MIN_AMOUNT_USD;
  if (trade.side === 'BUY' && copyAmountUsd < poolThreshold) {
    await addToPool(trade, copyAmountUsd, { id: allocation.id, isPaper });
    return;
  }

  if (trade.side === 'BUY' && copyAmountUsd > allocation.currentCapital) {
    await createSkippedRecord(trade, 'insufficient allocated capital', allocation.id, isPaper);
    return;
  }

  // ─── Convert amount for executor ───

  // BUY: executor expects USD amount
  // SELL: executor expects share count
  const executorAmount = trade.side === 'BUY'
    ? copyAmountUsd
    : sellShares!;

  // ─── Execute ───

  const preExecMs = Date.now();

  // Create PENDING record (always store requestedAmount as USD)
  // P2002 guard: if another concurrent call already claimed this detectedTradeId,
  // silently return — the unique constraint on detectedTradeId prevents duplicate CLOB orders.
  let copyTrade;
  try {
    copyTrade = await prisma.copyTrade.create({
      data: {
        detectedTradeId: trade.id,
        tokenId: trade.asset,
        side: trade.side,
        requestedAmount: copyAmountUsd,
        requestedPrice: trade.price,
        status: 'PENDING',
        isPaper,
        followAllocationId: allocation.id,
      },
    });
  } catch (err: any) {
    if (err.code === 'P2002') return; // Another call already claimed this trade
    throw err;
  }

  const postPendingMs = Date.now();
  const executeFn = isPaper ? paperExecute : realExecute;

  let result: ExecuteOrderResult;
  try {
    result = await executeFn({
      tokenId: trade.asset,
      side: trade.side as 'BUY' | 'SELL',
      amount: executorAmount,
      detectedPrice: trade.price,
      detectionSource: trade.detectionSource ?? undefined,
      signalAgeMs,
    });
  } catch (err: any) {
    result = {
      orderId: null,
      status: 'FAILED',
      filledPrice: null,
      filledSize: null,
      failReason: err.message?.slice(0, 500),
      transactionHashes: [],
    };
  }

  const postExecMs = Date.now();
  const latencyMs = postExecMs - startMs;

  log.info('Copy trade timing', {
    trader: trade.proxyWallet.slice(0, 10),
    side: trade.side,
    status: result.status,
    dbChecksMs: preExecMs - startMs,
    pendingInsertMs: postPendingMs - preExecMs,
    executorMs: postExecMs - postPendingMs,
    totalMs: latencyMs,
    detectionSource: trade.detectionSource,
  });

  // Calculate slippage if filled
  let slippageBps: number | null = null;
  if (result.filledPrice && trade.price > 0) {
    slippageBps = Math.round(((result.filledPrice - trade.price) / trade.price) * 10000);
    if (trade.side === 'SELL') slippageBps = -slippageBps;
  }

  // ─── DELAYED: sports market 3s matching delay — keep PENDING, poll in background ───
  if (result.status === 'DELAYED' && result.orderId) {
    await prisma.copyTrade.update({
      where: { id: copyTrade.id },
      data: {
        orderId: result.orderId,
        failReason: 'delayed matching: background poll scheduled',
        latencyMs,
      },
    });
    scheduleDelayedOrderPoll({
      copyTradeId: copyTrade.id,
      orderId: result.orderId,
      allocationId: allocation.id,
      side: trade.side as 'BUY' | 'SELL',
      tokenId: trade.asset,
      isPaper,
      detectedPrice: trade.price,
    });
    log.info('COPY TRADE DELAYED — background poll scheduled', {
      trader: trade.proxyWallet.slice(0, 10), mode: isPaper ? 'PAPER' : 'LIVE',
      side: trade.side, orderId: result.orderId,
      copyAmountUsd: copyAmountUsd.toFixed(2),
      title: trade.title?.slice(0, 50),
    });
    return;
  }

  // ─── Update record + capital atomically ───

  await prisma.$transaction(async (tx) => {
    await tx.copyTrade.update({
      where: { id: copyTrade.id },
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
        // FAK partial fills: update requestedAmount to actual USD so daily spend tracking is accurate
        requestedAmount: (result.status === 'FILLED' && result.filledSize && result.filledPrice)
          ? result.filledSize * result.filledPrice
          : undefined,
      },
    });

    if (result.status === 'FILLED') {
      const usdValue = (result.filledSize && result.filledPrice)
        ? result.filledSize * result.filledPrice
        : copyAmountUsd;

      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: allocation.id },
      });

      // Guard: if allocation was deactivated mid-flight (e.g. circuit breaker), skip capital update
      if (!fresh.isActive) {
        log.warn('Allocation deactivated mid-flight, skipping capital update', {
          tradeId: copyTrade.id, allocationId: allocation.id,
        });
        return;
      }

      if (trade.side === 'BUY') {
        // Defense-in-depth: cap decrement to available capital to prevent negative balance
        const safeDecrement = Math.min(usdValue, Math.max(fresh.currentCapital, 0));
        if (safeDecrement < usdValue) {
          log.warn('Capital re-check: capping decrement to available capital', {
            available: fresh.currentCapital, required: usdValue, allocationId: allocation.id,
          });
        }
        await tx.followAllocation.update({
          where: { id: allocation.id },
          data: {
            currentCapital: { decrement: safeDecrement },
            deployedCapital: { increment: safeDecrement },
          },
        });
      } else {
        // SELL: release cost basis (not proceeds) from deployedCapital
        const costBasisFills = await tx.copyTrade.findMany({
          where: {
            tokenId: trade.asset,
            followAllocationId: allocation.id,
            isPaper,
            status: 'FILLED',
            id: { not: copyTrade.id }, // exclude current SELL (already updated to FILLED above)
          },
          select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
        });
        const costBasis = computeSellCostBasis(costBasisFills, result.filledSize ?? sellShares!);

        log.debug('SELL cost basis', {
          tokenId: trade.asset.slice(0, 20),
          soldShares: (result.filledSize ?? sellShares!).toFixed(4),
          avgCost: costBasis.avgCostPerShare.toFixed(4),
          costBasis: costBasis.costBasisOfSoldShares.toFixed(2),
          proceeds: usdValue.toFixed(2),
        });

        await tx.followAllocation.update({
          where: { id: allocation.id },
          data: {
            currentCapital: { increment: usdValue },
            deployedCapital: { decrement: Math.min(costBasis.costBasisOfSoldShares, fresh.deployedCapital) },
          },
        });
      }
    }
  });

  // Record SELL fill time for per-token cool-down (after txn commit to avoid false cool-down on rollback)
  if (result.status === 'FILLED' && trade.side === 'SELL') {
    recordSellFill(allocation.id, trade.asset);
  }

  // ─── Log ───

  const mode = isPaper ? 'PAPER' : 'LIVE';

  if (result.status === 'FILLED') {
    log.info(`COPY TRADE EXECUTED [${mode}]`, {
      trader: trade.proxyWallet.slice(0, 10),
      mode,
      side: trade.side,
      outcome: trade.outcome,
      title: trade.title?.slice(0, 50),
      signalTradeUsd: traderTradeUsd != null ? `$${traderTradeUsd.toFixed(2)}` : undefined,
      copyAmountUsd: copyAmountUsd.toFixed(2),
      filledPrice: result.filledPrice,
      filledSize: result.filledSize,
      slippageBps,
      estimatedFee: result.estimatedFee,
      latencyMs,
      signalAgeMs,
      allocationId: allocation.id,
      copyPercent,
      maxPerTrade,
      maxPerPrediction,
    });
  } else if (result.status === 'SKIPPED') {
    log.info(`COPY TRADE SKIPPED [${mode}]`, {
      trader: trade.proxyWallet.slice(0, 10),
      mode,
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
      signalAgeMs,
    });
  } else {
    log.warn(`COPY TRADE FAILED [${mode}]`, {
      trader: trade.proxyWallet.slice(0, 10),
      mode,
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
      latencyMs,
      signalAgeMs,
    });
  }
}

async function getHeldShares(
  tokenId: string,
  followAllocationId: string,
  isPaper: boolean,
): Promise<number> {
  const fills = await prisma.copyTrade.findMany({
    where: { tokenId, followAllocationId, isPaper, status: { in: ['FILLED', 'PENDING'] } },
    select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true, requestedPrice: true },
  });

  let netShares = 0;
  for (const fill of fills) {
    if (fill.side === 'BUY') {
      if (fill.filledSize != null) {
        netShares += fill.filledSize;
      } else {
        // PENDING records have NULL filledSize — use requestedAmount/requestedPrice
        const price = fill.filledPrice ?? fill.requestedPrice ?? 1;
        netShares += fill.requestedAmount / price;
      }
    } else {
      if (fill.filledSize != null) {
        netShares -= fill.filledSize;
      } else {
        const price = fill.filledPrice ?? fill.requestedPrice ?? 1;
        netShares -= fill.requestedAmount / price;
      }
    }
  }
  if (netShares < 0) {
    log.warn('getHeldShares: negative net shares (data inconsistency)', {
      tokenId, followAllocationId, isPaper, netShares,
    });
  }
  // Round away sub-penny dust: amounts < 0.01 shares are unsellable on CLOB
  // (2dp floor → 0) and settle at market resolution. Eliminates phantom dust
  // from floating-point accumulation in requestedAmount/price division.
  const clamped = Math.max(netShares, 0);
  return clamped < 0.01 ? 0 : clamped;
}

async function getNetPositionUsd(
  tokenId: string,
  followAllocationId: string,
  isPaper: boolean,
): Promise<number> {
  const fills = await prisma.copyTrade.findMany({
    where: { tokenId, followAllocationId, isPaper, status: { in: ['FILLED', 'PENDING'] } },
    select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
  });

  let netUsd = 0;
  for (const fill of fills) {
    let usd: number;
    if (fill.filledSize != null && fill.filledPrice != null) {
      usd = fill.filledSize * fill.filledPrice;
    } else {
      // PENDING records have NULL filledSize/filledPrice — use requestedAmount
      usd = fill.requestedAmount;
    }
    if (fill.side === 'BUY') netUsd += usd;
    else netUsd -= usd;
  }
  if (netUsd < 0) {
    log.warn('getNetPositionUsd: negative net USD (data inconsistency)', {
      tokenId, followAllocationId, isPaper, netUsd,
    });
  }
  // Round away sub-penny residuals: amounts < $0.01 are below CLOB minimum
  // and represent floating-point accumulation artifacts, not real positions.
  const clamped = Math.max(netUsd, 0);
  return clamped < 0.01 ? 0 : clamped;
}

/**
 * Hedge guard helper: find our position on the OPPOSITE outcome
 * of the same binary market (conditionId).
 * Returns netUsd and avgBuyPrice for ratio-based hedge detection.
 */
async function getOppositePosition(
  conditionId: string,
  currentAsset: string,
  followAllocationId: string,
  isPaper: boolean,
): Promise<{ netUsd: number; avgBuyPrice: number }> {
  const oppositeToken = await prisma.detectedTrade.findFirst({
    where: {
      conditionId,
      asset: { not: currentAsset },
    },
    select: { asset: true },
  });
  if (!oppositeToken) return { netUsd: 0, avgBuyPrice: 0 };

  const fills = await prisma.copyTrade.findMany({
    where: { tokenId: oppositeToken.asset, followAllocationId, isPaper, status: { in: ['FILLED', 'PENDING'] } },
    select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true, requestedPrice: true },
  });

  let netUsd = 0;
  let buyCost = 0;
  let buyShares = 0;
  for (const fill of fills) {
    let usd: number;
    let shares: number;
    if (fill.filledSize != null && fill.filledPrice != null) {
      usd = fill.filledSize * fill.filledPrice;
      shares = fill.filledSize;
    } else {
      usd = fill.requestedAmount;
      shares = fill.requestedAmount / (fill.filledPrice ?? fill.requestedPrice ?? 1);
    }
    if (fill.side === 'BUY') {
      netUsd += usd;
      buyCost += usd;
      buyShares += shares;
    } else {
      netUsd -= usd;
    }
  }
  netUsd = Math.max(netUsd, 0);
  const avgBuyPrice = buyShares > 0 ? buyCost / buyShares : 0;
  return { netUsd, avgBuyPrice };
}

/**
 * Check if the market is closed.
 * Returns a skip reason string if the trade should not be executed, null otherwise.
 * BUY-only — SELLs should always be allowed (exit existing positions).
 * Fail-open: errors return null (allow trade).
 *
 * Note: We rely on the `closed` field (refreshed by position-settlement every 5 min
 * and resolveMarkets on first encounter) rather than `endDate`, because Polymarket
 * sets endDate to game-start time for sports markets, not market-close time.
 * The signal trader successfully executing a trade is itself evidence the market is open.
 */
async function checkMarketClosed(
  conditionId: string,
  side: string,
): Promise<string | null> {
  if (side !== 'BUY') return null;
  if (!config.MARKET_END_GATEKEEP_ENABLED) return null;

  try {
    let market = await prisma.market.findUnique({
      where: { conditionId },
      select: { closed: true },
    });

    // If not cached, resolve from Gamma API
    if (!market) {
      await resolveMarkets([conditionId]);
      market = await prisma.market.findUnique({
        where: { conditionId },
        select: { closed: true },
      });
    }

    // No market data — fail-open
    if (!market) return null;

    if (market.closed) {
      return 'market already closed';
    }

    return null;
  } catch (err: any) {
    log.warn('Market closed check failed (proceeding)', { conditionId, error: err.message });
    return null;
  }
}

export async function createSkippedRecord(
  trade: DetectedTradeRow,
  reason: string,
  followAllocationId: string | null,
  isPaper: boolean,
): Promise<void> {
  try {
    await prisma.copyTrade.create({
      data: {
        detectedTradeId: trade.id,
        tokenId: trade.asset,
        side: trade.side,
        requestedAmount: 0,
        requestedPrice: trade.price,
        status: 'SKIPPED',
        isPaper,
        failReason: reason,
        latencyMs: 0,
        followAllocationId,
      },
    });
  } catch (err: any) {
    // Skip duplicate constraint violations
    if (err.code === 'P2002') return;
    throw err;
  }

  log.debug(`COPY TRADE SKIPPED`, {
    trader: trade.proxyWallet.slice(0, 10),
    reason,
    side: trade.side,
    title: trade.title?.slice(0, 50),
  });
}
