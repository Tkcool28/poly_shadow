/**
 * Scalp Order Book Monitor
 *
 * Polls CLOB order book snapshots at regular intervals to capture:
 * - Spread width evolution (pre-match -> in-play transition)
 * - Depth at top-of-book and total
 * - Number of price levels
 * - Midpoint drift
 *
 * Outputs:
 * - Console: summary each poll
 * - CSV file: one row per snapshot per market, for post-hoc analysis
 * - JSON snapshots: full book at configurable intervals
 *
 * Usage:
 *   npx tsx src/scripts/scalp-ob-monitor.ts --match=epl-mun-ast-2026-03-15 --interval=30 --runtime=180
 *   npx tsx src/scripts/scalp-ob-monitor.ts --match=nba-min-okc-2026-03-15 --interval=15
 */

import axios from 'axios';
import * as fs from 'fs';
import * as path from 'path';
import { ClobClient } from '@polymarket/clob-client';

// ─── CLI Args ───

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

const eventSlug = getArg('match');
const pollIntervalSec = parseInt(getArg('interval') ?? '30', 10);
const maxRuntimeMin = parseInt(getArg('runtime') ?? '180', 10);
const snapshotEveryN = parseInt(getArg('snapshot-every') ?? '10', 10); // full JSON snapshot every N polls

if (!eventSlug) {
  console.error('Usage: npx tsx src/scripts/scalp-ob-monitor.ts --match=epl-mun-ast-2026-03-15 [--interval=30] [--runtime=180]');
  process.exit(1);
}

// ─── Constants ───

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const CLOB_REST_URL = 'https://clob.polymarket.com';

// ─── Types ───

interface MarketInfo {
  label: string;
  conditionId: string;
  yesTokenId: string;
  noTokenId: string;
}

interface BookLevel {
  price: number;
  size: number;
}

interface BookSnapshot {
  timestamp: string;
  epochMs: number;
  market: string;
  bestBid: number;
  bestAsk: number;
  spread: number;
  midpoint: number;
  bidDepthTop1Shares: number;
  bidDepthTop1Usd: number;
  askDepthTop1Shares: number;
  askDepthTop1Usd: number;
  bidDepthTop5Usd: number;
  askDepthTop5Usd: number;
  totalBidDepthUsd: number;
  totalAskDepthUsd: number;
  bidLevels: number;
  askLevels: number;
  // Depth at specific distances from midpoint
  bidDepth2cUsd: number;  // total bid USD within 2c of midpoint
  askDepth2cUsd: number;
  bidDepth5cUsd: number;  // within 5c
  askDepth5cUsd: number;
}

// ─── State ───

const markets: MarketInfo[] = [];
let clobClient: ClobClient;
let csvPath: string;
let csvStream: fs.WriteStream;
let pollCount = 0;
const snapshotDir = path.join('logs', 'paper-mm', 'ob-snapshots');

// ─── Logging ───

function tsShort(): string {
  return new Date().toISOString().replace('T', ' ').slice(0, 19) + 'Z';
}

function log(msg: string): void {
  console.log(`[${tsShort()}] ${msg}`);
}

// ─── Step 1: Discover markets ───

async function fetchMarkets(): Promise<void> {
  log(`Fetching markets for event: ${eventSlug}`);

  const response = await axios.get(GAMMA_EVENTS_URL, {
    params: { slug: eventSlug },
    timeout: 15_000,
  });

  const events: any[] = Array.isArray(response.data) ? response.data : [response.data];
  if (events.length === 0 || !events[0]) {
    console.error(`No event found for slug: ${eventSlug}`);
    process.exit(1);
  }

  const event = events[0];
  log(`Event: ${event.title || event.slug}`);

  const rawMarkets: any[] = event.markets ?? [];

  for (const m of rawMarkets) {
    const question: string = m.question ?? '';
    const conditionId: string = m.conditionId ?? '';

    let clobTokenIds: string[];
    if (typeof m.clobTokenIds === 'string') {
      try { clobTokenIds = JSON.parse(m.clobTokenIds); } catch { clobTokenIds = []; }
    } else if (Array.isArray(m.clobTokenIds)) {
      clobTokenIds = m.clobTokenIds;
    } else {
      clobTokenIds = [];
    }

    if (clobTokenIds.length < 2) continue;

    // For NBA, skip derivatives
    if (eventSlug!.toLowerCase().startsWith('nba-')) {
      const slug = (m.slug ?? '').toLowerCase();
      if (/-(?:spread|total|points|rebounds|assists|blocks|steals|turnovers|1h)-/i.test(slug)) continue;
    }

    // Determine label
    const qLower = question.toLowerCase();
    let label: string;
    if (qLower.includes('draw')) {
      label = 'Draw';
    } else {
      const winMatch = question.match(/^will\s+(.+?)\s+win\b/i);
      label = winMatch
        ? winMatch[1].replace(/\s*(FC|AFC)\s*/gi, '').trim()
        : question;
    }

    markets.push({
      label,
      conditionId,
      yesTokenId: clobTokenIds[0],
      noTokenId: clobTokenIds[1],
    });

    log(`  Market: ${label} | YES: ${clobTokenIds[0].slice(0, 16)}... | NO: ${clobTokenIds[1].slice(0, 16)}...`);
  }

  if (markets.length === 0) {
    console.error('No markets found.');
    process.exit(1);
  }

  log(`Monitoring ${markets.length} markets every ${pollIntervalSec}s for up to ${maxRuntimeMin}min`);
}

