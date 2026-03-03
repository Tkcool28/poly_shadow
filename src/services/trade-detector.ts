import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { getTrades } from '../api/data-api';
import type { RtdsTradePayload } from './ws-trade-stream';

// ─── Trade table sync helper ───

async function upsertToTradeTable(data: {
  proxyWallet: string;
  side: string;
  asset: string;
  conditionId: string;
  size: number;
  price: number;
  outcome: string;
  transactionHash: string;
  timestamp: number;
  title?: string | null;
  eventSlug?: string | null;
}): Promise<void> {
  try {
    await prisma.trade.upsert({
      where: {
        transactionHash_proxyWallet_asset_side_size_price: {
          transactionHash: data.transactionHash,
          proxyWallet: data.proxyWallet,
          asset: data.asset,
          side: data.side,
          size: data.size,
          price: data.price,
        },
      },
      create: {
        proxyWallet: data.proxyWallet,
        side: data.side,
        asset: data.asset,
        conditionId: data.conditionId,
        size: data.size,
        price: data.price,
        outcome: data.outcome,
        outcomeIndex: null,
        timestamp: data.timestamp,
        transactionHash: data.transactionHash,
        title: data.title ?? null,
        eventSlug: data.eventSlug ?? null,
        usdValue: data.size * data.price,
      },
      update: {}, // no-op on conflict
    });
  } catch (err: any) {
    // P2002 = unique constraint: trade already in table from backfill, safe to skip
    if (err.code !== 'P2002') {
      logger.warn(`Failed to sync trade to Trade table: ${err.message}`, {
        txHash: data.transactionHash.slice(0, 16),
        proxyWallet: data.proxyWallet.slice(0, 10),
      });
    }
  }
}

// ─── In-memory caches for WebSocket real-time path ───
// Tracks ALL completed traders for WS filtering.
// Polling fallback in detectNewTrades() uses isMonitored (= all COMPLETED traders).

let trackedWallets: Set<string> = new Set();
let liveAllocationWallets: Set<string> = new Set();
let scoreCache: Map<string, number> = new Map(); // proxyWallet → compositeScore
let userNameCache: Map<string, string | null> = new Map();
let cacheRefreshTimer: ReturnType<typeof setInterval> | null = null;

export async function refreshTrackedWallets(): Promise<void> {
  const traders = await prisma.trader.findMany({
    where: { backfillStatus: 'COMPLETED' },
    select: {
      proxyWallet: true,
      userName: true,
      scores: { select: { compositeScore: true }, take: 1 },
    },
  });

  const wallets = new Set<string>();
  const scores = new Map<string, number>();
  const names = new Map<string, string | null>();

  for (const t of traders) {
    const wallet = t.proxyWallet.toLowerCase();
    wallets.add(wallet);
    names.set(wallet, t.userName);
    if (t.scores[0]) {
      scores.set(wallet, t.scores[0].compositeScore);
    }
  }

  trackedWallets = wallets;
  scoreCache = scores;
  userNameCache = names;
  logger.debug(`Refreshed tracked wallets cache: ${wallets.size} wallets (all COMPLETED traders)`);

  // Also refresh live-allocation wallet set for ChainTradeWatcher
  const liveAllocs = await prisma.followAllocation.findMany({
    where: { isPaper: false, isActive: true },
    select: { proxyWallet: true },
  });
  liveAllocationWallets = new Set(liveAllocs.map(a => a.proxyWallet.toLowerCase()));
}

export async function startCacheRefresh(intervalMs = 60000): Promise<void> {
  if (cacheRefreshTimer) return;
  await refreshTrackedWallets();
  cacheRefreshTimer = setInterval(() => refreshTrackedWallets(), intervalMs);
}

export function stopCacheRefresh(): void {
  if (cacheRefreshTimer) {
    clearInterval(cacheRefreshTimer);
    cacheRefreshTimer = null;
  }
}

/** Returns the live-allocation wallet set (~7 wallets) — used by ChainTradeWatcher */
export function getLiveAllocationWallets(): Set<string> {
  return liveAllocationWallets;
}

/**
 * Handle a real-time trade from the RTDS WebSocket.
 * Returns true if the trade was inserted (new detection), false if skipped/duplicate.
 */
