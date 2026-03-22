/**
 * Unix Socket Bridge — IPC server for the Rust copier binary.
 *
 * Protocol: JSONL (newline-delimited JSON) over Unix domain socket.
 * Rust connects as client, Node.js listens as server.
 *
 * Inbound (Rust → Node.js):
 *   seed_request       → respond with full state from DB
 *   trade_detected     → upsert DetectedTrade record
 *   copy_trade_result  → upsert CopyTrade + update allocation capital
 *
 * Outbound (Node.js → Rust):
 *   allocation_updated / allocation_deactivated
 *   market_settled / market_closed
 *   position_reconciled / capital_reconciled
 *   balance_pause
 */

import * as net from 'net';
import * as fs from 'fs';
import { prisma } from '../lib/prisma.js';
import { createJobLogger } from '../lib/logger.js';
import { config } from '../config/env.js';
import type { ExecutionMethod } from '../../prisma/generated/prisma/client/client.js';

const log = createJobLogger('ipc-bridge');
const SOCKET_PATH = config.IPC_SOCKET_PATH;

let server: net.Server | null = null;
let activeConnection: net.Socket | null = null;

// ─── Public API ───

export function startBridge(): net.Server {
  // Remove stale socket file from previous run
  if (fs.existsSync(SOCKET_PATH)) {
    fs.unlinkSync(SOCKET_PATH);
  }

  // Ensure parent directory exists
  const dir = SOCKET_PATH.substring(0, SOCKET_PATH.lastIndexOf('/'));
  if (dir && !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  server = net.createServer((socket) => {
    log.info('Rust copier connected');
    activeConnection = socket;

    let buffer = '';
    socket.on('data', (data) => {
      buffer += data.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || ''; // keep incomplete line in buffer
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          handleMessage(socket, msg).catch((err) => {
            log.error('IPC message handler error', {
              error: err.message,
              type: msg?.type,
            });
          });
        } catch (err: any) {
          log.warn('IPC JSON parse error', {
            error: err.message,
            preview: line.slice(0, 100),
          });
        }
      }
    });

    socket.on('close', () => {
      log.warn('Rust copier disconnected');
      if (activeConnection === socket) {
        activeConnection = null;
      }
    });

    socket.on('error', (err) => {
      log.error('IPC socket error', { error: err.message });
      if (activeConnection === socket) {
        activeConnection = null;
      }
    });
  });

  server.listen(SOCKET_PATH, () => {
    // Set socket permissions (owner + group read/write)
    try {
      fs.chmodSync(SOCKET_PATH, 0o666);
    } catch {
      // Ignore — may not have permission in container
    }
    log.info('IPC bridge listening', { path: SOCKET_PATH });
  });

  server.on('error', (err) => {
    log.error('IPC server error', { error: err.message });
  });

  return server;
}

/** Send a message to the connected Rust copier. Fire-and-forget. */
export function sendToRust(msg: object): void {
  if (!activeConnection) return;
  try {
    const line = JSON.stringify(msg) + '\n';
    activeConnection.write(line);
  } catch (err: any) {
    log.warn('IPC send failed', { error: err.message });
  }
}

/** Reconcile all allocation capital with Rust copier (periodic safety net). */
export async function reconcileAllAllocations(): Promise<void> {
  if (!activeConnection) return;
  const allocs = await prisma.followAllocation.findMany({
    where: { isActive: true },
    select: { id: true, currentCapital: true, deployedCapital: true },
  });
  for (const a of allocs) {
    sendToRust({
      type: 'capital_reconciled',
      alloc_id: a.id,
      current: a.currentCapital,
      deployed: a.deployedCapital,
    });
  }
}

/** Close the bridge server and active connection. */
export function closeBridge(): void {
  if (activeConnection) {
    activeConnection.destroy();
    activeConnection = null;
  }
  if (server) {
    server.close();
    server = null;
  }
  // Clean up socket file
  if (fs.existsSync(SOCKET_PATH)) {
    try {
      fs.unlinkSync(SOCKET_PATH);
    } catch {
      // Ignore
    }
  }
  log.info('IPC bridge closed');
}

// ─── Message Dispatch ───

async function handleMessage(
  socket: net.Socket,
  msg: { type: string; [key: string]: any },
): Promise<void> {
  switch (msg.type) {
    case 'seed_request':
      await handleSeedRequest(socket);
      break;
    case 'trade_detected':
      await handleTradeDetected(msg as TradeDetectedMsg);
      break;
    case 'copy_trade_result':
      await handleCopyTradeResult(msg as CopyTradeResultMsg);
      break;
    default:
      log.warn('Unknown IPC message type', { type: msg.type });
  }
}

