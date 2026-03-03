#!/usr/bin/env tsx
/**
 * Arb Strategy Backtester
 *
 * Tests direction prediction accuracy and P&L for standard vs contrarian strategies
 * using historical Binance crypto prices + Polymarket settlement outcomes.
 *
 * Includes: equity curve, max drawdown, profit factor, fee simulation,
 * move-magnitude sweeps, volatility filters, time-of-day analysis, and strategy ranking.
 *
 * Usage:
 *   npx tsx src/scripts/arb-backtest.ts --asset btc --duration 5m --days 7
 *   npx tsx src/scripts/arb-backtest.ts --asset btc,eth,sol --duration 5m,15m --days 30
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
import { getCandleInfo, calculateFee } from '../services/arb/arb-engine';
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
    return null;
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
  const adjusted = startMs - dc.epochOffsetMs;
  let candleStart = Math.floor(adjusted / dc.candleDurationMs) * dc.candleDurationMs + dc.epochOffsetMs;

  while (candleStart < endMs) {
    timestamps.push(candleStart);
    candleStart += dc.candleDurationMs;
  }

  return timestamps;
}

// ─── Direction from klines ───

interface DirectionResult {
  direction: 'UP' | 'DOWN';
  moveMagnitude: number; // |entryPrice - openPrice| / openPrice
  openPrice: number;
  entryPrice: number;
}

function getDirectionFromKlines(
  klines: Kline[],
  candleStartMs: number,
  dc: ArbDurationConfig,
): DirectionResult | null {
  const entryTimeMs = candleStartMs + dc.entryStartMs;

  const openKline = klines.find((k) => k.openTime >= candleStartMs);
  const entryKline = findClosestKline(klines, entryTimeMs);

  if (!openKline || !entryKline) return null;

  const openPrice = openKline.open;
  const entryPrice = entryKline.open;

  if (entryPrice === openPrice) return null; // FLAT — skip
  return {
    direction: entryPrice > openPrice ? 'UP' : 'DOWN',
    moveMagnitude: Math.abs(entryPrice - openPrice) / openPrice,
    openPrice,
    entryPrice,
  };
}

/** Find the kline whose openTime is closest to (but not after) targetMs. Assumes klines sorted by openTime. */
function findClosestKline(klines: Kline[], targetMs: number): Kline | null {
  let best: Kline | null = null;
  let bestDelta = Infinity;
  for (const k of klines) {
    if (k.openTime > targetMs) break; // Only consider klines at or before target (no look-ahead)
    const delta = targetMs - k.openTime;
    if (delta < bestDelta) {
      bestDelta = delta;
      best = k;
    }
  }
  return best;
}

// ─── Volatility from klines ───

function computeVolatility(candleKlines: Kline[], openPrice: number): number {
  if (candleKlines.length === 0 || openPrice <= 0) return 0;
  const avgRange = candleKlines.reduce((s, k) => s + (k.high - k.low), 0) / candleKlines.length;
  return avgRange / openPrice;
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

    if (prices[upIdx] >= 0.95) return 'UP';
    if (prices[downIdx] >= 0.95) return 'DOWN';
    return null;
  } catch {
    return null;
  }
}

// ─── P&L calculation (with fees) ───

function calculateStandardPnl(
  predicted: 'UP' | 'DOWN',
  settlement: 'UP' | 'DOWN',
  positionSizeUsd: number,
): { pnl: number; fee: number } {
  const entryPrice = 0.99;
  const shares = positionSizeUsd / entryPrice;
  const fee = calculateFee(shares, entryPrice);
  const settlementPrice = predicted === settlement ? 1.0 : 0.0;
  const pnl = shares * settlementPrice - positionSizeUsd - fee;
  return { pnl, fee };
}