export async function handleRealtimeTrade(payload: RtdsTradePayload): Promise<boolean> {
  const normalizedWallet = payload.proxyWallet.toLowerCase();
  if (!trackedWallets.has(normalizedWallet)) {
    logger.debug('WS trade from untracked wallet', { wallet: payload.proxyWallet.slice(0, 10) });
    return false;
  }

  const compositeScore = scoreCache.get(normalizedWallet) ?? null;
  const userName = userNameCache.get(normalizedWallet) ?? payload.name ?? null;

  try {
    await prisma.detectedTrade.create({
      data: {
        proxyWallet: normalizedWallet,
        userName,
        side: payload.side,
        conditionId: payload.conditionId,
        asset: payload.asset,
        size: parseFloat(payload.size),
        price: parseFloat(payload.price),
        outcome: payload.outcome,
        title: payload.title ?? null,
        eventSlug: payload.eventSlug ?? null,
        transactionHash: payload.transactionHash,
        timestamp: payload.timestamp,
        compositeScore,
      },
    });

    // Dual-write to Trade table for scoring freshness (fire-and-forget)
    void upsertToTradeTable({
      proxyWallet: normalizedWallet,
      side: payload.side,
      asset: payload.asset,
      conditionId: payload.conditionId,
      size: parseFloat(payload.size),
      price: parseFloat(payload.price),
      outcome: payload.outcome,
      transactionHash: payload.transactionHash,
      timestamp: payload.timestamp,
      title: payload.title ?? null,
      eventSlug: payload.eventSlug ?? null,
    });

    const usdValue = (parseFloat(payload.size) * parseFloat(payload.price)).toFixed(2);
    const latencyMs = Date.now() - payload.timestamp * 1000;
    logger.info(`NEW TRADE DETECTED (WS)`, {
      trader: payload.proxyWallet.slice(0, 10),
      userName,
      side: payload.side,
      outcome: payload.outcome,
      title: payload.title?.slice(0, 50),
      usdValue: `$${usdValue}`,
      price: parseFloat(payload.price),
      compositeScore,
      latencyMs,
    });

    return true;
  } catch (err: any) {
    // Skip duplicate constraint violations
    if (err.code === 'P2002') return false;
    throw err;
  }
}

// ─── Polling-based detection (existing) ───

export async function detectNewTrades(): Promise<number> {
  // Get monitored traders
  const traders = await prisma.trader.findMany({
    where: { isMonitored: true },
    select: {
      proxyWallet: true,
      userName: true,
      lastTradeSync: true,
      scores: { select: { compositeScore: true }, take: 1 },
    },
  });

  if (traders.length === 0) {
    logger.debug('No monitored traders to check');
    return 0;
  }

  logger.info(`Checking ${traders.length} monitored traders for new trades`);

  let totalDetected = 0;

  for (const trader of traders) {
    try {
      const detected = await checkTraderForNewTrades(
        trader.proxyWallet,
        trader.userName,
        trader.lastTradeSync,
        trader.scores[0]?.compositeScore ?? null,
      );
      totalDetected += detected;
    } catch (err: any) {
      logger.warn(
        `Failed to check trades for ${trader.proxyWallet.slice(0, 10)}: ${err.message}`,
      );
    }
  }

  return totalDetected;
}

