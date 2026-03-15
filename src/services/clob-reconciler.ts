import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getClient } from './trade-executor';
import { computeSellCostBasis } from '../lib/cost-basis';
import { auditAllocation } from '../lib/capital-audit';
import { getOrCreateMutex } from '../lib/allocation-mutex';

const log = createJobLogger('clob-reconciler');

export async function reconcileStalePending(): Promise<void> {
  const stalePending = await prisma.copyTrade.findMany({
    where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60000) } },
  });

  if (stalePending.length === 0) return;

  const client = getClient();

  for (const record of stalePending) {
    // Paper trades: no CLOB to check — mark FAILED
    if (record.isPaper) {
      await prisma.copyTrade.update({
        where: { id: record.id },
        data: { status: 'FAILED', failReason: 'process restart: paper trade abandoned' },
      });
      continue;
    }

    // Live trade without orderId: never reached CLOB — mark FAILED
    if (!record.orderId) {
      await prisma.copyTrade.update({
        where: { id: record.id },
        data: { status: 'FAILED', failReason: 'process restart: order never placed (no orderId)' },
      });
      continue;
    }

    // Live trade with orderId: query CLOB for actual status
    if (!client) {
      log.error('Cannot reconcile live PENDING record — CLOB client unavailable', {
        id: record.id, orderId: record.orderId,
      });
      await prisma.copyTrade.update({
        where: { id: record.id },
        data: { status: 'FAILED', failReason: 'process restart: CLOB unavailable for reconciliation — MANUAL CHECK REQUIRED' },
      });
      continue;
    }

    try {
      const order = await client.getOrder(record.orderId);

      if (order?.status === 'MATCHED') {
        // Order filled on CLOB — update our record
        const sizeMatched = parseFloat(order.size_matched || '0');
        const price = parseFloat(order.price || '0');

        await prisma.copyTrade.update({
          where: { id: record.id },
          data: {
            status: 'FILLED',
            filledSize: sizeMatched > 0 ? sizeMatched : null,
            filledPrice: price > 0 ? price : null,
            failReason: null,
            latencyMs: Date.now() - record.createdAt.getTime(),
            filledAt: new Date(),
          },
        });

        // Capital accounting for reconciled fill
        if (sizeMatched > 0 && price > 0 && record.followAllocationId) {
          const usdValue = sizeMatched * price;
          await prisma.$transaction(async (tx) => {
            const fresh = await tx.followAllocation.findUniqueOrThrow({
              where: { id: record.followAllocationId! },
            });
            if (record.side === 'BUY') {
              const safeDecrement = Math.min(usdValue, Math.max(fresh.currentCapital, 0));
              await tx.followAllocation.update({
                where: { id: record.followAllocationId! },
                data: {
                  currentCapital: { decrement: safeDecrement },
                  deployedCapital: { increment: safeDecrement },
                },
              });
            } else {
              // SELL: release cost basis (not proceeds) from deployedCapital
              const costBasisFills = await tx.copyTrade.findMany({
                where: {
                  tokenId: record.tokenId,
                  followAllocationId: record.followAllocationId!,
                  isPaper: record.isPaper,
                  status: 'FILLED',
                  id: { not: record.id }, // exclude current SELL (already updated to FILLED above)
                },
                select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
              });
              const costBasis = computeSellCostBasis(costBasisFills, sizeMatched);

              await tx.followAllocation.update({
                where: { id: record.followAllocationId! },
                data: {
                  currentCapital: { increment: usdValue },
                  deployedCapital: { decrement: Math.min(costBasis.costBasisOfSoldShares, fresh.deployedCapital) },
                },
              });
            }
          });
        }

        log.info('Reconciled stale PENDING → FILLED', {
          id: record.id, orderId: record.orderId, sizeMatched, price,
        });
      } else if (order?.status === 'LIVE' || order?.status === 'DELAYED') {
        // Order still open — cancel it and mark FAILED
        try {
          await client.cancelOrder({ orderID: record.orderId });
        } catch (cancelErr: any) {
          log.warn(`Failed to cancel stale order: ${cancelErr.message}`, { orderId: record.orderId });
        }
        await prisma.copyTrade.update({
          where: { id: record.id },
          data: { status: 'FAILED', failReason: `process restart: stale ${order.status} order cancelled` },
        });
        log.info('Reconciled stale PENDING → FAILED (cancelled)', {
          id: record.id, orderId: record.orderId, clobStatus: order.status,
        });
      } else {
        // CANCELLED or unknown status
        await prisma.copyTrade.update({
          where: { id: record.id },
          data: { status: 'FAILED', failReason: `process restart: CLOB status=${order?.status ?? 'unknown'}` },
        });
        log.info('Reconciled stale PENDING → FAILED', {
          id: record.id, orderId: record.orderId, clobStatus: order?.status,
        });
      }
    } catch (err: any) {
      log.error(`CLOB reconciliation failed for order ${record.orderId}: ${err.message}`);
      await prisma.copyTrade.update({
        where: { id: record.id },
        data: { status: 'FAILED', failReason: `reconciliation error: ${err.message?.slice(0, 200)}` },
      });
    }
  }

  log.info(`Reconciled ${stalePending.length} stale PENDING records`);
}