function calculateContrarianPnlWithFee(
  predicted: 'UP' | 'DOWN',
  settlement: 'UP' | 'DOWN',
  positionSizeUsd: number,
  contrarianEntryPrice: number,
): { pnl: number; fee: number } {
  const contrarianDirection = predicted === 'UP' ? 'DOWN' : 'UP';
  const shares = positionSizeUsd / contrarianEntryPrice;
  const fee = calculateFee(shares, contrarianEntryPrice);
  const settlementPrice = contrarianDirection === settlement ? 1.0 : 0.0;
  const pnl = shares * settlementPrice - positionSizeUsd - fee;
  return { pnl, fee };
}

// ─── Stats ───

interface StrategyStats {
  label: string;
  trades: number;
  wins: number;
  losses: number;
  totalPnl: number;
  pnls: number[];
  equityCurve: number[];
  maxDrawdown: number;
  maxDrawdownUsd: number;
  maxConsecutiveLosses: number;
  profitFactor: number;
  totalFees: number;
  sharpe: number;
}

function buildStats(label: string, pnls: number[], fees: number[]): StrategyStats {
  if (pnls.length === 0) {
    return {
      label, trades: 0, wins: 0, losses: 0, totalPnl: 0, pnls: [],
      equityCurve: [], maxDrawdown: 0, maxDrawdownUsd: 0,
      maxConsecutiveLosses: 0, profitFactor: 0, totalFees: 0, sharpe: 0,
    };
  }

  const wins = pnls.filter((p) => p > 0).length;
  const losses = pnls.filter((p) => p <= 0).length;
  const totalPnl = pnls.reduce((s, p) => s + p, 0);
  const totalFees = fees.reduce((s, f) => s + f, 0);

  // Equity curve
  const equityCurve: number[] = [];
  let cumPnl = 0;
  for (const p of pnls) {
    cumPnl += p;
    equityCurve.push(cumPnl);
  }

  // Max drawdown (only when peak > 0 to avoid division by zero)
  let peak = 0;
  let maxDrawdownUsd = 0;
  let maxDrawdown = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    if (peak > 0) {
      const ddUsd = peak - eq;
      if (ddUsd > maxDrawdownUsd) maxDrawdownUsd = ddUsd;
      const ddPct = ddUsd / peak;
      if (ddPct > maxDrawdown) maxDrawdown = ddPct;
    }
  }
  maxDrawdown = Math.min(maxDrawdown, 1.0);

  // Max consecutive losses
  let maxConsecLosses = 0;
  let currentStreak = 0;
  for (const p of pnls) {
    if (p < 0) {
      currentStreak++;
      if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak;
    } else {
      currentStreak = 0;
    }
  }

  // Profit factor
  const grossWins = pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0);
  const grossLosses = Math.abs(pnls.filter((p) => p < 0).reduce((s, p) => s + p, 0));
  const profitFactor = grossLosses > 0
    ? Math.min(grossWins / grossLosses, 999.9)
    : (grossWins > 0 ? 999.9 : 0);

  // Sharpe ratio
  const mean = totalPnl / pnls.length;
  const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / Math.max(pnls.length - 1, 1);
  const stdDev = Math.sqrt(variance);
  const tradesPerYear = (pnls.length / Math.max(days, 1)) * 365;
  const rawSharpe = stdDev > 0 ? (mean / stdDev) * Math.sqrt(tradesPerYear) : 0;
  const sharpe = Math.max(-999, Math.min(999, rawSharpe));

  return {
    label, trades: pnls.length, wins, losses, totalPnl, pnls,
    equityCurve, maxDrawdown, maxDrawdownUsd, maxConsecutiveLosses: maxConsecLosses,
    profitFactor, totalFees, sharpe,
  };
}

