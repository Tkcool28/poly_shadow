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

  // Score threshold (skip unscored traders too)
  if (trade.compositeScore === null || trade.compositeScore < config.MIN_COMPOSITE_SCORE) {
    await createSkippedRecord(trade, 'composite score below threshold');
    return;
  }

  // Daily loss check (approximated by total negative slippage today)
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayTrades = await prisma.copyTrade.aggregate({
    where: {
      status: 'FILLED',
      createdAt: { gte: todayStart },
    },
    _sum: { requestedAmount: true },
    _count: true,
  });
  const todaySpent = todayTrades._sum.requestedAmount ?? 0;
  if (todaySpent >= config.MAX_DAILY_LOSS_USD) {
    await createSkippedRecord(trade, 'daily loss limit reached');
    return;
  }

  // Open positions check (net: BUYs minus SELLs per token)
  const [buyCount, sellCount] = await Promise.all([
    prisma.copyTrade.count({ where: { status: 'FILLED', side: 'BUY' } }),
    prisma.copyTrade.count({ where: { status: 'FILLED', side: 'SELL' } }),
  ]);
  const openPositionCount = Math.max(buyCount - sellCount, 0);
  if (openPositionCount >= config.MAX_OPEN_POSITIONS) {
    await createSkippedRecord(trade, 'max open positions reached');
    return;
  }

  // SELL guard: only copy SELL if we have a filled BUY for this token
  if (trade.side === 'SELL') {
    const hasBuyPosition = await prisma.copyTrade.findFirst({
      where: { tokenId: trade.asset, side: 'BUY', status: 'FILLED' },
    });
    if (!hasBuyPosition) {
      await createSkippedRecord(trade, 'no position to sell');
      return;
    }
  }

  // ─── Size calculation ───

  const copySize = trade.size * config.POSITION_SIZE_MULTIPLIER;
  let copyAmount: number;

  if (trade.side === 'BUY') {
    // BUY: amount is in USD
    copyAmount = Math.min(copySize * trade.price, config.MAX_POSITION_USD);
  } else {
    // SELL: amount is in shares
    copyAmount = Math.min(copySize, config.MAX_POSITION_USD / trade.price);
  }

  if (copyAmount < 0.10) {
    await createSkippedRecord(trade, 'amount too small');
    return;
  }

  // ─── Execute ───

  // Create PENDING record
  const copyTrade = await prisma.copyTrade.create({
    data: {
      detectedTradeId: trade.id,
      tokenId: trade.asset,
      side: trade.side,
      requestedAmount: copyAmount,
      requestedPrice: trade.price,
      status: 'PENDING',
    },
  });

  let result: ExecuteOrderResult;
  try {
    result = await executeMarketOrder({
      tokenId: trade.asset,
      side: trade.side as 'BUY' | 'SELL',
      amount: copyAmount,
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
    if (trade.side === 'SELL') slippageBps = -slippageBps; // Invert for sells
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

  // ─── Log ───

  if (result.status === 'FILLED') {
    log.info(`COPY TRADE EXECUTED`, {
      trader: trade.proxyWallet.slice(0, 10),
      side: trade.side,
      outcome: trade.outcome,
      title: trade.title?.slice(0, 50),
      requestedAmount: copyAmount,
      filledPrice: result.filledPrice,
      filledSize: result.filledSize,
      slippageBps,
      latencyMs,
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

async function createSkippedRecord(trade: DetectedTradeRow, reason: string): Promise<void> {
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
