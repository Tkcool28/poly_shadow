import { z } from 'zod/v4';
import { dataApi } from '../lib/api-client';
import { logger } from '../lib/logger';
import {
  TRADES_PAGE_SIZE,
  CLOSED_POSITIONS_PAGE_SIZE,
  POSITIONS_PAGE_SIZE,
  TRADES_MAX_OFFSET,
  CLOSED_POSITIONS_MAX_OFFSET,
  POSITIONS_MAX_OFFSET,
  BACKFILL_HISTORY_DAYS,
} from '../config/constants';
import {
  LeaderboardEntrySchema,
  TradeSchema,
  PositionSchema,
  ClosedPositionSchema,
  ActivitySchema,
  ValueSchema,
  TradedSchema,
  type LeaderboardEntry,
  type TradeData,
  type PositionData,
  type ClosedPositionData,
  type ActivityData,
  type ValueData,
  type TradedData,
} from './types';

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

// ─── Leaderboard ───

export async function getLeaderboard(params: {
  category?: string;
  timePeriod?: string;
  orderBy?: string;
  limit?: number;
  offset?: number;
}): Promise<LeaderboardEntry[]> {
  const raw = await dataApi.get<unknown[]>('/v1/leaderboard', params);
  if (!Array.isArray(raw)) return [];
  return safeParseArray(LeaderboardEntrySchema, raw, 'leaderboard');
}

// ─── Trades ───

export async function getTrades(params: {
  user?: string;
  market?: string;
  limit?: number;
  offset?: number;
  side?: string;
}): Promise<TradeData[]> {
  const raw = await dataApi.get<unknown[]>('/trades', params);
  if (!Array.isArray(raw)) return [];
  return safeParseArray(TradeSchema, raw, 'trades');
}

// ─── Positions ───

export async function getPositions(params: {
  user: string;
  market?: string;
  limit?: number;
  offset?: number;
  sizeThreshold?: number;
}): Promise<PositionData[]> {
  const raw = await dataApi.get<unknown[]>('/positions', {
    ...params,
    sizeThreshold: params.sizeThreshold ?? 0, // get all positions including tiny ones
  });
  if (!Array.isArray(raw)) return [];
  return safeParseArray(PositionSchema, raw, 'positions');
}

// ─── Closed Positions ───

export async function getClosedPositions(params: {
  user: string;
  market?: string;
  limit?: number;
  offset?: number;
  sortBy?: string;
  sortDirection?: string;
}): Promise<ClosedPositionData[]> {
  const raw = await dataApi.get<unknown[]>('/closed-positions', params);
  if (!Array.isArray(raw)) return [];
  return safeParseArray(ClosedPositionSchema, raw, 'closed-positions');
}

// ─── Activity ───

export async function getActivity(params: {
  user: string;
  market?: string;
  type?: string;
  start?: number;
  end?: number;
  limit?: number;
  offset?: number;
}): Promise<ActivityData[]> {
  const raw = await dataApi.get<unknown[]>('/activity', params);
  if (!Array.isArray(raw)) return [];
  return safeParseArray(ActivitySchema, raw, 'activity');
}

// ─── Value ───

export async function getValue(user: string): Promise<ValueData> {
  const raw = await dataApi.get<unknown>('/value', { user });
  return ValueSchema.parse(raw);
}

// ─── Traded ───

export async function getTraded(user: string): Promise<TradedData> {
  const raw = await dataApi.get<unknown>('/traded', { user });
  return TradedSchema.parse(raw);
}

// ─── Pagination Helpers ───

