#!/usr/bin/env node
/**
 * Multi-source observation-run metrics (handoff §10).
 * Reads a shadow data directory and prints the Phase 3 frozen-run report.
 * Discovery-system validation only — no P&L, no profitability.
 *
 * Usage: node scripts/multisource-metrics.mjs <dataDir>
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { epochMicros, secondsMicros } from '../src/compare/exact-clock.ts';

const dir = process.argv[2] ?? './shadow-data';

function rows(name) {
  const f = join(dir, name);
  if (!existsSync(f)) return [];
  return readFileSync(f, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
}

const pct = (sorted, p) =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] : null;

const sources = ['CHAIN', 'REST_TRADES', 'REST_ACTIVITY'];
const obs = rows('source_observations.ndjson');
const rec = rows('reconciliation.ndjson');
const tel = rows('poll_telemetry.ndjson');
const chainRaw = rows('raw_logs.ndjson');
const restRaw = rows('rest_raw.ndjson');
const quar = rows('quarantine.ndjson');

const bySource = (s) => obs.filter((o) => o.source === s);

// Unique normalized observations per source + source-only / matched counts.
const groups = new Map();
for (const r of rec) {
  if (!groups.has(r.groupKey)) groups.set(r.groupKey, []);
  groups.get(r.groupKey).push(r);
}
const sourceSets = Object.fromEntries(sources.map((s) => [s, new Set(bySource(s).map((o) => o.groupKey))]));
const sourceOnly = Object.fromEntries(sources.map((s) => [s,
  [...sourceSets[s]].filter((g) => sources.every((o) => o === s || !sourceSets[o].has(g))).length]));

const winners = {};
for (const r of rec.filter((x) => x.position === 'FIRST')) {
  winners[r.source] = (winners[r.source] ?? 0) + 1;
}

// Latency vs chain block timestamp where meaningful (sourceFirstSeen - sourceTs).
function latencyStats(s) {
  const ds = bySource(s)
    .filter((o) => o.sourceTs !== null && o.sourceFirstSeenUtc)
    .map((o) => epochMicros(o.sourceFirstSeenUtc) - secondsMicros(o.sourceTs))
    .filter((d) => d >= 0n && d < 86400000000n)
    .sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(d => Number(d) / 1000000);
  return { n: ds.length, p50: pct(ds, 50), p95: pct(ds, 95) };
}

// REST response delay + cache behavior.
const restTel = tel.filter((t) => t.responseUtc);
const delays = restTel.map((t) => epochMicros(t.responseUtc) - epochMicros(t.requestStartUtc)).sort((a,b) => a < b ? -1 : a > b ? 1 : 0).map(d => Number(d) / 1000);
const ages = restTel.map((t) => Number(t.ageHeader)).filter((a) => !Number.isNaN(a)).sort((a, b) => a - b);

const report = {
  dataDir: dir,
  generatedUtc: new Date().toISOString(),
  rawEventsPerSource: {
    CHAIN: chainRaw.length,
    REST_TRADES: restRaw.filter((r) => r.source === 'REST_TRADES').length,
    REST_ACTIVITY: restRaw.filter((r) => r.source === 'REST_ACTIVITY').length,
  },
  uniqueObservationsPerSource: Object.fromEntries(sources.map((s) => [s, bySource(s).length])),
  sourceOnlyObservations: sourceOnly,
  groups: {
    total: groups.size,
    matchedBy2PlusSources: [...groups.values()].filter((m) => new Set(m.map((x) => x.source)).size >= 2).length,
    seenByAllSources: [...groups.values()].filter((m) => new Set(m.map((x) => x.source)).size === sources.length).length,
    unmatchedAtEnd: [...groups.values()].filter((m) => m.length === 1).length,
  },
  firstSourceWinnerCounts: winners,
  makerVsTaker: {
    CHAIN: {
      TAKER_AGGREGATE: bySource('CHAIN').filter((o) => o.role === 'TAKER_AGGREGATE').length,
      MAKER_LEG: bySource('CHAIN').filter((o) => o.role === 'MAKER_LEG').length,
    },
    REST_roleUnknown: bySource('REST_TRADES').filter((o) => o.role === 'UNKNOWN').length
      + bySource('REST_ACTIVITY').filter((o) => o.role === 'UNKNOWN').length,
  },
  buyVsSell: Object.fromEntries(sources.map((s) => [s, {
    BUY: bySource(s).filter((o) => o.side === 'BUY').length,
    SELL: bySource(s).filter((o) => o.side === 'SELL').length,
    unknown: bySource(s).filter((o) => o.side === null).length,
  }])),
  latencySecondsVsSourceTs: Object.fromEntries(sources.map((s) => [s, latencyStats(s)])),
  rest: {
    polls: tel.length,
    errors: tel.filter((t) => t.error).length,
    responseDelayMs: { p50: pct(delays, 50), p95: pct(delays, 95) },
    cdnAgeHeaderSeconds: { p50: pct(ages, 50), p95: pct(ages, 95), samples: ages.length },
    duplicatesSeen: tel.reduce((n, t) => n + t.duplicates, 0),
  },
  hydration: {
    FULL: obs.filter((o) => o.hydration === 'FULL').length,
    PARTIAL: obs.filter((o) => o.hydration === 'PARTIAL').length,
  },
  quarantineCount: quar.length,
  reconciliationRows: rec.length,
};

console.log(JSON.stringify(report, null, 2));
