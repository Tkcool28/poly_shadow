import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { executeMarketOrder as realExecute, isBalancePaused, CLOB_MIN_ORDER_USD } from './trade-executor';
import { executeMarketOrder as paperExecute } from './paper-executor';
import type { ExecuteOrderResult } from './trade-executor';

const log = createJobLogger('order-pool');

// ─── Types ───

type PoolKey = string; // "tokenId:side:followAllocationId"

interface PoolEntry {
  copyTradeId: string;
  amountUsd: number;
  price: number;
  addedAt: number; // Date.now() — each entry has its own FIFO timer
}

interface PoolBucket {
  entries: PoolEntry[];
  totalAmountUsd: number;
  tokenId: string;
  side: string;
  followAllocationId: string;
  isPaper: boolean;
}

interface DetectedTradeRow {
  id: string;
  proxyWallet: string;
  userName: string | null;
  side: string;
  asset: string;
  size: number;
  price: number;
  outcome: string;
  title: string | null;
}

// ─── Pool State ───

const pool = new Map<PoolKey, PoolBucket>();

function makeKey(tokenId: string, side: string, allocationId: string): PoolKey {
  return `${tokenId}:${side}:${allocationId}`;
}

// ─── Exports ───

export async function addToPool(
  trade: DetectedTradeRow,
  copyAmountUsd: number,
  allocation: { id: string; isPaper: boolean },
): Promise<void> {
  if (trade.side === 'SELL') return; // SELLs should never be pooled

  // 1. Create POOLED CopyTrade record (audit trail)
  let copyTradeId: string;
  try {
    const record = await prisma.copyTrade.create({
      data: {
        detectedTradeId: trade.id,
        tokenId: trade.asset,
        side: trade.side,
        requestedAmount: copyAmountUsd,
        requestedPrice: trade.price,
        status: 'POOLED',
        isPaper: allocation.isPaper,
        followAllocationId: allocation.id,
        latencyMs: 0,
      },
    });
    copyTradeId = record.id;
  } catch (err: any) {
    if (err.code === 'P2002') return; // duplicate detectedTradeId — already processed
    throw err;
  }

  // 2. Reserve capital for BUY (prevent over-commitment)
  if (trade.side === 'BUY') {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.followAllocation.findUniqueOrThrow({
          where: { id: allocation.id },
        });
        if (fresh.currentCapital < copyAmountUsd) {
          throw new Error('insufficient capital for pool reservation');
        }
        await tx.followAllocation.update({
          where: { id: allocation.id },
          data: { currentCapital: { decrement: copyAmountUsd } },
        });
      });
    } catch (err: any) {
      // Clean up the POOLED record we just created
      await prisma.copyTrade.update({
        where: { id: copyTradeId },
        data: { status: 'SKIPPED', failReason: `pool reservation failed: ${err.message}` },
      });
      log.debug('Pool entry skipped: insufficient capital', {
        amount: copyAmountUsd.toFixed(4), tokenId: trade.asset.slice(0, 20),
      });
      return;
    }
  }

  // 3. Add to in-memory bucket
  const key = makeKey(trade.asset, trade.side, allocation.id);
  let bucket = pool.get(key);
  if (!bucket) {
    bucket = {
      entries: [],
      totalAmountUsd: 0,
      tokenId: trade.asset,
      side: trade.side,
      followAllocationId: allocation.id,
      isPaper: allocation.isPaper,
    };
    pool.set(key, bucket);
  }

  bucket.entries.push({
    copyTradeId,
    amountUsd: copyAmountUsd,
    price: trade.price,
    addedAt: Date.now(),
  });
  bucket.totalAmountUsd += copyAmountUsd;

  log.info('POOLED trade', {
    trader: trade.proxyWallet.slice(0, 10),
    side: trade.side,
    amount: copyAmountUsd.toFixed(4),
    poolTotal: bucket.totalAmountUsd.toFixed(4),
    poolSize: bucket.entries.length,
    title: trade.title?.slice(0, 50),
  });

  // 4. Fire immediately if threshold reached
  if (bucket.totalAmountUsd >= config.POOL_MIN_AMOUNT_USD) {
    await fireBucket(bucket);
    pool.delete(key);
  }
}

export async function sweepPool(): Promise<void> {
  const now = Date.now();
  const keysToDelete: PoolKey[] = [];

  for (const [key, bucket] of pool) {
    // Walk entries oldest-first, burn expired ones
    let i = 0;
    while (i < bucket.entries.length) {
      const entry = bucket.entries[i];
      if (now - entry.addedAt >= config.POOL_BURN_TIMEOUT_MS) {
        await burnEntry(entry, bucket);
        bucket.entries.splice(i, 1);
        // don't increment i — next entry shifts into position
      } else {
        // Entries are FIFO-ordered; once we hit a non-expired one, all later are newer
        break;
      }
    }

    if (bucket.entries.length === 0) {
      keysToDelete.push(key);
    }
  }

  for (const key of keysToDelete) {
    pool.delete(key);
  }
}

