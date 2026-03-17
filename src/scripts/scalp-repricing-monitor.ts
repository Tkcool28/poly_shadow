/**
 * Scalp Repricing Monitor
 *
 * Measures how quickly Polymarket EPL markets reprice after a goal.
 * Simultaneously monitors ESPN scoreboard (poll) and CLOB WebSocket (stream)
 * to capture the exact timing relationship between real-world events and market movements.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-repricing-monitor.ts --match=epl-ars-eve-2026-03-14
 *   npx tsx src/scripts/scalp-repricing-monitor.ts --match=epl-wes-mac-2026-03-14
 */

import axios from 'axios';
import WebSocket from 'ws';

// ─── CLI Args ───

const args = process.argv.slice(2);
const matchArg = args.find((a) => a.startsWith('--match='));
const eventSlug = matchArg?.split('=')[1];

if (!eventSlug) {
  console.error('Usage: npx tsx src/scripts/scalp-repricing-monitor.ts --match=epl-ars-eve-2026-03-14');
  process.exit(1);
}

// ─── Constants ───

const GAMMA_EVENTS_URL = 'https://gamma-api.polymarket.com/events';
const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const ESPN_SCOREBOARD_URL = 'https://site.api.espn.com/apis/site/v2/sports/soccer/eng.1/scoreboard';
const ESPN_POLL_INTERVAL_MS = 5_000;
const PING_INTERVAL_MS = 10_000;
const GOAL_CAPTURE_WINDOW_MS = 60_000;

// ─── Types ───

interface MarketInfo {
  slug: string;
  question: string;
  conditionId: string;
  outcomes: string[];
  clobTokenIds: string[];
  /** Which team this "Win" market belongs to, or "Draw" */
  label: string;
}

interface ClobTrade {
  timestamp: number; // ms since epoch
  assetId: string;
  price: number;
  size: number;
  side: string;
  market: string;
}

interface GoalEvent {
  detectedAt: number; // ms since epoch
  team: string;
  score: string;
  minute: string;
  preGoalPrices: Map<string, number>; // label -> last traded price before goal
  trades: ClobTrade[]; // trades captured in the 60s window after detection
  captureEndAt: number; // when to stop capturing
}

// ─── State ───

const allMarkets: MarketInfo[] = [];
const tokenToLabel = new Map<string, string>(); // tokenId -> "Arsenal Win YES" etc.
const tokenToMarketLabel = new Map<string, string>(); // tokenId -> "Arsenal Win"
const allTokenIds: string[] = [];
const tradeBuffer: ClobTrade[] = [];
const lastPriceByLabel = new Map<string, number>(); // "Arsenal Win" -> last traded price
const goalEvents: GoalEvent[] = [];
let activeGoalCapture: GoalEvent | null = null;

// ESPN state
let prevHomeScore: number | null = null;
let prevAwayScore: number | null = null;
let homeTeamName = '';
let awayTeamName = '';
let matchFound = false;

// ─── Logging Helpers ───

