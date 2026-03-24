#!/usr/bin/env tsx
/**
 * GTC Backtest — Replays DetectedTrade signals with GTC fill simulation
 *
 * Unlike the Trade-table backtest, this uses the SAME signals the Rust copier
 * received (DetectedTrade records) and simulates GTC fills using recorded
 * price tick data from parquet files.
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 aws_ireland_dockerapps
 *   # Download parquet files from server first:
 *   scp aws_ireland_dockerapps:/data/prices/*.parquet data/prices/
 *
 *   npx tsx src/scripts/backtest-gtc.ts --trader SeniorLaghetto --days 3
 *   npx tsx src/scripts/backtest-gtc.ts --trader cmmy2c3jxd0e3b9de --hours 24 --gtc-timeout 10
 */

import { parseArgs } from 'util';
import { connectBacktestDb } from './lib/backtest-db';
import { buildSimConfig, type AllocRow } from './lib/backtest-cli';
import type { CalibrationData } from './lib/backtest-db';
import {
  simulateGtcFill,
  loadPriceTicks,
  type DetectedSignal,
} from './lib/backtest-gtc-lib';

const { values: args } = parseArgs({
  options: {
    trader: { type: 'string', default: '' },
    hours: { type: 'string' },
    days: { type: 'string' },
    'gtc-timeout': { type: 'string', default: '10' },
    'price-dir': { type: 'string', default: 'data/prices' },
    'copy-percent': { type: 'string' },
    'max-trade': { type: 'string' },
    'max-pred': { type: 'string' },
    'min-buy-price': { type: 'string' },
    'starting-capital': { type: 'string' },
    verbose: { type: 'boolean', default: false },
  },
});

if (!args.trader) {
  console.error('Usage: npx tsx src/scripts/backtest-gtc.ts --trader <name|wallet|allocId> --days 3');
  process.exit(1);
}

const GTC_TIMEOUT_SEC = parseInt(args['gtc-timeout'] ?? '10', 10);
const PRICE_DIR = args['price-dir'] ?? 'data/prices';
const VERBOSE = args.verbose ?? false;