/**
 * Recover SKIPPED FAK trades that actually filled on-chain (ghost fills).
 * The CLOB API can return success with zero amounts while the order fills asynchronously.
 * Checks SKIPPED trades with orderId via getOrder(), recovers confirmed fills,
 * then replays capital via auditAllocation() under mutex.
 */
export async function reconcileSkippedGhostFills(): Promise<void> {
  const skippedWithOrderId = await prisma.copyTrade.findMany({
    where: {
      status: 'SKIPPED',
      orderId: { not: null },
      OR: [
        { failReason: { contains: 'FAK unmatched' } },
        { failReason: { contains: 'GTC fallback: unfilled' } },
        { failReason: { contains: 'GTC fallback: placement failed' } },
      ],
      isPaper: false,
      createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
    },
  });

  if (skippedWithOrderId.length === 0) return;
  log.info(`Ghost fill reconciliation: checking ${skippedWithOrderId.length} SKIPPED FAK/GTC trades`);

  const client = getClient();
  if (!client) {
    log.warn('Ghost fill reconciliation: CLOB client unavailable');
    return;
  }

  let recovered = 0;
  const affectedAllocations = new Set<string>();

  for (const record of skippedWithOrderId) {
    try {
      const order = await client.getOrder(record.orderId!);

      if (order?.status === 'MATCHED') {
        const sizeMatched = parseFloat(order.size_matched || '0');
        const orderPrice = parseFloat(order.price || '0');

        // For SELL FAK, order.price is $0.01 (the limit floor) — use requestedPrice
        // (= detected market price at signal time, stored on every CopyTrade record).
        // For BUY FAK, order.price is the slippage-limited price — close to actual fill.
        const recoveredPrice = (record.side === 'SELL')
          ? record.requestedPrice
          : orderPrice;

        // Sanity: prediction market price must be in (0, 1.0]
        if (sizeMatched > 0 && recoveredPrice > 0 && recoveredPrice <= 1.0) {
          await prisma.copyTrade.update({
            where: { id: record.id },
            data: {
              status: 'FILLED',
              filledSize: sizeMatched,
              filledPrice: recoveredPrice,
              failReason: `[ghost-fill-recovered] original: SKIPPED ${record.failReason?.includes('GTC') ? 'GTC' : 'FAK'}, orderPrice=${orderPrice}`,
              filledAt: record.createdAt,
              requestedAmount: sizeMatched * recoveredPrice,
            },
          });

          recovered++;
          if (record.followAllocationId) {
            affectedAllocations.add(record.followAllocationId);
          }

          log.info('Ghost fill recovered', {
            id: record.id, orderId: record.orderId,
            sizeMatched, recoveredPrice, orderPrice, side: record.side,
            tokenId: record.tokenId.slice(0, 20),
          });
        } else {
          log.warn('Ghost fill: MATCHED but invalid price/size from CLOB', {
            orderId: record.orderId, sizeMatched, orderPrice, recoveredPrice,
          });
        }
      } else if (order?.status === 'LIVE' || order?.status === 'DELAYED') {
        // FAK orders should never be LIVE/DELAYED — defensively cancel
        try {
          await client.cancelOrder({ orderID: record.orderId! });
          log.warn('Ghost fill: cancelled stale FAK order on CLOB', {
            orderId: record.orderId, clobStatus: order.status,
          });
        } catch (cancelErr: any) {
          log.warn('Ghost fill: failed to cancel stale order', {
            orderId: record.orderId, error: cancelErr.message,
          });
        }
      } else {
        log.debug('Ghost fill check: not MATCHED on CLOB', {
          orderId: record.orderId,
          clobStatus: order?.status ?? 'null (order not found)',
        });
      }
    } catch (err: any) {
      log.warn('Ghost fill check failed for order', {
        id: record.id, orderId: record.orderId,
        error: err.message?.slice(0, 200),
      });
    }
  }

  // Replay capital for all affected allocations via auditAllocation() under mutex
  // (same pattern as cleanupPhantomPositions — capital-audit.ts:423-452)
  for (const allocId of affectedAllocations) {
    try {
      const mutex = getOrCreateMutex(allocId);
      await mutex.runExclusive(async () => {
        const audit = await auditAllocation(allocId);
        await prisma.followAllocation.update({
          where: { id: allocId },
          data: {
            currentCapital: audit.computedCC,
            deployedCapital: audit.computedDC,
          },
        });
        log.info('Ghost fill: capital corrected via replay', {
          allocationId: allocId,
          ccBefore: audit.actualCC.toFixed(2),
          ccAfter: audit.computedCC.toFixed(2),
          dcBefore: audit.actualDC.toFixed(2),
          dcAfter: audit.computedDC.toFixed(2),
        });
      });
    } catch (err: any) {
      log.error('Ghost fill: capital correction failed', {
        allocationId: allocId, error: err.message,
      });
    }
  }

  if (recovered > 0) {
    log.info(`Ghost fill reconciliation complete`, {
      recovered, allocationsFixed: affectedAllocations.size,
    });
  }
}
