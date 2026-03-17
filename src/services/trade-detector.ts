import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { config } from '../config/env';
import { getTrades } from '../api/data-api';
import { ClobClient } from '@polymarket/clob-client';
import type { RtdsTradePayload } from './ws-trade-stream';
import type { ChainTradeData } from './chain-trade-watcher';
import { recordDetection } from './detection-race-tracker';

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
let liveAllocationWallets: Set<string> = new Set(); // For RAPID_POLL: excludes copyMakerFills
let chainWatcherWallets: Set<string> = new Set();   // For ChainTradeWatcher: ALL live allocations
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

  // Refresh live-allocation wallet sets:
  // 1. RAPID_POLL: excludes copyMakerFills wallets (they use CHAIN_MAKER, no need for redundant polling)
  const rapidPollAllocs = await prisma.followAllocation.findMany({
    where: { isPaper: false, isActive: true, copyMakerFills: { not: true } },
    select: { proxyWallet: true },
  });
  liveAllocationWallets = new Set(rapidPollAllocs.map(a => a.proxyWallet.toLowerCase()));

  // 2. ChainTradeWatcher: ALL live allocations (chain events are the primary detection for copyMakerFills)
  const allLiveAllocs = await prisma.followAllocation.findMany({
    where: { isPaper: false, isActive: true },
    select: { proxyWallet: true },
  });
  chainWatcherWallets = new Set(allLiveAllocs.map(a => a.proxyWallet.toLowerCase()));
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

/** Returns the RAPID_POLL wallet set (excludes copyMakerFills) */
export function getLiveAllocationWallets(): Set<string> {
  return liveAllocationWallets;
}

/** Returns ALL live-allocation wallets — used by ChainTradeWatcher */
export function getChainWatcherWallets(): Set<string> {
  return chainWatcherWallets;
}

// ─── On-chain trade detection (ChainTradeWatcher path) ───

// Read-only CLOB client for metadata lookups (no signer needed)
// Pattern matches arb-executor.ts:39
const readOnlyClobClient = new ClobClient('https://clob.polymarket.com', 137);

// In-memory cache: tokenId → { conditionId, outcome, eventSlug, question }
const tokenMetadataCache = new Map<string, {
  conditionId: string; outcome: string;
  eventSlug: string | null; question: string | null;
}>();

async function resolveTokenMetadata(
  tokenId: string,
): Promise<{ conditionId: string; outcome: string; eventSlug: string | null; question: string | null }> {
  // 1. In-memory cache
  const cached = tokenMetadataCache.get(tokenId);
  if (cached) return cached;

  // 2. DB: check DetectedTrade table for prior records with this tokenId
  const existing = await prisma.detectedTrade.findFirst({
    where: { asset: tokenId },
    select: { conditionId: true, outcome: true, eventSlug: true, title: true },
  });
  if (existing) {
    let eventSlug = existing.eventSlug;
    let question = existing.title;

    // If this record lacks metadata (CHAIN-source), check siblings with same conditionId
    // that came from POLL source and DO have eventSlug populated
    if (eventSlug == null) {
      const sibling = await prisma.detectedTrade.findFirst({
        where: { conditionId: existing.conditionId, eventSlug: { not: null } },
        select: { eventSlug: true, title: true },
      });
      if (sibling) {
        eventSlug = sibling.eventSlug;
        question = sibling.title ?? question;
      }
    }

    const result = { conditionId: existing.conditionId, outcome: existing.outcome, eventSlug, question };
    // Only cache if metadata is populated; otherwise re-check on next call
    if (eventSlug != null) {
      tokenMetadataCache.set(tokenId, result);
    }
    return result;
  }

  // 3. CLOB API fallback: getOrderBook(tokenId).market = conditionId
  //    getMarket(conditionId).tokens[].outcome for outcome name
  //    Also extract market_slug (≈ eventSlug) and question (≈ title)
  const orderBook = await readOnlyClobClient.getOrderBook(tokenId);
  const conditionId = orderBook.market;
  if (!conditionId) {
    throw new Error(`getOrderBook returned no market for tokenId ${tokenId.slice(0, 16)}`);
  }
  const market = await readOnlyClobClient.getMarket(conditionId);
  const tokens: Array<{ token_id: string; outcome: string }> = market?.tokens ?? [];
  const tokenEntry = tokens.find((t) => t.token_id === tokenId);
  const outcome = tokenEntry?.outcome ?? 'Unknown';
  // CLOB API returns market_slug (not event_slug) — verified via curl
  const eventSlug: string | null = (market as any)?.market_slug ?? null;
  const question: string | null = (market as any)?.question ?? null;

  const result = { conditionId, outcome, eventSlug, question };
  tokenMetadataCache.set(tokenId, result);
  return result;
}

