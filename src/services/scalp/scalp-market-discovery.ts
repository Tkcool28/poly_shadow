import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { getActiveEvents } from '../../api/gamma-api';
import { gammaApi } from '../../lib/api-client';
import type { GammaMarketData } from '../../api/types';
import type { ScalpMarketWatchModel as ScalpMarketWatch } from '../../../prisma/generated/prisma/client/models/ScalpMarketWatch';
import {
  GAME_SLUG_PREFIXES,
  SERIES_SLUG_PATTERN,
  MAP_SLUG_PATTERN,
  type ScalpGame,
} from './scalp-types';

const log = createJobLogger('scalp-discovery');

// In-memory caches
const slugCache = new Map<string, ScalpMarketWatch>();
const teamIndex = new Map<string, ScalpMarketWatch>(); // "team1|team2" → market
const tokenIdIndex = new Map<string, ScalpMarketWatch>(); // tokenId → market

const enabledGames: Set<ScalpGame> = new Set(
  config.SCALP_GAMES.split(',').map((g) => g.trim().toLowerCase() as ScalpGame),
);

// Gamma API event tag_slugs that contain esports/tennis markets
const DISCOVERY_TAG_SLUGS = ['esports', 'tennis'] as const;

// NBA team abbreviation (from NBA API) → Polymarket outcome name mapping
// Polymarket uses city names or team nicknames in outcomes
const NBA_TEAM_ABBREV_TO_NAME: Record<string, string> = {
  ATL: 'Hawks',
  BOS: 'Celtics',
  BKN: 'Nets',
  CHA: 'Hornets',
  CHI: 'Bulls',
  CLE: 'Cavaliers',
  DAL: 'Mavericks',
  DEN: 'Nuggets',
  DET: 'Pistons',
  GSW: 'Warriors',
  HOU: 'Rockets',
  IND: 'Pacers',
  LAC: 'Clippers',
  LAL: 'Lakers',
  MEM: 'Grizzlies',
  MIA: 'Heat',
  MIL: 'Bucks',
  MIN: 'Timberwolves',
  NOP: 'Pelicans',
  NYK: 'Knicks',
  OKC: 'Thunder',
  ORL: 'Magic',
  PHI: '76ers',
  PHX: 'Suns',
  POR: 'Trail Blazers',
  SAC: 'Kings',
  SAS: 'Spurs',
  TOR: 'Raptors',
  UTA: 'Jazz',
  WAS: 'Wizards',
};

// Cache for NBA series API response (refreshes every 5 minutes)
let nbaSeriesCache: { data: any; fetchedAt: number } | null = null;
const NBA_SERIES_CACHE_TTL_MS = 300_000; // 5 minutes

// Cache for EPL/Soccer series API response
let soccerSeriesCache: { data: any; fetchedAt: number } | null = null;
const SOCCER_SERIES_CACHE_TTL_MS = 300_000; // 5 minutes

// Index for soccer single-team markets: normalizedTeamName → market
const soccerTeamIndex = new Map<string, ScalpMarketWatch>();

/**
 * Normalize a team name for matching: trim, lowercase, strip non-alphanumeric.
 */
function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Normalize a soccer team name for matching.
 * Strips common suffixes (FC, AFC, UTD, United, City) so ESPN names match Polymarket outcomes.
 * e.g., "Arsenal FC" → "arsenal", "Arsenal" → "arsenal"
 *       "Manchester United FC" → "manchesterunited" (keeps "united" to avoid Man Utd/City collision)
 *       "Newcastle United FC" → "newcastleunited"
 *       "Manchester City FC" → "manchestercity"
 */
function normalizeSoccerTeamName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')  // keep spaces for now
    .replace(/\b(fc|afc|utd|rovers|wanderers|albion|hotspur)\b/g, '')  // NOT united/city/town — avoids Manchester collision
    .replace(/\s+/g, '')           // now strip spaces
    .replace(/[^a-z0-9]/g, '');
}

/**
 * Build a canonical team pair key (sorted so order doesn't matter).
 */
function teamPairKey(team1: string, team2: string): string {
  const t1 = normalizeTeamName(team1);
  const t2 = normalizeTeamName(team2);
  return t1 < t2 ? `${t1}|${t2}` : `${t2}|${t1}`;
}

/**
 * Detect game from slug prefix.
 */
