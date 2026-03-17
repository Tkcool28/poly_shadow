/**
 * Scalp Market Maker — Paper Trading Script
 *
 * Runs the paper market making engine against live CLOB WebSocket data for a specific
 * Polymarket sports event. Connects to the CLOB WS to receive real-time trades,
 * optionally starts a game feed (soccer, NBA) for event-based quote cancellation,
 * and tracks hypothetical fills, inventory, and PnL.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-mm-paper.ts --match=epl-wes-mac-2026-03-14 --spread=0.04 --size=10
 *   npx tsx src/scripts/scalp-mm-paper.ts --match=epl-ars-eve-2026-03-14 --spread=0.06 --size=15 --max-inventory=50
 *   npx tsx src/scripts/scalp-mm-paper.ts --match=nba-lal-bos-2026-03-15 --spread=0.04 --size=10
 *
 * Options:
 *   --match=<slug>       Event slug from Gamma API (required)
 *   --spread=<number>    Total spread width in price units (default: 0.04)
 *   --size=<number>      USD per side (default: 10)
 *   --max-inventory=<n>  Max one-sided USD exposure (default: 50)
 *   --stats-interval=<n> Seconds between stats printouts (default: 60)
 *   --vwap-window=<n>    Number of trades for VWAP (default: 20)
 *   --event-pause=<n>    Seconds to pause after game event (default: 30)
 *   --no-feed            Disable game feed integration (CLOB-only mode)
 *   --market-filter=<s>  Only quote markets whose label contains this string (case-insensitive)
 *   --max-loss=<n>       Max loss per match in USD before halting (default: -20)
 *   --max-inv-shares=<n> Max inventory in shares before halting (default: 200)
 *   --max-inv-usd=<n>    Max inventory in USD before halting (default: 100)
 *   --max-fills-pm=<n>   Max fills per minute before pausing (default: 20)
 *   --queue-depth=<n>    Estimated USD of queue depth ahead of us (default: 0 = disabled)
 */

import axios from 'axios';
import WebSocket from 'ws';
import { ScalpMarketMaker } from '../services/scalp/scalp-market-maker';
import type { ClobTradeEvent } from '../services/clob-market-stream';
import { SoccerFeed } from '../services/scalp/feeds/soccer-feed';
import { NbaFeed } from '../services/scalp/feeds/nba-feed';
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
const statsIntervalSec = parseInt(getArg('stats-interval') ?? '60', 10);
const vwapWindow = parseInt(getArg('vwap-window') ?? '20', 10);
const eventPauseMs = parseInt(getArg('event-pause') ?? '30', 10) * 1000;
const warmUpMs = parseInt(getArg('warm-up') ?? '10', 10) * 1000;
const maxPriceStdDev = parseFloat(getArg('max-stddev') ?? '0.03');
const noFeed = hasFlag('no-feed');
const marketFilter = getArg('market-filter')?.toLowerCase();
const maxRuntimeMin = parseInt(getArg('max-runtime') ?? '150', 10); // auto-shutdown after N minutes (default 2.5hrs)
const maxLossPerMatch = parseFloat(getArg('max-loss') ?? '-20');
const maxInventoryShares = parseInt(getArg('max-inv-shares') ?? '200', 10);
const maxInventoryUsd = parseFloat(getArg('max-inv-usd') ?? '100');
const maxFillsPerMinute = parseInt(getArg('max-fills-pm') ?? '20', 10);
const queueDepthAheadUsd = parseFloat(getArg('queue-depth') ?? '0');

if (!eventSlug) {
  console.error('Usage: npx tsx src/scripts/scalp-mm-paper.ts --match=epl-wes-mac-2026-03-14 [--spread=0.04] [--size=10]');
  process.exit(1);
}

// ─── Constants ───

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const STALE_THRESHOLD_MS = 30_000;

// ─── Types ───

interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  outcomes: string[];
  clobTokenIds: string[];
  label: string;
}

// ─── State ───

