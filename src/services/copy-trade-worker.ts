import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { executeMarketOrder as realExecute, isBalancePaused, CLOB_MIN_ORDER_USD } from './trade-executor';
import { executeMarketOrder as paperExecute } from './paper-executor';
import type { ExecuteOrderResult } from './trade-executor';
import { addToPool } from './order-pool';
import { resolveMarkets } from './market-resolver';

const log = createJobLogger('copy-trade-worker');

interface DetectedTradeRow {
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
  compositeScore: number | null;
  detectedAt: Date;
}

export async function processCopyTrade(trade: DetectedTradeRow): Promise<void> {
  const startMs = Date.now();
  const signalAgeMs = startMs - trade.timestamp * 1000;

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

  // Skip live BUYs when wallet balance is insufficient — SELLs and paper allocations continue normally
  if (!isPaper && trade.side === 'BUY' && isBalancePaused()) {
    await createSkippedRecord(trade, 'live trading paused: insufficient wallet balance', allocation.id, isPaper);
    return;
  }

  // ─── Market end-time gatekeep (BUY only) ───
  const endTimeSkip = await checkMarketEndTime(trade.conditionId, trade.side);
  if (endTimeSkip) {
    await createSkippedRecord(trade, endTimeSkip, allocation.id, isPaper);
    return;
  }

  // ─── Sizing ───

  let copyAmountUsd: number;
  let sellShares: number | null = null;
  let traderTradeUsd: number | null = null;

  if (trade.side === 'SELL') {
    const heldShares = await getHeldShares(trade.asset, allocation.id, isPaper);
    // Threshold of 0.000001 shares (1 micro-share) guards against floating-point residuals
    // from the getHeldShares fallback path (requestedAmount / price) that pass > 0 but
    // round to 0 in CLOB integer conversion → HTTP 400 "amounts must be > 0"
    if (heldShares < 0.000001) {
      await createSkippedRecord(trade, 'no shares held to sell', allocation.id, isPaper);
      return;
    }
    // Full position close — when trader sells, we exit entirely
    sellShares = heldShares;
    copyAmountUsd = sellShares * trade.price;
  } else {
    // Guard: negative or zero capital means no buying power — skip silently
    if (allocation.currentCapital <= 0) return;

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
    copyAmountUsd = traderTradeUsd * config.COPY_TRADE_PERCENT;
    // Cap at 2× percent (never exceed 20% of signal trade size)
    copyAmountUsd = Math.min(copyAmountUsd, traderTradeUsd * (config.COPY_TRADE_PERCENT * 2));
    // Absolute dollar cap
    copyAmountUsd = Math.min(copyAmountUsd, config.MAX_POSITION_USD);
  }

  // Live: bump to CLOB $1 minimum before backstop checks — ensures the backstop sees the true
  // intended order size, preventing it from capping below the exchange minimum.
  if (trade.side === 'BUY' && !isPaper && copyAmountUsd < CLOB_MIN_ORDER_USD) {
    copyAmountUsd = CLOB_MIN_ORDER_USD;
  }

  // ─── Per-prediction position cap (BUY only) ───
  // Prevents stacking beyond MAX_PREDICTION_POSITION_USD in a single tokenId.
  // On partial room: trim to the gap rather than skip entirely.
  // Net position = BUY fills minus SELL fills, so re-entries after exits are allowed.
  if (trade.side === 'BUY' && config.MAX_PREDICTION_POSITION_USD > 0) {
    const positionUsd = await getNetPositionUsd(trade.asset, allocation.id, isPaper);
    const remaining = config.MAX_PREDICTION_POSITION_USD - positionUsd;
    if (remaining <= 0) {
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
      // After trimming: live order may now fall below CLOB $1 minimum — not executable
      if (!isPaper && copyAmountUsd < CLOB_MIN_ORDER_USD) {
        await createSkippedRecord(
          trade,
          `position gap $${remaining.toFixed(2)} below CLOB minimum $${CLOB_MIN_ORDER_USD}`,
          allocation.id,
          isPaper,
        );
        return;
      }
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
        status: { in: ['FILLED', 'POOLED'] },
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

  // Paper: pool if below paper pool threshold
  if (trade.side === 'BUY' && isPaper && copyAmountUsd < config.POOL_MIN_AMOUNT_USD) {
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

  // Create PENDING record (always store requestedAmount as USD)
  const copyTrade = await prisma.copyTrade.create({
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

  const executeFn = isPaper ? paperExecute : realExecute;

  let result: ExecuteOrderResult;
  try {
    result = await executeFn({
      tokenId: trade.asset,
      side: trade.side as 'BUY' | 'SELL',
      amount: executorAmount,
      detectedPrice: trade.price,
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

  const latencyMs = Date.now() - startMs;

  // Calculate slippage if filled
  let slippageBps: number | null = null;
  if (result.filledPrice && trade.price > 0) {
    slippageBps = Math.round(((result.filledPrice - trade.price) / trade.price) * 10000);
    if (trade.side === 'SELL') slippageBps = -slippageBps;
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
      },
    });

    if (result.status === 'FILLED') {
      const usdValue = (result.filledSize && result.filledPrice)
        ? result.filledSize * result.filledPrice
        : copyAmountUsd;

      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: allocation.id },
      });

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
        await tx.followAllocation.update({
          where: { id: allocation.id },
          data: {
            currentCapital: { increment: usdValue },
            deployedCapital: { decrement: Math.min(usdValue, fresh.deployedCapital) },
          },
        });
      }
    }
  });

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
    where: { tokenId, followAllocationId, isPaper, status: 'FILLED' },
    select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
  });

  let netShares = 0;
  for (const fill of fills) {
    if (fill.side === 'BUY') {
      if (fill.filledSize != null) {
        netShares += fill.filledSize;
      } else {
        const price = fill.filledPrice ?? 1;
        netShares += fill.requestedAmount / price;
        log.warn('getHeldShares: BUY fill missing filledSize, using fallback', { tokenId, fillPrice: price });
      }
    } else {
      netShares -= fill.filledSize ?? 0;
    }
  }
  return Math.max(netShares, 0);
}