export async function rehydratePool(): Promise<void> {
  const pooledRecords = await prisma.copyTrade.findMany({
    where: { status: 'POOLED' },
    orderBy: { createdAt: 'asc' },
  });

  if (pooledRecords.length === 0) {
    log.info('Pool rehydrated: 0 records across 0 buckets');
    return;
  }

  const now = Date.now();
  let burnedCount = 0;

  for (const record of pooledRecords) {
    const ageMs = now - record.createdAt.getTime();

    if (ageMs >= config.POOL_BURN_TIMEOUT_MS) {
      // Too old — burn immediately
      await prisma.copyTrade.update({
        where: { id: record.id },
        data: {
          status: 'SKIPPED',
          failReason: 'pool entry expired during process restart',
          latencyMs: ageMs,
        },
      });
      if (record.side === 'BUY' && record.followAllocationId) {
        await prisma.followAllocation.update({
          where: { id: record.followAllocationId },
          data: { currentCapital: { increment: record.requestedAmount } },
        });
      }
      burnedCount++;
      continue;
    }

    // Still valid — restore to in-memory pool
    if (!record.followAllocationId) continue;
    const key = makeKey(record.tokenId, record.side, record.followAllocationId);
    let bucket = pool.get(key);
    if (!bucket) {
      bucket = {
        entries: [],
        totalAmountUsd: 0,
        tokenId: record.tokenId,
        side: record.side,
        followAllocationId: record.followAllocationId,
        isPaper: record.isPaper,
      };
      pool.set(key, bucket);
    }

    bucket.entries.push({
      copyTradeId: record.id,
      amountUsd: record.requestedAmount,
      price: record.requestedPrice,
      addedAt: record.createdAt.getTime(),
    });
    bucket.totalAmountUsd += record.requestedAmount;
  }

  // Check if any rehydrated buckets now exceed threshold
  for (const [key, bucket] of pool) {
    if (bucket.totalAmountUsd >= config.POOL_MIN_AMOUNT_USD) {
      await fireBucket(bucket);
      pool.delete(key);
    }
  }

  log.info(`Pool rehydrated: ${pooledRecords.length} records (${burnedCount} burned, ${pool.size} buckets active)`);
}

// ─── Internal ───