async function checkTraderForNewTrades(
  proxyWallet: string,
  userName: string | null,
  lastSync: Date | null,
  compositeScore: number | null,
  logSuffix = '',
): Promise<number> {
  // Fetch recent trades (limit 100 should be enough for a 2-min window)
  const recentTrades = await getTrades({
    user: proxyWallet,
    limit: 100,
  });

  if (recentTrades.length === 0) return 0;

  // If lastSync is null (first monitor run), initialize to now and skip.
  // This avoids flooding DetectedTrade with the trader's entire history.
  if (!lastSync) {
    const maxTimestamp = Math.max(...recentTrades.map(t => t.timestamp));
    await prisma.trader.update({
      where: { proxyWallet },
      data: { lastTradeSync: new Date(maxTimestamp * 1000) },
    });
    logger.info(`Initialized lastTradeSync for ${proxyWallet.slice(0, 10)}, skipping historical trades`);
    return 0;
  }

  // Filter to only trades after lastSync
  const lastSyncEpoch = Math.floor(lastSync.getTime() / 1000);
  const newTrades = recentTrades.filter(t => t.timestamp > lastSyncEpoch);

  if (newTrades.length === 0) return 0;

  // Insert detected trades (skip duplicates via unique constraint)
  let insertedCount = 0;
  for (const trade of newTrades) {
    try {
      await prisma.detectedTrade.create({
        data: {
          proxyWallet,
          userName,
          side: trade.side,
          conditionId: trade.conditionId,
          asset: trade.asset,
          size: trade.size,
          price: trade.price,
          outcome: trade.outcome,
          title: trade.title ?? null,
          eventSlug: trade.eventSlug ?? null,
          transactionHash: trade.transactionHash,
          timestamp: trade.timestamp,
          compositeScore,
        },
      });
      insertedCount++;

      // Dual-write to Trade table for scoring freshness (fire-and-forget)
      void upsertToTradeTable({
        proxyWallet,
        side: trade.side,
        asset: trade.asset,
        conditionId: trade.conditionId,
        size: trade.size,
        price: trade.price,
        outcome: trade.outcome,
        transactionHash: trade.transactionHash,
        timestamp: trade.timestamp,
        title: trade.title ?? null,
        eventSlug: trade.eventSlug ?? null,
      });

      // Log the detected trade
      const usdValue = (trade.size * trade.price).toFixed(2);
      logger.info(`NEW TRADE DETECTED${logSuffix}`, {
        trader: proxyWallet.slice(0, 10),
        userName,
        side: trade.side,
        outcome: trade.outcome,
        title: trade.title?.slice(0, 50),
        usdValue: `$${usdValue}`,
        price: trade.price,
        compositeScore,
      });
    } catch (err: any) {
      // Skip duplicate constraint violations
      if (err.code === 'P2002') continue;
      throw err;
    }
  }

  // Update lastTradeSync to the most recent trade timestamp
  const maxTimestamp = Math.max(...newTrades.map(t => t.timestamp));
  await prisma.trader.update({
    where: { proxyWallet },
    data: { lastTradeSync: new Date(maxTimestamp * 1000) },
  });

  if (insertedCount > 0) {
    logger.info(
      `Detected ${insertedCount} new trades from ${proxyWallet.slice(0, 10)} (${userName ?? 'unknown'})`,
    );
  }

  return insertedCount;
}

/**
 * Immediately check a single live-allocation wallet for new trades.
 * Called by ChainTradeWatcher on Polygon OrderFilled event (hot path).
 * Uses case-insensitive lookup: chain events produce lowercase addresses;
 * DB may store EIP-55 checksummed values.
 */
export async function detectLiveTradeForWallet(proxyWallet: string): Promise<number> {
  const trader = await prisma.trader.findFirst({
    where: { proxyWallet: { equals: proxyWallet, mode: 'insensitive' } },
    select: {
      proxyWallet: true,
      userName: true,
      lastTradeSync: true,
      scores: { select: { compositeScore: true }, take: 1 },
    },
  });
  if (!trader) return 0;
  return checkTraderForNewTrades(
    trader.proxyWallet,
    trader.userName,
    trader.lastTradeSync,
    trader.scores[0]?.compositeScore ?? null,
    ' (CHAIN)',
  );
}

/**
 * Fast-poll detection for all live-allocation traders.
 * Backup for ChainTradeWatcher — runs every LIVE_TRADERS_POLL_MS (10s).
 */
export async function detectLiveTrades(): Promise<number> {
  const liveAllocations = await prisma.followAllocation.findMany({
    where: { isPaper: false, isActive: true },
    select: { proxyWallet: true },
  });
  if (liveAllocations.length === 0) return 0;

  const wallets = liveAllocations.map(a => a.proxyWallet);
  const traders = await prisma.trader.findMany({
    where: { proxyWallet: { in: wallets } },
    select: {
      proxyWallet: true,
      userName: true,
      lastTradeSync: true,
      scores: { select: { compositeScore: true }, take: 1 },
    },
  });
  if (traders.length === 0) return 0;

  const results = await Promise.all(
    traders.map(t =>
      checkTraderForNewTrades(
        t.proxyWallet, t.userName, t.lastTradeSync,
        t.scores[0]?.compositeScore ?? null, ' (LIVE)',
      ).catch((err: any) => {
        logger.warn(`Live poll: failed for ${t.proxyWallet.slice(0, 10)}: ${err.message}`);
        return 0;
      }),
    ),
  );
  return results.reduce((sum, n) => sum + n, 0);
}