function detectGame(slug: string): ScalpGame | null {
  for (const [game, prefix] of Object.entries(GAME_SLUG_PREFIXES)) {
    if (slug.startsWith(prefix)) return game as ScalpGame;
  }
  return null;
}

/**
 * Classify market type from slug using allowlist patterns.
 * - "series": exactly {game}-{team1}-{team2}-{YYYY-MM-DD} (no suffix)
 * - "map": ends with -game1, -game2, -game3
 * - "derivative": everything else (handicaps, totals, kills, odd-even, first-blood, etc.)
 */
function classifyMarketType(slug: string): 'series' | 'map' | 'derivative' {
  if (SERIES_SLUG_PATTERN.test(slug)) return 'series';
  if (MAP_SLUG_PATTERN.test(slug)) return 'map';
  return 'derivative';
}

/**
 * Extract team names from Gamma API outcomes field.
 * Outcomes is a JSON string like '["MOUZ", "Astralis"]'.
 */
function parseOutcomes(outcomesJson: string): string[] {
  try {
    const parsed = JSON.parse(outcomesJson);
    if (Array.isArray(parsed)) return parsed.map((o: string) => String(o).trim());
  } catch {}
  return [];
}

/**
 * Discover NBA moneyline markets via the Gamma series API.
 * NBA uses a series-based structure (series ID 10345) rather than tag_slug.
 * Each event in the series represents a single game with multiple sub-markets.
 * We only care about the moneyline (sportsMarketType === 'moneyline') market.
 */
async function discoverNbaMarkets(): Promise<number> {
  if (!enabledGames.has('nba') || !config.SCALP_NBA_ENABLED) return 0;

  let upserted = 0;

  try {
    // Check cache
    if (nbaSeriesCache && Date.now() - nbaSeriesCache.fetchedAt < NBA_SERIES_CACHE_TTL_MS) {
      // Use cached data
    } else {
      const data = await gammaApi.get<any>(`/series/${config.SCALP_NBA_SERIES_ID}`);
      nbaSeriesCache = { data, fetchedAt: Date.now() };
    }

    const seriesData = nbaSeriesCache.data;
    if (!seriesData) return 0;

    // The series response can be an object with events, or direct event data
    const events: any[] = seriesData.events ?? (Array.isArray(seriesData) ? seriesData : [seriesData]);

    for (const event of events) {
      // Skip closed events
      if (event.closed) continue;

      const eventSlug: string = event.slug ?? '';
      if (!eventSlug.startsWith('nba-')) continue;

      const markets: any[] = event.markets ?? [];

      for (const market of markets) {
        // Only moneyline markets
        const sportsMarketType = market.sportsMarketType ?? '';
        if (sportsMarketType !== 'moneyline') continue;

        const slug = market.slug ?? eventSlug;
        const conditionId = market.conditionId;
        if (!conditionId) continue;

        const outcomes = market.outcomes ?? '';
        const outcomesStr = typeof outcomes === 'string' ? outcomes : JSON.stringify(outcomes);
        const parsedOutcomes = parseOutcomes(outcomesStr);
        if (parsedOutcomes.length < 2) continue;

        const clobTokenIds = market.clobTokenIds ?? '';
        const clobTokenIdsStr = typeof clobTokenIds === 'string' ? clobTokenIds : JSON.stringify(clobTokenIds);
        if (!clobTokenIdsStr || clobTokenIdsStr === '[]') continue;

        const homeTeam = normalizeTeamName(parsedOutcomes[0]);
        const awayTeam = normalizeTeamName(parsedOutcomes[1]);

        try {
          const record = await prisma.scalpMarketWatch.upsert({
            where: { slug },
            create: {
              game: 'nba',
              slug,
              conditionId,
              question: market.question ?? `${parsedOutcomes[0]} vs ${parsedOutcomes[1]}`,
              outcomes: outcomesStr,
              clobTokenIds: clobTokenIdsStr,
              negRisk: market.negRisk ?? false,
              tickSize: market.minimumTickSize ?? 0.01,
              orderMinSize: market.orderMinSize ?? 5,
              liquidity: market.liquidity != null ? Number(market.liquidity) : null,
              eventSlug,
              endDate: market.endDate ? new Date(market.endDate) : null,
              isActive: true,
              marketType: 'moneyline',
              homeTeam,
              awayTeam,
            },
            update: {
              conditionId,
              question: market.question ?? `${parsedOutcomes[0]} vs ${parsedOutcomes[1]}`,
              outcomes: outcomesStr,
              clobTokenIds: clobTokenIdsStr,
              negRisk: market.negRisk ?? false,
              tickSize: market.minimumTickSize ?? 0.01,
              orderMinSize: market.orderMinSize ?? 5,
              liquidity: market.liquidity != null ? Number(market.liquidity) : null,
              eventSlug,
              endDate: market.endDate ? new Date(market.endDate) : null,
              isActive: true,
              marketType: 'moneyline',
              homeTeam,
              awayTeam,
            },
          });

          addToCache(record);
          upserted++;
        } catch (err: any) {
          log.warn(`Failed to upsert NBA market ${slug}: ${err.message}`);
        }
      }
    }

    if (upserted > 0) {
      log.info('NBA market discovery complete', { upserted });
    }
  } catch (err: any) {
    log.warn(`NBA series discovery failed: ${err.message}`);
  }

  return upserted;
}