function ts(): string {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

function tsShort(): string {
  const d = new Date();
  return d.toTimeString().split(' ')[0] + '.' + String(d.getMilliseconds()).padStart(3, '0');
}

function logInfo(msg: string): void {
  console.log(`[${tsShort()}] ${msg}`);
}

function logTrade(label: string, price: number, size: number, side: string, tOffset?: string): void {
  const offsetStr = tOffset ? ` (${tOffset})` : '';
  console.log(`[${tsShort()}] TRADE ${label}: ${price.toFixed(3)} x ${size.toFixed(1)} shares [${side}]${offsetStr}`);
}

// ─── Step 1: Fetch markets from Gamma API ───

async function fetchMarkets(): Promise<void> {
  logInfo(`Fetching markets for event slug: ${eventSlug}`);

  // Try fetching by slug parameter
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
  logInfo(`Event: ${event.title || event.slug}`);

  const markets: any[] = event.markets ?? [];
  if (markets.length === 0) {
    console.error(`No markets found for event. Check slug: ${eventSlug}`);
    process.exit(1);
  }

  for (const m of markets) {
    const slug = m.slug ?? '';
    const question: string = m.question ?? '';
    const conditionId: string = m.conditionId ?? '';

    // Parse outcomes
    let outcomes: string[];
    if (typeof m.outcomes === 'string') {
      try { outcomes = JSON.parse(m.outcomes); } catch { outcomes = []; }
    } else if (Array.isArray(m.outcomes)) {
      outcomes = m.outcomes;
    } else {
      outcomes = [];
    }

    // Parse clobTokenIds
    let clobTokenIds: string[];
    if (typeof m.clobTokenIds === 'string') {
      try { clobTokenIds = JSON.parse(m.clobTokenIds); } catch { clobTokenIds = []; }
    } else if (Array.isArray(m.clobTokenIds)) {
      clobTokenIds = m.clobTokenIds;
    } else {
      clobTokenIds = [];
    }

    if (clobTokenIds.length === 0) continue;

    // Determine label — clean up verbose question format
    let label: string;
    const qLower = question.toLowerCase();
    if (qLower.includes('draw')) {
      label = 'Draw';
    } else {
      // "Will Arsenal FC win on 2026-03-14?" -> "Arsenal Win"
      const winMatch = question.match(/^will\s+(.+?)\s+win\b/i);
      label = winMatch
        ? winMatch[1].replace(/\s*(FC|AFC)\s*/gi, '').trim() + ' Win'
        : question;
    }

    const marketInfo: MarketInfo = { slug, question, conditionId, outcomes, clobTokenIds, label };
    allMarkets.push(marketInfo);

    // Map each token ID to its label
    for (let i = 0; i < clobTokenIds.length; i++) {
      const outcomeLabel = outcomes[i] ?? (i === 0 ? 'Yes' : 'No');
      const fullLabel = `${label} ${outcomeLabel.toUpperCase()}`;
      tokenToLabel.set(clobTokenIds[i], fullLabel);
      tokenToMarketLabel.set(clobTokenIds[i], label);
      allTokenIds.push(clobTokenIds[i]);
    }

    logInfo(`  Market: ${label} [${conditionId.slice(0, 12)}...] — ${clobTokenIds.length} tokens`);
  }

  if (allTokenIds.length === 0) {
    console.error('No valid token IDs found. Cannot monitor.');
    process.exit(1);
  }

  logInfo(`Total: ${allMarkets.length} markets, ${allTokenIds.length} token IDs to watch`);
}

// ─── Step 2: CLOB WebSocket Connection ───

let ws: WebSocket | null = null;
let pingTimer: ReturnType<typeof setInterval> | null = null;
let reconnecting = false;

function connectClobWs(): void {
  logInfo('Connecting to CLOB WebSocket...');

  ws = new WebSocket(CLOB_WS_URL);

  ws.on('open', () => {
    logInfo(`Connected to CLOB WS, watching ${allTokenIds.length} tokens`);
    reconnecting = false;

    // Subscribe to all token IDs
    const subscribeMsg = JSON.stringify({
      assets_ids: allTokenIds,
      type: 'market',
      custom_feature_enabled: true,
    });
    ws!.send(subscribeMsg);

    // Start ping
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (ws?.readyState === WebSocket.OPEN) {
        ws.send('PING');
      }
    }, PING_INTERVAL_MS);
  });

  ws.on('message', (data: WebSocket.Data) => {
    const raw = data.toString();
    if (raw === 'PONG') return;

    try {
      const parsed = JSON.parse(raw);
      const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

      for (const item of items) {
        if (item.event_type === 'last_trade_price') {
          handleTradeEvent(item);
        } else if (item.event_type === 'price_change' && item.price_changes) {
          for (const pc of item.price_changes) {
            if (!pc.asset_id || !pc.price || !pc.size || !pc.side) continue;
            handleTradeEvent({
              asset_id: pc.asset_id,
              market: item.market || '',
              price: pc.price,
              size: pc.size,
              side: pc.side,
              timestamp: item.timestamp || String(Date.now()),
              event_type: 'last_trade_price',
            });
          }
        }
      }
    } catch {
      // Non-JSON (subscription ack, etc.)
    }
  });

  ws.on('close', (code: number) => {
    logInfo(`CLOB WS closed (code ${code}), reconnecting in 3s...`);
    if (pingTimer) clearInterval(pingTimer);
    if (!reconnecting) {
      reconnecting = true;
      setTimeout(connectClobWs, 3000);
    }
  });

  ws.on('error', (err: Error) => {
    logInfo(`CLOB WS error: ${err.message}`);
  });
}

