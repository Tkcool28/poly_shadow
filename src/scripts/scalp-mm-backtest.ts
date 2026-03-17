/**
 * Scalp Market Maker — Historical Backtest
 *
 * Fetches all trades for a closed Polymarket event from the Data API,
 * replays them through the ScalpMarketMaker engine, and outputs performance
 * metrics: fills, PnL, inventory path, round trips, spread capture.
 *
 * This gives us a baseline expectation for paper testing on live matches.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-mm-backtest.ts --match=epl-ars-eve-2026-03-14 --spread=0.04 --size=10
 *   npx tsx src/scripts/scalp-mm-backtest.ts --match=epl-ars-eve-2026-03-14 --spread=0.06 --size=15 --queue-depth=500
 *   npx tsx src/scripts/scalp-mm-backtest.ts --match=epl-wes-mac-2026-03-14 --spread=0.04 --size=10 --event-pause=30
 *
 * Options:
 *   --match=<slug>         Event slug (required)
 *   --spread=<number>      Total spread width (default: 0.04)
 *   --size=<number>        USD per side (default: 10)
 *   --max-inventory=<n>    Max one-sided USD exposure (default: 50)
 *   --vwap-window=<n>      VWAP window (default: 20)
 *   --event-pause=<n>      Seconds to pause after game event (default: 30)
 *   --queue-depth=<n>      USD of queue ahead (default: 0 = off)
 *   --warm-up=<n>          Warm-up seconds (default: 10)
 *   --max-stddev=<n>       Max price stddev for stability (default: 0.03)
 *   --goals=<ts1,ts2,...>  Comma-separated goal timestamps (Unix ms) for event injection
 *   --market-filter=<s>    Only backtest markets whose label contains this string
 *   --sweep                Run parameter sweep across multiple spread/queue configs
 *   --start=<ISO|unix>     Filter trades after this time (e.g., 2026-03-14T15:00:00Z)
 *   --end=<ISO|unix>       Filter trades before this time
 */

import axios from 'axios';
import { ScalpMarketMaker } from '../services/scalp/scalp-market-maker';
import type { ClobTradeEvent } from '../services/clob-market-stream';
import type { GameEvent } from '../services/scalp/scalp-types';

// ─── CLI Args ───

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

const eventSlug = getArg('match');
const spreadWidth = parseFloat(getArg('spread') ?? '0.04');
const orderSize = parseFloat(getArg('size') ?? '10');
const maxInventory = parseFloat(getArg('max-inventory') ?? '50');
const vwapWindow = parseInt(getArg('vwap-window') ?? '20', 10);
const eventPauseSec = parseInt(getArg('event-pause') ?? '30', 10);
const warmUpSec = parseInt(getArg('warm-up') ?? '10', 10);
const maxPriceStdDev = parseFloat(getArg('max-stddev') ?? '0.03');
const queueDepthAheadUsd = parseFloat(getArg('queue-depth') ?? '0');
const marketFilter = getArg('market-filter')?.toLowerCase();
const goalTimestamps = getArg('goals')?.split(',').map(Number).filter((n) => !isNaN(n)) ?? [];
const doSweep = hasFlag('sweep');

// Time filters — parse either ISO string or Unix timestamp (seconds or ms)
function parseTimeArg(val: string | undefined): number | null {
  if (!val) return null;
  const num = Number(val);
  if (!isNaN(num)) return num < 1e12 ? num * 1000 : num; // seconds → ms
  const date = new Date(val);
  return isNaN(date.getTime()) ? null : date.getTime();
}

const startTime = parseTimeArg(getArg('start'));
const endTime = parseTimeArg(getArg('end'));

if (!eventSlug) {
  console.error('Usage: npx tsx src/scripts/scalp-mm-backtest.ts --match=epl-ars-eve-2026-03-14 [--spread=0.04] [--size=10]');
  process.exit(1);
}

// ─── Constants ───

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const DATA_API_BASE = 'https://data-api.polymarket.com';
const TRADES_PAGE_SIZE = 500;

// ─── Types ───

interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  outcomes: string[];
  clobTokenIds: string[];
  label: string;
}

interface HistoricalTrade {
  price: number;
  size: number;
  side: string;       // BUY or SELL
  timestamp: number;  // Unix ms
  asset: string;      // token ID
  conditionId: string;
}

interface BacktestResult {
  label: string;
  tokenId: string;
  totalTrades: number;
  totalFills: number;
  bidFills: number;
  askFills: number;
  roundTrips: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  avgSpreadCapture: number;
  fillRate: number;       // fills per hour
  maxInventory: number;   // peak inventory shares
  maxInventoryUsd: number;
  durationMinutes: number;
  tradesPerMinute: number;
  finalPosition: number;
}

