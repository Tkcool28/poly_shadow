import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getClient, getMarketMetadata } from './trade-executor';
import { auditAllocation } from '../lib/capital-audit';
import { getOrCreateMutex } from '../lib/allocation-mutex';
import { OrderType, Side } from '@polymarket/clob-client';
import { config } from '../config/env';

const log = createJobLogger('delayed-order-poller');

export interface DelayedOrderContext {
  copyTradeId: string;
  orderId: string;
  allocationId: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  isPaper: boolean;
  detectedPrice: number; // for SELL price recovery (CLOB returns $0.01 limit floor)
}

export interface GtcFallbackContext extends DelayedOrderContext {
  amountUsd: number; // copy trade USD amount (for shares calculation)
}

const POLL_DELAYS_MS = [4000, 8000, 15000];

/**
 * Fire-and-forget background poll for delayed FAK orders (sports market 3s matching delay).
 * Polls getOrder() at 4s, 8s, 15s to resolve PENDING → FILLED or FAILED.
 * If all retries exhaust, leaves record as PENDING for reconcileStalePending() at 60s.
 */
export function scheduleDelayedOrderPoll(ctx: DelayedOrderContext): void {
  if (ctx.isPaper) {
    // Paper trades have no CLOB order — mark FAILED immediately
    prisma.copyTrade.update({
      where: { id: ctx.copyTradeId },
      data: { status: 'FAILED', failReason: 'delayed matching: paper trade (no CLOB order)' },
    }).catch((err) => {
      log.error('Delayed poll: failed to mark paper trade FAILED', {
        copyTradeId: ctx.copyTradeId, error: err.message,
      });
    });
    return;
  }

  pollWithRetry(ctx, 0);
}

function pollWithRetry(ctx: DelayedOrderContext, attempt: number): void {
  if (attempt >= POLL_DELAYS_MS.length) {
    log.warn('Delayed order poll: exhausted retries — leaving PENDING for reconcileStalePending()', {
      copyTradeId: ctx.copyTradeId, orderId: ctx.orderId, attempts: attempt,
    });
    return;
  }

  setTimeout(() => {
    resolveDelayedOrder(ctx, attempt).catch((err) => {
      log.error('Delayed order poll: unexpected error, retrying', {
        copyTradeId: ctx.copyTradeId, orderId: ctx.orderId, attempt, error: err.message,
      });
      pollWithRetry(ctx, attempt + 1);
    });
  }, POLL_DELAYS_MS[attempt]);
}

async function resolveDelayedOrder(ctx: DelayedOrderContext, attempt: number): Promise<void> {
  // Guard: check record is still PENDING (may have been resolved by reconcileStalePending)
  const record = await prisma.copyTrade.findUnique({
    where: { id: ctx.copyTradeId },
    select: { status: true },
  });

  if (!record || record.status !== 'PENDING') {
    log.debug('Delayed order poll: record no longer PENDING, skipping', {
      copyTradeId: ctx.copyTradeId, currentStatus: record?.status ?? 'deleted',
    });
    return;
  }

  const client = getClient();
  if (!client) {
    log.warn('Delayed order poll: CLOB client unavailable', {
      copyTradeId: ctx.copyTradeId, orderId: ctx.orderId,
    });
    pollWithRetry(ctx, attempt + 1);
    return;
  }

  const order = await client.getOrder(ctx.orderId);
  const clobStatus = order?.status ?? 'unknown';

  if (order?.status === 'MATCHED') {
    const sizeMatched = parseFloat(order.size_matched || '0');
    const orderPrice = parseFloat(order.price || '0');

    // Price recovery: SELL FAK uses $0.01 limit floor — use detectedPrice instead
    const recoveredPrice = (ctx.side === 'SELL') ? ctx.detectedPrice : orderPrice;

    if (sizeMatched > 0 && recoveredPrice > 0 && recoveredPrice <= 1.0) {
      await prisma.copyTrade.update({
        where: { id: ctx.copyTradeId },
        data: {
          status: 'FILLED',
          filledSize: sizeMatched,
          filledPrice: recoveredPrice,
          requestedAmount: sizeMatched * recoveredPrice,
          failReason: `[delayed-poll-resolved] attempt=${attempt + 1}, orderPrice=${orderPrice}`,
          filledAt: new Date(),
          executionMethod: 'FAK',
        },
      });

      log.info('Delayed order poll: resolved PENDING → FILLED', {
        copyTradeId: ctx.copyTradeId, orderId: ctx.orderId,
        sizeMatched, recoveredPrice, orderPrice, side: ctx.side,
        attempt: attempt + 1, tokenId: ctx.tokenId.slice(0, 20),
      });

      // Capital correction via full replay under per-allocation mutex
      await correctCapital(ctx.allocationId);
    } else {
      log.warn('Delayed order poll: MATCHED but invalid price/size', {
        orderId: ctx.orderId, sizeMatched, orderPrice, recoveredPrice,
      });
      await prisma.copyTrade.update({
        where: { id: ctx.copyTradeId },
        data: {
          status: 'FAILED',
          failReason: `delayed poll: MATCHED but invalid data — size=${sizeMatched}, price=${recoveredPrice}`,
        },
      });
    }
  } else if (clobStatus === 'DELAYED' || clobStatus === 'LIVE') {
    // Still pending on CLOB — retry
    log.debug('Delayed order poll: still pending on CLOB', {
      copyTradeId: ctx.copyTradeId, orderId: ctx.orderId, clobStatus, attempt: attempt + 1,
    });
    pollWithRetry(ctx, attempt + 1);
  } else {
    // CANCELLED or unknown — mark FAILED
    await prisma.copyTrade.update({
      where: { id: ctx.copyTradeId },
      data: {
        status: 'FAILED',
        failReason: `delayed poll: CLOB status=${clobStatus}`,
      },
    });
    log.info('Delayed order poll: resolved PENDING → FAILED', {
      copyTradeId: ctx.copyTradeId, orderId: ctx.orderId, clobStatus,
    });
  }
}