function handleTradeEvent(item: any): void {
  const assetId: string = item.asset_id;
  const price = parseFloat(item.price);
  const size = parseFloat(item.size);
  const side: string = item.side ?? 'UNKNOWN';
  const tradeTs = item.timestamp ? parseInt(item.timestamp, 10) : Date.now();

  if (isNaN(price) || isNaN(size) || size <= 0) return;

  const label = tokenToLabel.get(assetId) ?? `Unknown(${assetId.slice(0, 12)}...)`;
  const marketLabel = tokenToMarketLabel.get(assetId) ?? label;

  const trade: ClobTrade = {
    timestamp: Date.now(), // when WE received it (local clock)
    assetId,
    price,
    size,
    side,
    market: marketLabel,
  };

  // Update last price
  lastPriceByLabel.set(marketLabel, price);

  // Always buffer the trade
  tradeBuffer.push(trade);

  // Keep buffer manageable (last 10 minutes)
  if (tradeBuffer.length > 10_000) {
    tradeBuffer.splice(0, tradeBuffer.length - 5_000);
  }

  // If we're in a goal capture window, add to goal event
  if (activeGoalCapture && Date.now() <= activeGoalCapture.captureEndAt) {
    activeGoalCapture.trades.push(trade);
    const tOffsetMs = Date.now() - activeGoalCapture.detectedAt;
    const tOffsetStr = `T+${(tOffsetMs / 1000).toFixed(1)}s`;
    logTrade(label, price, size, side, tOffsetStr);
  } else if (activeGoalCapture && Date.now() > activeGoalCapture.captureEndAt) {
    // Capture window ended — print summary
    printGoalSummary(activeGoalCapture);
    activeGoalCapture = null;
  } else {
    // Normal operation — log all YES trades and significant NO trades (skip dust)
    const usdValue = price * size;
    if (usdValue >= 5) {
      logTrade(label, price, size, side);
    }
  }
}

// ─── Step 3: ESPN Scoreboard Polling ───

let espnTimer: ReturnType<typeof setInterval> | null = null;

function startEspnPolling(): void {
  logInfo(`Starting ESPN poll every ${ESPN_POLL_INTERVAL_MS / 1000}s for EPL scoreboard`);

  // Immediate first poll
  pollEspn();

  espnTimer = setInterval(pollEspn, ESPN_POLL_INTERVAL_MS);
}

