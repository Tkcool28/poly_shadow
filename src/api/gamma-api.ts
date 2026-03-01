import { z } from 'zod/v4';
import { gammaApi } from '../lib/api-client';
import { logger } from '../lib/logger';
import { GammaMarketSchema, type GammaMarketData } from './types';

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

/**
 * Fetch markets by condition IDs. The Gamma API only supports single
 * condition_ids lookups, so we query one at a time with rate limiting.
 */
export async function getMarketsByConditionIds(conditionIds: string[]): Promise<GammaMarketData[]> {
  if (conditionIds.length === 0) return [];

  const allMarkets: GammaMarketData[] = [];

  for (const conditionId of conditionIds) {
    try {
      const markets = await getMarkets({
        condition_ids: conditionId,
        limit: 1,
      });
      allMarkets.push(...markets);
    } catch (err: any) {
      // Skip individual failures
      logger.debug(`Failed to resolve market ${conditionId.slice(0, 16)}: ${err.message}`);
    }
  }

  return allMarkets;
}