const allMarkets: MarketInfo[] = [];
const tokenToLabel = new Map<string, string>();
const tokenToMarketLabel = new Map<string, string>();
const allTokenIds: string[] = [];
const mmEngines = new Map<string, ScalpMarketMaker>(); // tokenId -> MM engine (one per YES token)

// Track real-time market best bid/ask from price_change events (order book state, not trades)
const marketBbo = new Map<string, { bestBid: number; bestAsk: number; updatedAt: number }>(); // tokenId -> BBO

// Team names extracted from event title, used to filter game events to this match only
const matchTeamNames: string[] = [];

// ─── Logging ───

function tsShort(): string {
  return new Date().toTimeString().split(' ')[0];
}

function log(msg: string): void {
  console.log(`[${tsShort()}] ${msg}`);
}

// ─── Step 1: Fetch Markets ───

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
  const eventTitle: string = event.title || event.slug || '';
  log(`Event: ${eventTitle}`);

  // Extract team names from event title for game event filtering.
  // Polymarket titles are like "Manchester United vs Aston Villa" or "Crystal Palace vs Leeds United"
  const titleParts = eventTitle.split(/\s+vs\.?\s+/i);
  if (titleParts.length === 2) {
    // Normalize team names: lowercase, strip common suffixes (FC, AFC, etc.)
    for (const part of titleParts) {
      const cleaned = part.replace(/\s*(FC|AFC|SC|CF)\s*/gi, '').trim().toLowerCase();
      if (cleaned) matchTeamNames.push(cleaned);
    }
    log(`Match teams (for event filtering): ${matchTeamNames.join(', ')}`);
  }

  const markets: any[] = event.markets ?? [];
  if (markets.length === 0) {
    console.error(`No markets found for event.`);
    process.exit(1);
  }

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

    if (clobTokenIds.length === 0) continue;

    // For NBA events, skip derivative markets (spreads, totals, player props).
    // The moneyline slug matches the event slug exactly; derivatives have suffixes.
    if (eventSlug!.toLowerCase().startsWith('nba-')) {
      const marketSlug = slug.toLowerCase();
      const hasDerivativeSuffix = /-(?:spread|total|points|rebounds|assists|blocks|steals|turnovers|1h)-/i.test(marketSlug);
      if (hasDerivativeSuffix) {
        continue;  // skip silently — there can be 30+ props per game
      }
    }

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

    // Apply market filter
    if (marketFilter && !label.toLowerCase().includes(marketFilter)) {
      log(`  Skipping market: ${label} (does not match filter "${marketFilter}")`);
      continue;
    }

    const marketInfo: MarketInfo = { slug, question, conditionId, outcomes, clobTokenIds, label };
    allMarkets.push(marketInfo);

    for (let i = 0; i < clobTokenIds.length; i++) {
      const outcomeLabel = outcomes[i] ?? (i === 0 ? 'Yes' : 'No');
      const fullLabel = `${label} ${outcomeLabel.toUpperCase()}`;
      tokenToLabel.set(clobTokenIds[i], fullLabel);
      tokenToMarketLabel.set(clobTokenIds[i], label);
      allTokenIds.push(clobTokenIds[i]);
    }

    log(`  Market: ${label} [${conditionId.slice(0, 12)}...] — ${clobTokenIds.length} tokens`);
  }

  if (allTokenIds.length === 0) {
    console.error('No valid token IDs found.');
    process.exit(1);
  }

  log(`Total: ${allMarkets.length} markets, ${allTokenIds.length} token IDs`);
}

// ─── Step 2: Create MM Engines ───

function createEngines(): void {
  // Create one MM engine per YES token (index 0 of each market's clobTokenIds)
  for (const market of allMarkets) {
    const yesTokenId = market.clobTokenIds[0];
    if (!yesTokenId) continue;

    const label = `${market.label} YES`;

    const mm = new ScalpMarketMaker(
      {
        spreadWidth,
        orderSize,
        maxInventory,
        isPaper: true,
        vwapWindow,
        eventPauseMs,
        warmUpMs,
        maxPriceStdDev,
        queueDepthAheadUsd,
        riskLimits: {
          maxLossPerMatch,
          maxInventoryShares,
          maxInventoryUsd,
          maxFillsPerMinute,
        },
      },
      yesTokenId,
      label,
      (msg) => console.log(msg),
    );

    mmEngines.set(yesTokenId, mm);
    log(`Created MM engine: ${label}`);
  }
}

