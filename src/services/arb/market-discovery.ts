import { createJobLogger } from '../../lib/logger';
import { getMarketBySlug } from '../../api/gamma-api';
import type { MarketInfo, ArbMarketConfig } from './arb-types';

const log = createJobLogger('arb-market-discovery');

// Cache: slug → MarketInfo (token IDs don't change per market)
const cache = new Map<string, MarketInfo>();

// Full names used in hourly slugs
const ASSET_FULL_NAMES: Record<string, string> = {
  btc: 'bitcoin', eth: 'ethereum', sol: 'solana', xrp: 'xrp',
};

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/**
 * Build the slug for a crypto Up/Down market from its config and candle timestamp.
 *
 * Hourly markets use a human-readable format in ET:
 *   "bitcoin-up-or-down-march-2-5am-et"
 * All other durations use numeric timestamps:
 *   "btc-updown-5m-1772448300"
 */
export function buildSlug(marketConfig: ArbMarketConfig, slugTimestamp: number): string {
  if (marketConfig.duration === '1h') {
    return buildHourlySlug(marketConfig.asset, slugTimestamp);
  }
  return `${marketConfig.slugPrefix}${slugTimestamp}`;
}

/**
 * Build hourly slug: "{fullname}-up-or-down-{month}-{day}-{hour}{ampm}-et"
 * The hour is in America/New_York timezone (ET).
 */
function buildHourlySlug(asset: string, slugTimestamp: number): string {
  const fullName = ASSET_FULL_NAMES[asset] ?? asset;
  // Convert to ET (America/New_York handles DST automatically)
  const date = new Date(slugTimestamp * 1000);
  const etParts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    hour12: true,
  }).formatToParts(date);

  const month = parseInt(etParts.find((p) => p.type === 'month')?.value ?? '1', 10);
  const day = parseInt(etParts.find((p) => p.type === 'day')?.value ?? '1', 10);
  const hour = parseInt(etParts.find((p) => p.type === 'hour')?.value ?? '12', 10);
  const dayPeriod = (etParts.find((p) => p.type === 'dayPeriod')?.value ?? 'am').toLowerCase();

  const monthName = MONTH_NAMES[month - 1];
  return `${fullName}-up-or-down-${monthName}-${day}-${hour}${dayPeriod}-et`;
}

/**
 * Discover a BTC Up/Down market by slug, returning token IDs for Up and Down outcomes.
 * Results are cached since token IDs are immutable per market.
 */
export async function discoverMarket(slug: string): Promise<MarketInfo | null> {
  const cached = cache.get(slug);
  if (cached) return cached;

  const market = await getMarketBySlug(slug);
  if (!market) {
    log.debug(`Market not found for slug: ${slug}`);
    return null;
  }

  // Parse outcomes and clobTokenIds from the Gamma API response
  // GammaMarketSchema uses .passthrough(), so these fields flow through untyped
  const raw = market as Record<string, unknown>;
  let outcomes: string[];
  let clobTokenIds: string[];

  try {
    outcomes = typeof market.outcomes === 'string' ? JSON.parse(market.outcomes) : [];
    clobTokenIds = typeof raw.clobTokenIds === 'string'
      ? JSON.parse(raw.clobTokenIds as string)
      : [];
  } catch {
    log.warn(`Failed to parse market data for ${slug}`, { outcomes: market.outcomes, clobTokenIds: raw.clobTokenIds });
    return null;
  }

  if (outcomes.length < 2 || clobTokenIds.length < 2) {
    log.warn(`Insufficient outcomes/tokens for ${slug}`, { outcomes, tokenCount: clobTokenIds.length });
    return null;
  }

  const upIndex = outcomes.findIndex((o) => o.toLowerCase() === 'up');
  const downIndex = outcomes.findIndex((o) => o.toLowerCase() === 'down');

  if (upIndex === -1 || downIndex === -1) {
    log.warn(`Could not find Up/Down outcomes in ${slug}`, { outcomes });
    return null;
  }

  const info: MarketInfo = {
    slug,
    upTokenId: clobTokenIds[upIndex],
    downTokenId: clobTokenIds[downIndex],
    conditionId: market.conditionId,
    negRisk: market.negRisk ?? false,
  };

  cache.set(slug, info);
  log.info(`Discovered market: ${slug}`, {
    conditionId: info.conditionId.slice(0, 16) + '...',
    upToken: info.upTokenId.slice(0, 16) + '...',
    downToken: info.downTokenId.slice(0, 16) + '...',
    negRisk: info.negRisk,
  });

  return info;
}

/**
 * Prune old entries from the cache to prevent unbounded growth.
 * Call periodically (e.g., every hour).
 */
export function pruneCache(maxEntries = 500): void {
  if (cache.size <= maxEntries) return;
  // Remove oldest entries (Map preserves insertion order)
  const toRemove = cache.size - maxEntries;
  let removed = 0;
  for (const key of cache.keys()) {
    if (removed >= toRemove) break;
    cache.delete(key);
    removed++;
  }
  log.debug(`Pruned ${removed} entries from market cache`);
}