function printStats(stats: StrategyStats): void {
  if (stats.trades === 0) return;

  const winRate = ((stats.wins / stats.trades) * 100).toFixed(1);
  const avgWin = stats.wins > 0
    ? stats.pnls.filter((p) => p > 0).reduce((s, p) => s + p, 0) / stats.wins
    : 0;
  const avgLoss = stats.losses > 0
    ? stats.pnls.filter((p) => p <= 0).reduce((s, p) => s + p, 0) / stats.losses
    : 0;

  const pfDisplay = stats.profitFactor >= 999.9 ? '999.9+' : stats.profitFactor.toFixed(2);

  console.log(`  ${stats.label}`);
  console.log(`    Win rate: ${winRate}%  |  Wins: ${stats.wins}  Losses: ${stats.losses}`);
  console.log(`    Avg win: ${avgWin >= 0 ? '+' : ''}$${avgWin.toFixed(2)}  |  Avg loss: $${avgLoss.toFixed(2)}`);
  console.log(`    Total PnL: ${stats.totalPnl >= 0 ? '+' : ''}$${stats.totalPnl.toFixed(2)}  |  Sharpe: ${stats.sharpe.toFixed(2)}`);
  console.log(`    Max DD: ${(stats.maxDrawdown * 100).toFixed(1)}% ($${stats.maxDrawdownUsd.toFixed(2)})  |  Max consec losses: ${stats.maxConsecutiveLosses}`);
  console.log(`    Profit factor: ${pfDisplay}  |  Total fees: $${stats.totalFees.toFixed(2)}`);
}

// ─── Strategy accumulator ───

interface StrategyAccumulator {
  pnls: number[];
  fees: number[];
}

// ─── Strategy entry price configs ───

const CONTRARIAN_PRICES = [0.02, 0.05, 0.10];
const MOVE_THRESHOLDS = [0.001, 0.002, 0.003, 0.005, 0.008];
const VOL_THRESHOLDS = [0.001, 0.002, 0.005];

// ─── Main ───