/**
 * Create a DetectedTrade directly from on-chain OrderFilled event data.
 * Called by ChainTradeWatcher callback — bypasses REST API entirely.
 * Returns true if inserted, false if duplicate.
 */
export async function createDetectedTradeFromChain(
  data: ChainTradeData,
): Promise<boolean> {
  const normalizedWallet = data.proxyWallet.toLowerCase();
  const { conditionId, outcome, eventSlug, question } = await resolveTokenMetadata(data.tokenId);
  if (eventSlug == null) {
    logger.debug(`Chain trade ${data.transactionHash?.slice(0, 10)}: eventSlug not resolved for conditionId ${conditionId.slice(0, 16)}`);
  }
  const compositeScore = scoreCache.get(normalizedWallet) ?? null;
  const userName = userNameCache.get(normalizedWallet) ?? null;
  const now = Math.floor(Date.now() / 1000);
  const blockTs = data.blockTimestamp;
  const timestamp = blockTs ?? now;
  const realTimestamp = blockTs ?? null;

  // Staleness warning (only when block time is known)
  if (blockTs && (now - blockTs) > 30) {
    logger.warn('Stale chain event: WS delivered late', {
      wallet: normalizedWallet.slice(0, 10),
      side: data.side,
      driftSeconds: now - blockTs,
      blockNumber: data.blockNumber,
      txHash: data.transactionHash.slice(0, 18),
    });
  }

  try {
    await prisma.detectedTrade.create({
      data: {
        proxyWallet: normalizedWallet,
        userName,
        side: data.side,
        conditionId,
        asset: data.tokenId,
        size: data.size,
        price: data.price,
        outcome,
        title: question ?? null,
        eventSlug: eventSlug ?? null,
        transactionHash: data.transactionHash,
        timestamp,
        realTimestamp,
        compositeScore,
        detectionSource: data.isMaker ? 'CHAIN_MAKER' : 'CHAIN',
      },
    });

    recordDetection(data.transactionHash, normalizedWallet, data.tokenId, data.isMaker ? 'CHAIN_MAKER' : 'CHAIN');

    // Dual-write to Trade table (fire-and-forget)
    void upsertToTradeTable({
      proxyWallet: normalizedWallet,
      side: data.side,
      asset: data.tokenId,
      conditionId,
      size: data.size,
      price: data.price,
      outcome,
      transactionHash: data.transactionHash,
      timestamp,
    });

    const usdValue = (data.size * data.price).toFixed(2);
    logger.info('NEW TRADE DETECTED (CHAIN)', {
      trader: normalizedWallet.slice(0, 10),
      userName,
      side: data.side,
      isMaker: data.isMaker,
      outcome,
      tokenId: data.tokenId.slice(0, 16),
      usdValue: `$${usdValue}`,
      price: data.price.toFixed(4),
      compositeScore,
      txHash: data.transactionHash.slice(0, 18),
      blockNumber: data.blockNumber,
      blockTimestamp: blockTs,
      signalAgeS: blockTs ? now - blockTs : null,
    });

    // Fire-and-forget: backfill realTimestamp from Data API (only on cache miss)
    if (!realTimestamp) {
      void (async () => {
        try {
          const trades = await getTrades({ user: normalizedWallet, limit: 20 });
          const match = trades.find(t => t.transactionHash === data.transactionHash);
          if (match) {
            await prisma.detectedTrade.updateMany({
              where: {
                transactionHash: data.transactionHash,
                proxyWallet: normalizedWallet,
                asset: data.tokenId,
              },
              data: { realTimestamp: match.timestamp },
            });
          }
        } catch (e) {
          logger.debug('realTimestamp backfill failed', { wallet: normalizedWallet.slice(0, 10), err: (e as Error).message });
        }
      })();
    }

    return true;
  } catch (err: any) {
    if (err.code === 'P2002') {
      recordDetection(data.transactionHash, normalizedWallet, data.tokenId, data.isMaker ? 'CHAIN_MAKER' : 'CHAIN');
      return false; // dedup: @@unique([transactionHash, proxyWallet, asset])
    }
    throw err;
  }
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
        realTimestamp: payload.timestamp,
        compositeScore,
        detectionSource: 'WS',
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

// ─── Rapid-poll primary signal source ───
// Polls all live-allocation wallets IN PARALLEL at high frequency.
// Source: RAPID_POLL — included in copy signal drain queries.

export async function detectRapidPollTrades(): Promise<number> {
  if (liveAllocationWallets.size === 0) return 0;
  const cycleStart = Date.now();

  // Batch-fetch lastTradeSync for all live wallets (1 query instead of N)
  const walletList = [...liveAllocationWallets];
  const traders = await prisma.trader.findMany({
    where: { proxyWallet: { in: walletList } },
    select: { proxyWallet: true, lastTradeSync: true },
  });
  const syncMap = new Map(traders.map(t => [t.proxyWallet, t.lastTradeSync]));

  // Fire all wallet checks in parallel with per-wallet timeout
  const results = await Promise.allSettled(
    walletList.map(async (wallet) => {
      if (!syncMap.has(wallet)) return 0; // wallet not in Trader table
      const lastSync = syncMap.get(wallet) ?? null;
      const score = scoreCache.get(wallet) ?? null;
      const name = userNameCache.get(wallet) ?? null;

      let timer: ReturnType<typeof setTimeout>;
      return Promise.race([
        checkTraderForNewTrades(wallet, name, lastSync, score, ' (RAPID_POLL)', 'RAPID_POLL'),
        new Promise<number>((_, reject) => {
          timer = setTimeout(() => reject(new Error('rapid poll timeout')), 5000);
        }),
      ]).finally(() => clearTimeout(timer));
    }),
  );

  let total = 0;
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'fulfilled') {
      total += r.value;
    } else {
      logger.warn(`Rapid poll failed for ${walletList[i].slice(0, 10)}: ${r.reason?.message}`);
    }
  }

  const cycleMs = Date.now() - cycleStart;
  if (total > 0 || cycleMs > 500) {
    logger.info('Rapid poll cycle', { cycleMs, wallets: walletList.length, detected: total });
  }

  return total;
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
  source: string = 'POLL',
): Promise<number> {
  const normalizedWallet = proxyWallet.toLowerCase();

  // Fetch recent trades
  const limit = source === 'RAPID_POLL' ? config.RAPID_POLL_LIMIT : 100;
  const recentTrades = await getTrades({
    user: proxyWallet,
    limit,
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
          proxyWallet: normalizedWallet,
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
          realTimestamp: trade.timestamp,
          compositeScore,
          detectionSource: source,
        },
      });
      insertedCount++;

      if (source === 'RAPID_POLL') {
        recordDetection(trade.transactionHash, normalizedWallet, trade.asset, source);
      }

      // Dual-write to Trade table for scoring freshness (fire-and-forget)
      void upsertToTradeTable({
        proxyWallet: normalizedWallet,
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
      if (err.code === 'P2002') {
        if (source === 'RAPID_POLL') {
          recordDetection(trade.transactionHash, normalizedWallet, trade.asset, source);
        }
        continue;
      }
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