// ─── Seed Handler ───

async function handleSeedRequest(socket: net.Socket): Promise<void> {
  const t0 = Date.now();
  log.info('Seed request received, querying DB...');

  try {
    const [allocations, positions, majorityData, dailySpend, markets] = await Promise.all([
      queryAllocations(),
      queryPositions(),
      queryMajorityData(),
      queryDailySpend(),
      queryMarkets(),
    ]);

    // Capital comes from the allocations query
    const capital = allocations.map((a) => ({
      alloc_id: a.id,
      current: a.currentCapital,
      deployed: a.deployedCapital,
    }));

    const seedState = {
      type: 'seed_state',
      allocations: allocations.map(formatAllocationForRust),
      positions,
      capital,
      majority_data: majorityData,
      markets,
      daily_live_spend: dailySpend.live,
      daily_paper_spend: dailySpend.paper,
    };

    const line = JSON.stringify(seedState) + '\n';
    socket.write(line);

    log.info('Seed response sent', {
      allocations: allocations.length,
      positions: positions.length,
      majority_data: majorityData.length,
      markets: markets.length,
      elapsed_ms: Date.now() - t0,
    });
  } catch (err: any) {
    log.error('Seed query failed', { error: err.message, stack: err.stack });
    // Send empty seed so Rust doesn't hang on timeout
    const emptySeed = {
      type: 'seed_state',
      allocations: [],
      positions: [],
      capital: [],
      majority_data: [],
      markets: [],
      daily_live_spend: 0,
      daily_paper_spend: 0,
    };
    socket.write(JSON.stringify(emptySeed) + '\n');
  }
}

async function queryAllocations() {
  return prisma.followAllocation.findMany({
    where: { isActive: true },
  });
}

async function queryPositions(): Promise<
  Array<{
    token_id: string;
    alloc_id: string;
    is_paper: boolean;
    net_shares: number;
    net_usd: number;
    buy_cost: number;
    buy_shares: number;
  }>
> {
  const rows = await prisma.$queryRaw<
    Array<{
      token_id: string;
      alloc_id: string;
      is_paper: boolean;
      net_shares: number;
      net_usd: number;
      buy_cost: number;
      buy_shares: number;
    }>
  >`
    SELECT
      ct."tokenId" as token_id,
      ct."followAllocationId" as alloc_id,
      ct."isPaper" as is_paper,
      SUM(CASE WHEN ct.side = 'BUY' THEN ct."filledSize" ELSE -ct."filledSize" END) as net_shares,
      SUM(CASE WHEN ct.side = 'BUY' THEN ct."filledSize" * ct."filledPrice"
               ELSE -(ct."filledSize" * ct."filledPrice") END) as net_usd,
      SUM(CASE WHEN ct.side = 'BUY' THEN ct."filledSize" * ct."filledPrice" ELSE 0 END) as buy_cost,
      SUM(CASE WHEN ct.side = 'BUY' THEN ct."filledSize" ELSE 0 END) as buy_shares
    FROM "CopyTrade" ct
    WHERE ct.status = 'FILLED'
      AND ct."followAllocationId" IS NOT NULL
    GROUP BY ct."tokenId", ct."followAllocationId", ct."isPaper"
    HAVING SUM(CASE WHEN ct.side = 'BUY' THEN ct."filledSize" ELSE -ct."filledSize" END) > 0.001
  `;
  return rows.map((r) => ({
    token_id: r.token_id,
    alloc_id: r.alloc_id,
    is_paper: r.is_paper,
    net_shares: Number(r.net_shares),
    net_usd: Number(r.net_usd),
    buy_cost: Number(r.buy_cost),
    buy_shares: Number(r.buy_shares),
  }));
}

async function queryMajorityData(): Promise<
  Array<{
    wallet: string;
    condition_id: string;
    outcome: string;
    usd: number;
    timestamp_ms: number;
  }>