// ─── Logging ───

function log(msg: string): void {
  console.log(`[BT] ${msg}`);
}

// ─── Step 1: Fetch Event Markets ───

async function fetchMarkets(): Promise<MarketInfo[]> {
  log(`Fetching event: ${eventSlug}`);

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
  const eventTitle: string = event.title || event.slug || '';
  log(`Event: ${eventTitle} (closed: ${event.closed ?? 'unknown'})`);

  const markets: any[] = event.markets ?? [];
  const result: MarketInfo[] = [];

  for (const m of markets) {
    const slug = m.slug ?? '';
    const question: string = m.question ?? '';
    const conditionId: string = m.conditionId ?? '';

    let outcomes: string[];
    if (typeof m.outcomes === 'string') {
      try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = []; }
    } else if (Array.isArray(m.outcomes)) {
      outcomes = m.outcomes;
    } else {
      outcomes = [];
    }

    let clobTokenIds: string[];
    if (typeof m.clobTokenIds === 'string') {
      try { clobTokenIds = JSON.parse(m.clobTokenIds); } catch { clobTokenIds = []; }
    } else if (Array.isArray(m.clobTokenIds)) {
      clobTokenIds = m.clobTokenIds;
    } else {
      clobTokenIds = [];
    }

    if (clobTokenIds.length === 0 || !conditionId) continue;

    // Determine label
    let label: string;
    const qLower = question.toLowerCase();
    if (qLower.includes('draw')) {
      label = 'Draw';
    } else {
      const winMatch = question.match(/^will\s+(.+?)\s+win\b/i);
      label = winMatch
        ? winMatch[1].replace(/\s*(FC|AFC)\s*/gi, '').trim() + ' Win'
        : question;
    }

    if (marketFilter && !label.toLowerCase().includes(marketFilter)) {
      continue;
    }

    result.push({ slug, question, conditionId, outcomes, clobTokenIds, label });
    log(`  Market: ${label} [${conditionId.slice(0, 16)}...] — ${clobTokenIds.length} tokens`);
  }

  return result;
}

// ─── Step 2: Fetch Historical Trades ───

async function fetchTrades(conditionId: string): Promise<HistoricalTrade[]> {
  const allTrades: HistoricalTrade[] = [];
  let offset = 0;
  let page = 0;

  while (true) {
    const url = `${DATA_API_BASE}/trades`;
    let resp: any;
    try {
      resp = await axios.get(url, {
        params: { market: conditionId, limit: TRADES_PAGE_SIZE, offset },
        timeout: 30_000,
      });
    } catch (err: any) {
      log(`  API error: ${err.response?.status} ${err.response?.statusText} — URL: ${url}?market=${conditionId.slice(0, 20)}...&limit=${TRADES_PAGE_SIZE}&offset=${offset}`);
      if (err.response?.data) log(`  Response body: ${JSON.stringify(err.response.data).slice(0, 200)}`);
      throw err;
    }

    const batch: any[] = Array.isArray(resp.data) ? resp.data : [];
    if (batch.length === 0) break;

    for (const t of batch) {
      const price = typeof t.price === 'number' ? t.price : parseFloat(t.price);
      const size = typeof t.size === 'number' ? t.size : parseFloat(t.size);
      const timestamp = typeof t.timestamp === 'number' ? t.timestamp : parseInt(t.timestamp, 10);

      if (isNaN(price) || isNaN(size) || size <= 0) continue;

      allTrades.push({
        price,
        size,
        side: t.side ?? 'BUY',
        timestamp: timestamp < 1e12 ? timestamp * 1000 : timestamp, // ensure ms
        asset: t.asset ?? '',
        conditionId: t.conditionId ?? conditionId,
      });
    }

    page++;
    offset += TRADES_PAGE_SIZE;

    // Data API caps at offset 3000, and max 100 pages safety
    if (page >= 100 || batch.length < TRADES_PAGE_SIZE || offset >= 3000) break;

    // Brief pause between pages to be polite
    await new Promise((r) => setTimeout(r, 200));
  }

  return allTrades;
}

// ─── Step 3: Run Backtest ───