// ─── Step 3: CLOB WebSocket ───

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let lastMessageAt = 0;
let reconnecting = false;
let totalTradesReceived = 0;
let wsReconnectCount = 0;
let wsConnectedAt = 0;

function connectClobWs(): void {
  log('Connecting to CLOB WebSocket...');

  ws = new WebSocket(CLOB_WS_URL);

  ws.on('open', () => {
    log(`Connected to CLOB WS, subscribing to ${allTokenIds.length} tokens${wsReconnectCount > 0 ? ` (reconnect #${wsReconnectCount})` : ''}`);
    reconnecting = false;
    lastMessageAt = Date.now();
    wsConnectedAt = Date.now();

    const msg = JSON.stringify({
      assets_ids: allTokenIds,
      type: 'market',
      custom_feature_enabled: true,
    });
    ws!.send(msg);

    // Start ping
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        // Stale check
        if (lastMessageAt > 0 && Date.now() - lastMessageAt > STALE_THRESHOLD_MS) {
          log('CLOB WS stale, forcing reconnect...');
          ws.terminate();
          return;
        }
        ws.send('PING');
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data: WebSocket.Data) => {
    const raw = data.toString();
    if (raw === 'PONG') {
      lastMessageAt = Date.now();
      return;
    }

    lastMessageAt = Date.now();

    try {
      const parsed = JSON.parse(raw);
      const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (item.event_type === 'last_trade_price') {
          totalTradesReceived++;
          dispatchTrade(item as ClobTradeEvent);
        }
        // NOTE: price_change events are ORDER BOOK STATE changes (total size at a price level),
        // NOT actual trades. Their `size` field is total resting volume (e.g. 37,847 shares),
        // not a trade size. Using them as trade proxies would massively inflate VWAP and
        // trigger false fills. Only `last_trade_price` events represent real trades.
        //
        // However, price_change events contain best_bid/best_ask which we track for spread analysis.
        if (item.event_type === 'price_change' && item.price_changes) {
          for (const pc of item.price_changes) {
            if (pc.asset_id && pc.best_bid && pc.best_ask) {
              marketBbo.set(pc.asset_id, {
                bestBid: parseFloat(pc.best_bid),
                bestAsk: parseFloat(pc.best_ask),
                updatedAt: Date.now(),
              });
            }
          }
        }
      }
    } catch {
      // Non-JSON (subscription ack, etc.)
    }
  });

  ws.on('close', (code: number) => {
    wsReconnectCount++;
    const uptimeSec = wsConnectedAt > 0 ? Math.round((Date.now() - wsConnectedAt) / 1000) : 0;
    log(`CLOB WS closed (code ${code}) after ${uptimeSec}s uptime, reconnecting in 3s... (reconnect #${wsReconnectCount})`);
    if (pingTimer) clearInterval(pingTimer);
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(connectClobWs, 3000);
    }
  });

  ws.on('error', (err: Error) => {
    log(`CLOB WS error: ${err.message}`);
  });
}

function dispatchTrade(event: ClobTradeEvent): void {
  // Forward to all MM engines — each filters by its own tokenId internally
  for (const mm of mmEngines.values()) {
    mm.onTrade(event);
  }
}

// ─── Step 4: Game Feed (optional) ───

let soccerFeed: SoccerFeed | null = null;
let nbaFeed: NbaFeed | null = null;