async function getNetPositionUsd(
  tokenId: string,
  followAllocationId: string,
  isPaper: boolean,
): Promise<number> {
  const fills = await prisma.copyTrade.findMany({
    where: { tokenId, followAllocationId, isPaper, status: 'FILLED' },
    select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
  });

  let netUsd = 0;
  for (const fill of fills) {
    let usd: number;
    if (fill.filledSize != null && fill.filledPrice != null) {
      usd = fill.filledSize * fill.filledPrice;
    } else {
      usd = fill.requestedAmount;
      log.warn('getNetPositionUsd: fill missing filledSize/filledPrice, using requestedAmount fallback', {
        tokenId, side: fill.side, requestedAmount: fill.requestedAmount,
      });
    }
    if (fill.side === 'BUY') netUsd += usd;
    else netUsd -= usd;
  }
  return Math.max(netUsd, 0);
}

/**
 * Returns the minimum time (ms) that must remain before market end
 * for us to place a BUY order. Scales with proximity to close.
 */
function getMinTimeRemaining(timeRemainingMs: number): number {
  if (timeRemainingMs <= 10 * 60_000) return 120_000;   // ≤10 min → 2 min buffer
  if (timeRemainingMs <= 60 * 60_000) return 90_000;    // ≤1 hour → 90s buffer
  if (timeRemainingMs <= 4 * 60 * 60_000) return 60_000; // ≤4 hours → 60s buffer
  return 30_000;                                          // >4 hours → 30s buffer
}

/**
 * Check if the market's end time has passed or is too close.
 * Returns a skip reason string if the trade should not be executed, null otherwise.
 * BUY-only — SELLs should always be allowed (exit existing positions).
 * Fail-open: errors return null (allow trade).
 */
async function checkMarketEndTime(
  conditionId: string,
  side: string,
): Promise<string | null> {
  if (side !== 'BUY') return null;
  if (!config.MARKET_END_GATEKEEP_ENABLED) return null;

  try {
    let market = await prisma.market.findUnique({
      where: { conditionId },
      select: { endDate: true, closed: true },
    });

    // If not cached, resolve from Gamma API
    if (!market) {
      await resolveMarkets([conditionId]);
      market = await prisma.market.findUnique({
        where: { conditionId },
        select: { endDate: true, closed: true },
      });
    }

    // No market data — fail-open
    if (!market) return null;

    if (market.closed) {
      return 'market already closed';
    }

    // No endDate (regular prediction markets) — allow
    if (!market.endDate) return null;

    const now = Date.now();
    const timeRemainingMs = market.endDate.getTime() - now;

    if (timeRemainingMs <= 0) {
      return `market ended ${Math.abs(Math.round(timeRemainingMs / 1000))}s ago`;
    }

    const minBuffer = getMinTimeRemaining(timeRemainingMs);
    if (timeRemainingMs < minBuffer) {
      return `market ends in ${Math.round(timeRemainingMs / 1000)}s, below ${Math.round(minBuffer / 1000)}s minimum`;
    }

    return null;
  } catch (err: any) {
    // Fail-open: don't block trades on API/DB errors
    log.warn('Market end-time check failed (proceeding)', { conditionId, error: err.message });
    return null;
  }
}

async function createSkippedRecord(
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