async function runBacktest(
  markets: MarketInfo[],
  allTrades: HistoricalTrade[],
  config: { spread: number; size: number; queueDepth: number; eventPause: number },
): Promise<BacktestResult[]> {
  const results: BacktestResult[] = [];

  // Build token -> market mapping
  const tokenToMarket = new Map<string, MarketInfo>();
  const tokenToLabel = new Map<string, string>();

  for (const market of markets) {
    for (let i = 0; i < market.clobTokenIds.length; i++) {
      tokenToMarket.set(market.clobTokenIds[i], market);
      const outcomeLabel = market.outcomes[i] ?? (i === 0 ? 'Yes' : 'No');
      tokenToLabel.set(market.clobTokenIds[i], `${market.label} ${outcomeLabel.toUpperCase()}`);
    }
  }

  // Create one MM engine per YES token
  const engines = new Map<string, ScalpMarketMaker>();
  for (const market of markets) {
    const yesTokenId = market.clobTokenIds[0];
    if (!yesTokenId) continue;

    const label = `${market.label} YES`;
    const mm = new ScalpMarketMaker(
      {
        spreadWidth: config.spread,
        orderSize: config.size,
        maxInventory,
        isPaper: true,
        vwapWindow,
        eventPauseMs: config.eventPause * 1000,
        warmUpMs: warmUpSec * 1000,
        maxPriceStdDev,
        queueDepthAheadUsd: config.queueDepth,
        // Generous risk limits for backtesting — don't want session timer or fill-rate
        // limits to interfere with the simulation
        riskLimits: {
          maxLossPerMatch: -1000,       // effectively disabled
          maxInventoryShares: 10000,    // effectively disabled
          maxInventoryUsd: 10000,       // effectively disabled
          maxFillsPerMinute: 1000,      // effectively disabled
          maxSessionMs: 24 * 60 * 60 * 1000, // 24 hours
        },
      },
      yesTokenId,
      label,
      // Suppress individual fill logs during sweep mode
      doSweep ? () => {} : (msg) => console.log(msg),
    );

    engines.set(yesTokenId, mm);
  }

  // Sort trades by timestamp
  allTrades.sort((a, b) => a.timestamp - b.timestamp);

  if (allTrades.length === 0) {
    log('No trades to replay.');
    return [];
  }

  const firstTs = allTrades[0].timestamp;
  const lastTs = allTrades[allTrades.length - 1].timestamp;
  const durationMin = (lastTs - firstTs) / 60_000;

  log(`Replaying ${allTrades.length} trades over ${durationMin.toFixed(1)} minutes`);
  log(`Config: spread=${config.spread}, size=$${config.size}, queue=${config.queueDepth}, eventPause=${config.eventPause}s`);

  // Sort goal timestamps
  const sortedGoals = [...goalTimestamps].sort((a, b) => a - b);
  let nextGoalIdx = 0;

  // Track peak inventory per engine
  const peakInventory = new Map<string, number>();
  const peakInventoryUsd = new Map<string, number>();

  // Replay trades
  // The MM engine uses Date.now() internally for warm-up timing. In backtest mode,
  // we need to override time. Since we can't easily mock Date.now(), we'll rely on
  // the fact that warm-up is very short (10s) relative to match duration (90+ min).
  // The first ~10s of trades will be used for warm-up naturally.

  // IMPORTANT: The MM engine uses Date.now() for warm-up, pause, and cooldown timing.
  // For backtesting, we override Date.now to simulate time progression.
  const originalDateNow = Date.now;
  let simulatedNow = firstTs;

  // Monkey-patch Date.now for the backtest duration
  Date.now = () => simulatedNow;

  // Start all engines (await to initialize heartbeat timer)
  for (const mm of engines.values()) {
    await mm.start();
  }

  for (const trade of allTrades) {
    // Advance simulated time
    simulatedNow = trade.timestamp;

    // Inject game events (goals) that occurred before this trade
    while (nextGoalIdx < sortedGoals.length && sortedGoals[nextGoalIdx] <= trade.timestamp) {
      const goalTs = sortedGoals[nextGoalIdx];
      const gameEvent: GameEvent = {
        matchId: eventSlug!,
        game: 'soccer',
        eventType: 'goal',
        winner: 'Unknown',
        loser: 'Unknown',
        seriesScore: [0, 0],
        seriesFormat: 'bo1',
        isSeriesDecisive: false,
        mapNumber: 0,
        timestamp: new Date(goalTs),
        rawData: {},
      };

      for (const mm of engines.values()) {
        mm.onGameEvent(gameEvent);
      }

      if (!doSweep) {
        log(`GOAL EVENT injected at ${new Date(goalTs).toISOString()}`);
      }
      nextGoalIdx++;
    }

    // Convert to ClobTradeEvent format
    const clobEvent: ClobTradeEvent = {
      asset_id: trade.asset,
      market: trade.conditionId,
      price: String(trade.price),
      size: String(trade.size),
      side: trade.side,
      fee_rate_bps: '0',
      timestamp: String(trade.timestamp),
      transaction_hash: '',
      event_type: 'last_trade_price',
    };

    // Dispatch to all engines (each filters by tokenId internally)
    for (const mm of engines.values()) {
      mm.onTrade(clobEvent);
    }

    // Track peak inventory
    for (const [tokenId, mm] of engines.entries()) {
      const state = mm.getState();
      const invShares = Math.abs(state.position);
      const invUsd = invShares * (state.lastFairValue || trade.price);
      const prevPeak = peakInventory.get(tokenId) ?? 0;
      const prevPeakUsd = peakInventoryUsd.get(tokenId) ?? 0;
      if (invShares > prevPeak) peakInventory.set(tokenId, invShares);
      if (invUsd > prevPeakUsd) peakInventoryUsd.set(tokenId, invUsd);
    }
  }

  // Restore Date.now
  Date.now = originalDateNow;

  // Stop all engines (cleans up heartbeat timers)
  for (const mm of engines.values()) {
    mm.stop();
  }

  // Collect results
  for (const [tokenId, mm] of engines.entries()) {
    const stats = mm.getStats();
    const state = stats.state;

    results.push({
      label: stats.label,
      tokenId: tokenId.slice(0, 16) + '...',
      totalTrades: stats.tradesProcessed,
      totalFills: state.totalFills,
      bidFills: state.totalBidFills,
      askFills: state.totalAskFills,
      roundTrips: state.totalRoundTrips,
      realizedPnl: state.realizedPnl,
      unrealizedPnl: state.unrealizedPnl,
      totalPnl: state.realizedPnl + state.unrealizedPnl,
      avgSpreadCapture: stats.avgSpreadCapture,
      fillRate: durationMin > 0 ? (state.totalFills / durationMin) * 60 : 0,
      maxInventory: peakInventory.get(tokenId) ?? 0,
      maxInventoryUsd: peakInventoryUsd.get(tokenId) ?? 0,
      durationMinutes: durationMin,
      tradesPerMinute: durationMin > 0 ? allTrades.length / durationMin : 0,
      finalPosition: state.position,
    });
  }

  return results;
}