async function startGameFeed(): Promise<void> {
  if (noFeed) {
    log('Game feed disabled (--no-feed)');
    return;
  }

  // Determine feed type from slug prefix
  const slugLower = eventSlug!.toLowerCase();

  // Recognize all soccer league slug prefixes
  // Note: actual Polymarket slug prefixes (from Gamma API series discovery):
  // EPL=epl-, LaLiga=lal-, UCL=ucl-, SerieA=sea-, Ligue1=fl1-, Bundesliga=bun-, MLS=mls-, UEL=uel-
  const soccerPrefixes = ['epl-', 'eng-', 'lal-', 'ucl-', 'sea-', 'fl1-', 'bun-', 'uel-', 'ere-', 'scop-', 'mls-'];
  const isSoccer = soccerPrefixes.some((p) => slugLower.startsWith(p));

  if (isSoccer) {
    log(`Starting soccer feed for ${slugLower.split('-')[0].toUpperCase()} event detection...`);

    // SoccerFeed reads config at import time — defaults are:
    //   SCALP_SOCCER_ENABLED=true, SCALP_SOCCER_LEAGUES=eng.1, poll=15s
    // Override via .env or shell env before running this script if needed.

    soccerFeed = new SoccerFeed();
    soccerFeed.onEvent((event: GameEvent) => {
      // Filter: only forward events that involve THIS match's teams.
      // The soccer feed watches ALL EPL matches, but each process only cares about one match.
      if (matchTeamNames.length > 0) {
        const eventTeams = [event.winner, event.loser]
          .map((t) => t.toLowerCase());
        const isOurMatch = matchTeamNames.some((team) =>
          eventTeams.some((et) => et.includes(team) || team.includes(et)),
        );
        if (!isOurMatch) {
          log(`EVENT FILTERED OUT (not our match): ${event.eventType} ${event.winner} vs ${event.loser}`);
          return;
        }
      }

      // Forward to all MM engines for this match
      for (const mm of mmEngines.values()) {
        mm.onGameEvent(event);
      }
    });

    try {
      await soccerFeed.start();
      log('Soccer feed started');
    } catch (err: any) {
      log(`Soccer feed failed to start: ${err.message}`);
      log('Continuing without game feed...');
      soccerFeed = null;
    }
  } else if (slugLower.startsWith('nba-')) {
    log('Starting NBA feed for event detection (scoring runs, lead changes)...');

    nbaFeed = new NbaFeed();
    nbaFeed.onEvent((event: GameEvent) => {
      // Filter: only forward events that involve THIS match's teams.
      // The NBA feed watches ALL live games, but each process only cares about one game.
      // NBA event.winner/loser use team nicknames (e.g., "Warriors", "Knicks") which match
      // the Polymarket outcome names and our matchTeamNames extracted from the event title.
      if (matchTeamNames.length > 0) {
        const eventTeams = [event.winner, event.loser]
          .map((t) => t.toLowerCase());
        const isOurMatch = matchTeamNames.some((team) =>
          eventTeams.some((et) => et.includes(team) || team.includes(et)),
        );
        if (!isOurMatch) {
          log(`EVENT FILTERED OUT (not our game): ${event.eventType} ${event.winner} vs ${event.loser}`);
          return;
        }
      }

      // Forward to all MM engines for this game
      for (const mm of mmEngines.values()) {
        mm.onGameEvent(event);
      }
    });

    try {
      await nbaFeed.start();
      log('NBA feed started');
    } catch (err: any) {
      log(`NBA feed failed to start: ${err.message}`);
      log('Continuing without game feed...');
      nbaFeed = null;
    }
  } else {
    log(`No game feed available for slug prefix: ${slugLower.split('-')[0]}`);
  }
}

// ─── Step 5: Stats Timer ───

let statsTimer: ReturnType<typeof setInterval> | null = null;

