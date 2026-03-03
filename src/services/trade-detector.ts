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
    wallets.add(t.proxyWallet);
    names.set(t.proxyWallet, t.userName);
    if (t.scores[0]) {
      scores.set(t.proxyWallet, t.scores[0].compositeScore);
    }
  }

  trackedWallets = wallets;
  scoreCache = scores;
  userNameCache = names;
  logger.debug(`Refreshed tracked wallets cache: ${wallets.size} wallets (all COMPLETED traders)`);
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

/**
 * Handle a real-time trade from the RTDS WebSocket.
 * Returns true if the trade was inserted (new detection), false if skipped/duplicate.
 */
export async function handleRealtimeTrade(payload: RtdsTradePayload): Promise<boolean> {
  if (!trackedWallets.has(payload.proxyWallet)) return false;

  const compositeScore = scoreCache.get(payload.proxyWallet) ?? null;
  const userName = userNameCache.get(payload.proxyWallet) ?? payload.name ?? null;

  try {
    await prisma.detectedTrade.create({
      data: {
        proxyWallet: payload.proxyWallet,
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
      proxyWallet: payload.proxyWallet,
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
      logger.info(`NEW TRADE DETECTED`, {
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