async function fireBucket(bucket: PoolBucket): Promise<void> {
  const { entries, totalAmountUsd, tokenId, side, followAllocationId, isPaper } = bucket;

  // Use latest entry's price (most recent market state)
  const latestPrice = entries[entries.length - 1].price;

  // Live BUY: bump to CLOB minimum. Paper BUY: use signal amount as-is. SELL: shares.
  const executorAmount = (side === 'BUY' && !isPaper)
    ? Math.max(totalAmountUsd, CLOB_MIN_ORDER_USD)
    : side === 'BUY'
      ? totalAmountUsd
      : totalAmountUsd / latestPrice;

  // Reserve extra capital needed to reach CLOB minimum (live BUY only)
  const bumpAmount = (!isPaper && side === 'BUY')
    ? Math.max(0, executorAmount - totalAmountUsd)
    : 0;

  if (bumpAmount > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        const fresh = await tx.followAllocation.findUniqueOrThrow({
          where: { id: followAllocationId },
        });
        if (fresh.currentCapital < bumpAmount) {
          throw new Error(
            `need $${bumpAmount.toFixed(4)}, have $${fresh.currentCapital.toFixed(4)}`,
          );
        }
        await tx.followAllocation.update({
          where: { id: followAllocationId },
          data: { currentCapital: { decrement: bumpAmount } },
        });
      });
    } catch (err: any) {
      // Can't top-up to CLOB minimum — skip entire bucket, refund pool reservations
      await prisma.$transaction(async (tx) => {
        for (const entry of entries) {
          await tx.copyTrade.update({
            where: { id: entry.copyTradeId },
            data: {
              status: 'SKIPPED',
              failReason: `min-order bump: insufficient capital (${err.message})`,
              latencyMs: Date.now() - entry.addedAt,
            },
          });
        }
        await tx.followAllocation.update({
          where: { id: followAllocationId },
          data: { currentCapital: { increment: totalAmountUsd } },
        });
      });
      log.warn('POOL BUCKET SKIPPED: insufficient capital for CLOB min-order bump', {
        side,
        totalAmountUsd: totalAmountUsd.toFixed(4),
        bumpAmount: bumpAmount.toFixed(4),
        tokenId: tokenId.slice(0, 20) + '...',
      });
      return;
    }
  }

  const executeFn = isPaper ? paperExecute : realExecute;

  let result: ExecuteOrderResult;
  if (!isPaper && isBalancePaused()) {
    result = {
      orderId: null,
      status: 'FAILED',
      filledPrice: null,
      filledSize: null,
      failReason: 'live trading paused: insufficient wallet balance',
      transactionHashes: [],
    };
  } else {
    try {
      result = await executeFn({
        tokenId,
        side: side as 'BUY' | 'SELL',
        amount: executorAmount,
        detectedPrice: latestPrice,
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
  }

  await prisma.$transaction(async (tx) => {
    // Update all CopyTrade records in this bucket
    for (const entry of entries) {
      const proportion = entry.amountUsd / totalAmountUsd;
      const entryFilledSize = result.filledSize ? result.filledSize * proportion : null;

      let slippageBps: number | null = null;
      if (result.filledPrice && entry.price > 0) {
        slippageBps = Math.round(((result.filledPrice - entry.price) / entry.price) * 10000);
        if (side === 'SELL') slippageBps = -slippageBps;
      }

      await tx.copyTrade.update({
        where: { id: entry.copyTradeId },
        data: {
          orderId: result.orderId,
          status: result.status,
          filledPrice: result.filledPrice,
          filledSize: entryFilledSize,
          slippageBps,
          failReason: result.failReason,
          estimatedFee: result.estimatedFee ? result.estimatedFee * proportion : null,
          latencyMs: Date.now() - entry.addedAt,
          filledAt: result.status === 'FILLED' ? new Date() : null,
          // Update requestedAmount to bumped proportion so daily spend limit counts actual USD committed
          requestedAmount: executorAmount * proportion,
        },
      });
    }

    // Capital accounting
    if (result.status === 'FILLED') {
      // Use executorAmount as fallback (covers bumped amount if fill data is missing)
      const actualUsd = (result.filledSize && result.filledPrice)
        ? result.filledSize * result.filledPrice
        : executorAmount;

      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: followAllocationId },
      });

      if (side === 'BUY') {
        // Capital was already reserved (pool + bump). Adjust for fill vs reserved difference.
        const overReserved = executorAmount - actualUsd;
        await tx.followAllocation.update({
          where: { id: followAllocationId },
          data: {
            currentCapital: { increment: overReserved },
            deployedCapital: { increment: actualUsd },
          },
        });
      } else {
        await tx.followAllocation.update({
          where: { id: followAllocationId },
          data: {
            currentCapital: { increment: actualUsd },
            deployedCapital: { decrement: Math.min(actualUsd, fresh.deployedCapital) },
          },
        });
      }
    } else {
      // FAILED/SKIPPED: refund full reserved BUY capital (pool + any bump already deducted)
      if (side === 'BUY') {
        await tx.followAllocation.update({
          where: { id: followAllocationId },
          data: { currentCapital: { increment: executorAmount } },
        });
      }
    }
  });

  log.info(`POOL FIRED [${isPaper ? 'PAPER' : 'LIVE'}]`, {
    status: result.status,
    side,
    entries: entries.length,
    totalAmountUsd: totalAmountUsd.toFixed(4),
    executorAmount: executorAmount.toFixed(4),
    bumpAmount: bumpAmount > 0 ? bumpAmount.toFixed(4) : undefined,
    filledPrice: result.filledPrice,
    filledSize: result.filledSize,
    tokenId: tokenId.slice(0, 20) + '...',
  });
}

async function burnEntry(entry: PoolEntry, bucket: PoolBucket): Promise<void> {
  await prisma.copyTrade.update({
    where: { id: entry.copyTradeId },
    data: {
      status: 'SKIPPED',
      failReason: `pool entry expired after ${config.POOL_BURN_TIMEOUT_MS / 1000}s`,
      latencyMs: Date.now() - entry.addedAt,
    },
  });

  // Refund reserved capital for BUY
  if (bucket.side === 'BUY') {
    await prisma.followAllocation.update({
      where: { id: bucket.followAllocationId },
      data: { currentCapital: { increment: entry.amountUsd } },
    });
  }

  bucket.totalAmountUsd -= entry.amountUsd;

  log.info('POOL ENTRY BURNED', {
    side: bucket.side,
    burnedAmount: entry.amountUsd.toFixed(4),
    remaining: bucket.totalAmountUsd.toFixed(4),
    remainingEntries: bucket.entries.length - 1, // entry not yet spliced at this point
    tokenId: bucket.tokenId.slice(0, 20) + '...',
  });
}
