import { z } from 'zod/v4';
import { dataApi } from '../lib/api-client';
import { logger } from '../lib/logger';
import { CLOSED_POSITIONS_PAGE_SIZE } from '../config/constants';
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

export async function getAllTrades(user: string, maxOffset = 10000): Promise<TradeData[]> {
  const allTrades: TradeData[] = [];
  const pageSize = 10000;
  let offset = 0;

  while (offset < maxOffset) {
    const batch = await getTrades({ user, limit: pageSize, offset });
    allTrades.push(...batch);

    if (batch.length < pageSize) break;
    offset += pageSize;

    if (offset >= maxOffset) {
      logger.warn(`Reached max offset ${maxOffset} for trades of ${user}. Some older trades may be missing.`);
    }
  }

  return allTrades;
}

export async function getAllClosedPositions(user: string): Promise<ClosedPositionData[]> {
  const all: ClosedPositionData[] = [];
  const pageSize = CLOSED_POSITIONS_PAGE_SIZE;
  let offset = 0;
  const maxOffset = 100000;

  while (offset < maxOffset) {
    const batch = await getClosedPositions({ user, limit: pageSize, offset });
    all.push(...batch);

    if (batch.length < pageSize) break;
    offset += pageSize;
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

    if (batch.length < pageSize) break;
    offset += pageSize;
  }

  return all;
}