/**
 * Discover EPL (Premier League) markets via the Gamma series API.
 * Soccer uses 3-outcome markets: Team A Win, Draw, Team B Win — each as a separate
 * binary Yes/No market with its own conditionId.
 *
 * We store each team's "Win" market individually, indexed by normalized soccer team name,
 * so the engine can look up "Arsenal win" market when Arsenal scores a goal.
 */
async function discoverEplMarkets(): Promise<number> {
  if (!enabledGames.has('soccer') || !config.SCALP_SOCCER_ENABLED) return 0;

  let upserted = 0;

  try {
    // Check cache
    if (soccerSeriesCache && Date.now() - soccerSeriesCache.fetchedAt < SOCCER_SERIES_CACHE_TTL_MS) {
      // Use cached data
    } else {
      const data = await gammaApi.get<any>(`/series/${config.SCALP_SOCCER_SERIES_ID}`);
      soccerSeriesCache = { data, fetchedAt: Date.now() };
    }

    const seriesData = soccerSeriesCache.data;
    if (!seriesData) return 0;

    const events: any[] = seriesData.events ?? (Array.isArray(seriesData) ? seriesData : [seriesData]);

    for (const event of events) {
      if (event.closed) continue;

      const eventSlug: string = event.slug ?? '';
      // EPL slugs look like: epl-ars-eve-2026-03-14
      if (!eventSlug.startsWith('epl-')) continue;

      const markets: any[] = event.markets ?? [];

      for (const market of markets) {
        const slug = market.slug ?? '';
        const conditionId = market.conditionId;
        if (!conditionId) continue;

        const outcomes = market.outcomes ?? '';
        const outcomesStr = typeof outcomes === 'string' ? outcomes : JSON.stringify(outcomes);
        const parsedOutcomes = parseOutcomes(outcomesStr);
        if (parsedOutcomes.length < 2) continue;

        const clobTokenIds = market.clobTokenIds ?? '';
        const clobTokenIdsStr = typeof clobTokenIds === 'string' ? clobTokenIds : JSON.stringify(clobTokenIds);
        if (!clobTokenIdsStr || clobTokenIdsStr === '[]') continue;

        const question: string = market.question ?? '';

        // Determine market type from question:
        // "Will Arsenal win?" or "Will Arsenal FC win?" → soccer_win
        // "Will it be a draw?" → soccer_draw
        let marketType: string;
        let homeTeam: string;
        let awayTeam: string;

        const questionLower = question.toLowerCase();
        if (questionLower.includes('draw')) {
          marketType = 'soccer_draw';
          // For draw markets, use the event-level team context
          // The outcomes are typically ["Yes", "No"] for each individual market
          homeTeam = normalizeSoccerTeamName(eventSlug);
          awayTeam = 'draw';
        } else if (questionLower.includes('win')) {
          marketType = 'soccer_win';
          // Extract team name from question: "Will {TeamName} win?"
          const winMatch = question.match(/^will\s+(.+?)\s+win\s*\??\s*$/i);
          const teamName = winMatch ? winMatch[1] : parsedOutcomes[0];
          homeTeam = normalizeSoccerTeamName(teamName);
          awayTeam = ''; // Single-team lookup; awayTeam not used for soccer_win
        } else {
          // Unknown market type within EPL event — skip
          continue;
        }

        try {
          const record = await prisma.scalpMarketWatch.upsert({
            where: { slug },
            create: {
              game: 'soccer',
              slug,
              conditionId,
              question,
              outcomes: outcomesStr,
              clobTokenIds: clobTokenIdsStr,
              negRisk: market.negRisk ?? false,
              tickSize: market.minimumTickSize ?? 0.01,
              orderMinSize: market.orderMinSize ?? 5,
              liquidity: market.liquidity != null ? Number(market.liquidity) : null,
              eventSlug,
              endDate: market.endDate ? new Date(market.endDate) : null,
              isActive: true,
              marketType,
              homeTeam,
              awayTeam,
            },
            update: {
              conditionId,
              question,
              outcomes: outcomesStr,
              clobTokenIds: clobTokenIdsStr,
              negRisk: market.negRisk ?? false,
              tickSize: market.minimumTickSize ?? 0.01,
              orderMinSize: market.orderMinSize ?? 5,
              liquidity: market.liquidity != null ? Number(market.liquidity) : null,
              eventSlug,
              endDate: market.endDate ? new Date(market.endDate) : null,
              isActive: true,
              marketType,
              homeTeam,
              awayTeam,
            },
          });

          addToCache(record);
          upserted++;
        } catch (err: any) {
          log.warn(`Failed to upsert EPL market ${slug}: ${err.message}`);
        }
      }
    }

    if (upserted > 0) {
      log.info('EPL market discovery complete', { upserted });
    }
  } catch (err: any) {
    log.warn(`EPL series discovery failed: ${err.message}`);
  }

  return upserted;
}