> {
  const cutoff = new Date(Date.now() - 4 * 60 * 60 * 1000); // 4h (covers p95 accumulation time with 4.8x margin)
  const rows = await prisma.$queryRaw<
    Array<{
      wallet: string;
      condition_id: string;
      outcome: string;
      usd: number;
      timestamp_ms: number;
    }>
  >`
    SELECT
      dt."proxyWallet" as wallet,
      dt."conditionId" as condition_id,
      dt.outcome,
      SUM(dt.size * dt.price) as usd,
      EXTRACT(EPOCH FROM MAX(dt."detectedAt")) * 1000 as timestamp_ms
    FROM "DetectedTrade" dt
    WHERE dt.side = 'BUY'
      AND dt."detectedAt" > ${cutoff}
      AND dt."proxyWallet" IN (
        SELECT "proxyWallet" FROM "FollowAllocation" WHERE "isActive" = true
      )
    GROUP BY dt."proxyWallet", dt."conditionId", dt.outcome
  `;
  return rows.map((r) => ({
    wallet: r.wallet,
    condition_id: r.condition_id,
    outcome: r.outcome,
    usd: Number(r.usd),
    timestamp_ms: Number(r.timestamp_ms),
  }));
}

async function queryDailySpend(): Promise<{ live: number; paper: number }> {
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await prisma.$queryRaw<
    Array<{ is_paper: boolean; total: number }>
  >`
    SELECT
      ct."isPaper" as is_paper,
      COALESCE(SUM(ct."filledSize" * ct."filledPrice"), 0) as total
    FROM "CopyTrade" ct
    WHERE ct.status = 'FILLED'
      AND ct.side = 'BUY'
      AND ct."filledAt" >= ${todayStart}
    GROUP BY ct."isPaper"
  `;

  let live = 0;
  let paper = 0;
  for (const r of rows) {
    if (r.is_paper) {
      paper = Number(r.total);
    } else {
      live = Number(r.total);
    }
  }
  return { live, paper };
}

async function queryMarkets(): Promise<
  Array<{
    condition_id: string;
    closed: boolean;
    end_date: number | null;
    event_slug: string | null;
    question: string | null;
    tokens: string[];
    tick_size: string;
    taker_base_fee: number | null;
  }>
> {
  // Get markets for conditions with open (unsettled) positions
  const conditions = await prisma.$queryRaw<Array<{ conditionId: string }>>`
    SELECT DISTINCT dt."conditionId"
    FROM "CopyTrade" ct
    JOIN "DetectedTrade" dt ON ct."detectedTradeId" = dt.id
    WHERE ct.status = 'FILLED'
      AND ct."followAllocationId" IS NOT NULL
      AND ct."createdAt" > NOW() - INTERVAL '30 days'
  `;
  if (conditions.length === 0) return [];
  const cids = conditions.map((c) => c.conditionId).filter(Boolean);
  if (cids.length === 0) return [];

  const markets = await prisma.market.findMany({
    where: { conditionId: { in: cids } },
  });

  return markets.map((m) => {
    let tokens: string[] = [];
    try { tokens = JSON.parse(m.clobTokenIds ?? '[]'); } catch {}
    return {
      condition_id: m.conditionId,
      closed: m.closed ?? false,
      end_date: m.endDate ? Math.floor(m.endDate.getTime() / 1000) : null,
      event_slug: m.slug ?? null,
      question: m.question ?? null,
      tokens,
      tick_size: String(m.minimumTickSize ?? 0.01),
      taker_base_fee: null, // DB doesn't store this; Rust resolver fills from CLOB API
    };
  });
}

// ─── Trade Detected Handler ───

async function handleTradeDetected(msg: TradeDetectedMsg): Promise<void> {
  try {
    await prisma.detectedTrade.upsert({
      where: {
        transactionHash_proxyWallet_asset: {
          transactionHash: msg.transaction_hash,
          proxyWallet: msg.proxy_wallet,
          asset: msg.token_id,
        },
      },
      create: {
        proxyWallet: msg.proxy_wallet,
        side: msg.side,
        conditionId: msg.condition_id ?? '',
        asset: msg.token_id,
        size: msg.size,
        price: msg.price,
        outcome: '', // not available from WSS; resolved by settlement sweeper
        transactionHash: msg.transaction_hash,
        timestamp: msg.timestamp,
        detectedAt: new Date(),
        detectionSource: msg.detection_source,
        title: msg.title,
        eventSlug: msg.event_slug,
      },
      update: {}, // no-op if already exists
    });
  } catch (err: any) {
    // Expected race: both Rust IPC and Node.js chain watcher detect the same trade
    log.debug('DetectedTrade upsert race (record exists)', {
      tx: msg.transaction_hash,
    });
  }
}

// ─── Copy Trade Result Handler ───