async function main(): Promise<void> {
  const endMs = Date.now();
  const startMs = endMs - days * 24 * 60 * 60 * 1000;

  console.log(`\nArb Backtest — ${days} days (${new Date(startMs).toISOString().slice(0, 10)} → ${new Date(endMs).toISOString().slice(0, 10)})`);
  console.log(`Assets: ${assets.join(', ')}  |  Durations: ${durations.join(', ')}`);
  console.log(`Cache: ${cacheDir}\n`);

  // Global ranking across all (asset, duration) combos
  const globalRanking: StrategyStats[] = [];

  for (const asset of assets) {
    console.log(`Fetching Binance 1m klines for ${asset.toUpperCase()}...`);
    const klines = await cachedFetchKlines(asset, startMs, endMs);
    console.log(`  ${klines.length} klines fetched\n`);

    for (const dur of durations) {
      const dc = DURATION_CONFIGS[dur];
      const marketConfig = buildMarketConfig(asset as SupportedAsset, dc);
      const candleStarts = generateCandleTimestamps(dc, startMs, endMs);
      const resolvedCandleStarts = candleStarts.filter((cs) => cs + dc.candleDurationMs < endMs);

      console.log(`=== ${asset.toUpperCase()}-${dur} — ${resolvedCandleStarts.length} candles ===`);

      const prefix = `${asset.toUpperCase()}-${dur}`;
      let marketsFound = 0;
      let marketsResolved = 0;
      let directionFlat = 0;

      // Strategy accumulators
      const accumulators = new Map<string, StrategyAccumulator>();
      const getAcc = (key: string): StrategyAccumulator => {
        let acc = accumulators.get(key);
        if (!acc) {
          acc = { pnls: [], fees: [] };
          accumulators.set(key, acc);
        }
        return acc;
      };

      // Time-of-day tracking
      const hourlyCorrect = new Map<number, { correct: number; total: number; pnl: number }>();

      const posSize = 10; // $10 per trade for simulation

      for (let i = 0; i < resolvedCandleStarts.length; i++) {
        const candleStartMs = resolvedCandleStarts[i];

        if ((i + 1) % 200 === 0 || i === resolvedCandleStarts.length - 1) {
          process.stdout.write(`\r  Processing ${i + 1}/${resolvedCandleStarts.length}...`);
        }

        // 1. Get direction + move magnitude from klines (pre-entry only — no future data)
        const preEntryKlines = klines.filter(
          (k) => k.openTime >= candleStartMs && k.openTime <= candleStartMs + dc.entryStartMs,
        );
        const result = getDirectionFromKlines(preEntryKlines, candleStartMs, dc);
        if (!result) {
          directionFlat++;
          continue;
        }

        const { direction: predicted, moveMagnitude, openPrice } = result;

        // 2. Compute volatility for filters (pre-entry klines only)
        const volatility = computeVolatility(preEntryKlines, openPrice);

        // 3. Generate slug and query Gamma API
        const candle = getCandleInfo(candleStartMs + dc.entryStartMs, dc.candleDurationMs, dc.epochOffsetMs);
        const slug = buildSlug(marketConfig, candle.slugTimestamp);
        const market = await cachedGetMarket(slug);

        if (!market) continue;
        marketsFound++;

        // 4. Parse settlement
        const settlement = parseSettlement(market);
        if (!settlement) continue;
        marketsResolved++;

        // 5. Calculate P&L for all strategies and push to accumulators
        const isCorrect = predicted === settlement;

        // Time-of-day tracking
        const utcHour = new Date(candleStartMs).getUTCHours();
        const hourEntry = hourlyCorrect.get(utcHour) ?? { correct: 0, total: 0, pnl: 0 };
        hourEntry.total++;
        if (isCorrect) hourEntry.correct++;

        // Standard strategy
        const stdResult = calculateStandardPnl(predicted, settlement, posSize);
        hourEntry.pnl += stdResult.pnl;
        hourlyCorrect.set(utcHour, hourEntry);

        const stdAcc = getAcc(`${prefix} Standard @$0.99`);
        stdAcc.pnls.push(stdResult.pnl);
        stdAcc.fees.push(stdResult.fee);

        // Standard + move threshold variants
        for (const thresh of MOVE_THRESHOLDS) {
          if (moveMagnitude >= thresh) {
            const key = `${prefix} Standard @$0.99 move>${(thresh * 100).toFixed(1)}%`;
            const acc = getAcc(key);
            acc.pnls.push(stdResult.pnl);
            acc.fees.push(stdResult.fee);
          }
        }

        // Standard + volatility filter variants
        for (const maxVol of VOL_THRESHOLDS) {
          if (volatility <= maxVol) {
            const key = `${prefix} Standard @$0.99 vol<${(maxVol * 100).toFixed(1)}%`;
            const acc = getAcc(key);
            acc.pnls.push(stdResult.pnl);
            acc.fees.push(stdResult.fee);
          }
        }

        // Contrarian strategies at multiple price points
        for (const cp of CONTRARIAN_PRICES) {
          const cResult = calculateContrarianPnlWithFee(predicted, settlement, posSize, cp);
          const label = `$${cp.toFixed(2)}`;

          const cAcc = getAcc(`${prefix} Contrarian @${label}`);
          cAcc.pnls.push(cResult.pnl);
          cAcc.fees.push(cResult.fee);

          // Contrarian + move threshold variants
          for (const thresh of MOVE_THRESHOLDS) {
            if (moveMagnitude >= thresh) {
              const key = `${prefix} Contrarian @${label} move>${(thresh * 100).toFixed(1)}%`;
              const acc = getAcc(key);
              acc.pnls.push(cResult.pnl);
              acc.fees.push(cResult.fee);
            }
          }

          // Contrarian + volatility filter variants
          for (const maxVol of VOL_THRESHOLDS) {
            if (volatility <= maxVol) {
              const key = `${prefix} Contrarian @${label} vol<${(maxVol * 100).toFixed(1)}%`;
              const acc = getAcc(key);
              acc.pnls.push(cResult.pnl);
              acc.fees.push(cResult.fee);
            }
          }
        }
      }

      console.log(''); // Clear progress line
      console.log(`  Markets found: ${marketsFound}/${resolvedCandleStarts.length}  |  Resolved: ${marketsResolved}  |  Flat: ${directionFlat}`);
      const unresolvedCount = marketsFound - marketsResolved;
      if (unresolvedCount > 0 && marketsFound > 0) {
        console.log(`  Unresolved markets: ${unresolvedCount} (${((unresolvedCount / marketsFound) * 100).toFixed(1)}%) — capital lockup not modeled`);
      }

      if (marketsResolved === 0) {
        console.log('  No resolved trades to analyze.\n');
        continue;
      }

      // Direction accuracy
      const stdAcc = accumulators.get(`${prefix} Standard @$0.99`);
      if (stdAcc) {
        const correct = stdAcc.pnls.filter((p) => p > 0).length;
        console.log(`  Direction accuracy: ${correct}/${stdAcc.pnls.length} (${((correct / stdAcc.pnls.length) * 100).toFixed(1)}%)\n`);
      }

      // Print main strategy stats (standard + contrarian base variants)
      const mainKeys = [
        `${prefix} Standard @$0.99`,
        ...CONTRARIAN_PRICES.map((cp) => `${prefix} Contrarian @$${cp.toFixed(2)}`),
      ];
      for (const key of mainKeys) {
        const acc = accumulators.get(key);
        if (acc) {
          const stats = buildStats(key.slice(prefix.length + 1), acc.pnls, acc.fees);
          printStats(stats);
          globalRanking.push({ ...stats, label: key });
        }
      }

      // ─── Drawdown-reduction strategies (stateful: decisions depend on prior outcomes) ───
      // These operate on the base contrarian P&L arrays sequentially.

      for (const cp of CONTRARIAN_PRICES) {
        const baseKey = `${prefix} Contrarian @$${cp.toFixed(2)}`;
        const baseAcc = accumulators.get(baseKey);
        if (!baseAcc || baseAcc.pnls.length < 20) continue;
        const basePnls = baseAcc.pnls;
        const baseFees = baseAcc.fees;

        // 1. Streak cooldown: after N consecutive losses, skip the next M candles
        for (const [cooldownAfter, skipCount] of [[3, 2], [5, 3], [5, 5], [3, 5]] as const) {
          const filtPnls: number[] = [];
          const filtFees: number[] = [];
          let consecLosses = 0;
          let cooldownRemaining = 0;

          for (let j = 0; j < basePnls.length; j++) {
            if (cooldownRemaining > 0) {
              cooldownRemaining--;
              continue; // Skip this trade
            }
            filtPnls.push(basePnls[j]);
            filtFees.push(baseFees[j]);
            if (basePnls[j] < 0) {
              consecLosses++;
              if (consecLosses >= cooldownAfter) {
                cooldownRemaining = skipCount;
                consecLosses = 0;
              }
            } else {
              consecLosses = 0;
            }
          }

          const key = `${baseKey} cool${cooldownAfter}L→skip${skipCount}`;
          accumulators.set(key, { pnls: filtPnls, fees: filtFees });
        }

        // 2. Drawdown pause: stop entering when cumulative DD exceeds threshold,
        //    skip a fixed cooldown period, then resume unconditionally.
        //    Cooldown scales with threshold: $50→3 candles, $100→5, $200→8.
        const DD_COOLDOWNS: [number, number][] = [[50, 3], [100, 5], [200, 8]];
        for (const [maxDdUsd, cooldownCandles] of DD_COOLDOWNS) {
          const filtPnls: number[] = [];
          const filtFees: number[] = [];
          let cumPnl = 0;
          let peak = 0;
          let skipRemaining = 0;

          for (let j = 0; j < basePnls.length; j++) {
            if (skipRemaining > 0) {
              skipRemaining--;
              continue;
            }
            filtPnls.push(basePnls[j]);
            filtFees.push(baseFees[j]);
            cumPnl += basePnls[j];
            if (cumPnl > peak) peak = cumPnl;
            const ddUsd = peak - cumPnl;
            if (ddUsd >= maxDdUsd) {
              skipRemaining = cooldownCandles;
            }
          }

          const key = `${baseKey} ddPause$${maxDdUsd}`;
          accumulators.set(key, { pnls: filtPnls, fees: filtFees });
        }

        // 3. Every-Nth trade: only enter every Nth candle (reduces exposure & streak length)
        for (const nth of [2, 3]) {
          const filtPnls: number[] = [];
          const filtFees: number[] = [];
          for (let j = 0; j < basePnls.length; j++) {
            if (j % nth === 0) {
              filtPnls.push(basePnls[j]);
              filtFees.push(baseFees[j]);
            }
          }
          const key = `${baseKey} every${nth}th`;
          accumulators.set(key, { pnls: filtPnls, fees: filtFees });
        }

        // 4. Martingale inverse: halve position after each loss, reset after win
        // Simulated as: after a loss, the next trade P&L is halved (smaller bet)
        {
          const filtPnls: number[] = [];
          const filtFees: number[] = [];
          let scale = 1.0;
          for (let j = 0; j < basePnls.length; j++) {
            filtPnls.push(basePnls[j] * scale);
            filtFees.push(baseFees[j] * scale);
            if (basePnls[j] < 0) {
              scale = Math.max(0.25, scale * 0.5); // Floor at 25% of base
            } else {
              scale = 1.0; // Reset on win
            }
          }
          const key = `${baseKey} antiMart`;
          accumulators.set(key, { pnls: filtPnls, fees: filtFees });
        }
      }

      // Print drawdown-reduction strategy stats
      console.log('');
      const ddKeys = [...accumulators.keys()].filter((k) =>
        k.includes('cool') || k.includes('ddPause') || k.includes('every') || k.includes('antiMart'),
      );
      if (ddKeys.length > 0) {
        console.log(`  --- Drawdown-Reduction Variants ---`);
        for (const key of ddKeys) {
          const acc = accumulators.get(key)!;
          if (acc.pnls.length < 10) continue;
          const stats = buildStats(key.slice(prefix.length + 1), acc.pnls, acc.fees);
          printStats(stats);
        }
      }

      // Time-of-day analysis
      const sortedHours = [...hourlyCorrect.entries()].sort((a, b) => a[0] - b[0]);
      if (sortedHours.length > 0) {
        console.log(`\n  Time-of-day (UTC):`);
        for (const [hour, data] of sortedHours) {
          const pct = data.total > 0 ? ((data.correct / data.total) * 100).toFixed(1) : '0.0';
          const pnlStr = data.pnl >= 0 ? `+$${data.pnl.toFixed(2)}` : `-$${Math.abs(data.pnl).toFixed(2)}`;
          console.log(`    ${String(hour).padStart(2, '0')}h: ${data.correct}/${data.total} correct (${pct}%)  PnL: ${pnlStr}`);
        }
      }

      // Add all variant stats to global ranking
      for (const [key, acc] of accumulators) {
        // Skip main keys already added
        if (mainKeys.includes(key)) continue;
        if (acc.pnls.length === 0) continue;
        const stats = buildStats(key, acc.pnls, acc.fees);
        globalRanking.push(stats);
      }

      // Save results JSON
      const resultsData: Record<string, Omit<StrategyStats, 'pnls'>> = {};
      for (const [key, acc] of accumulators) {
        if (acc.pnls.length === 0) continue;
        const stats = buildStats(key, acc.pnls, acc.fees);
        const { pnls: _, ...rest } = stats;
        resultsData[key] = rest;
      }
      cachedWriteJSON('results', `${asset}-${dur}-${days}d`, resultsData);

      console.log(`\n  WARNING: Fill rate & liquidity NOT modeled. Scale contrarian PnL by`);
      console.log(`  estimated fill rate (10-30%) for realistic projections.\n`);
    }
  }

  // ─── Global Strategy Ranking ───

  const MIN_TRADES = 20;
  const allRanked = globalRanking
    .filter((s) => s.trades >= MIN_TRADES)
    .sort((a, b) => b.profitFactor - a.profitFactor);
  const ranked = allRanked.slice(0, 20);

  if (ranked.length > 0) {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`=== STRATEGY RANKING (top ${Math.min(ranked.length, 20)} by Profit Factor, min ${MIN_TRADES} trades) ===`);
    console.log(`${'='.repeat(80)}`);
    for (let i = 0; i < ranked.length; i++) {
      const s = ranked[i];
      const pfStr = s.profitFactor >= 999.9 ? '999.9+' : s.profitFactor.toFixed(2);
      const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(0)}` : `-$${Math.abs(s.totalPnl).toFixed(0)}`;
      const ddStr = `${(s.maxDrawdown * 100).toFixed(1)}%`;
      console.log(`  ${String(i + 1).padStart(2)}. ${s.label}: PF=${pfStr}, Sharpe=${s.sharpe.toFixed(1)}, PnL=${pnlStr}, DD=${ddStr}, Trades=${s.trades}`);
    }
    console.log('');

    // ─── Low-Drawdown Ranking (sorted by lowest DD among profitable strategies) ───
    const lowDdRanked = allRanked
      .filter((s) => s.profitFactor > 1 && s.trades >= MIN_TRADES)
      .sort((a, b) => a.maxDrawdown - b.maxDrawdown || b.profitFactor - a.profitFactor)
      .slice(0, 15);

    if (lowDdRanked.length > 0) {
      console.log(`${'='.repeat(80)}`);
      console.log(`=== LOW-DRAWDOWN RANKING (profitable, sorted by lowest DD, min ${MIN_TRADES} trades) ===`);
      console.log(`${'='.repeat(80)}`);
      for (let i = 0; i < lowDdRanked.length; i++) {
        const s = lowDdRanked[i];
        const pfStr = s.profitFactor >= 999.9 ? '999.9+' : s.profitFactor.toFixed(2);
        const pnlStr = s.totalPnl >= 0 ? `+$${s.totalPnl.toFixed(0)}` : `-$${Math.abs(s.totalPnl).toFixed(0)}`;
        const ddStr = `${(s.maxDrawdown * 100).toFixed(1)}%`;
        const ddUsdStr = `$${s.maxDrawdownUsd.toFixed(0)}`;
        console.log(`  ${String(i + 1).padStart(2)}. ${s.label}: DD=${ddStr}(${ddUsdStr}), PF=${pfStr}, PnL=${pnlStr}, MaxConsecL=${s.maxConsecutiveLosses}, Trades=${s.trades}`);
      }
      console.log('');
    }

    // ─── Recommended Config ───
    // Only consider base strategies (no move/vol filter variants) since those can't be deployed at runtime
    const isBaseStrategy = (label: string) => !label.includes('move>') && !label.includes('vol<');
    const bestBase = allRanked.find((s) => isBaseStrategy(s.label) && s.profitFactor > 1);

    if (bestBase) {
      const isContrarian = bestBase.label.includes('Contrarian');
      const assetMatch = bestBase.label.match(/^([A-Z]+)-/);
      const durMatch = bestBase.label.match(/-(\d+[mh])/);
      const priceMatch = bestBase.label.match(/@\$(\d+\.\d+)/);

      console.log(`=== RECOMMENDED PAPER CONFIG ===`);
      console.log(`ARB_ENABLED=true`);
      console.log(`ARB_IS_PAPER=true`);
      if (assetMatch) console.log(`ARB_ASSETS=${assetMatch[1].toLowerCase()}`);
      if (durMatch) console.log(`ARB_MARKET_TYPES=${durMatch[1]}`);
      if (isContrarian) {
        console.log(`ARB_CONTRARIAN_ENABLED=true`);
        if (priceMatch) console.log(`ARB_CONTRARIAN_MAX_PRICE=${priceMatch[1]}`);
        console.log(`ARB_CONTRARIAN_INITIAL_CAPITAL_USD=200`);
      }
      console.log(`ARB_STANDARD_INITIAL_CAPITAL_USD=1000`);
      const bestPfStr = bestBase.profitFactor >= 999.9 ? '999.9+' : bestBase.profitFactor.toFixed(2);
      console.log(`# Backtest: PF=${bestPfStr}, Sharpe=${bestBase.sharpe.toFixed(1)}, PnL=${bestBase.totalPnl >= 0 ? '+' : ''}$${bestBase.totalPnl.toFixed(0)}, MaxDD=${(bestBase.maxDrawdown * 100).toFixed(1)}%`);
      console.log('');
    }
  }
}

main().catch((err) => {
  console.error('Backtest failed:', err.message);
  process.exit(1);
});
