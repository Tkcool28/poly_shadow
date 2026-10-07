import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readNdjson } from './ndjson.js';
import { addShadowObservation } from './phase4.js';
import type { CohortFn, ShadowGroup } from './phase4.js';
import { tradeGroupKey } from '../shadow/racing.js';
import type { SourceObservationRow } from '../shadow/racing.js';

async function* optionalRows<T = Record<string, unknown>>(dir: string, name: string) {
  const file = join(dir, name);
  if (existsSync(file)) yield* readNdjson<T>(file);
}

/** Counters and exact upper median; memory scales with distinct CDN ages,
 * not raw payload bytes. Preserve Number(null/empty)=0 and reject only NaN. */
export async function readHealth(dir?: string): Promise<Record<string, unknown>> {
  if (!dir) return { available: false };
  let restPolls = 0, restErrors = 0, quarantineCount = 0, chainRawEvents = 0;
  let lastRestError: string | null = null, latestObservationUtc: string | null = null;
  let recoveryRequired = false, ageCount = 0;
  const ageCounts = new Map<number, number>();
  for await (const t of optionalRows(dir, 'poll_telemetry.ndjson')) {
    restPolls++;
    if (t['error']) { restErrors++; lastRestError = String(t['error']).slice(0, 120); }
    const age = Number(t['ageHeader']);
    if (!Number.isNaN(age)) { ageCount++; ageCounts.set(age, (ageCounts.get(age) ?? 0) + 1); }
  }
  let cdnAgeP50Sec: number | null = null;
  let cumulative = 0;
  for (const [age, count] of [...ageCounts].sort(([a], [b]) => a - b)) {
    cumulative += count;
    if (cumulative > Math.floor(ageCount / 2)) { cdnAgeP50Sec = age; break; }
  }
  for await (const q of optionalRows(dir, 'quarantine.ndjson')) {
    quarantineCount++;
    if ((q['detail'] as Record<string, unknown>)?.['recoveryRequired'] === true) recoveryRequired = true;
  }
  for await (const o of optionalRows(dir, 'source_observations.ndjson')) latestObservationUtc = String(o['completedUtc'] ?? '');
  for await (const _ of optionalRows(dir, 'raw_logs.ndjson')) chainRawEvents++;
  return { available: true, chainRawEvents, latestObservationUtc, restPolls, restErrors, lastRestError, cdnAgeP50Sec, quarantineCount, recoveryRequired };
}

/** First valid REST title/conditionId wins, exactly as in the legacy CLI. */
export async function readMarketMetadata(dir: string): Promise<Map<string, string>> {
  const markets = new Map<string, string>();
  for await (const r of optionalRows<{ payload?: Record<string, unknown> }>(dir, 'rest_raw.ndjson')) {
    const p = r.payload ?? {};
    const tx = String(p['transactionHash'] ?? '').toLowerCase();
    const asset = p['asset'] != null && p['asset'] !== '' ? String(p['asset']) : null;
    const size6 = typeof p['size'] === 'number' ? p['size'].toFixed(6) : null;
    const market = (p['title'] ?? p['conditionId']) as string | undefined;
    if (tx && asset && size6 && market && !markets.has(tradeGroupKey(tx, asset, size6))) {
      markets.set(tradeGroupKey(tx, asset, size6), market);
    }
  }
  return markets;
}

/** Retain only comparator essentials per included economic group, never raw
 * observations/members. Group insertion and first-member metadata unchanged. */
export async function readShadowGroups(
  dir: string, cohort: CohortFn, window: { startUtc: string; endUtc: string },
): Promise<Map<string, ShadowGroup>> {
  const groups = new Map<string, ShadowGroup>();
  for await (const row of optionalRows<SourceObservationRow>(dir, 'source_observations.ndjson')) {
    addShadowObservation(groups, row, cohort, window);
  }
  return groups;
}