async function pollEspn(): Promise<void> {
  try {
    const response = await axios.get(ESPN_SCOREBOARD_URL, {
      timeout: 10_000,
      headers: { Accept: 'application/json' },
    });

    const events: any[] = response.data?.events ?? [];

    for (const event of events) {
      const competition = event.competitions?.[0];
      if (!competition) continue;

      // Try to match this ESPN event to our monitored match
      const homeComp = competition.competitors?.find((c: any) => c.homeAway === 'home');
      const awayComp = competition.competitors?.find((c: any) => c.homeAway === 'away');
      if (!homeComp || !awayComp) continue;

      const espnHome = homeComp.team?.displayName ?? '';
      const espnAway = awayComp.team?.displayName ?? '';

      // Match by checking if ESPN team names appear in our market labels
      const matchesOurEvent = isMatchingEvent(espnHome, espnAway);
      if (!matchesOurEvent) continue;

      // Found our match
      if (!matchFound) {
        homeTeamName = espnHome;
        awayTeamName = espnAway;
        matchFound = true;
        logInfo(`Monitoring ${homeTeamName} vs ${awayTeamName} (${eventSlug})`);
      }

      const homeScore = parseInt(homeComp.score ?? '0', 10) || 0;
      const awayScore = parseInt(awayComp.score ?? '0', 10) || 0;
      const status = competition.status;
      const period = status?.period ?? 0;
      const displayClock = status?.displayClock ?? '';
      const stateType = status?.type?.state ?? 'pre';

      if (stateType === 'pre') {
        logInfo(`Match not started yet: ${homeTeamName} vs ${awayTeamName}`);
        return;
      }

      // Initialize scores on first poll
      if (prevHomeScore === null || prevAwayScore === null) {
        prevHomeScore = homeScore;
        prevAwayScore = awayScore;
        logInfo(`Initial score: ${homeTeamName} ${homeScore} - ${awayScore} ${awayTeamName} (${periodLabel(period)} ${displayClock})`);
        return;
      }

      // Detect goals
      const homeDelta = homeScore - prevHomeScore;
      const awayDelta = awayScore - prevAwayScore;

      if (homeDelta > 0) {
        onGoalDetected(homeTeamName, awayTeamName, homeScore, awayScore, periodLabel(period), displayClock);
      }
      if (awayDelta > 0) {
        onGoalDetected(awayTeamName, homeTeamName, homeScore, awayScore, periodLabel(period), displayClock);
      }

      prevHomeScore = homeScore;
      prevAwayScore = awayScore;

      if (stateType === 'post') {
        logInfo(`Match ended: ${homeTeamName} ${homeScore} - ${awayScore} ${awayTeamName}`);
      }

      return; // Found our match, no need to check more events
    }

    if (!matchFound) {
      // Log once that the match hasn't been found yet
      const liveCount = events.filter((e: any) => e.competitions?.[0]?.status?.type?.state === 'in').length;
      logInfo(`ESPN: ${events.length} events, ${liveCount} live — our match not found yet (check slug)`);
    }
  } catch (err: any) {
    logInfo(`ESPN poll error: ${err.message}`);
  }
}

function isMatchingEvent(espnHome: string, espnAway: string): boolean {
  // Extract team abbreviations from slug: epl-ars-eve-2026-03-14
  const slugParts = eventSlug!.split('-');
  if (slugParts.length < 4) return false;
  const abbr1 = slugParts[1].toLowerCase(); // e.g., "ars"
  const abbr2 = slugParts[2].toLowerCase(); // e.g., "eve"

  const homeNorm = espnHome.toLowerCase();
  const awayNorm = espnAway.toLowerCase();

  // Check if the abbreviations match the start of the ESPN team names
  // "ars" matches "arsenal", "eve" matches "everton", "wes" matches "west ham", "mac" matches "manchester city"
  // Also handle: "che" -> "chelsea", "new" -> "newcastle"
  const homeMatch = homeNorm.startsWith(abbr1) || awayNorm.startsWith(abbr1);
  const awayMatch = homeNorm.startsWith(abbr2) || awayNorm.startsWith(abbr2);

  // Also check market labels for a secondary match
  if (homeMatch && awayMatch) return true;

  // Fallback: check if market labels contain the ESPN team names
  for (const market of allMarkets) {
    const labelLower = market.label.toLowerCase();
    if (labelLower.includes(espnHome.toLowerCase().split(' ')[0]) ||
        labelLower.includes(espnAway.toLowerCase().split(' ')[0])) {
      return true;
    }
  }

  return false;
}

function periodLabel(period: number): string {
  if (period === 1) return '1H';
  if (period === 2) return '2H';
  if (period > 2) return 'ET';
  return `P${period}`;
}

// ─── Step 4: Goal Detection Handler ───

