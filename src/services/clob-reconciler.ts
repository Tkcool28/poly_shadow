import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { getClient } from './trade-executor';

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
              await tx.followAllocation.update({
                where: { id: record.followAllocationId! },
                data: {
                  currentCapital: { increment: usdValue },
                  deployedCapital: { decrement: Math.min(usdValue, fresh.deployedCapital) },
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
