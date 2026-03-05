#!/usr/bin/env tsx
/**
 * Arb Calibration Script
 *
 * Extracts empirical opposite-token price data from ArbCycle records
 * and builds a calibration model for backtest entry filtering.
 *
 * The model maps (marketType, moveMagnitude_bucket) → entry rates per price tier,
 * allowing the backtest to realistically filter entries based on actual Polymarket
 * token pricing behavior observed in live/paper trading.
 *
 * Usage: npx tsx src/scripts/arb-calibrate.ts
 * Output: src/scripts/backtest-cache/calibration-model.json
 */

import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { prisma } from '../lib/prisma';
import { getBucketLabel, type BucketStats, type CalibrationModel } from './backtest-price-model';

// ─── Config ───

const CACHE_DIR = join(__dirname, 'backtest-cache');
const OUTPUT_FILE = join(CACHE_DIR, 'calibration-model.json');

// Price tiers to compute entry rates for
const PRICE_TIERS = [0.02, 0.05, 0.10, 0.15, 0.20];

// ─── Types ───

interface CalibrationSample {
  marketType: string;
  moveMagnitude: number;
  oppositePrice: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = (p / 100) * (sorted.length - 1);
  const lower = Math.floor(idx);
  const upper = Math.ceil(idx);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (idx - lower);
}

// ─── Main ───

