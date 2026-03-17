/**
 * Standalone Feed Validation Script
 *
 * Imports and runs game feeds against live data, logging all detected events.
 * NO database, no engine, no trading, no CLOB. Just feeds + console output.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-feed-test.ts [--minutes=10] [--feeds=nba,dota2,lol]
 *
 * The NBA feed transitively imports scalp-market-discovery which imports prisma.
 * We mock the prisma module before any feed imports to avoid DB dependency.
 */

// ─── Step 0: Mock prisma before anything else imports it ───

// tsx compiles to CJS under the hood. We can intercept require() to provide a
// mock for ../../lib/prisma so that scalp-market-discovery.ts loads without a DB.
import Module from 'module';
import path from 'path';

const originalResolveFilename = (Module as any)._resolveFilename;
const prismaModulePath = path.resolve(__dirname, '../lib/prisma.ts');
const prismaModulePathJs = path.resolve(__dirname, '../lib/prisma.js');

// Return a fake path for prisma imports, then intercept the load
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any,
) {
  // Intercept any resolution that would lead to our prisma module
  const resolved = originalResolveFilename.call(this, request, parent, isMain, options);
  if (resolved === prismaModulePath || resolved === prismaModulePathJs) {
    // Return a sentinel so we can provide a mock
    return '__MOCK_PRISMA__';
  }
  return resolved;
};

// Pre-populate the require cache with a mock prisma module
const mockPrismaModule = new Module('__MOCK_PRISMA__');
(mockPrismaModule as any).exports = {
  prisma: new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined; // not a thenable
        // Return a no-op for any prisma model access
        return new Proxy(
          {},
          {
            get: () => async () => null,
          },
        );
      },
    },
  ),
};
(mockPrismaModule as any).loaded = true;
require.cache['__MOCK_PRISMA__'] = mockPrismaModule as any;

// Also mock gamma-api and api-client which scalp-market-discovery imports
const gammaApiModulePath = path.resolve(__dirname, '../api/gamma-api.ts');
const gammaApiModulePathJs = path.resolve(__dirname, '../api/gamma-api.js');
const apiClientModulePath = path.resolve(__dirname, '../lib/api-client.ts');
const apiClientModulePathJs = path.resolve(__dirname, '../lib/api-client.js');

const origResolve2 = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  isMain: boolean,
  options: any,
) {
  const resolved = origResolve2.call(this, request, parent, isMain, options);
  if (
    resolved === gammaApiModulePath ||
    resolved === gammaApiModulePathJs
  ) {
    return '__MOCK_GAMMA_API__';
  }
  if (
    resolved === apiClientModulePath ||
    resolved === apiClientModulePathJs
  ) {
    return '__MOCK_API_CLIENT__';
  }
  return resolved;
};

const mockGammaApi = new Module('__MOCK_GAMMA_API__');
(mockGammaApi as any).exports = {
  getActiveEvents: async () => [],
};
(mockGammaApi as any).loaded = true;
require.cache['__MOCK_GAMMA_API__'] = mockGammaApi as any;

const mockApiClient = new Module('__MOCK_API_CLIENT__');
(mockApiClient as any).exports = {
  gammaApi: { get: async () => ({ data: [] }) },
};
(mockApiClient as any).loaded = true;
require.cache['__MOCK_API_CLIENT__'] = mockApiClient as any;

// ─── Step 1: Now safe to import feeds and other modules ───

import 'dotenv/config';
import type { GameEvent } from '../services/scalp/scalp-types.js';

// ANSI color codes
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const WHITE = '\x1b[37m';

// Game icons and colors
const GAME_STYLE: Record<string, { icon: string; color: string; label: string }> = {
  nba: { icon: '[NBA]', color: YELLOW, label: 'NBA' },
  dota2: { icon: '[DOTA]', color: RED, label: 'DOTA2' },
  lol: { icon: '[LOL]', color: CYAN, label: 'LOL' },
};

// Event type colors
const EVENT_COLORS: Record<string, string> = {
  lead_change: MAGENTA,
  scoring_run: GREEN,
  roshan_kill: RED,
  barracks_destroyed: RED,
  gold_lead_shift: YELLOW,
  baron_kill: MAGENTA,
  elder_dragon: BLUE,
  map_win: GREEN,
  series_end: WHITE,
};

// ─── Stats tracking ───