// ─── Step 4: Display Results ───

function displayResults(results: BacktestResult[], configLabel: string): void {
  console.log('\n' + '='.repeat(80));
  console.log(`BACKTEST RESULTS: ${eventSlug} | ${configLabel}`);
  console.log('='.repeat(80));

  let totalPnl = 0;
  let totalFills = 0;
  let totalRoundTrips = 0;

  for (const r of results) {
    console.log(`\n--- ${r.label} ---`);
    console.log(`  Trades received:   ${r.totalTrades}`);
    console.log(`  Duration:          ${r.durationMinutes.toFixed(1)} min (${(r.durationMinutes / 60).toFixed(1)} hrs)`);
    console.log(`  Trades/min:        ${r.tradesPerMinute.toFixed(1)}`);
    console.log(`  Total fills:       ${r.totalFills} (${r.bidFills} buys, ${r.askFills} sells)`);
    console.log(`  Round trips:       ${r.roundTrips}`);
    console.log(`  Fill rate:         ${r.fillRate.toFixed(1)}/hr`);
    console.log(`  Realized PnL:      ${r.realizedPnl >= 0 ? '+' : ''}$${r.realizedPnl.toFixed(4)}`);
    console.log(`  Unrealized PnL:    ${r.unrealizedPnl >= 0 ? '+' : ''}$${r.unrealizedPnl.toFixed(4)}`);
    console.log(`  Total PnL:         ${r.totalPnl >= 0 ? '+' : ''}$${r.totalPnl.toFixed(4)}`);
    console.log(`  Avg spread capture:${r.avgSpreadCapture >= 0 ? '+' : ''}$${r.avgSpreadCapture.toFixed(4)}/RT`);
    console.log(`  Peak inventory:    ${r.maxInventory} shares ($${r.maxInventoryUsd.toFixed(2)})`);
    console.log(`  Final position:    ${r.finalPosition} shares`);

    totalPnl += r.totalPnl;
    totalFills += r.totalFills;
    totalRoundTrips += r.roundTrips;
  }

  console.log('\n--- TOTAL ---');
  console.log(`  Markets:          ${results.length}`);
  console.log(`  Total fills:      ${totalFills}`);
  console.log(`  Total round trips:${totalRoundTrips}`);
  console.log(`  Total PnL:        ${totalPnl >= 0 ? '+' : ''}$${totalPnl.toFixed(4)}`);
  console.log('='.repeat(80));
}

// ─── Step 5: Parameter Sweep ───