async function correctCapital(allocationId: string): Promise<void> {
  try {
    const mutex = getOrCreateMutex(allocationId);
    await mutex.runExclusive(async () => {
      const audit = await auditAllocation(allocationId);
      await prisma.followAllocation.update({
        where: { id: allocationId },
        data: {
          currentCapital: audit.computedCC,
          deployedCapital: audit.computedDC,
        },
      });
      log.info('Delayed order poll: capital corrected via replay', {
        allocationId,
        ccBefore: audit.actualCC.toFixed(2),
        ccAfter: audit.computedCC.toFixed(2),
        dcBefore: audit.actualDC.toFixed(2),
        dcAfter: audit.computedDC.toFixed(2),
      });
    });
  } catch (err: any) {
    log.error('Delayed order poll: capital correction failed', {
      allocationId, error: err.message,
    });
  }
}

// ─── GTC Fallback: async place + single-shot poll ───

/**
 * GTC fallback: async place + single-shot poll.
 * 1. Place GTC limit order at signal price (non-blocking).
 * 2. Wait GTC_FALLBACK_REST_MS, then check status.
 * 3. If MATCHED → FILLED. If LIVE → cancel, mark SKIPPED.
 *
 * Fire-and-forget — caller returns immediately after invoking this.
 */
export function scheduleGtcFallbackPoll(ctx: GtcFallbackContext): void {
  if (ctx.isPaper) {
    prisma.copyTrade.update({
      where: { id: ctx.copyTradeId },
      data: { status: 'SKIPPED', failReason: 'GTC fallback: paper trade (no CLOB order)' },
    }).catch(() => {});
    return;
  }

  placeAndPollGtc(ctx).catch((err) => {
    log.error('GTC fallback: unhandled error', { copyTradeId: ctx.copyTradeId, error: err.message });
    // Leave PENDING for reconcileStalePending() safety net
  });
}