interface FeedStats {
  totalEvents: number;
  eventsByType: Record<string, number>;
  startTime: number;
  lastEventTime: number | null;
  healthy: boolean;
  started: boolean;
  error: string | null;
}

const stats: Record<string, FeedStats> = {};

function initStats(feedName: string): FeedStats {
  const s: FeedStats = {
    totalEvents: 0,
    eventsByType: {},
    startTime: Date.now(),
    lastEventTime: null,
    healthy: false,
    started: false,
    error: null,
  };
  stats[feedName] = s;
  return s;
}

// ─── Event formatting ───

function formatTime(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}:${String(now.getSeconds()).padStart(2, '0')}`;
}

function formatEvent(event: GameEvent): string {
  const time = formatTime();
  const style = GAME_STYLE[event.game] || { icon: `[${event.game}]`, color: WHITE, label: event.game.toUpperCase() };
  const evColor = EVENT_COLORS[event.eventType] || WHITE;

  let detail = '';

  switch (event.eventType) {
    case 'lead_change': {
      const raw = event.rawData as Record<string, any> | undefined;
      const margin = raw?.margin ?? '?';
      const period = raw?.period ?? event.mapNumber;
      const decisive = raw?.isDecisiveGame ? 'decisive=true' : 'decisive=false';
      detail = `${event.winner} takes lead from ${event.loser} | ${event.seriesScore[0]}-${event.seriesScore[1]} Q${period} | margin=${margin} ${decisive}`;
      break;
    }
    case 'scoring_run': {
      const raw = event.rawData as Record<string, any> | undefined;
      const runPts = raw?.runPoints ?? '?';
      const period = raw?.period ?? event.mapNumber;
      detail = `${event.winner} ${runPts}-0 run | ${event.seriesScore[0]}-${event.seriesScore[1]} Q${period}`;
      break;
    }
    case 'roshan_kill': {
      const raw = event.rawData as Record<string, any> | undefined;
      const goldLead = raw?.goldLead != null ? (raw.goldLead >= 0 ? `+${raw.goldLead}` : `${raw.goldLead}`) : '?';
      detail = `${event.winner} kills Roshan | gold_lead=${goldLead}`;
      break;
    }
    case 'barracks_destroyed': {
      const raw = event.rawData as Record<string, any> | undefined;
      const mega = raw?.isMegaCreeps ? ' MEGA CREEPS!' : '';
      const remaining = raw?.remainingBarracks ?? '?';
      detail = `${event.winner} destroys ${event.loser}'s barracks | remaining=${remaining}${mega}`;
      break;
    }
    case 'gold_lead_shift': {
      const raw = event.rawData as Record<string, any> | undefined;
      const swing = raw?.goldSwing ?? '?';
      const newLead = raw?.newGoldLead ?? '?';
      detail = `${event.winner} gold swing +${swing} | net_lead=${newLead}`;
      break;
    }
    case 'baron_kill': {
      const raw = event.rawData as Record<string, any> | undefined;
      const goldDiff = raw?.goldDiff != null ? ` | gold_diff=${raw.goldDiff}` : '';
      detail = `${event.winner} kills Baron${goldDiff}`;
      break;
    }
    case 'elder_dragon': {
      const raw = event.rawData as Record<string, any> | undefined;
      const goldDiff = raw?.goldDiff != null ? ` | gold_diff=${raw.goldDiff}` : '';
      detail = `${event.winner} kills Elder Dragon${goldDiff}`;
      break;
    }
    case 'map_win': {
      detail = `${event.winner} wins game ${event.mapNumber} | series ${event.seriesScore[0]}-${event.seriesScore[1]}`;
      break;
    }
    case 'series_end': {
      detail = `${event.winner} wins series ${event.seriesScore[0]}-${event.seriesScore[1]} over ${event.loser}`;
      break;
    }
    default:
      detail = `${event.winner} vs ${event.loser} | ${JSON.stringify(event.rawData ?? {})}`;
  }

  return `${DIM}[${time}]${RESET} ${style.color}${BOLD}${style.icon}${RESET} ${evColor}${event.eventType}${RESET} | ${detail}`;
}

// ─── CLI args parsing ───

function parseArgs(): { minutes: number; feeds: string[] } {
  const args = process.argv.slice(2);
  let minutes = 10;
  let feeds = ['nba', 'dota2', 'lol'];

  for (const arg of args) {
    if (arg.startsWith('--minutes=')) {
      minutes = parseInt(arg.split('=')[1], 10);
      if (isNaN(minutes) || minutes < 1) minutes = 10;
    }
    if (arg.startsWith('--feeds=')) {
      feeds = arg.split('=')[1].split(',').map((f) => f.trim().toLowerCase());
    }
  }

  return { minutes, feeds };
}

