import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { executeMarketOrder as realExecute, isBalancePaused } from './trade-executor';
import { executeMarketOrder as paperExecute } from './paper-executor';
import type { ExecuteOrderResult } from './trade-executor';
import { addToPool } from './order-pool';

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

  // Check cached trader portfolio value
  if (!allocation.traderPortfolioValue || allocation.traderPortfolioValue <= 0) {
    await createSkippedRecord(trade, 'trader portfolio value unknown', allocation.id, isPaper);
    return;
  }

  // Check portfolio value freshness (stale data = bad sizing)
  const maxStaleMs = 30 * 60 * 1000; // 30 minutes
  if (allocation.portfolioValueAt &&
      Date.now() - allocation.portfolioValueAt.getTime() > maxStaleMs) {
    await createSkippedRecord(trade, 'trader portfolio value stale', allocation.id, isPaper);
    return;
  }

  // ─── Sizing ───

  let copyAmountUsd: number;
  let sellShares: number | null = null;
  let cappedPercent: number | null = null;

  if (trade.side === 'SELL') {
    const heldShares = await getHeldShares(trade.asset, allocation.id, isPaper);
    if (heldShares <= 0) {
      await createSkippedRecord(trade, 'no shares held to sell', allocation.id, isPaper);
      return;
    }
    // Full position close — when trader sells, we exit entirely
    sellShares = heldShares;
    copyAmountUsd = sellShares * trade.price;

    // Skip dust sells (rounding remnants)
    if (copyAmountUsd < config.MIN_SELL_USD) {
      await createSkippedRecord(trade, `dust sell: $${copyAmountUsd.toFixed(4)} below minimum`, allocation.id, isPaper);
      return;
    }
  } else {
    const tradeUsdValue = trade.size * trade.price;
    const tradePercent = tradeUsdValue / allocation.traderPortfolioValue;
    cappedPercent = Math.min(tradePercent, config.MAX_TRADE_PERCENT);
    copyAmountUsd = cappedPercent * allocation.currentCapital;
    copyAmountUsd = Math.min(copyAmountUsd, config.MAX_POSITION_USD);
  }

  if (trade.side === 'BUY' && copyAmountUsd < config.POOL_MIN_AMOUNT_USD) {
    await addToPool(trade, copyAmountUsd, { id: allocation.id, isPaper });
    return;
  }

  if (trade.side === 'BUY' && copyAmountUsd > allocation.currentCapital) {
    await createSkippedRecord(trade, 'insufficient allocated capital', allocation.id, isPaper);
    return;
  }

  // ─── Per-allocation daily spend check (BUY only) ───

  if (trade.side === 'BUY') {
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);

    const todayBuySpend = await prisma.copyTrade.aggregate({
      where: {
        status: { in: ['FILLED', 'POOLED'] },
        side: 'BUY',
        createdAt: { gte: todayStart },
        followAllocationId: allocation.id,
      },
      _sum: { requestedAmount: true },
    });
    const spent = todayBuySpend._sum.requestedAmount ?? 0;
    const dailyLimit = allocation.initialCapital * 0.20;
    if (spent + copyAmountUsd > dailyLimit) {
      await createSkippedRecord(trade, 'per-allocation daily limit reached', allocation.id, isPaper);
      return;
    }

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
    if ((globalSpend._sum.requestedAmount ?? 0) + copyAmountUsd > config.MAX_DAILY_LOSS_USD) {
      await createSkippedRecord(trade, 'global daily loss limit reached', allocation.id, isPaper);
      return;
    }
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
      tradePercent: cappedPercent != null ? (cappedPercent * 100).toFixed(2) + '%' : 'full-close',
      copyAmountUsd: copyAmountUsd.toFixed(2),
      filledPrice: result.filledPrice,
      filledSize: result.filledSize,
      slippageBps,
      estimatedFee: result.estimatedFee,
      latencyMs,
      allocationId: allocation.id,
    });
  } else if (result.status === 'SKIPPED') {
    log.info(`COPY TRADE SKIPPED [${mode}]`, {
      trader: trade.proxyWallet.slice(0, 10),
      mode,
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
    });
  } else {
    log.warn(`COPY TRADE FAILED [${mode}]`, {
      trader: trade.proxyWallet.slice(0, 10),
      mode,
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
      latencyMs,
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