function startStatsTimer(): void {
  statsTimer = setInterval(() => {
    log('');
    log('--- PERIODIC STATS ---');
    for (const mm of mmEngines.values()) {
      mm.printStats();
    }
    const wsUptime = wsConnectedAt > 0 ? Math.round((Date.now() - wsConnectedAt) / 1000) : 0;
    const wsStaleSec = lastMessageAt > 0 ? Math.round((Date.now() - lastMessageAt) / 1000) : 0;
    const wsStatus = ws?.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSED';
    log(`WS trades=${totalTradesReceived} status=${wsStatus} uptime=${wsUptime}s lastMsg=${wsStaleSec}s ago reconnects=${wsReconnectCount}`);
    // Market BBO (best bid/ask from price_change events)
    for (const [tokenId, mm] of mmEngines.entries()) {
      const bbo = marketBbo.get(tokenId);
      const mmState = mm.getState();
      if (bbo) {
        const mktSpread = ((bbo.bestAsk - bbo.bestBid) * 100).toFixed(1);
        const staleSec = Math.round((Date.now() - bbo.updatedAt) / 1000);
        const quoteSpread = mmState.isQuoting ? ((mmState.askPrice - mmState.bidPrice) * 100).toFixed(1) : '-';
        log(`  BBO ${mm.getStats().label.padEnd(25)} mktBid=${bbo.bestBid.toFixed(2)} mktAsk=${bbo.bestAsk.toFixed(2)} mktSpread=${mktSpread}c ourSpread=${quoteSpread}c (${staleSec}s ago)`);
      }
    }
    // Feed health
    if (soccerFeed) {
      log(`Soccer feed: ${soccerFeed.isHealthy() ? 'HEALTHY' : 'UNHEALTHY'}`);
    }
    if (nbaFeed) {
      log(`NBA feed: ${nbaFeed.isHealthy() ? 'HEALTHY' : 'UNHEALTHY'}`);
    }
    log('');
  }, statsIntervalSec * 1000);
}

// ─── Step 6: Shutdown ───

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  log('');
  log('='.repeat(80));
  log('SHUTTING DOWN — FINAL SUMMARY');
  log('='.repeat(80));
  log('');

  log(`Event: ${eventSlug}`);
  log(`Config: spread=${spreadWidth} size=$${orderSize} maxInventory=$${maxInventory} vwap=${vwapWindow}`);
  log(`CLOB trades received: ${totalTradesReceived}`);
  log(`WS reconnects: ${wsReconnectCount}`);
  if (soccerFeed) log(`Soccer feed: ${soccerFeed.isHealthy() ? 'HEALTHY' : 'UNHEALTHY'}`);
  if (nbaFeed) log(`NBA feed: ${nbaFeed.isHealthy() ? 'HEALTHY' : 'UNHEALTHY'}`);
  log('');

  for (const mm of mmEngines.values()) {
    mm.stop();
    const stats = mm.getStats();
    log('');
    log(`--- ${stats.label} ---`);
    log(`  Trades processed: ${stats.tradesProcessed}`);
    log(`  Total fills: ${stats.state.totalFills} (${stats.state.totalBidFills} bids, ${stats.state.totalAskFills} asks)`);
    log(`  Round trips: ${stats.state.totalRoundTrips}`);
    log(`  Realized PnL: ${stats.state.realizedPnl >= 0 ? '+' : '-'}$${Math.abs(stats.state.realizedPnl).toFixed(2)}`);
    log(`  Unrealized PnL: ${stats.state.unrealizedPnl >= 0 ? '+' : '-'}$${Math.abs(stats.state.unrealizedPnl).toFixed(2)}`);
    const totalPnl = stats.state.realizedPnl + stats.state.unrealizedPnl;
    log(`  Total PnL: ${totalPnl >= 0 ? '+' : '-'}$${Math.abs(totalPnl).toFixed(2)}`);
    log(`  Final inventory: ${stats.state.position} shares`);
    if (stats.state.totalRoundTrips > 0) {
      log(`  Avg spread capture: ${stats.avgSpreadCapture >= 0 ? '+' : '-'}$${Math.abs(stats.avgSpreadCapture).toFixed(3)}/RT`);
    }
    const uptimeMin = stats.uptimeMs / 60_000;
    if (uptimeMin > 1) {
      log(`  Fill rate: ${stats.fillRate.toFixed(1)} fills/hr`);
      log(`  RT rate: ${stats.roundTripRate.toFixed(1)} RTs/hr`);
    }
    const riskState = mm.getRiskLimits().getState();
    log(`  Risk: halts=${riskState.totalHalts} pauses=${riskState.totalPauses} peak=${riskState.peakPnl >= 0 ? '+' : '-'}$${Math.abs(riskState.peakPnl).toFixed(2)}`);
    const hbStats = mm.getHeartbeat().getStats();
    log(`  Heartbeat: sent=${hbStats.totalSent} failed=${hbStats.totalFailed} healthy=${mm.getHeartbeat().isHealthy()}`);
    const queueStats = mm.getQueueStats();
    if (queueStats.queueDepthUsd > 0) {
      log(`  Queue: depth=$${queueStats.queueDepthUsd} skipped=${queueStats.skippedFills} accProb=${queueStats.accumulatedProb.toFixed(2)}`);
    }
  }

  log('');
  log('='.repeat(80));

  // Write JSON summary for programmatic analysis
  const summaryData: Record<string, any> = {
    event: eventSlug,
    config: { spreadWidth, orderSize, maxInventory, vwapWindow, warmUpMs, maxPriceStdDev },
    totalTradesReceived,
    shutdownAt: new Date().toISOString(),
    markets: {} as Record<string, any>,
  };

  for (const mm of mmEngines.values()) {
    const stats = mm.getStats();
    summaryData.markets[stats.label] = {
      tokenId: stats.tokenId,
      tradesProcessed: stats.tradesProcessed,
      totalFills: stats.state.totalFills,
      bidFills: stats.state.totalBidFills,
      askFills: stats.state.totalAskFills,
      roundTrips: stats.state.totalRoundTrips,
      realizedPnl: stats.state.realizedPnl,
      unrealizedPnl: stats.state.unrealizedPnl,
      totalPnl: stats.state.realizedPnl + stats.state.unrealizedPnl,
      finalPosition: stats.state.position,
      avgSpreadCapture: stats.avgSpreadCapture,
      fillRate: stats.fillRate,
      roundTripRate: stats.roundTripRate,
      uptimeMs: stats.uptimeMs,
    };
  }

  log('');
  log('JSON_SUMMARY:' + JSON.stringify(summaryData));
  log('');

  // Cleanup
  if (statsTimer) clearInterval(statsTimer);
  if (pingTimer) clearInterval(pingTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, 'Shutdown');
  }
  if (soccerFeed) soccerFeed.stop();
  if (nbaFeed) nbaFeed.stop();

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Main ───

