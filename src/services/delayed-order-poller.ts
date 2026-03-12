import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getClient } from './trade-executor';
import { auditAllocation } from '../lib/capital-audit';
import { getOrCreateMutex } from '../lib/allocation-mutex';

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