async function main(): Promise<void> {
  console.log('Arb Calibration — extracting empirical opposite-token price data\n');

  // Query all contrarian cycles
  const cycles = await prisma.arbCycle.findMany({
    where: { strategy: { contains: 'contrarian' } },
    select: {
      marketType: true,
      btcOpenPrice: true,
      btcEntryPrice: true,
      entryPrice: true,
      oppositePrice: true,
      failReason: true,
      status: true,
    },
  });

  console.log(`Total contrarian cycles: ${cycles.length}`);

  // Extract (marketType, moveMagnitude, oppositePrice) tuples
  const samples: CalibrationSample[] = [];
  let parsedFromFailReason = 0;
  let parsedFromOppositePrice = 0;
  let parsedFromEntryPrice = 0;
  let skippedNoPrice = 0;
  let skippedNoMagnitude = 0;

  for (const c of cycles) {
    // Get oppositePrice from best available source
    let price: number | null = null;

    if (c.oppositePrice != null && Number.isFinite(c.oppositePrice)) {
      price = c.oppositePrice;
      parsedFromOppositePrice++;
    } else if (c.entryPrice != null && Number.isFinite(c.entryPrice) && c.status !== 'SKIPPED') {
      // ENTERED/LOST/WON cycles — entryPrice IS the opposite token price
      price = c.entryPrice;
      parsedFromEntryPrice++;
    } else if (c.failReason) {
      // Parse from failReason: "opposite price $0.047 > max $0.02"
      const match = c.failReason.match(/opposite price \$?([\d.]+)/);
      if (match) {
        const parsed = parseFloat(match[1]);
        if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) {
          price = parsed;
          parsedFromFailReason++;
        }
      }
    }

    if (price == null) {
      skippedNoPrice++;
      continue;
    }

    // Compute moveMagnitude from btcOpenPrice/btcEntryPrice
    if (!c.btcOpenPrice || !c.btcEntryPrice || c.btcOpenPrice === 0) {
      skippedNoMagnitude++;
      continue;
    }
    const moveMagnitude = Math.abs(c.btcEntryPrice - c.btcOpenPrice) / c.btcOpenPrice;

    samples.push({
      marketType: c.marketType,
      moveMagnitude,
      oppositePrice: price,
    });
  }

  console.log(`\nData extraction:`);
  console.log(`  From oppositePrice column: ${parsedFromOppositePrice}`);
  console.log(`  From entryPrice (entered): ${parsedFromEntryPrice}`);
  console.log(`  From failReason parsing:   ${parsedFromFailReason}`);
  console.log(`  Skipped (no price):        ${skippedNoPrice}`);
  console.log(`  Skipped (no magnitude):    ${skippedNoMagnitude}`);
  console.log(`  Total usable samples:      ${samples.length}`);

  if (samples.length === 0) {
    console.error('\nNo usable samples found. Run paper arb trading to collect data first.');
    process.exit(1);
  }

  // Group by (marketType, bucket) and compute stats
  const grouped = new Map<string, Map<string, number[]>>();
  for (const s of samples) {
    const bucket = getBucketLabel(s.moveMagnitude);
    if (!grouped.has(s.marketType)) grouped.set(s.marketType, new Map());
    const marketMap = grouped.get(s.marketType)!;
    if (!marketMap.has(bucket)) marketMap.set(bucket, []);
    marketMap.get(bucket)!.push(s.oppositePrice);
  }

  // Also compute an "all" aggregate across market types for each duration
  // Extract duration from marketType (e.g., "sol-5m" → "5m")
  const byDuration = new Map<string, Map<string, number[]>>();
  for (const s of samples) {
    const duration = s.marketType.split('-').pop() ?? s.marketType;
    const bucket = getBucketLabel(s.moveMagnitude);
    if (!byDuration.has(duration)) byDuration.set(duration, new Map());
    const dMap = byDuration.get(duration)!;
    if (!dMap.has(bucket)) dMap.set(bucket, []);
    dMap.get(bucket)!.push(s.oppositePrice);
  }

  // Build model
  const model: CalibrationModel = {
    generatedAt: new Date().toISOString(),
    sampleCount: samples.length,
    buckets: {},
  };

  // Per-marketType buckets
  for (const [marketType, bucketMap] of grouped) {
    model.buckets[marketType] = {};
    for (const [bucket, prices] of bucketMap) {
      model.buckets[marketType][bucket] = computeBucketStats(prices);
    }
  }

  // Duration-aggregated buckets (e.g., "5m" combines sol-5m + eth-5m + xrp-5m)
  for (const [duration, bucketMap] of byDuration) {
    model.buckets[`_all_${duration}`] = {};
    for (const [bucket, prices] of bucketMap) {
      model.buckets[`_all_${duration}`][bucket] = computeBucketStats(prices);
    }
  }

  // Write output
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(OUTPUT_FILE, JSON.stringify(model, null, 2));
  console.log(`\nCalibration model written to: ${OUTPUT_FILE}`);

  // Print summary table
  console.log('\n─── Calibration Summary ───\n');
  for (const [key, bucketMap] of Object.entries(model.buckets)) {
    console.log(`  ${key}:`);
    for (const [bucket, stats] of Object.entries(bucketMap)) {
      const tierStr = PRICE_TIERS
        .map((t) => `@$${t.toFixed(2)}=${(stats.entryRate[t.toFixed(2)] * 100).toFixed(0)}%`)
        .join('  ');
      console.log(`    ${bucket.padEnd(12)} n=${String(stats.count).padStart(4)}  p50=$${stats.p50.toFixed(3)}  ${tierStr}`);
    }
  }

  console.log('\nDone.');
  await prisma.$disconnect();
  process.exit(0);
}

function computeBucketStats(prices: number[]): BucketStats {
  const sorted = [...prices].sort((a, b) => a - b);
  const mean = prices.reduce((a, b) => a + b, 0) / prices.length;

  const entryRate: Record<string, number> = {};
  for (const tier of PRICE_TIERS) {
    const count = sorted.filter((p) => p <= tier).length;
    entryRate[tier.toFixed(2)] = count / sorted.length;
  }

  return {
    count: sorted.length,
    p25: percentile(sorted, 25),
    p50: percentile(sorted, 50),
    p75: percentile(sorted, 75),
    mean,
    entryRate,
  };
}

main().catch((err) => {
  console.error('Calibration failed:', err);
  process.exit(1);
});