async function main(): Promise<void> {
  log('='.repeat(80));
  log('Scalp Market Maker — Paper Mode');
  log(`Event: ${eventSlug}`);
  log(`Config: spread=${spreadWidth} size=$${orderSize} maxInventory=$${maxInventory} vwap=${vwapWindow} eventPause=${eventPauseMs / 1000}s warmUp=${warmUpMs / 1000}s maxStdDev=${maxPriceStdDev}`);
  log(`Risk limits: maxLoss=$${maxLossPerMatch} maxInvShares=${maxInventoryShares} maxInvUsd=$${maxInventoryUsd} maxFills/min=${maxFillsPerMinute}`);
  if (queueDepthAheadUsd > 0) {
    log(`Queue modeling: $${queueDepthAheadUsd} estimated depth ahead of us per level`);
  }
  log('='.repeat(80));
  log('');

  // Fetch market data
  await fetchMarkets();
  log('');

  // Create MM engines
  createEngines();
  log('');

  // Start game feed
  await startGameFeed();
  log('');

  // Start all engines (async for heartbeat initialization)
  for (const mm of mmEngines.values()) {
    await mm.start();
  }

  // Connect to CLOB WebSocket
  connectClobWs();

  // Start stats timer
  startStatsTimer();

  // Auto-shutdown timer
  if (maxRuntimeMin > 0) {
    setTimeout(() => {
      log(`Auto-shutdown after ${maxRuntimeMin} minutes`);
      shutdown();
    }, maxRuntimeMin * 60 * 1000);
  }

  log('');
  log('Paper MM running. Press Ctrl+C to stop.');
  log(`Stats every ${statsIntervalSec}s. Watching ${mmEngines.size} markets. Auto-shutdown in ${maxRuntimeMin}min.`);
  log('');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