async function runSweep(markets: MarketInfo[], allTrades: HistoricalTrade[]): Promise<void> {
  const spreads = [0.02, 0.03, 0.04, 0.05, 0.06, 0.08];
  const queueDepths = [0, 100, 300, 500, 1000];
  const eventPauses = [30]; // keep constant for sweep

  console.log('\n' + '='.repeat(100));
  console.log('PARAMETER SWEEP');
  console.log('='.repeat(100));
  console.log(`${'Spread'.padEnd(8)} ${'Queue'.padEnd(8)} ${'Fills'.padEnd(8)} ${'RTs'.padEnd(6)} ${'PnL'.padEnd(12)} ${'Avg/RT'.padEnd(10)} ${'PeakInv$'.padEnd(10)} ${'FinalPos'.padEnd(10)} ${'Fill/hr'.padEnd(10)}`);
  console.log('-'.repeat(100));

  for (const spread of spreads) {
    for (const queue of queueDepths) {
      const results = await runBacktest(markets, [...allTrades], {
        spread,
        size: orderSize,
        queueDepth: queue,
        eventPause: eventPauses[0],
      });

      // Aggregate
      let fills = 0, rts = 0, pnl = 0, peakInv = 0, finalPos = 0, fillRate = 0;
      for (const r of results) {
        fills += r.totalFills;
        rts += r.roundTrips;
        pnl += r.totalPnl;
        peakInv = Math.max(peakInv, r.maxInventoryUsd);
        finalPos += Math.abs(r.finalPosition);
        fillRate += r.fillRate;
      }

      const avgPerRt = rts > 0 ? pnl / rts : 0;
      const pnlStr = `${pnl >= 0 ? '+' : ''}$${pnl.toFixed(3)}`;
      const avgRtStr = `${avgPerRt >= 0 ? '+' : ''}$${avgPerRt.toFixed(4)}`;

      console.log(
        `${spread.toFixed(2).padEnd(8)} ` +
        `${('$' + queue).padEnd(8)} ` +
        `${String(fills).padEnd(8)} ` +
        `${String(rts).padEnd(6)} ` +
        `${pnlStr.padEnd(12)} ` +
        `${avgRtStr.padEnd(10)} ` +
        `${('$' + peakInv.toFixed(0)).padEnd(10)} ` +
        `${String(finalPos).padEnd(10)} ` +
        `${fillRate.toFixed(1).padEnd(10)}`
      );
    }
  }

  console.log('='.repeat(100));
}

// ─── Main ───

async function main(): Promise<void> {
  const markets = await fetchMarkets();

  if (markets.length === 0) {
    console.error('No markets to backtest.');
    process.exit(1);
  }

  // Fetch trades for all markets
  log(`Fetching historical trades for ${markets.length} markets...`);
  const allTrades: HistoricalTrade[] = [];

  for (const market of markets) {
    log(`  Fetching trades for ${market.label} (${market.conditionId.slice(0, 16)}...)...`);
    const trades = await fetchTrades(market.conditionId);
    log(`    Got ${trades.length} trades`);
    allTrades.push(...trades);
  }

  // Apply time filters
  let filteredTrades = allTrades;
  if (startTime) {
    filteredTrades = filteredTrades.filter((t) => t.timestamp >= startTime);
    log(`Filtered to after ${new Date(startTime).toISOString()}: ${filteredTrades.length} trades`);
  }
  if (endTime) {
    filteredTrades = filteredTrades.filter((t) => t.timestamp <= endTime);
    log(`Filtered to before ${new Date(endTime).toISOString()}: ${filteredTrades.length} trades`);
  }

  log(`Total: ${filteredTrades.length} trades across ${markets.length} markets`);

  if (filteredTrades.length === 0) {
    console.error('No trades found after filtering. Check --start/--end times or market may have no trades.');
    process.exit(1);
  }

  // Show trade time range
  const sortedForRange = [...filteredTrades].sort((a, b) => a.timestamp - b.timestamp);
  log(`Time range: ${new Date(sortedForRange[0].timestamp).toISOString()} — ${new Date(sortedForRange[sortedForRange.length - 1].timestamp).toISOString()}`);
  const allTrades_final = filteredTrades;

  if (doSweep) {
    await runSweep(markets, allTrades_final);
  } else {
    const results = await runBacktest(markets, allTrades_final, {
      spread: spreadWidth,
      size: orderSize,
      queueDepth: queueDepthAheadUsd,
      eventPause: eventPauseSec,
    });
    displayResults(results, `spread=${spreadWidth} size=$${orderSize} queue=$${queueDepthAheadUsd}`);
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