// ─── Step 2: Initialize CLOB client ───

function initClobClient(): void {
  // Read-only client — no signing needed for order book reads
  clobClient = new ClobClient(CLOB_REST_URL, 137);
}

// ─── Step 3: Poll order book ───

function parseBookSide(levels: any[]): BookLevel[] {
  return (levels || []).map((l: any) => ({
    price: parseFloat(l.price),
    size: parseFloat(l.size),
  }));
}

function depthWithinDistance(levels: BookLevel[], midpoint: number, maxDistanceCents: number, isBid: boolean): number {
  let total = 0;
  for (const l of levels) {
    const dist = isBid ? (midpoint - l.price) : (l.price - midpoint);
    if (dist <= maxDistanceCents / 100) {
      total += l.price * l.size;
    }
  }
  return total;
}

async function pollOrderBook(market: MarketInfo): Promise<BookSnapshot | null> {
  try {
    const book = await clobClient.getOrderBook(market.yesTokenId);

    const rawBids = parseBookSide(book.bids);
    const rawAsks = parseBookSide(book.asks);

    // CLOB API sorts bids ascending (worst to best) and asks descending (worst to best).
    // Reverse both so best-price-first for our analysis:
    //   bids: highest price first (best bid at index 0)
    //   asks: lowest price first (best ask at index 0)
    const bids = [...rawBids].reverse();
    const asks = [...rawAsks].reverse();

    const bestBid = bids.length > 0 ? bids[0].price : 0;
    const bestAsk = asks.length > 0 ? asks[0].price : 1;
    const spread = bestAsk - bestBid;
    const midpoint = (bestBid + bestAsk) / 2;

    // Top-of-book depth (best level)
    const bidTop1Shares = bids.length > 0 ? bids[0].size : 0;
    const bidTop1Usd = bids.length > 0 ? bids[0].price * bids[0].size : 0;
    const askTop1Shares = asks.length > 0 ? asks[0].size : 0;
    const askTop1Usd = asks.length > 0 ? asks[0].price * asks[0].size : 0;

    // Top-5 depth (5 best levels)
    const bidTop5Usd = bids.slice(0, 5).reduce((s, l) => s + l.price * l.size, 0);
    const askTop5Usd = asks.slice(0, 5).reduce((s, l) => s + l.price * l.size, 0);

    // Total depth
    const totalBidUsd = bids.reduce((s, l) => s + l.price * l.size, 0);
    const totalAskUsd = asks.reduce((s, l) => s + l.price * l.size, 0);

    // Depth within distance bands
    const bidDepth2c = depthWithinDistance(bids, midpoint, 2, true);
    const askDepth2c = depthWithinDistance(asks, midpoint, 2, false);
    const bidDepth5c = depthWithinDistance(bids, midpoint, 5, true);
    const askDepth5c = depthWithinDistance(asks, midpoint, 5, false);

    const now = new Date();

    return {
      timestamp: now.toISOString(),
      epochMs: now.getTime(),
      market: market.label,
      bestBid,
      bestAsk,
      spread,
      midpoint,
      bidDepthTop1Shares: bidTop1Shares,
      bidDepthTop1Usd: bidTop1Usd,
      askDepthTop1Shares: askTop1Shares,
      askDepthTop1Usd: askTop1Usd,
      bidDepthTop5Usd: bidTop5Usd,
      askDepthTop5Usd: askTop5Usd,
      totalBidDepthUsd: totalBidUsd,
      totalAskDepthUsd: totalAskUsd,
      bidLevels: bids.length,
      askLevels: asks.length,
      bidDepth2cUsd: bidDepth2c,
      askDepth2cUsd: askDepth2c,
      bidDepth5cUsd: bidDepth5c,
      askDepth5cUsd: askDepth5c,
    };
  } catch (err: any) {
    log(`  ERROR polling ${market.label}: ${err.message}`);
    return null;
  }
}

// ─── Step 4: CSV output ───

const CSV_HEADER = [
  'timestamp', 'epochMs', 'market',
  'bestBid', 'bestAsk', 'spread', 'midpoint',
  'bidTop1Shares', 'bidTop1Usd', 'askTop1Shares', 'askTop1Usd',
  'bidTop5Usd', 'askTop5Usd',
  'totalBidUsd', 'totalAskUsd',
  'bidLevels', 'askLevels',
  'bidDepth2cUsd', 'askDepth2cUsd',
  'bidDepth5cUsd', 'askDepth5cUsd',
].join(',');