async function main() {
  const db = await connectBacktestDb();
  console.log('Connected to production DB (Ireland)');

  // Resolve trader
  const input = args.trader!;
  let proxyWallet: string;
  let allocConfig: AllocRow | null = null;
  let traderName = input;

  // Try allocation ID first
  const allocResult = await db.query(`
    SELECT "proxyWallet", id, "initialCapital", "copyTradePercent", "maxPositionUsd",
           "maxPredictionPositionUsd", "minBuyPrice", "excludeEventSlugPatterns",
           "majorityOnlyMode", "copySells", "committedSideLock"
    FROM "FollowAllocation"
    WHERE id LIKE $1 OR "proxyWallet" LIKE $1
    LIMIT 1
  `, [`%${input}%`]);

  if (allocResult.rows.length > 0) {
    const row = allocResult.rows[0];
    proxyWallet = row.proxyWallet;
    allocConfig = {
      copyTradePercent: row.copyTradePercent,
      maxPositionUsd: row.maxPositionUsd,
      maxPredictionPositionUsd: row.maxPredictionPositionUsd,
      minBuyPrice: row.minBuyPrice,
      excludeEventSlugPatterns: row.excludeEventSlugPatterns,
      majorityOnlyMode: row.majorityOnlyMode,
      initialCapital: row.initialCapital,
      copySells: row.copySells,
      committedSideLock: row.committedSideLock,
    };
    console.log(`Found allocation: ${row.id}`);
  } else {
    const traderResult = await db.query(`
      SELECT "proxyWallet", "userName" FROM "Trader"
      WHERE "proxyWallet" LIKE $1 OR "userName" ILIKE $1
      LIMIT 1
    `, [`%${input}%`]);
    if (traderResult.rows.length === 0) {
      console.error(`Trader not found: ${input}`);
      process.exit(1);
    }
    proxyWallet = traderResult.rows[0].proxyWallet;
    traderName = traderResult.rows[0].userName;
    console.log(`Found trader: ${traderName} (${proxyWallet})`);
  }

  // Time window
  const hours = parseInt(args.hours ?? '0', 10);
  const days = parseInt(args.days ?? '0', 10);
  if (hours <= 0 && days <= 0) {
    console.error('Specify --hours or --days');
    process.exit(1);
  }
  const windowSec = days > 0 ? days * 86400 : hours * 3600;
  const cutoffTs = Math.floor(Date.now() / 1000) - windowSec;
  const cutoffMs = cutoffTs * 1000;
  const windowLabel = days > 0 ? `${days} days` : `${hours} hours`;

  // Build sim config from allocation
  const emptyCalibration: CalibrationData = { slippage: null, fakFailureRate: 0 };
  const simConfig = buildSimConfig(
    args as Record<string, string | boolean | undefined>,
    emptyCalibration,
    allocConfig,
  );

  console.log(`\nConfig:`);
  console.log(`  copyPercent=${simConfig.copyPercent} maxTrade=$${simConfig.maxTradeUsd} maxPred=$${simConfig.maxPredUsd}`);
  console.log(`  minBuyPrice=$${simConfig.minBuyPrice} startingCapital=$${simConfig.startingCapital}`);
  console.log(`  GTC timeout=${GTC_TIMEOUT_SEC}s | Window: ${windowLabel}`);

  // Fetch DetectedTrade signals
  console.log(`\nFetching DetectedTrade signals...`);
  const signalResult = await db.query(`
    SELECT id, "proxyWallet", side, "conditionId", asset as "tokenId",
           size, price, outcome, "eventSlug", title, timestamp,
           EXTRACT(EPOCH FROM "detectedAt") * 1000 as "detectedAtMs"
    FROM "DetectedTrade"
    WHERE "proxyWallet" = $1 AND timestamp >= $2
    ORDER BY timestamp ASC
  `, [proxyWallet, cutoffTs]);

  const signals: DetectedSignal[] = signalResult.rows.map((r: any) => ({
    id: r.id,
    proxyWallet: r.proxyWallet,
    side: r.side,
    conditionId: r.conditionId,
    tokenId: r.tokenId,
    size: parseFloat(r.size) || 0,
    price: parseFloat(r.price) || 0,
    outcome: r.outcome || '',
    eventSlug: r.eventSlug || '',
    title: r.title || '',
    timestamp: parseInt(r.timestamp) || 0,
    detectedAtMs: parseFloat(r.detectedAtMs) || 0,
  }));

  const buySignals = signals.filter(s => s.side === 'BUY');
  const sellSignals = signals.filter(s => s.side === 'SELL');
  console.log(`Found ${signals.length} signals (${buySignals.length} BUY, ${sellSignals.length} SELL)`);

  // Load price ticks from parquet files
  console.log(`\nLoading price data from ${PRICE_DIR}...`);
  const priceTicks = await loadPriceTicks(PRICE_DIR, cutoffMs);
  console.log(`Loaded ${priceTicks.size} tokens with price data`);

  // Simulate GTC fills
  const { copyPercent, maxTradeUsd, maxPredUsd, minBuyPrice, startingCapital } = simConfig;
  const excludeSlugs = simConfig.excludeSlugs;

  let capital = startingCapital;
  let deployed = 0;
  let totalPnl = 0;
  let fillCount = 0;
  let skipCount = 0;
  let expiredCount = 0;
  let priceFilterCount = 0;
  let slugFilterCount = 0;
  let capitalFilterCount = 0;
  let predFilterCount = 0;

  const predDeployed = new Map<string, number>();
  const tokenPositions = new Map<string, number>(); // conditionId:oi -> USD
  const fills: Array<{ signal: DetectedSignal; fillPrice: number; fillLatencyMs: number; copyAmount: number }> = [];

  for (const signal of buySignals) {
    // Slug exclusion
    if (excludeSlugs.length > 0) {
      const slug = signal.eventSlug.toLowerCase();
      if (excludeSlugs.some(p => slug.includes(p))) { slugFilterCount++; continue; }
    }

    // Min buy price
    if (signal.price < minBuyPrice || signal.price > 0.95) { priceFilterCount++; continue; }

    // Sizing
    const fillUsd = signal.size * signal.price;
    if (fillUsd < 1) continue;

    let copyAmount = Math.min(fillUsd * copyPercent, maxTradeUsd);
    const predUsed = predDeployed.get(signal.conditionId) ?? 0;
    const predRemaining = maxPredUsd - predUsed;
    if (predRemaining < 0.50) { predFilterCount++; continue; }
    copyAmount = Math.min(copyAmount, predRemaining);

    // Available capital
    const available = capital;
    if (available < 0.50) { capitalFilterCount++; continue; }
    copyAmount = Math.min(copyAmount, available);

    // Hedge guard (binary markets only — outcomeIndex 0 or 1)
    const hedgePriceRatio = 0.25;
    const hedgeNakedMaxPrice = 0.10;
    const hedgeMaxRatio = 0.20;
    if (hedgePriceRatio > 0 && signal.price < hedgePriceRatio) {
      // Track positions by conditionId:tokenId — opposite is any other token on same conditionId
      const thisKey = `${signal.conditionId}:${signal.tokenId}`;
      // Check if we have a position on the opposite outcome
      let oppositeUsd = 0;
      for (const [key, val] of tokenPositions) {
        if (key.startsWith(`${signal.conditionId}:`) && key !== thisKey) {
          oppositeUsd += val;
        }
      }
      if (oppositeUsd < 0.01) {
        if (hedgeNakedMaxPrice > 0 && signal.price <= hedgeNakedMaxPrice) { skipCount++; continue; }
      } else {
        copyAmount = Math.min(copyAmount, oppositeUsd * hedgeMaxRatio);
      }
    }

    if (copyAmount < 0.50) { capitalFilterCount++; continue; }

    // GTC fill simulation: check if price crossed our limit within timeout
    const gtcResult = simulateGtcFill(
      signal.tokenId,
      signal.price,
      signal.timestamp * 1000, // convert to ms
      GTC_TIMEOUT_SEC * 1000,
      priceTicks,
    );

    if (gtcResult.filled) {
      fillCount++;
      capital -= copyAmount;
      deployed += copyAmount;
      predDeployed.set(signal.conditionId, predUsed + copyAmount);

      // Track token position for hedge guard (keyed by conditionId:tokenId)
      const tokenKey = `${signal.conditionId}:${signal.tokenId}`;
      tokenPositions.set(tokenKey, (tokenPositions.get(tokenKey) ?? 0) + copyAmount);

      fills.push({ signal, fillPrice: gtcResult.fillPrice, fillLatencyMs: gtcResult.fillLatencyMs, copyAmount });

      if (VERBOSE) {
        console.log(
          `  FILL: ${signal.title?.slice(0, 50) || signal.conditionId.slice(0, 16)} | ` +
          `$${copyAmount.toFixed(2)} @ ${gtcResult.fillPrice.toFixed(4)} | ` +
          `latency=${gtcResult.fillLatencyMs}ms`
        );
      }
    } else {
      expiredCount++;
      if (VERBOSE) {
        console.log(
          `  EXPIRED: ${signal.title?.slice(0, 50) || signal.conditionId.slice(0, 16)} | ` +
          `wanted ${signal.price.toFixed(4)}, no fill in ${GTC_TIMEOUT_SEC}s`
        );
      }
    }
  }

  // Summary
  const totalEligible = buySignals.length - slugFilterCount;
  const fillRate = totalEligible > 0 ? (fillCount / totalEligible * 100) : 0;
  const avgLatency = fills.length > 0 ? fills.reduce((s, f) => s + f.fillLatencyMs, 0) / fills.length : 0;
  const totalDeployed = fills.reduce((s, f) => s + f.copyAmount, 0);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`GTC BACKTEST — ${traderName} | ${windowLabel} | timeout=${GTC_TIMEOUT_SEC}s`);
  console.log(`${'='.repeat(80)}`);

  console.log(`\nSignals: ${signals.length} total (${buySignals.length} BUY, ${sellSignals.length} SELL)`);
  console.log(`\nBUY filter breakdown:`);
  console.log(`  Slug excluded: ${slugFilterCount}`);
  console.log(`  Price filter: ${priceFilterCount}`);
  console.log(`  Pred limit: ${predFilterCount}`);
  console.log(`  Capital: ${capitalFilterCount}`);
  console.log(`  Hedge/other: ${skipCount}`);

  console.log(`\nGTC fill results:`);
  console.log(`  Filled: ${fillCount} (${fillRate.toFixed(1)}% of eligible)`);
  console.log(`  Expired: ${expiredCount}`);
  console.log(`  Avg fill latency: ${avgLatency.toFixed(0)}ms`);
  console.log(`  Total deployed: $${totalDeployed.toFixed(2)}`);
  console.log(`  Capital remaining: $${capital.toFixed(2)} (started $${startingCapital})`);

  if (fills.length > 0) {
    console.log(`\nPrice improvement (fill vs signal):`);
    const improvements = fills.map(f => (f.signal.price - f.fillPrice) / f.signal.price * 100);
    const avgImprovement = improvements.reduce((s, v) => s + v, 0) / improvements.length;
    console.log(`  Avg: ${avgImprovement.toFixed(2)}% (positive = filled below signal price)`);
  }

  // Compare to paper CopyTrade results if available
  if (allocConfig) {
    const intervalSeconds = windowSec;
    const paperResult = await db.query(`
      SELECT COUNT(*) as fills,
             ROUND(COALESCE(SUM("filledSize" * "filledPrice"), 0)::numeric, 2) as total_usd
      FROM "CopyTrade"
      WHERE "followAllocationId" IN (
        SELECT id FROM "FollowAllocation" WHERE "proxyWallet" = $1 AND "isPaper" = true
      )
      AND status IN ('FILLED', 'SETTLED')
      AND side = 'BUY'
      AND "createdAt" >= NOW() - $2::int * INTERVAL '1 second'
    `, [proxyWallet, intervalSeconds]);

    const paperFills = parseInt(paperResult.rows[0]?.fills ?? '0');
    const paperUsd = parseFloat(paperResult.rows[0]?.total_usd ?? '0');

    console.log(`\nComparison to paper trading:`);
    console.log(`  Paper BUY fills: ${paperFills}`);
    console.log(`  Paper deployed: $${paperUsd.toFixed(2)}`);
    console.log(`  GTC BT fills: ${fillCount}`);
    console.log(`  GTC BT deployed: $${totalDeployed.toFixed(2)}`);
    console.log(`  Fill gap: ${fillCount - paperFills} (${((fillCount / Math.max(paperFills, 1)) * 100).toFixed(0)}%)`);
  }

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