function onGoalDetected(
  scoringTeam: string,
  concedingTeam: string,
  homeScore: number,
  awayScore: number,
  period: string,
  minute: string,
): void {
  const now = Date.now();
  const score = `${homeScore}-${awayScore}`;

  logInfo('');
  logInfo('='.repeat(80));
  logInfo(`GOAL! ${scoringTeam} scores (${score} at ${minute}' ${period}) -- detected via ESPN`);
  logInfo('='.repeat(80));

  // Snapshot pre-goal prices
  const preGoalPrices = new Map(lastPriceByLabel);
  for (const [label, price] of preGoalPrices) {
    logInfo(`  Pre-goal ${label}: ${price.toFixed(3)}`);
  }

  // Start capture window
  const goalEvent: GoalEvent = {
    detectedAt: now,
    team: scoringTeam,
    score,
    minute,
    preGoalPrices,
    trades: [],
    captureEndAt: now + GOAL_CAPTURE_WINDOW_MS,
  };

  goalEvents.push(goalEvent);
  activeGoalCapture = goalEvent;

  logInfo(`Capturing all CLOB trades for the next ${GOAL_CAPTURE_WINDOW_MS / 1000}s...`);
  logInfo('');

  // Also capture recent trades from the buffer (last 10 seconds before goal)
  const lookbackMs = 10_000;
  const recentTrades = tradeBuffer.filter((t) => t.timestamp >= now - lookbackMs && t.timestamp < now);
  if (recentTrades.length > 0) {
    logInfo(`  Recent trades (last ${lookbackMs / 1000}s before goal detection):`);
    for (const t of recentTrades) {
      const label = tokenToLabel.get(t.assetId) ?? t.market;
      const tOffsetMs = t.timestamp - now;
      logInfo(`    [T${(tOffsetMs / 1000).toFixed(1)}s] ${label}: ${t.price.toFixed(3)} x ${t.size.toFixed(1)} [${t.side}]`);
    }
    logInfo('');
  }

  // Schedule summary print after capture window
  setTimeout(() => {
    if (activeGoalCapture === goalEvent) {
      printGoalSummary(goalEvent);
      activeGoalCapture = null;
    }
  }, GOAL_CAPTURE_WINDOW_MS + 1000);
}

// ─── Step 5: Goal Summary ───