/**
 * Get the NBA team name for a given NBA API abbreviation (e.g., "BKN" → "Nets").
 * Returns null if abbreviation is not recognized.
 */
export function getNbaTeamName(abbrev: string): string | null {
  return NBA_TEAM_ABBREV_TO_NAME[abbrev.toUpperCase()] ?? null;
}

/**
 * Full discovery: fetch events by tag_slug, extract nested markets, filter by game slug, upsert into DB.
 *
 * Esports/tennis markets are NOT reachable via /markets pagination (30K+ markets, esports buried).
 * Instead, use /events?tag_slug=esports which returns events with nested markets.
 */
export async function discoverMarkets(): Promise<number> {
  const startTime = Date.now();
  let totalFound = 0;
  let totalUpserted = 0;

  log.info('Starting market discovery...', { enabledGames: [...enabledGames] });

  for (const tagSlug of DISCOVERY_TAG_SLUGS) {
    let offset = 0;
    const limit = 100;

    while (true) {
      const events = await getActiveEvents({ tag_slug: tagSlug, limit, offset, active: true, closed: false });
      if (events.length === 0) break;

      for (const event of events) {
        const markets = event.markets ?? [];
        for (const market of markets) {
          const game = detectGame(market.slug);
          if (!game || !enabledGames.has(game)) continue;

          const marketType = classifyMarketType(market.slug);
          // Phase 1: skip derivative markets (handicaps, totals)
          if (marketType === 'derivative') continue;

          const outcomes = parseOutcomes(market.outcomes);
          if (outcomes.length < 2) continue;

          const clobTokenIds = market.clobTokenIds ?? '';
          if (!clobTokenIds) continue;

          const homeTeam = normalizeTeamName(outcomes[0]);
          const awayTeam = normalizeTeamName(outcomes[1]);

          try {
            const record = await prisma.scalpMarketWatch.upsert({
              where: { slug: market.slug },
              create: {
                game,
                slug: market.slug,
                conditionId: market.conditionId,
                question: market.question,
                outcomes: market.outcomes,
                clobTokenIds,
                negRisk: market.negRisk ?? false,
                tickSize: market.minimumTickSize ?? 0.01,
                orderMinSize: market.orderMinSize ?? 5,
                liquidity: market.liquidity ?? null,
                eventSlug: event.slug,
                endDate: market.endDate ? new Date(market.endDate) : null,
                isActive: true,
                marketType,
                homeTeam,
                awayTeam,
              },
              update: {
                conditionId: market.conditionId,
                question: market.question,
                outcomes: market.outcomes,
                clobTokenIds,
                negRisk: market.negRisk ?? false,
                tickSize: market.minimumTickSize ?? 0.01,
                orderMinSize: market.orderMinSize ?? 5,
                liquidity: market.liquidity ?? null,
                eventSlug: event.slug,
                endDate: market.endDate ? new Date(market.endDate) : null,
                isActive: true,
                marketType,
                homeTeam,
                awayTeam,
              },
            });

            addToCache(record);
            totalUpserted++;
          } catch (err: any) {
            log.warn(`Failed to upsert market ${market.slug}: ${err.message}`);
          }

          totalFound++;
        }
      }

      offset += limit;
      // Safety: events are <500 per tag, 2000 is generous
      if (offset > 2000) break;
    }
  }

  // NBA series-based discovery (separate from tag_slug esports/tennis)
  const nbaUpserted = await discoverNbaMarkets();
  totalUpserted += nbaUpserted;

  // EPL/Soccer series-based discovery
  const eplUpserted = await discoverEplMarkets();
  totalUpserted += eplUpserted;

  // Mark stale markets inactive
  const staleCount = await markStaleMarkets();
  if (staleCount > 0) {
    // Rebuild caches from DB to remove stale token IDs
    await loadMarketsIntoCache();
    log.info('Rebuilt caches after stale deactivation', { staleCount });
  }

  const elapsed = Date.now() - startTime;
  log.info('Market discovery complete', {
    totalFound,
    totalUpserted,
    staleDeactivated: staleCount,
    cacheSize: slugCache.size,
    tokenIndexSize: tokenIdIndex.size,
    elapsedMs: elapsed,
  });

  return totalUpserted;
}