async function handleCopyTradeResult(msg: CopyTradeResultMsg): Promise<void> {
  // Wait for DetectedTrade to exist (may arrive slightly after trade_detected IPC)
  // Use transactionHash + token_id (asset) to narrow match — transactionHash alone
  // is not unique (compound index is [transactionHash, proxyWallet, asset]).
  let dtId: string | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const dt = await prisma.detectedTrade.findFirst({
      where: {
        transactionHash: msg.detected_trade_id ?? '',
        asset: msg.token_id,
      },
      select: { id: true },
    });
    if (dt) {
      dtId = dt.id;
      break;
    }
    if (attempt < 2) await sleep(100);
  }

  if (!dtId) {
    // Race: CopyTradeResult arrived before TradeDetected was persisted.
    // Create synthetic DetectedTrade so the fill isn't lost.
    if (!msg.proxy_wallet || !msg.detected_trade_id) {
      log.warn('DetectedTrade not found and insufficient data to self-heal', {
        tx: msg.detected_trade_id,
        status: msg.status,
        alloc: msg.allocation_id,
      });
      return;
    }
    try {
      const created = await prisma.detectedTrade.create({
        data: {
          proxyWallet: msg.proxy_wallet,
          side: msg.side,
          conditionId: msg.condition_id ?? '',
          asset: msg.token_id,
          size: msg.requested_amount,
          price: msg.requested_price,
          outcome: '',
          transactionHash: msg.detected_trade_id,
          timestamp: Math.floor(Date.now() / 1000),
          detectedAt: new Date(),
          detectionSource: 'IPC_BACKFILL',
          title: null,
          eventSlug: null,
        },
      });
      dtId = created.id;
      log.info('Created synthetic DetectedTrade for orphaned copy_trade_result', {
        dtId,
        tx: msg.detected_trade_id,
        alloc: msg.allocation_id,
      });
    } catch (createErr: any) {
      if (createErr.code === 'P2002') {
        // Unique constraint = original just arrived via TradeDetected handler. One more lookup.
        const dt = await prisma.detectedTrade.findFirst({
          where: { transactionHash: msg.detected_trade_id!, asset: msg.token_id },
          select: { id: true },
        });
        if (dt) {
          dtId = dt.id;
        } else {
          log.error('DetectedTrade P2002 but findFirst still null', {
            tx: msg.detected_trade_id,
            alloc: msg.allocation_id,
          });
          return;
        }
      } else {
        log.error('DetectedTrade self-heal create failed', {
          tx: msg.detected_trade_id,
          alloc: msg.allocation_id,
          error: createErr.message,
        });
        return;
      }
    }
  }

  // Map PAPER → null (Prisma enum only has FAK|GTC|POOL)
  const execMethod: ExecutionMethod | null =
    msg.execution_method === 'FAK' || msg.execution_method === 'GTC' || msg.execution_method === 'POOL'
      ? (msg.execution_method as ExecutionMethod)
      : null;

  try {
    // Check if CopyTrade already exists (idempotency guard)
    const existing = await prisma.copyTrade.findUnique({
      where: { detectedTradeId: dtId! },
      select: { id: true },
    });

    if (existing) {
      // Record already exists — update metadata only, skip capital adjustment
      await prisma.copyTrade.update({
        where: { detectedTradeId: dtId! },
        data: {
          status: msg.status,
          filledPrice: msg.filled_price > 0 ? msg.filled_price : undefined,
          filledSize: msg.filled_size > 0 ? msg.filled_size : undefined,
          orderId: msg.order_id ?? undefined,
          executionMethod: execMethod ?? undefined,
          latencyMs: Math.round(msg.latency_ms),
          failReason: msg.fail_reason ?? undefined,
          filledAt: msg.status === 'FILLED' ? new Date() : undefined,
        },
      });
      // Capital already adjusted by Node.js — DO NOT decrement again
      if (msg.status === 'FILLED') {
        log.info('CopyTrade updated (Node.js wrote first, capital skipped)', {
          side: msg.side, alloc: msg.allocation_id, paper: msg.is_paper,
        });
      }
      return;
    }

    await prisma.$transaction(async (tx) => {
      // New record — create and adjust capital
      await tx.copyTrade.create({
        data: {
          detectedTradeId: dtId!,
          tokenId: msg.token_id,
          side: msg.side,
          requestedAmount: msg.requested_amount,
          requestedPrice: msg.requested_price,
          filledPrice: msg.filled_price > 0 ? msg.filled_price : null,
          filledSize: msg.filled_size > 0 ? msg.filled_size : null,
          status: msg.status,
          failReason: msg.fail_reason,
          latencyMs: Math.round(msg.latency_ms),
          isPaper: msg.is_paper,
          orderId: msg.order_id,
          executionMethod: execMethod,
          followAllocationId: msg.allocation_id,
          filledAt: msg.status === 'FILLED' ? new Date() : null,
        },
      });

      // Capital adjustment — only on CREATE (first writer wins)
      if (msg.status === 'FILLED' && msg.filled_size > 0) {
        const fillUsd = msg.filled_size * msg.filled_price;
        if (msg.side === 'BUY') {
          // Guard: don't decrement more than available capital (prevents negative)
          const fresh = await tx.followAllocation.findUniqueOrThrow({
            where: { id: msg.allocation_id },
            select: { currentCapital: true },
          });
          const safeDecrement = Math.min(fillUsd, Math.max(fresh.currentCapital, 0));
          await tx.followAllocation.update({
            where: { id: msg.allocation_id },
            data: {
              currentCapital: { decrement: safeDecrement },
              deployedCapital: { increment: safeDecrement },
            },
          });
        } else {
          // SELL: compute cost basis from avg buy price
          const posRows = await tx.$queryRaw<
            Array<{ buy_cost: number; buy_shares: number }>
          >`
            SELECT
              COALESCE(SUM("filledSize" * "filledPrice"), 0) as buy_cost,
              COALESCE(SUM("filledSize"), 0) as buy_shares
            FROM "CopyTrade"
            WHERE "tokenId" = ${msg.token_id}
              AND "followAllocationId" = ${msg.allocation_id}
              AND "isPaper" = ${msg.is_paper}
              AND status = 'FILLED'
              AND side = 'BUY'
          `;
          const totalBuyCost = Number(posRows[0]?.buy_cost ?? 0);
          const totalBuyShares = Number(posRows[0]?.buy_shares ?? 0);
          const avgBuyPrice =
            totalBuyShares > 0 ? totalBuyCost / totalBuyShares : msg.filled_price;
          const costBasis = msg.filled_size * avgBuyPrice;
          const freshSell = await tx.followAllocation.findUniqueOrThrow({
            where: { id: msg.allocation_id },
            select: { deployedCapital: true },
          });
          const safeDecrementDC = Math.min(costBasis, Math.max(freshSell.deployedCapital, 0));
          await tx.followAllocation.update({
            where: { id: msg.allocation_id },
            data: {
              currentCapital: { increment: fillUsd },
              deployedCapital: { decrement: safeDecrementDC },
            },
          });
        }
      }
    });

    if (msg.status === 'FILLED') {
      log.info('CopyTrade persisted', {
        side: msg.side,
        size: msg.filled_size,
        price: msg.filled_price,
        method: msg.execution_method,
        alloc: msg.allocation_id,
        paper: msg.is_paper,
      });
    }
  } catch (err: any) {
    log.error('CopyTrade persist failed', {
      error: err.message,
      tx: msg.detected_trade_id,
      status: msg.status,
    });
  }
}