// ─── Print summary ───

function printSummary(): void {
  const elapsed = ((Date.now() - globalStartTime) / 1000).toFixed(0);

  console.log('\n');
  console.log(`${BOLD}${'='.repeat(70)}${RESET}`);
  console.log(`${BOLD}  FEED VALIDATION SUMMARY  (ran for ${elapsed}s)${RESET}`);
  console.log(`${'='.repeat(70)}`);

  let totalAllEvents = 0;

  for (const [name, s] of Object.entries(stats)) {
    const style = GAME_STYLE[name] || { icon: '', color: WHITE, label: name };
    const status = s.error
      ? `${RED}ERROR: ${s.error}${RESET}`
      : s.started
        ? s.healthy
          ? `${GREEN}HEALTHY${RESET}`
          : `${YELLOW}STARTED (not healthy)${RESET}`
        : `${DIM}NOT STARTED${RESET}`;

    console.log(`\n  ${style.color}${BOLD}${style.label}${RESET} — ${status}`);
    console.log(`    Total events: ${BOLD}${s.totalEvents}${RESET}`);
    totalAllEvents += s.totalEvents;

    if (Object.keys(s.eventsByType).length > 0) {
      for (const [type, count] of Object.entries(s.eventsByType)) {
        const evColor = EVENT_COLORS[type] || WHITE;
        console.log(`      ${evColor}${type}${RESET}: ${count}`);
      }
    }

    if (s.lastEventTime) {
      const ago = ((Date.now() - s.lastEventTime) / 1000).toFixed(0);
      console.log(`    Last event: ${ago}s ago`);
    }
  }

  console.log(`\n  ${BOLD}Total events across all feeds: ${totalAllEvents}${RESET}`);
  console.log(`${'='.repeat(70)}\n`);
}

// ─── Main ───

let globalStartTime = Date.now();
const feedInstances: { name: string; feed: { stop(): void } }[] = [];