function printGoalSummary(goal: GoalEvent): void {
  logInfo('');
  logInfo('='.repeat(80));
  logInfo(`Goal summary: ${goal.team} scores (${goal.score}) at ${goal.minute}'`);
  logInfo(`  ESPN detection timestamp: ${new Date(goal.detectedAt).toISOString()}`);
  logInfo(`  Total trades captured in 60s window: ${goal.trades.length}`);
  logInfo('');

  // Group trades by market label
  const tradesByMarket = new Map<string, ClobTrade[]>();
  for (const t of goal.trades) {
    const label = t.market;
    if (!tradesByMarket.has(label)) tradesByMarket.set(label, []);
    tradesByMarket.get(label)!.push(t);
  }

  for (const [marketLabel, trades] of tradesByMarket) {
    const prePrice = goal.preGoalPrices.get(marketLabel);
    if (trades.length === 0) continue;

    // Sort by time
    trades.sort((a, b) => a.timestamp - b.timestamp);

    const firstTrade = trades[0];
    const lastTrade = trades[trades.length - 1];

    const firstTradeOffset = (firstTrade.timestamp - goal.detectedAt) / 1000;
    const lastTradeOffset = (lastTrade.timestamp - goal.detectedAt) / 1000;

    // Find the price trajectory
    const pricePoints: { offsetS: number; price: number }[] = trades.map((t) => ({
      offsetS: (t.timestamp - goal.detectedAt) / 1000,
      price: t.price,
    }));

    // Calculate move statistics
    const finalPrice = lastTrade.price;
    const startPrice = prePrice ?? firstTrade.price;
    const totalMove = finalPrice - startPrice;
    const absTotalMove = Math.abs(totalMove);

    // Find when 50% and 90% of the move was complete
    let halfMoveTime: number | null = null;
    let ninetyMoveTime: number | null = null;
    const halfTarget = startPrice + totalMove * 0.5;
    const ninetyTarget = startPrice + totalMove * 0.9;

    for (const pp of pricePoints) {
      if (totalMove > 0) {
        if (halfMoveTime === null && pp.price >= halfTarget) halfMoveTime = pp.offsetS;
        if (ninetyMoveTime === null && pp.price >= ninetyTarget) ninetyMoveTime = pp.offsetS;
      } else if (totalMove < 0) {
        if (halfMoveTime === null && pp.price <= halfTarget) halfMoveTime = pp.offsetS;
        if (ninetyMoveTime === null && pp.price <= ninetyTarget) ninetyMoveTime = pp.offsetS;
      }
    }

    // Find first significant move (>2 cent change)
    let firstSigMoveTime: number | null = null;
    for (const pp of pricePoints) {
      if (Math.abs(pp.price - startPrice) >= 0.02) {
        firstSigMoveTime = pp.offsetS;
        break;
      }
    }

    logInfo(`  ${marketLabel}:`);
    logInfo(`    Pre-goal price: ${startPrice.toFixed(3)}`);
    logInfo(`    Final price (T+60s): ${finalPrice.toFixed(3)}`);
    logInfo(`    Total move: ${totalMove >= 0 ? '+' : ''}${(totalMove * 100).toFixed(1)} cents over ${lastTradeOffset.toFixed(1)}s`);
    logInfo(`    Trades in window: ${trades.length}`);
    if (firstSigMoveTime !== null) {
      logInfo(`    First significant move (>=2c): T+${firstSigMoveTime.toFixed(1)}s`);
    }
    if (halfMoveTime !== null) {
      logInfo(`    50% of move complete by: T+${halfMoveTime.toFixed(1)}s`);
    }
    if (ninetyMoveTime !== null) {
      logInfo(`    90% of move complete by: T+${ninetyMoveTime.toFixed(1)}s`);
    }

    // Price time series (sample at intervals)
    logInfo(`    Price time series:`);
    const intervals = [0, 1, 2, 3, 5, 10, 15, 20, 30, 45, 60];
    for (const sec of intervals) {
      // Find the closest trade at or before this time
      const tradesBeforeSec = pricePoints.filter((pp) => pp.offsetS <= sec);
      if (tradesBeforeSec.length > 0) {
        const latest = tradesBeforeSec[tradesBeforeSec.length - 1];
        const delta = latest.price - startPrice;
        logInfo(`      T+${String(sec).padStart(2)}s: ${latest.price.toFixed(3)} (${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(1)}c)`);
      }
    }

    logInfo('');
  }

  // Net window assessment
  logInfo('  --- Assessment ---');
  const espnLatencyEstimate = `${ESPN_POLL_INTERVAL_MS / 1000}s (poll interval) + 0-${ESPN_POLL_INTERVAL_MS / 1000}s (phase offset)`;
  logInfo(`  ESPN detection latency: ~${espnLatencyEstimate}`);

  // Check if there's a tradeable window
  for (const [marketLabel, trades] of tradesByMarket) {
    if (trades.length === 0) continue;
    const prePrice = goal.preGoalPrices.get(marketLabel);
    if (!prePrice) continue;

    const finalPrice = trades[trades.length - 1].price;
    const totalMove = Math.abs(finalPrice - prePrice);
    if (totalMove < 0.02) continue; // ignore tiny moves

    // Find how much move was complete by T+5s and T+10s (our realistic detection window)
    const at5s = trades.filter((t) => (t.timestamp - goal.detectedAt) / 1000 <= 5);
    const at10s = trades.filter((t) => (t.timestamp - goal.detectedAt) / 1000 <= 10);
    const at15s = trades.filter((t) => (t.timestamp - goal.detectedAt) / 1000 <= 15);

    const priceAt5s = at5s.length > 0 ? at5s[at5s.length - 1].price : prePrice;
    const priceAt10s = at10s.length > 0 ? at10s[at10s.length - 1].price : prePrice;
    const priceAt15s = at15s.length > 0 ? at15s[at15s.length - 1].price : prePrice;

    const moveAt5s = Math.abs(priceAt5s - prePrice);
    const moveAt10s = Math.abs(priceAt10s - prePrice);
    const moveAt15s = Math.abs(priceAt15s - prePrice);

    const pctAt5s = totalMove > 0 ? ((moveAt5s / totalMove) * 100).toFixed(0) : '0';
    const pctAt10s = totalMove > 0 ? ((moveAt10s / totalMove) * 100).toFixed(0) : '0';
    const pctAt15s = totalMove > 0 ? ((moveAt15s / totalMove) * 100).toFixed(0) : '0';

    logInfo(`  ${marketLabel}:`);
    logInfo(`    Move complete at T+5s:  ${pctAt5s}% (${(moveAt5s * 100).toFixed(1)}c of ${(totalMove * 100).toFixed(1)}c)`);
    logInfo(`    Move complete at T+10s: ${pctAt10s}% (${(moveAt10s * 100).toFixed(1)}c of ${(totalMove * 100).toFixed(1)}c)`);
    logInfo(`    Move complete at T+15s: ${pctAt15s}% (${(moveAt15s * 100).toFixed(1)}c of ${(totalMove * 100).toFixed(1)}c)`);

    const remainingAt10s = totalMove - moveAt10s;
    if (remainingAt10s >= 0.03) {
      logInfo(`    --> TRADEABLE WINDOW: ~${(remainingAt10s * 100).toFixed(1)}c remaining after T+10s`);
    } else {
      logInfo(`    --> NO WINDOW: market reprices too fast (${pctAt10s}% done by T+10s)`);
    }
  }

  logInfo('='.repeat(80));
  logInfo('');
}