// ─── Helpers ───

function formatAllocationForRust(alloc: any) {
  return {
    id: alloc.id,
    proxy_wallet: alloc.proxyWallet,
    is_paper: alloc.isPaper,
    is_active: alloc.isActive,
    initial_capital: alloc.initialCapital,
    copy_trade_percent: alloc.copyTradePercent,
    max_position_usd: alloc.maxPositionUsd,
    max_prediction_position_usd: alloc.maxPredictionPositionUsd,
    min_buy_price: alloc.minBuyPrice,
    exclude_event_slug_patterns: alloc.excludeEventSlugPatterns
      ? alloc.excludeEventSlugPatterns.split(',').filter(Boolean)
      : [],
    exclude_title_patterns: alloc.excludeTitlePatterns
      ? alloc.excludeTitlePatterns.split(',').filter(Boolean)
      : [],
    majority_only_mode: alloc.majorityOnlyMode ?? false,
    copy_maker_fills: alloc.copyMakerFills ?? false,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Message type interfaces (matches Rust OutboundMessage serde) ───

interface TradeDetectedMsg {
  type: 'trade_detected';
  proxy_wallet: string;
  token_id: string;
  side: string;
  size: number;
  price: number;
  transaction_hash: string;
  is_neg_risk: boolean;
  is_maker: boolean;
  block_number: number;
  condition_id: string | null;
  event_slug: string | null;
  title: string | null;
  detection_source: string;
  timestamp: number;
}

interface CopyTradeResultMsg {
  type: 'copy_trade_result';
  detected_trade_id: string | null;
  allocation_id: string;
  proxy_wallet?: string;
  condition_id?: string | null;
  token_id: string;
  side: string;
  status: string;
  filled_price: number;
  filled_size: number;
  requested_amount: number;
  requested_price: number;
  order_id: string | null;
  execution_method: string;
  latency_ms: number;
  fail_reason: string | null;
  is_paper: boolean;
}