async function main(): Promise<void> {
  const { minutes, feeds } = parseArgs();
  globalStartTime = Date.now();

  console.log(`\n${BOLD}Scalp Feed Validation${RESET}`);
  console.log(`  Duration: ${minutes} minutes`);
  console.log(`  Feeds: ${feeds.join(', ')}`);
  console.log(`  Time: ${new Date().toLocaleString()}`);
  console.log(`${'─'.repeat(70)}\n`);

  // ─── NBA Feed ───
  if (feeds.includes('nba')) {
    const s = initStats('nba');
    try {
      const { NbaFeed } = await import('../services/scalp/feeds/nba-feed.js');
      const nbaFeed = new NbaFeed();

      nbaFeed.onEvent((event: GameEvent) => {
        s.totalEvents++;
        s.eventsByType[event.eventType] = (s.eventsByType[event.eventType] || 0) + 1;
        s.lastEventTime = Date.now();
        console.log(formatEvent(event));
      });

      console.log(`${YELLOW}[NBA]${RESET} Starting NBA feed...`);
      await nbaFeed.start();
      s.started = true;
      s.healthy = nbaFeed.isHealthy();
      feedInstances.push({ name: 'nba', feed: nbaFeed });

      if (s.healthy) {
        console.log(`${YELLOW}[NBA]${RESET} ${GREEN}Feed started and healthy${RESET}`);
      } else {
        console.log(`${YELLOW}[NBA]${RESET} ${DIM}Feed started (may be disabled via config)${RESET}`);
      }
    } catch (err: any) {
      s.error = err.message;
      console.log(`${YELLOW}[NBA]${RESET} ${RED}Failed to start: ${err.message}${RESET}`);
    }
  }

  // ─── Dota 2 Feed ───
  if (feeds.includes('dota2')) {
    const s = initStats('dota2');

    const steamKey = process.env.SCALP_STEAM_API_KEY;
    if (!steamKey) {
      s.error = 'SCALP_STEAM_API_KEY not set';
      console.log(`${RED}[DOTA]${RESET} ${YELLOW}WARNING: SCALP_STEAM_API_KEY not set — Dota 2 feed will be disabled${RESET}`);
      console.log(`${RED}[DOTA]${RESET} ${DIM}Set SCALP_STEAM_API_KEY in .env to enable${RESET}`);
    }

    try {
      const { Dota2Feed } = await import('../services/scalp/feeds/dota2-feed.js');
      const dota2Feed = new Dota2Feed();

      dota2Feed.onEvent((event: GameEvent) => {
        s.totalEvents++;
        s.eventsByType[event.eventType] = (s.eventsByType[event.eventType] || 0) + 1;
        s.lastEventTime = Date.now();
        console.log(formatEvent(event));
      });

      console.log(`${RED}[DOTA]${RESET} Starting Dota 2 feed...`);
      await dota2Feed.start();
      s.started = true;
      s.healthy = dota2Feed.isHealthy();
      feedInstances.push({ name: 'dota2', feed: dota2Feed });

      if (s.healthy) {
        console.log(`${RED}[DOTA]${RESET} ${GREEN}Feed started and healthy${RESET}`);
      } else {
        console.log(`${RED}[DOTA]${RESET} ${DIM}Feed started (${steamKey ? 'polling but no live matches?' : 'disabled — no API key'})${RESET}`);
      }
    } catch (err: any) {
      s.error = err.message;
      console.log(`${RED}[DOTA]${RESET} ${RED}Failed to start: ${err.message}${RESET}`);
    }
  }

  // ─── LoL Feed ───
  if (feeds.includes('lol')) {
    const s = initStats('lol');
    try {
      const { LolFeed } = await import('../services/scalp/feeds/lol-feed.js');
      const lolFeed = new LolFeed();

      lolFeed.onEvent((event: GameEvent) => {
        s.totalEvents++;
        s.eventsByType[event.eventType] = (s.eventsByType[event.eventType] || 0) + 1;
        s.lastEventTime = Date.now();
        console.log(formatEvent(event));
      });

      console.log(`${CYAN}[LOL]${RESET} Starting LoL feed...`);
      await lolFeed.start();
      s.started = true;
      s.healthy = lolFeed.isHealthy();
      feedInstances.push({ name: 'lol', feed: lolFeed });

      if (s.healthy) {
        console.log(`${CYAN}[LOL]${RESET} ${GREEN}Feed started and healthy${RESET}`);
      } else {
        console.log(`${CYAN}[LOL]${RESET} ${DIM}Feed started (no live matches?)${RESET}`);
      }
    } catch (err: any) {
      s.error = err.message;
      console.log(`${CYAN}[LOL]${RESET} ${RED}Failed to start: ${err.message}${RESET}`);
    }
  }

  // ─── Wait for duration ───
  console.log(`\n${DIM}Listening for events... (Ctrl+C to stop early)${RESET}\n`);

  // Print a heartbeat every 60s
  const heartbeat = setInterval(() => {
    const elapsed = ((Date.now() - globalStartTime) / 1000 / 60).toFixed(1);
    const totalEvents = Object.values(stats).reduce((sum, s) => sum + s.totalEvents, 0);
    const healthStr = feedInstances
      .map((f) => {
        const s = stats[f.name];
        const style = GAME_STYLE[f.name] || { color: WHITE, label: f.name };
        return `${style.color}${style.label}${RESET}:${s?.healthy ? GREEN + 'OK' : YELLOW + 'idle'}${RESET}`;
      })
      .join(' | ');
    console.log(`${DIM}[heartbeat ${elapsed}min] events=${totalEvents} | ${healthStr}${RESET}`);
  }, 60_000);

  // Auto-stop after configured duration
  const timer = setTimeout(() => {
    console.log(`\n${BOLD}Duration reached (${minutes} min). Stopping feeds...${RESET}`);
    shutdown();
  }, minutes * 60 * 1000);

  // Don't let the timer keep the process alive after shutdown
  timer.unref();
  heartbeat.unref();
}

function shutdown(): void {
  for (const { name, feed } of feedInstances) {
    try {
      feed.stop();
      console.log(`${DIM}Stopped ${name} feed${RESET}`);
    } catch {
      // ignore
    }
  }
  printSummary();
  process.exit(0);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log(`\n${BOLD}SIGINT received. Stopping...${RESET}`);
  shutdown();
});
process.on('SIGTERM', () => {
  console.log(`\n${BOLD}SIGTERM received. Stopping...${RESET}`);
  shutdown();
});

// Run
main().catch((err) => {
  console.error(`${RED}Fatal error: ${err.message}${RESET}`);
  console.error(err.stack);
  process.exit(1);
});
