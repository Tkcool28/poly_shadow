import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { executeMarketOrder } from './trade-executor';
import type { ExecuteOrderResult } from './trade-executor';

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
    await createSkippedRecord(trade, 'no active follow allocation', null);
    return;
  }

  // Check cached trader portfolio value
  if (!allocation.traderPortfolioValue || allocation.traderPortfolioValue <= 0) {
    await createSkippedRecord(trade, 'trader portfolio value unknown', allocation.id);
    return;
  }

  // ─── Percentage-based sizing ───

  const tradeUsdValue = trade.size * trade.price;
  const tradePercent = tradeUsdValue / allocation.traderPortfolioValue;
  const cappedPercent = Math.min(tradePercent, config.MAX_TRADE_PERCENT);

  let copyAmountUsd = cappedPercent * allocation.currentCapital;
  copyAmountUsd = Math.min(copyAmountUsd, config.MAX_POSITION_USD);

  if (copyAmountUsd < 0.10) {
    await createSkippedRecord(trade, 'amount too small', allocation.id);
    return;
  }

  if (trade.side === 'BUY' && copyAmountUsd > allocation.currentCapital) {
    await createSkippedRecord(trade, 'insufficient allocated capital', allocation.id);
    return;
  }

  // ─── Per-allocation daily spend check (BUY only) ───

  if (trade.side === 'BUY') {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayBuySpend = await prisma.copyTrade.aggregate({
      where: {
        status: 'FILLED',
        side: 'BUY',
        createdAt: { gte: todayStart },
        followAllocationId: allocation.id,
      },
      _sum: { requestedAmount: true },
    });
    const spent = todayBuySpend._sum.requestedAmount ?? 0;
    const dailyLimit = allocation.initialCapital * 0.20;
    if (spent + copyAmountUsd > dailyLimit) {
      await createSkippedRecord(trade, 'per-allocation daily limit reached', allocation.id);
      return;
    }

    // Global daily backstop (across all allocations)
    const globalSpend = await prisma.copyTrade.aggregate({
      where: {
        status: 'FILLED',
        side: 'BUY',
        createdAt: { gte: todayStart },
      },
      _sum: { requestedAmount: true },
    });
    if ((globalSpend._sum.requestedAmount ?? 0) + copyAmountUsd > config.MAX_DAILY_LOSS_USD) {
      await createSkippedRecord(trade, 'global daily loss limit reached', allocation.id);
      return;
    }
  }

  // ─── Global open positions backstop ───

  const [globalBuys, globalSells] = await Promise.all([
    prisma.copyTrade.count({ where: { status: 'FILLED', side: 'BUY' } }),
    prisma.copyTrade.count({ where: { status: 'FILLED', side: 'SELL' } }),
  ]);
  const globalOpenPositions = Math.max(globalBuys - globalSells, 0);

  if (globalOpenPositions >= config.MAX_OPEN_POSITIONS) {
    await createSkippedRecord(trade, 'global max open positions reached', allocation.id);
    return;
  }

  // SELL guard: only sell tokens we hold (scoped to this allocation)
  if (trade.side === 'SELL') {
    const hasBuyPosition = await prisma.copyTrade.findFirst({
      where: {
        tokenId: trade.asset,
        side: 'BUY',
        status: 'FILLED',
        followAllocationId: allocation.id,
      },
    });
    if (!hasBuyPosition) {
      await createSkippedRecord(trade, 'no position to sell', allocation.id);
      return;
    }
  }

  // ─── Convert amount for executor ───

  // BUY: executor expects USD amount
  // SELL: executor expects share count
  const executorAmount = trade.side === 'BUY'
    ? copyAmountUsd
    : copyAmountUsd / trade.price;

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
      followAllocationId: allocation.id,
    },
  });

  let result: ExecuteOrderResult;
  try {
    result = await executeMarketOrder({
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

  // Update record
  await prisma.copyTrade.update({
    where: { id: copyTrade.id },
    data: {
      orderId: result.orderId,
      status: result.status,
      filledPrice: result.filledPrice,
      filledSize: result.filledSize,
      slippageBps,
      failReason: result.failReason,
      latencyMs,
      filledAt: result.status === 'FILLED' ? new Date() : null,
    },
  });

  // ─── Capital update after fill (transactional with fresh read) ───

  if (result.status === 'FILLED') {
    const usdValue = (result.filledSize && result.filledPrice)
      ? result.filledSize * result.filledPrice
      : copyAmountUsd;

    await prisma.$transaction(async (tx) => {
      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: allocation.id },
      });

      if (trade.side === 'BUY') {
        await tx.followAllocation.update({
          where: { id: allocation.id },
          data: {
            currentCapital: { decrement: usdValue },
            deployedCapital: { increment: usdValue },
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
    });
  }

  // ─── Log ───

  if (result.status === 'FILLED') {
    log.info(`COPY TRADE EXECUTED`, {
      trader: trade.proxyWallet.slice(0, 10),
      side: trade.side,
      outcome: trade.outcome,
      title: trade.title?.slice(0, 50),
      tradePercent: (cappedPercent * 100).toFixed(2) + '%',
      copyAmountUsd: copyAmountUsd.toFixed(2),
      filledPrice: result.filledPrice,
      filledSize: result.filledSize,
      slippageBps,
      latencyMs,
      allocationId: allocation.id,
    });
  } else if (result.status === 'SKIPPED') {
    log.info(`COPY TRADE SKIPPED`, {
      trader: trade.proxyWallet.slice(0, 10),
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
    });
  } else {
    log.warn(`COPY TRADE FAILED`, {
      trader: trade.proxyWallet.slice(0, 10),
      reason: result.failReason,
      side: trade.side,
      title: trade.title?.slice(0, 50),
      latencyMs,
    });
  }
}

async function createSkippedRecord(
  trade: DetectedTradeRow,
  reason: string,
  followAllocationId: string | null,
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