/**
 * Load all active markets from DB into memory caches (used on startup).
 */
export async function loadMarketsIntoCache(): Promise<void> {
  const markets = await prisma.scalpMarketWatch.findMany({
    where: { isActive: true },
  });

  slugCache.clear();
  teamIndex.clear();
  tokenIdIndex.clear();
  soccerTeamIndex.clear();

  for (const m of markets) {
    addToCache(m);
  }

  log.info('Loaded markets into cache', {
    total: markets.length,
    tokenIds: tokenIdIndex.size,
  });
}

function addToCache(m: ScalpMarketWatch): void {
  slugCache.set(m.slug, m);

  if (m.homeTeam && m.awayTeam) {
    teamIndex.set(teamPairKey(m.homeTeam, m.awayTeam), m);
  }

  // Index soccer_win markets by normalized team name for single-team lookups
  if (m.game === 'soccer' && m.marketType === 'soccer_win' && m.homeTeam) {
    soccerTeamIndex.set(m.homeTeam, m);
  }

  // Index each token ID for fast bot detector lookups
  try {
    const tokenIds: string[] = JSON.parse(m.clobTokenIds);
    for (const tid of tokenIds) {
      tokenIdIndex.set(tid, m);
    }
  } catch {}
}

/**
 * Mark markets not updated in the last 24h as inactive.
 */
async function markStaleMarkets(): Promise<number> {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const result = await prisma.scalpMarketWatch.updateMany({
    where: { isActive: true, updatedAt: { lt: cutoff } },
    data: { isActive: false },
  });
  return result.count;
}

// ─── Cache accessors ───

export function getMarketBySlug(slug: string): ScalpMarketWatch | null {
  return slugCache.get(slug) ?? null;
}

export function getMarketByTeamPair(team1: string, team2: string): ScalpMarketWatch | null {
  return teamIndex.get(teamPairKey(team1, team2)) ?? null;
}

export function getMarketByTokenId(tokenId: string): ScalpMarketWatch | null {
  return tokenIdIndex.get(tokenId) ?? null;
}

export function getAllEsportsTokenIds(): Set<string> {
  return new Set(tokenIdIndex.keys());
}

export function getCacheSize(): number {
  return slugCache.size;
}

/**
 * Look up a soccer team's individual "Win" market by team name.
 * Uses soccer-specific normalization to match ESPN names to Polymarket outcomes.
 * e.g., getMarketForSoccerTeam("Arsenal") matches "Arsenal FC" win market.
 */
export function getMarketForSoccerTeam(teamName: string): ScalpMarketWatch | null {
  const normalized = normalizeSoccerTeamName(teamName);
  return soccerTeamIndex.get(normalized) ?? null;
}