function snapshotToCsv(s: BookSnapshot): string {
  return [
    s.timestamp, s.epochMs, s.market,
    s.bestBid.toFixed(4), s.bestAsk.toFixed(4), s.spread.toFixed(4), s.midpoint.toFixed(4),
    s.bidDepthTop1Shares.toFixed(1), s.bidDepthTop1Usd.toFixed(2),
    s.askDepthTop1Shares.toFixed(1), s.askDepthTop1Usd.toFixed(2),
    s.bidDepthTop5Usd.toFixed(2), s.askDepthTop5Usd.toFixed(2),
    s.totalBidDepthUsd.toFixed(2), s.totalAskDepthUsd.toFixed(2),
    s.bidLevels, s.askLevels,
    s.bidDepth2cUsd.toFixed(2), s.askDepth2cUsd.toFixed(2),
    s.bidDepth5cUsd.toFixed(2), s.askDepth5cUsd.toFixed(2),
  ].join(',');
}

function initCsv(): void {
  const dir = path.join('logs', 'paper-mm');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const slug = eventSlug!.replace(/[^a-z0-9-]/gi, '_');
  const dateStr = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  csvPath = path.join(dir, `ob-${slug}-${dateStr}.csv`);

  csvStream = fs.createWriteStream(csvPath, { flags: 'w' });
  csvStream.write(CSV_HEADER + '\n');

  // Snapshot directory
  if (!fs.existsSync(snapshotDir)) fs.mkdirSync(snapshotDir, { recursive: true });

  log(`CSV output: ${csvPath}`);
}

// ─── Step 5: Main poll loop ───

async function doPoll(): Promise<void> {
  pollCount++;
  const isSnapshot = pollCount % snapshotEveryN === 0;

  log(`--- Poll #${pollCount} ---`);

  const snapshots: BookSnapshot[] = [];

  for (const market of markets) {
    const snap = await pollOrderBook(market);
    if (!snap) continue;

    snapshots.push(snap);

    // Write CSV row
    csvStream.write(snapshotToCsv(snap) + '\n');

    // Console summary
    const spreadBps = (snap.spread * 100).toFixed(1);
    log(
      `  ${snap.market.padEnd(20)} ` +
      `bid=${snap.bestBid.toFixed(2)} ask=${snap.bestAsk.toFixed(2)} ` +
      `spread=${spreadBps}c ` +
      `mid=${snap.midpoint.toFixed(3)} ` +
      `top1bid=$${snap.bidDepthTop1Usd.toFixed(0)} top1ask=$${snap.askDepthTop1Usd.toFixed(0)} ` +
      `within2c=$${snap.bidDepth2cUsd.toFixed(0)}/$${snap.askDepth2cUsd.toFixed(0)} ` +
      `levels=${snap.bidLevels}/${snap.askLevels}`
    );
  }

  // Periodic JSON snapshot (full book data for deep analysis)
  if (isSnapshot && snapshots.length > 0) {
    const snapFile = path.join(
      snapshotDir,
      `snap-${pollCount}-${Date.now()}.json`
    );
    // Fetch full books again for JSON (includes all levels)
    const fullBooks: Record<string, any> = {};
    for (const market of markets) {
      try {
        const book = await clobClient.getOrderBook(market.yesTokenId);
        fullBooks[market.label] = {
          tokenId: market.yesTokenId,
          bids: (book.bids || []).slice(0, 20),
          asks: (book.asks || []).slice(0, 20),
        };
      } catch {}
    }
    fs.writeFileSync(snapFile, JSON.stringify({ timestamp: new Date().toISOString(), pollCount, fullBooks }, null, 2));
    log(`  Full snapshot saved: ${snapFile}`);
  }
}

// ─── Step 6: Shutdown ───

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log('');
  log('='.repeat(60));
  log('ORDER BOOK MONITOR SHUTDOWN');
  log(`Polls completed: ${pollCount}`);
  log(`CSV: ${csvPath}`);
  log('='.repeat(60));

  csvStream.end();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Main ───

async function main(): Promise<void> {
  log('='.repeat(60));
  log('Scalp Order Book Monitor');
  log(`Event: ${eventSlug}`);
  log(`Poll interval: ${pollIntervalSec}s | Max runtime: ${maxRuntimeMin}min`);
  log('='.repeat(60));

  await fetchMarkets();
  initClobClient();
  initCsv();

  // Initial poll immediately
  await doPoll();

  // Set up interval
  const timer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await doPoll();
    } catch (err: any) {
      log(`Poll error: ${err.message}`);
    }
  }, pollIntervalSec * 1000);

  // Auto-shutdown
  setTimeout(() => {
    log(`Auto-shutdown after ${maxRuntimeMin} minutes`);
    clearInterval(timer);
    shutdown();
  }, maxRuntimeMin * 60 * 1000);

  log('');
  log(`Monitoring started. Ctrl+C to stop. Auto-shutdown in ${maxRuntimeMin}min.`);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
