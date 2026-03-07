import { createJobLogger } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { config } from '../../config/env';
import { getActiveMarkets } from '../../api/gamma-api';
import type { GammaMarketData } from '../../api/types';
import type { ScalpMarketWatchModel as ScalpMarketWatch } from '../../../prisma/generated/prisma/client/models/ScalpMarketWatch';
import {
  GAME_SLUG_PREFIXES,
  DERIVATIVE_SLUG_PATTERNS,
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

/**
 * Normalize a team name for matching: trim, lowercase, strip non-alphanumeric.
 */
function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
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
 * Classify market type from slug.
 * - "series": no suffix (e.g., cs2-mouz-ast10-2026-03-07)
 * - "map": has -game1, -game2 suffix
 * - "derivative": handicap, total, etc.
 */
function classifyMarketType(slug: string): 'series' | 'map' | 'derivative' {
  if (DERIVATIVE_SLUG_PATTERNS.some((p) => slug.includes(p))) return 'derivative';
  if (MAP_SLUG_PATTERN.test(slug)) return 'map';
  return 'series';
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
 * Full discovery: paginate all active markets, filter by game slug, upsert into DB.
 */
export async function discoverMarkets(): Promise<number> {
  const startTime = Date.now();
  let offset = 0;
  const limit = 100;
  let totalFound = 0;
  let totalUpserted = 0;

  log.info('Starting market discovery...', { enabledGames: [...enabledGames] });

  while (true) {
    const markets = await getActiveMarkets({ limit, offset, active: true, closed: false });
    if (markets.length === 0) break;

    for (const market of markets) {
      const game = detectGame(market.slug);
      if (!game || !enabledGames.has(game)) continue;

      const marketType = classifyMarketType(market.slug);
      // Phase 1: only track series markets
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
            eventSlug: market.eventSlug ?? null,
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
            eventSlug: market.eventSlug ?? null,
            endDate: market.endDate ? new Date(market.endDate) : null,
            isActive: true,
            marketType,
            homeTeam,
            awayTeam,
          },
        });

        // Update in-memory caches
        addToCache(record);
        totalUpserted++;
      } catch (err: any) {
        log.warn(`Failed to upsert market ${market.slug}: ${err.message}`);
      }

      totalFound++;
    }

    offset += limit;
    // Safety: don't paginate forever
    if (offset > 5000) break;
  }

  // Mark stale markets inactive
  const staleCount = await markStaleMarkets();

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
