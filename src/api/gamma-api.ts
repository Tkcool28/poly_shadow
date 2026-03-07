import { z } from 'zod/v4';
import { gammaApi } from '../lib/api-client';
import { logger } from '../lib/logger';
import { GammaMarketSchema, GammaEventSchema, type GammaMarketData, type GammaEventData } from './types';

function safeParseArray<T>(schema: z.ZodType<T>, data: unknown[], label: string): T[] {
  const results: T[] = [];
  let skipped = 0;

  for (const item of data) {
    const parsed = schema.safeParse(item);
    if (parsed.success) {
      results.push(parsed.data);
    } else {
      skipped++;
    }
  }

  if (skipped > 0) {
    logger.warn(`${label}: skipped ${skipped}/${data.length} items due to validation errors`);
  }

  return results;
}

export async function getMarkets(params: {
  condition_ids?: string;
  limit?: number;
  offset?: number;
}): Promise<GammaMarketData[]> {
  const raw = await gammaApi.get<unknown[]>('/markets', params);
  if (!Array.isArray(raw)) return [];
  return safeParseArray(GammaMarketSchema, raw, 'gamma-markets');
}

export async function getMarketBySlug(slug: string): Promise<GammaMarketData | null> {
  const raw = await gammaApi.get<unknown[]>('/markets', { slug, limit: 1 });
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const parsed = GammaMarketSchema.safeParse(raw[0]);
  return parsed.success ? parsed.data : null;
}

/**
 * Paginate all active (non-closed) markets from the Gamma API.
 * Uses the existing Bottleneck-wrapped `gammaApi` client for rate limiting.
 */
export async function getActiveMarkets(params: {
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<GammaMarketData[]> {
  const raw = await gammaApi.get<unknown[]>('/markets', {
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
    active: params.active ?? true,
    closed: params.closed ?? false,
  });
  if (!Array.isArray(raw)) return [];
  return safeParseArray(GammaMarketSchema, raw, 'gamma-active-markets');
}

/**
 * Fetch active events by tag_slug from the Gamma events endpoint.
 * Events contain nested markets — this is the correct way to discover
 * esports/sports markets (they are unreachable via /markets pagination).
 */
export async function getActiveEvents(params: {
  tag_slug: string;
  limit?: number;
  offset?: number;
  active?: boolean;
  closed?: boolean;
}): Promise<GammaEventData[]> {
  const raw = await gammaApi.get<unknown[]>('/events', {
    tag_slug: params.tag_slug,
    limit: params.limit ?? 100,
    offset: params.offset ?? 0,
    active: params.active ?? true,
    closed: params.closed ?? false,
  });
  if (!Array.isArray(raw)) return [];
  return safeParseArray(GammaEventSchema, raw, `gamma-events-${params.tag_slug}`);
}

/**
 * Fetch markets by condition IDs. The Gamma API only supports single
 * condition_ids lookups, so we query one at a time. All lookups are
 * submitted concurrently — Bottleneck's maxConcurrent (5) and reservoir
 * (300/10s) on gammaApiMarkets handle throttling automatically.
 */
export async function getMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarketData[]> {
  if (conditionIds.length === 0) return [];

  const results = await Promise.allSettled(
    conditionIds.map((conditionId) =>
      getMarkets({ condition_ids: conditionId, limit: 1 })
    )
  );

  const allMarkets: GammaMarketData[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    if (result.status === 'fulfilled') {
      allMarkets.push(...result.value);
    } else {
      logger.debug(`Failed to resolve market ${conditionIds[i].slice(0, 16)}: ${result.reason?.message}`);
    }
  }

  return allMarkets;
}