export async function getAllTrades(user: string): Promise<TradeData[]> {
  const allTrades: TradeData[] = [];
  const pageSize = TRADES_PAGE_SIZE;
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - BACKFILL_HISTORY_DAYS * 86400;
  let offset = 0;
  let reachedCutoff = false;

  while (offset < TRADES_MAX_OFFSET) {
    let batch: TradeData[];
    try {
      batch = await getTrades({ user, limit: pageSize, offset });
    } catch (err: any) {
      if (offset > 0 && err.response?.status === 400) {
        logger.warn(`Trades pagination hit API limit at offset ${offset} for ${user}. Returning ${allTrades.length} trades.`);
        break;
      }
      throw err;
    }
    if (batch.length === 0) break;

    for (const trade of batch) {
      if (trade.timestamp >= cutoffTimestamp) {
        allTrades.push(trade);
      } else {
        reachedCutoff = true;
        break;
      }
    }

    if (reachedCutoff || batch.length < pageSize) break;
    offset += batch.length;
  }

  if (reachedCutoff) {
    logger.info(`Trades cutoff reached for ${user}: ${allTrades.length} trades within ${BACKFILL_HISTORY_DAYS} days`);
  } else if (offset >= TRADES_MAX_OFFSET) {
    logger.warn(`Reached max offset ${TRADES_MAX_OFFSET} for trades of ${user}. Fetched ${allTrades.length} trades; older trades may be missing.`);
  }

  return allTrades;
}

export async function getAllClosedPositions(user: string): Promise<ClosedPositionData[]> {
  const all: ClosedPositionData[] = [];
  const pageSize = CLOSED_POSITIONS_PAGE_SIZE;
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - BACKFILL_HISTORY_DAYS * 86400;
  let offset = 0;
  let reachedCutoff = false;

  while (offset < CLOSED_POSITIONS_MAX_OFFSET) {
    let batch: ClosedPositionData[];
    try {
      batch = await getClosedPositions({
        user,
        limit: pageSize,
        offset,
        sortBy: 'TIMESTAMP',
        sortDirection: 'DESC',
      });
    } catch (err: any) {
      if (offset > 0 && err.response?.status === 400) {
        logger.warn(`Closed positions pagination hit API limit at offset ${offset} for ${user}. Returning ${all.length} closed positions.`);
        break;
      }
      throw err;
    }
    if (batch.length === 0) break;

    for (const cp of batch) {
      if (cp.timestamp >= cutoffTimestamp) {
        all.push(cp);
      } else {
        reachedCutoff = true;
        break;
      }
    }

    if (reachedCutoff || batch.length < pageSize) break;
    offset += batch.length;
  }

  if (reachedCutoff) {
    logger.info(`Closed positions cutoff reached for ${user}: ${all.length} within ${BACKFILL_HISTORY_DAYS} days`);
  } else if (offset >= CLOSED_POSITIONS_MAX_OFFSET) {
    logger.warn(`Reached max offset ${CLOSED_POSITIONS_MAX_OFFSET} for closed positions of ${user}. Fetched ${all.length}; some may be missing.`);
  }

  return all;
}

export async function getAllPositions(user: string): Promise<PositionData[]> {
  const all: PositionData[] = [];
  const pageSize = POSITIONS_PAGE_SIZE;
  let offset = 0;

  while (offset < POSITIONS_MAX_OFFSET) {
    let batch: PositionData[];
    try {
      batch = await getPositions({ user, limit: pageSize, offset });
    } catch (err: any) {
      if (offset > 0 && err.response?.status === 400) {
        logger.warn(`Positions pagination hit API limit at offset ${offset} for ${user}. Returning ${all.length} positions.`);
        break;
      }
      throw err;
    }
    all.push(...batch);
    if (batch.length === 0 || batch.length < pageSize) break;
    offset += batch.length;
  }

  if (offset >= POSITIONS_MAX_OFFSET) {
    logger.warn(`Reached max offset ${POSITIONS_MAX_OFFSET} for positions of ${user}. Fetched ${all.length}; some may be missing.`);
  }

  return all;
}

export async function getAllActivity(user: string): Promise<ActivityData[]> {
  const all: ActivityData[] = [];
  const pageSize = 500;
  let offset = 0;
  const maxOffset = 10000;

  while (offset < maxOffset) {
    const batch = await getActivity({ user, limit: pageSize, offset });
    all.push(...batch);
    if (batch.length === 0 || batch.length < pageSize) break;
    offset += batch.length;
  }

  return all;
}