async function placeAndPollGtc(ctx: GtcFallbackContext): Promise<void> {
  const client = getClient();
  if (!client) {
    log.warn('GTC fallback: CLOB client unavailable', { copyTradeId: ctx.copyTradeId });
    await markGtcSkipped(ctx.copyTradeId, 'GTC fallback: CLOB client unavailable', ctx.allocationId);
    return;
  }

  // ── Phase 1: Place GTC limit order at signal price ──
  let gtcOrderId: string | undefined;
  try {
    const { tickSize, negRisk } = await getMarketMetadata(ctx.tokenId);
    // GTC rests at signal price (detectedPrice), NOT the FAK bump price.
    // A resting BUY at signal price is fair value — no overpay to incoming sellers.
    const limitPrice = ctx.detectedPrice;
    const shares = ctx.amountUsd / limitPrice;

    const gtcResponse = await client.createAndPostOrder(
      {
        tokenID: ctx.tokenId,
        price: limitPrice,
        size: shares,
        side: Side.BUY,
      },
      { tickSize, negRisk },
      OrderType.GTC,
    );

    gtcOrderId = gtcResponse?.orderID;
    if (!gtcOrderId) {
      log.warn('GTC fallback: no orderId returned', { copyTradeId: ctx.copyTradeId });
      await markGtcSkipped(ctx.copyTradeId, 'GTC fallback: no orderId returned from CLOB', ctx.allocationId);
      return;
    }

    // Update CopyTrade with the real GTC orderId (replaces the FAK orderId placeholder)
    await prisma.copyTrade.update({
      where: { id: ctx.copyTradeId },
      data: { orderId: gtcOrderId },
    });

    log.info('GTC fallback: resting limit order placed', {
      copyTradeId: ctx.copyTradeId, gtcOrderId,
      shares: shares.toFixed(4), limitPrice,
      tokenId: ctx.tokenId.slice(0, 20), restMs: config.GTC_FALLBACK_REST_MS,
    });
  } catch (err: any) {
    log.warn('GTC fallback: failed to place GTC order', {
      copyTradeId: ctx.copyTradeId, error: err.message,
    });
    await markGtcSkipped(ctx.copyTradeId, `GTC fallback: placement failed — ${err.message}`, ctx.allocationId);
    return;
  }

  // ── Phase 2: Wait REST_MS then resolve ──
  await new Promise(resolve => setTimeout(resolve, config.GTC_FALLBACK_REST_MS));
  await resolveGtcFallback(ctx.copyTradeId, gtcOrderId, ctx.allocationId);
}

async function resolveGtcFallback(
  copyTradeId: string, orderId: string, allocationId: string,
): Promise<void> {
  const record = await prisma.copyTrade.findUnique({
    where: { id: copyTradeId },
    select: { status: true },
  });
  if (!record || record.status !== 'PENDING') return; // already resolved

  const client = getClient();
  if (!client) {
    log.warn('GTC fallback: CLOB client unavailable for resolve', { copyTradeId });
    return; // leave PENDING for reconcileStalePending()
  }

  const order = await client.getOrder(orderId);
  const clobStatus = order?.status ?? 'unknown';

  if (clobStatus === 'MATCHED') {
    const sizeMatched = parseFloat(order.size_matched || '0');
    const orderPrice = parseFloat(order.price || '0');
    if (sizeMatched > 0 && orderPrice > 0 && orderPrice <= 1.0) {
      await prisma.copyTrade.update({
        where: { id: copyTradeId },
        data: {
          status: 'FILLED',
          filledSize: sizeMatched,
          filledPrice: orderPrice,
          requestedAmount: sizeMatched * orderPrice,
          estimatedFee: 0, // GTC fills are maker orders — 0% fee on Polymarket
          failReason: `[gtc-fallback-filled] restMs=${config.GTC_FALLBACK_REST_MS}`,
          filledAt: new Date(),
          executionMethod: 'GTC',
        },
      });
      log.info('GTC fallback: FILLED', {
        copyTradeId, orderId, sizeMatched, orderPrice,
        estimatedFee: 0,
        restMs: config.GTC_FALLBACK_REST_MS,
      });
      await correctCapital(allocationId);
      return;
    }
  }

  // Not filled — cancel the resting order
  if (clobStatus === 'LIVE' || clobStatus === 'DELAYED') {
    try {
      await client.cancelOrder({ orderID: orderId });
      log.info('GTC fallback: cancelled unfilled order', { copyTradeId, orderId });
    } catch (err: any) {
      log.warn('GTC fallback: cancel failed (reconciler will clean up)', {
        orderId, error: err.message,
      });
    }
  }

  await markGtcSkipped(
    copyTradeId,
    `GTC fallback: unfilled after ${config.GTC_FALLBACK_REST_MS}ms, cancelled (CLOB status=${clobStatus})`,
    allocationId,
  );
}

async function markGtcSkipped(copyTradeId: string, reason: string, allocationId?: string): Promise<void> {
  try {
    await prisma.copyTrade.update({
      where: { id: copyTradeId },
      data: { status: 'SKIPPED', failReason: reason },
    });
    // Release reserved capital immediately (don't wait for next audit cycle)
    if (allocationId) {
      await correctCapital(allocationId);
    }
  } catch (err) {
    log.error('GTC fallback: failed to mark SKIPPED', { copyTradeId, error: (err as Error).message });
  }
}