// ─── Step 6: Graceful Shutdown ───

function printFinalSummary(): void {
  logInfo('');
  logInfo('='.repeat(80));
  logInfo('FINAL SESSION SUMMARY');
  logInfo('='.repeat(80));
  logInfo(`Match: ${homeTeamName || '?'} vs ${awayTeamName || '?'} (${eventSlug})`);
  logInfo(`Total CLOB trades observed: ${tradeBuffer.length}`);
  logInfo(`Goals detected: ${goalEvents.length}`);

  if (goalEvents.length === 0) {
    logInfo('No goals detected during monitoring session.');
  }

  for (let i = 0; i < goalEvents.length; i++) {
    const g = goalEvents[i];
    logInfo(`\nGoal ${i + 1}: ${g.team} (${g.score}) at ${g.minute}' — ${g.trades.length} trades captured`);
  }

  // Current prices
  logInfo('\nFinal market prices:');
  for (const [label, price] of lastPriceByLabel) {
    logInfo(`  ${label}: ${price.toFixed(3)}`);
  }

  logInfo('='.repeat(80));
}

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;

  logInfo('\nShutting down...');
  printFinalSummary();

  if (espnTimer) clearInterval(espnTimer);
  if (pingTimer) clearInterval(pingTimer);
  if (ws) {
    ws.removeAllListeners();
    ws.close(1000, 'Shutdown');
  }

  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── Main ───

async function main(): Promise<void> {
  logInfo('='.repeat(80));
  logInfo('Scalp Repricing Monitor');
  logInfo(`Monitoring: ${eventSlug}`);
  logInfo('='.repeat(80));
  logInfo('');

  // Step 1: Fetch market data from Gamma API
  await fetchMarkets();
  logInfo('');

  // Step 2: Connect to CLOB WebSocket
  connectClobWs();

  // Step 3: Start ESPN polling
  startEspnPolling();

  logInfo('');
  logInfo('Monitor running. Press Ctrl+C to stop.');
  logInfo(`ESPN poll: every ${ESPN_POLL_INTERVAL_MS / 1000}s | CLOB WS: real-time streaming`);
  logInfo('');

  // Keep alive
  setInterval(() => {
    const now = new Date();
    const tradeCount = tradeBuffer.length;
    const uniqueMarkets = new Set(tradeBuffer.slice(-100).map((t) => t.market)).size;
    if (tradeCount > 0 && tradeCount % 100 < 10) {
      logInfo(`Heartbeat: ${tradeCount} total trades, ${uniqueMarkets} active markets, WS ${ws?.readyState === WebSocket.OPEN ? 'connected' : 'disconnected'}`);
    }
  }, 30_000);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
