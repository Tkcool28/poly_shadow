#!/usr/bin/env tsx
/**
 * Arb Strategy Backtester
 *
 * Tests direction prediction accuracy and P&L for standard vs contrarian strategies
 * using historical Binance crypto prices + Polymarket settlement outcomes.
 *
 * Usage:
 *   npx tsx src/scripts/arb-backtest.ts --asset btc --duration 5m --days 7
 *   npx tsx src/scripts/arb-backtest.ts --asset btc,eth --duration 5m,15m --days 30
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';
import { fetchKlines, type Kline } from '../services/arb/binance-klines';
import { getMarketBySlug } from '../api/gamma-api';
import {
  DURATION_CONFIGS,
  SUPPORTED_ASSETS,
  buildMarketConfig,
  type ArbDurationConfig,
  type SupportedAsset,
} from '../services/arb/arb-types';
import { getCandleInfo } from '../services/arb/arb-engine';
import { buildSlug } from '../services/arb/market-discovery';

// ─── CLI Args ───

const { values } = parseArgs({
  options: {
    asset: { type: 'string', default: 'btc' },
    duration: { type: 'string', default: '5m' },
    days: { type: 'string', default: '7' },
    'cache-dir': { type: 'string', default: 'src/scripts/backtest-cache' },
  },
});

const assets = (values.asset ?? 'btc').split(',').map((a) => a.trim().toLowerCase()) as SupportedAsset[];
const durations = (values.duration ?? '5m').split(',').map((d) => d.trim());
const days = parseInt(values.days ?? '7', 10);
const cacheDir = values['cache-dir'] ?? 'src/scripts/backtest-cache';

// Validate inputs
for (const asset of assets) {
  if (!SUPPORTED_ASSETS.includes(asset)) {
    console.error(`Unsupported asset: ${asset}. Supported: ${SUPPORTED_ASSETS.join(', ')}`);
    process.exit(1);
  }
}
for (const dur of durations) {
  if (!DURATION_CONFIGS[dur]) {
    console.error(`Unsupported duration: ${dur}. Supported: ${Object.keys(DURATION_CONFIGS).join(', ')}`);
    process.exit(1);
  }
}

// ─── Disk Cache ───

function ensureCacheDir(subdir: string): void {
  const dir = join(cacheDir, subdir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function cachedReadJSON<T>(subdir: string, key: string): T | null {
  const filePath = join(cacheDir, subdir, `${key}.json`);
  if (!existsSync(filePath)) return null;
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function cachedWriteJSON(subdir: string, key: string, data: unknown): void {
  ensureCacheDir(subdir);
  const filePath = join(cacheDir, subdir, `${key}.json`);
  writeFileSync(filePath, JSON.stringify(data));
}

// ─── Gamma API with caching ───

async function cachedGetMarket(slug: string): Promise<{ closed: boolean; outcomes: string; outcomePrices?: string | null } | null> {
  const cached = cachedReadJSON<{ closed: boolean; outcomes: string; outcomePrices?: string | null }>('gamma', slug);
  if (cached) return cached;

  try {
    const market = await getMarketBySlug(slug);
    if (!market) {
      // Cache miss (market not found) — write null marker to avoid re-querying
      cachedWriteJSON('gamma', slug, null);
      return null;
    }
    const data = {
      closed: market.closed,
      outcomes: market.outcomes,
      outcomePrices: market.outcomePrices ?? null,
    };
    cachedWriteJSON('gamma', slug, data);
    return data;
  } catch {
    return null; // Transient API error — don't cache
  }
}

// ─── Binance klines with caching ───

async function cachedFetchKlines(asset: string, startMs: number, endMs: number): Promise<Kline[]> {
  const key = `${asset}-1m-${startMs}-${endMs}`;
  const cached = cachedReadJSON<Kline[]>('binance', key);
  if (cached) return cached;

  const klines = await fetchKlines(asset, '1m', startMs, endMs);
  cachedWriteJSON('binance', key, klines);
  return klines;
}

// ─── Candle generation ───

function generateCandleTimestamps(dc: ArbDurationConfig, startMs: number, endMs: number): number[] {
  const timestamps: number[] = [];
  // Align to first candle boundary
  const adjusted = startMs - dc.epochOffsetMs;
  let candleStart = Math.floor(adjusted / dc.candleDurationMs) * dc.candleDurationMs + dc.epochOffsetMs;

  while (candleStart < endMs) {
    timestamps.push(candleStart);
    candleStart += dc.candleDurationMs;
  }

  return timestamps;
}

// ─── Direction from klines ───

function getDirectionFromKlines(
  klines: Kline[],
  candleStartMs: number,
  dc: ArbDurationConfig,
): 'UP' | 'DOWN' | null {
  // openPrice = kline closest to candle start
  // entryPrice = kline closest to entryStartMs
  const entryTimeMs = candleStartMs + dc.entryStartMs;

  const openKline = klines.find((k) => k.openTime >= candleStartMs);
  const entryKline = findClosestKline(klines, entryTimeMs);

  if (!openKline || !entryKline) return null;

  const openPrice = openKline.open;
  const entryPrice = entryKline.close;

  if (entryPrice === openPrice) return null; // FLAT — skip
  return entryPrice > openPrice ? 'UP' : 'DOWN';
}

function findClosestKline(klines: Kline[], targetMs: number): Kline | null {
  let best: Kline | null = null;
  let bestDelta = Infinity;
  for (const k of klines) {
    const delta = Math.abs(k.openTime - targetMs);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = k;
    }
    // Once we pass the target, no point searching further (klines are sorted)
    if (k.openTime > targetMs + 120_000) break;
  }
  return best;
}

// ─── Settlement parsing ───

function parseSettlement(market: { closed: boolean; outcomes: string; outcomePrices?: string | null }): 'UP' | 'DOWN' | null {
  if (!market.closed || !market.outcomePrices) return null;

  try {
    const outcomes: string[] = JSON.parse(market.outcomes);
    const prices: number[] = JSON.parse(market.outcomePrices).map(Number);

    const upIdx = outcomes.findIndex((o) => o.toLowerCase() === 'up');
    const downIdx = outcomes.findIndex((o) => o.toLowerCase() === 'down');

    if (upIdx === -1 || downIdx === -1) return null;
    if (upIdx >= prices.length || downIdx >= prices.length) return null;

    // Settlement: the winning outcome has price = 1.0 (or very close)
    if (prices[upIdx] >= 0.95) return 'UP';
    if (prices[downIdx] >= 0.95) return 'DOWN';
    return null; // Neither settled definitively
  } catch {
    return null;
  }
}

// ─── P&L calculation ───

interface TradeResult {
  slug: string;
  predictedDirection: 'UP' | 'DOWN';
  settlement: 'UP' | 'DOWN';
  standardPnl: number;
  contrarianPnl_002: number;
  contrarianPnl_005: number;
  contrarianPnl_010: number;
}

function calculatePnl(
  predicted: 'UP' | 'DOWN',
  settlement: 'UP' | 'DOWN',
  positionSizeUsd: number,
): TradeResult['standardPnl'] {
  // Standard: bought predicted side at $0.99
  // Win = settlement matches → shares × $1.00 - cost
  // Loss = settlement doesn't match → shares × $0.00 - cost
  const entryPrice = 0.99;
  const shares = positionSizeUsd / entryPrice;
  const settlementPrice = predicted === settlement ? 1.0 : 0.0;
  return shares * settlementPrice - positionSizeUsd;
}

function calculateContrarianPnl(
  predicted: 'UP' | 'DOWN',
  settlement: 'UP' | 'DOWN',
  positionSizeUsd: number,
  contrarianEntryPrice: number,
): number {
  // Contrarian: bought OPPOSITE side at low price
  // If predicted UP → bought DOWN token
  // Win = settlement is opposite of prediction (DOWN) → shares × $1.00 - cost
  const contrarianDirection = predicted === 'UP' ? 'DOWN' : 'UP';
  const shares = positionSizeUsd / contrarianEntryPrice;
  const settlementPrice = contrarianDirection === settlement ? 1.0 : 0.0;
  return shares * settlementPrice - positionSizeUsd;
}

// ─── Stats ───

interface StrategyStats {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  pnls: number[];
}

function printStats(stats: StrategyStats): void {
  const winRate = stats.trades > 0 ? ((stats.wins / stats.trades) * 100).toFixed(1) : '0.0';
  const avgWin = stats.wins > 0
    ? stats.pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0) / stats.wins
    : 0;
  const avgLoss = stats.losses > 0
    ? stats.pnls.filter((p) => p <= 0).reduce((s, p) => s + p, 0) / stats.losses
    : 0;

  // Sharpe ratio (annualized using actual trades-per-day from the dataset)
  const mean = stats.totalPnl / Math.max(stats.trades, 1);
  const variance = stats.pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / Math.max(stats.trades - 1, 1);
  const stdDev = Math.sqrt(variance);
  const tradesPerYear = (stats.trades / Math.max(days, 1)) * 365;
  const sharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(tradesPerYear) : 0;

  console.log(`  ${stats.label}`);
  console.log(`    Win rate: ${winRate}%  |  Wins: ${stats.wins}  Losses: ${stats.losses}`);
  console.log(`    Avg win: ${avgWin >= 0 ? '+' : ''}$${avgWin.toFixed(2)}  |  Avg loss: $${avgLoss.toFixed(2)}`);
  console.log(`    Total PnL: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}  |  Sharpe: ${sharpe.toFixed(2)}`);
}

// ─── Main ───

async function main(): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  console.log(`\nArb Backtest — ${days} days (${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)})`);
  console.log(`Assets: ${assets.join(', ')}  |  Durations: ${durations.join(', ')}`);
  console.log(`Cache: ${cacheDir}\n`);

  for (const asset of assets) {
    // Fetch 1m klines for the entire date range (shared across durations)
    console.log(`Fetching Binance 1m klines for ${asset.toUpperCase()}...`);
    const klines = await cachedFetchKlines(asset, startMs, endMs);
    console.log(`  ${klines.length} klines fetched\n`);

    for (const dur of durations) {
      const dc = DURATION_CONFIGS[dur];
      const marketConfig = buildMarketConfig(asset as SupportedAsset, dc);
      const candleStarts = generateCandleTimestamps(dc, startMs, endMs);

      // Don't include candles that haven't finished yet
      const resolvedCandleStarts = candleStarts.filter((cs) => cs + dc.candleDurationMs < endMs);

      console.log(`=== ${asset.toUpperCase()}-${dur} — ${resolvedCandleStarts.length} candles ===`);

      let marketsFound = 0;
      let marketsResolved = 0;
      let directionFlat = 0;
      const results: TradeResult[] = [];

      const posSize = 10; // $10 per trade for simulation

      for (let i = 0; i < resolvedCandleStarts.length; i++) {
        const candleStartMs = resolvedCandleStarts[i];

        // Progress indicator
        if ((i + 1) % 200 === 0 || i === resolvedCandleStarts.length - 1) {
          process.stdout.write(`\r  Processing ${i + 1}/${resolvedCandleStarts.length}...`);
        }

        // 1. Get direction from klines
        const candleKlines = klines.filter(
          (k) => k.openTime >= candleStartMs && k.openTime < candleStartMs + dc.candleDurationMs,
        );
        const predicted = getDirectionFromKlines(candleKlines, candleStartMs, dc);
        if (!predicted) {
          directionFlat++;
          continue;
        }

        // 2. Generate slug and query Gamma API
        const candle = getCandleInfo(candleStartMs + dc.entryStartMs, dc.candleDurationMs, dc.epochOffsetMs);
        const slug = buildSlug(marketConfig, candle.slugTimestamp);
        const market = await cachedGetMarket(slug);

        if (!market) continue;
        marketsFound++;

        // 3. Parse settlement
        const settlement = parseSettlement(market);
        if (!settlement) continue;
        marketsResolved++;

        // 4. Calculate P&L
        results.push({
          slug,
          predictedDirection: predicted,
          settlement,
          standardPnl: calculatePnl(predicted, settlement, posSize),
          contrarianPnl_002: calculateContrarianPnl(predicted, settlement, posSize, 0.02),
          contrarianPnl_005: calculateContrarianPnl(predicted, settlement, posSize, 0.05),
          contrarianPnl_010: calculateContrarianPnl(predicted, settlement, posSize, 0.10),
        });
      }

      console.log(''); // Clear progress line
      console.log(`  Markets found: ${marketsFound}/${resolvedCandleStarts.length}  |  Resolved: ${marketsResolved}  |  Flat: ${directionFlat}`);

      if (results.length === 0) {
        console.log('  No resolved trades to analyze.\n');
        continue;
      }

      // Direction accuracy
      const correct = results.filter((r) => r.predictedDirection === r.settlement).length;
      console.log(`  Direction accuracy: ${correct}/${results.length} (${((correct / results.length) * 100).toFixed(1)}%)\n`);

      // Standard strategy stats
      const standardStats: StrategyStats = {
        label: 'Standard (BUY predicted @ $0.99)',
        trades: results.length,
        wins: results.filter((r) => r.standardPnl > 0).length,
        losses: results.filter((r) => r.standardPnl <= 0).length,
        totalPnl: results.reduce((s, r) => s + r.standardPnl, 0),
        pnls: results.map((r) => r.standardPnl),
      };
      printStats(standardStats);

      // Contrarian strategy stats at multiple price points
      for (const [label, key] of [
        ['Contrarian @ $0.02 entry', 'contrarianPnl_002'],
        ['Contrarian @ $0.05 entry', 'contrarianPnl_005'],
        ['Contrarian @ $0.10 entry', 'contrarianPnl_010'],
      ] as const) {
        const pnls = results.map((r) => r[key]);
        const cStats: StrategyStats = {
          label,
          trades: results.length,
          wins: pnls.filter((p) => p > 0).length,
          losses: pnls.filter((p) => p <= 0).length,
          totalPnl: pnls.reduce((s, p) => s + p, 0),
          pnls,
        };
        printStats(cStats);
      }

      // Per-direction breakdown
      const upPredictions = results.filter((r) => r.predictedDirection === 'UP');
      const downPredictions = results.filter((r) => r.predictedDirection === 'DOWN');
      const upCorrect = upPredictions.filter((r) => r.settlement === 'UP').length;
      const downCorrect = downPredictions.filter((r) => r.settlement === 'DOWN').length;

      console.log(`\n  Direction breakdown:`);
      console.log(`    Predicted UP:   ${upCorrect}/${upPredictions.length} correct (${upPredictions.length > 0 ? ((upCorrect / upPredictions.length) * 100).toFixed(1) : '0.0'}%)`);
      console.log(`    Predicted DOWN: ${downCorrect}/${downPredictions.length} correct (${downPredictions.length > 0 ? ((downCorrect / downPredictions.length) * 100).toFixed(1) : '0.0'}%)`);

      console.log(`\n  WARNING: Fill rate & liquidity NOT modeled. Scale contrarian PnL by`);
      console.log(`  estimated fill rate (10-30%) for realistic projections.\n`);
    }
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
