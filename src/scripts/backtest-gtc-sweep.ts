#!/usr/bin/env tsx
/**
 * GTC Config Sweep — Find optimal copy-trade parameters per trader
 *
 * Uses DetectedTrade signals + parquet price data for GTC fill simulation,
 * then resolves PnL from Market table outcomes.
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 $PROD_SSH_HOST
 *   scp $PROD_SSH_HOST:/data/prices/*.parquet data/prices/
 *
 *   npx tsx src/scripts/backtest-gtc-sweep.ts --trader 0xabcd --days 1
 *   npx tsx src/scripts/backtest-gtc-sweep.ts --trader 0xd189 --days 3 --top 10
 *   npx tsx src/scripts/backtest-gtc-sweep.ts --trader 0xabcd --hours 12 --include-open
 */

import { parseArgs } from 'util';
import { connectBacktestDb } from './lib/backtest-db';
import { pad, rpad, type AllocRow } from './lib/backtest-cli';
import { computeScore, categorize } from './lib/backtest-engine';
import {
  simulateGtcFill,
  loadPriceTicks,
  type DetectedSignal,
  type PriceTick,
} from './lib/backtest-gtc-lib';

const { values: args } = parseArgs({
  options: {
    trader: { type: 'string', default: '' },
    hours: { type: 'string' },
    days: { type: 'string' },
    'price-dir': { type: 'string', default: 'data/prices' },
    top: { type: 'string', default: '20' },
    'include-open': { type: 'boolean', default: false },
    'no-train-test': { type: 'boolean', default: false },
    'starting-capital': { type: 'string' },
    'exclude-slugs': { type: 'string' },
  },
});

if (!args.trader) {
  console.error('Usage: npx tsx src/scripts/backtest-gtc-sweep.ts --trader <name|wallet|allocId> --days 3');
  process.exit(1);
}

const TOP_N = parseInt(args.top ?? '20', 10);
const PRICE_DIR = args['price-dir'] ?? 'data/prices';
const includeOpen = !!args['include-open'];

// ─── Sweep Dimensions ───

const SWEEP = {
  minBuyPrice:  [0.10, 0.20, 0.30, 0.40, 0.50, 0.60],
  maxTrade:     [3, 5, 8, 12],
  maxPred:      [10, 20, 30, 50],
  copyPercent:  [0.05, 0.10, 0.15, 0.20],
  gtcTimeout:   [5, 10, 15, 30],  // seconds
};

const MIN_BUYS_FOR_RANKING = 5;
const MIN_BUYS_PER_DAY = 0.5;

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;

interface SweepConfig {
  minBuyPrice: number;
  maxTrade: number;
  maxPred: number;
  copyPercent: number;
  gtcTimeout: number;
}

interface SweepResult {
  pnl: number;
  deployed: number;
  roi: number;
  holdWr: number;
  buys: number;
  wins: number;
  losses: number;
  fillRate: number;
  maxDdPct: number;
  sharpe: number;
  buysPerDay: number;
  scalpPct: number;
  score: number;
  sweepCfg: SweepConfig;
}

interface MarketRow {
  conditionId: string;
  outcomePrices: string;
  outcomes: string;
  endDate: string | null;
  closed: boolean;
}

function generateSweepConfigs(): SweepConfig[] {
  const configs: SweepConfig[] = [];
  for (const minBuyPrice of SWEEP.minBuyPrice) {
    for (const maxTrade of SWEEP.maxTrade) {
      for (const maxPred of SWEEP.maxPred) {
        for (const copyPercent of SWEEP.copyPercent) {
          for (const gtcTimeout of SWEEP.gtcTimeout) {
            configs.push({ minBuyPrice, maxTrade, maxPred, copyPercent, gtcTimeout });
          }
        }
      }
    }
  }
  return configs;
}

async function main() {
  const db = await connectBacktestDb();
  console.log('Connected to production DB (Ireland)');

  // Resolve trader
  const input = args.trader!;
  let proxyWallet: string;
  let allocConfig: AllocRow | null = null;
  let traderName = input;

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

  // Exclude slugs: from CLI or allocation config
  const excludeSlugs = (args['exclude-slugs'] ?? allocConfig?.excludeEventSlugPatterns ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  const startingCapital = parseFloat(
    args['starting-capital'] ?? String(allocConfig?.initialCapital ?? 450)
  );

  console.log(`\nConfig: startingCapital=$${startingCapital} | excludeSlugs=[${excludeSlugs.join(',')}] | window=${windowLabel}`);

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
  console.log(`Found ${signals.length} signals (${buySignals.length} BUY, ${signals.length - buySignals.length} SELL)`);

  if (buySignals.length === 0) {
    console.log('No BUY signals found. Nothing to sweep.');
    await db.end();
    return;
  }

  // Fetch Market data for all unique conditionIds
  const conditionIds = Array.from(new Set(buySignals.map(s => s.conditionId)));
  console.log(`\nFetching Market data for ${conditionIds.length} markets...`);
  const marketResult = await db.query(`
    SELECT "conditionId", "outcomePrices", outcomes, "endDate", closed
    FROM "Market" WHERE "conditionId" = ANY($1)
  `, [conditionIds]);

  const marketsMap = new Map<string, MarketRow>();
  for (const r of marketResult.rows) {
    marketsMap.set(r.conditionId, {
      conditionId: r.conditionId,
      outcomePrices: r.outcomePrices || '[]',
      outcomes: r.outcomes || '[]',
      endDate: r.endDate,
      closed: r.closed ?? false,
    });
  }

  // Fallback: fetch missing markets from Gamma API
  const missingIds = conditionIds.filter(id => !marketsMap.has(id));
  if (missingIds.length > 0) {
    console.log(`  ${marketsMap.size} in DB, ${missingIds.length} missing — fetching from Gamma API...`);
    const GAMMA_URL = 'https://gamma-api.polymarket.com/markets';
    const batchSize = 10;
    for (let i = 0; i < missingIds.length; i += batchSize) {
      const batch = missingIds.slice(i, i + batchSize);
      const promises = batch.map(async (cid) => {
        try {
          const resp = await fetch(`${GAMMA_URL}?conditionId=${cid}`);
          if (!resp.ok) return;
          const markets = await resp.json() as any[];
          const m = markets[0];
          if (!m) return;
          marketsMap.set(cid, {
            conditionId: cid,
            outcomePrices: m.outcomePrices || '[]',
            outcomes: m.outcomes || '[]',
            endDate: m.endDate || null,
            closed: m.closed ?? false,
          });
        } catch { /* skip */ }
      });
      await Promise.all(promises);
    }
    console.log(`  After Gamma: ${marketsMap.size} total markets`);
  }

  const resolvedCount = Array.from(marketsMap.values()).filter(m => m.closed).length;
  console.log(`  ${marketsMap.size} markets found (${resolvedCount} resolved, ${marketsMap.size - resolvedCount} open)`);

  if (resolvedCount === 0 && !includeOpen) {
    console.warn('\nWARNING: No resolved markets — PnL will be zero. Use --include-open for mark-to-market, or wait for markets to close.');
  }

  // Build token→outcome mapping for signals with empty outcome
  // DetectedTrade sometimes has empty outcome field — resolve via Trade table
  const emptyOutcomeTokens = Array.from(new Set(
    buySignals.filter(s => !s.outcome).map(s => s.tokenId)
  ));
  const tokenOutcomeMap = new Map<string, string>();
  if (emptyOutcomeTokens.length > 0) {
    console.log(`\nResolving ${emptyOutcomeTokens.length} tokens with empty outcome via Trade table...`);
    const tokenResult = await db.query(`
      SELECT DISTINCT asset, outcome
      FROM "Trade"
      WHERE asset = ANY($1) AND outcome IS NOT NULL AND outcome != ''
    `, [emptyOutcomeTokens]);
    for (const r of tokenResult.rows) {
      tokenOutcomeMap.set(r.asset, r.outcome);
    }
    // Backfill empty outcomes
    let filled = 0;
    for (const s of buySignals) {
      if (!s.outcome && tokenOutcomeMap.has(s.tokenId)) {
        s.outcome = tokenOutcomeMap.get(s.tokenId)!;
        filled++;
      }
    }
    console.log(`  Resolved ${filled}/${emptyOutcomeTokens.length} tokens (${buySignals.filter(s => !s.outcome).length} still missing)`);
  }

  // Load price ticks
  console.log(`\nLoading price data from ${PRICE_DIR}...`);
  const priceTicks = await loadPriceTicks(PRICE_DIR, cutoffMs);
  console.log(`Loaded ${priceTicks.size} tokens with price data`);

  // Check price data coverage
  const signalsWithPriceData = buySignals.filter(s => priceTicks.has(s.tokenId)).length;
  if (signalsWithPriceData < buySignals.length * 0.1) {
    console.warn(`\nWARNING: Only ${signalsWithPriceData}/${buySignals.length} BUY signals have price tick data. Fill rate will be near 0%.`);
  }

  // Train/test split
  const useTrainTest = !args['no-train-test'];
  const MIN_SIGNALS_FOR_SPLIT = 30;
  const canSplit = useTrainTest && buySignals.length >= MIN_SIGNALS_FOR_SPLIT;

  let sweepSignals = buySignals;
  let trainSignals: DetectedSignal[] | null = null;
  let testSignals: DetectedSignal[] | null = null;

  if (canSplit) {
    const splitIdx = Math.floor(buySignals.length * 0.7);
    trainSignals = buySignals.slice(0, splitIdx);
    testSignals = buySignals.slice(splitIdx);
    sweepSignals = trainSignals;
    console.log(`\nTrain/test split: ${trainSignals.length} train, ${testSignals.length} test signals`);
  } else if (useTrainTest) {
    console.log(`\nWARNING: Only ${buySignals.length} BUY signals — insufficient for split (need ${MIN_SIGNALS_FOR_SPLIT}). Using full dataset.`);
  }

  // Sweep
  const sweepConfigs = generateSweepConfigs();
  console.log(`\nSweeping ${sweepConfigs.length} configs${canSplit ? ' (on train set)' : ''}...`);
  const startMs = Date.now();

  const results: SweepResult[] = [];
  for (const sc of sweepConfigs) {
    const result = runSimulation(sweepSignals, sc, excludeSlugs, startingCapital, priceTicks, marketsMap, includeOpen);
    results.push(result);
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const profitable = results.filter(r => r.score > 0 && r.buysPerDay >= MIN_BUYS_PER_DAY);

  // Debug: show best configs even if unprofitable
  const allWithBuys = results.filter(r => r.buys > 0);
  if (allWithBuys.length > 0 && profitable.length === 0) {
    allWithBuys.sort((a, b) => b.pnl - a.pnl);
    console.log(`  Done in ${elapsed}s — 0 profitable but ${allWithBuys.length} configs had fills:`);
    const best = allWithBuys[0];
    console.log(`  Best: PnL=$${best.pnl.toFixed(2)} ROI=${best.roi.toFixed(1)}% Buys=${best.buys} WR=${best.holdWr.toFixed(0)}% FillR=${best.fillRate.toFixed(1)}% (minBuy=${best.sweepCfg.minBuyPrice} maxTr=$${best.sweepCfg.maxTrade} maxPr=$${best.sweepCfg.maxPred} copy=${best.sweepCfg.copyPercent} tmout=${best.sweepCfg.gtcTimeout}s)`);
    const worst = allWithBuys[allWithBuys.length - 1];
    console.log(`  Worst: PnL=$${worst.pnl.toFixed(2)} Buys=${worst.buys} WR=${worst.holdWr.toFixed(0)}%`);
    console.log(`  Median: PnL=$${allWithBuys[Math.floor(allWithBuys.length/2)].pnl.toFixed(2)} Buys=${allWithBuys[Math.floor(allWithBuys.length/2)].buys}\n`);
  } else {
    console.log(`  Done in ${elapsed}s — ${profitable.length}/${sweepConfigs.length} profitable (>= ${MIN_BUYS_FOR_RANKING} buys, >= ${MIN_BUYS_PER_DAY} buys/day)\n`);
  }

  // Sort and deduplicate
  profitable.sort((a, b) => b.score - a.score);
  const seen = new Set<string>();
  const deduped: SweepResult[] = [];
  for (const r of profitable) {
    const key = `${r.pnl.toFixed(2)}_${r.buys}_${r.holdWr.toFixed(1)}_${r.maxDdPct.toFixed(1)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(r);
  }

  console.log(`  Unique result profiles: ${deduped.length} (from ${profitable.length} profitable configs)`);

  // Median selection
  const profitableRatio = profitable.length / sweepConfigs.length;
  let selectionMethod: string;
  if (profitableRatio > 0.80 && deduped.length > 2) {
    const medianIdx = Math.floor(deduped.length / 2);
    const median = deduped.splice(medianIdx, 1)[0];
    deduped.unshift(median);
    selectionMethod = `MEDIAN (${(profitableRatio * 100).toFixed(0)}% of configs profitable — picking median to avoid noise)`;
  } else {
    selectionMethod = `BEST (${(profitableRatio * 100).toFixed(0)}% of configs profitable)`;
  }
  console.log(`  Selection: ${selectionMethod}\n`);

  // Header
  console.log(`${'='.repeat(130)}`);
  console.log(`GTC CONFIG SWEEP — ${traderName} | ${windowLabel} | ${sweepConfigs.length} configs`);
  console.log(`${'='.repeat(130)}\n`);

  const subheader =
    `${pad('', 5)}${rpad('minBuy', 7)}${rpad('MaxTr', 7)}${rpad('MaxPrd', 7)}${rpad('Copy%', 6)}${rpad('Tmout', 6)}  ` +
    `${rpad('PnL$', 8)}${rpad('Depld$', 8)}${rpad('ROI%', 7)}${rpad('HldWR%', 7)}${rpad('Buys', 6)}` +
    `${rpad('FillR%', 7)}${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('Tr/Day', 7)}${rpad('Score', 8)}`;
  console.log(subheader);
  console.log('-'.repeat(subheader.length));

  for (let i = 0; i < Math.min(deduped.length, TOP_N); i++) {
    const r = deduped[i];
    const c = r.sweepCfg;
    console.log(
      `${pad(String(i + 1), 5)}` +
      `${rpad(c.minBuyPrice.toFixed(2), 7)}${rpad('$' + c.maxTrade, 7)}${rpad('$' + c.maxPred, 7)}${rpad((c.copyPercent * 100).toFixed(0) + '%', 6)}${rpad(c.gtcTimeout + 's', 6)}  ` +
      `${rpad('$' + r.pnl.toFixed(0), 8)}${rpad('$' + r.deployed.toFixed(0), 8)}${rpad(r.roi.toFixed(1), 7)}${rpad(r.holdWr.toFixed(1), 7)}${rpad(String(r.buys), 6)}` +
      `${rpad(r.fillRate.toFixed(1), 7)}${rpad(r.maxDdPct.toFixed(1), 8)}${rpad(r.sharpe.toFixed(2), 8)}${rpad(r.buysPerDay.toFixed(1), 7)}${rpad(r.score.toFixed(2), 8)}`
    );
  }

  // Train/Test validation
  if (canSplit && testSignals && deduped.length > 0) {
    const nValidate = Math.min(3, deduped.length);
    console.log(`\n  Train/Test Validation on top ${nValidate} configs:\n`);

    for (let i = 0; i < nValidate; i++) {
      const sc = deduped[i].sweepCfg;
      const trainResult = deduped[i];
      const testResult = runSimulation(testSignals, sc, excludeSlugs, startingCapital, priceTicks, marketsMap, includeOpen);

      const ratio = trainResult.pnl > 0 ? testResult.pnl / trainResult.pnl : 0;
      const passed = trainResult.pnl > 0 && testResult.pnl > 0;

      console.log(`  Config #${i + 1} (minBuy=${sc.minBuyPrice} MaxTr=$${sc.maxTrade} MaxPr=$${sc.maxPred} Copy=${(sc.copyPercent * 100).toFixed(0)}% Tmout=${sc.gtcTimeout}s):`);
      console.log(`    Train: PnL=$${trainResult.pnl.toFixed(0)} | Buys=${trainResult.buys} | WR=${trainResult.holdWr.toFixed(1)}% | FillR=${trainResult.fillRate.toFixed(1)}%`);
      console.log(`    Test:  PnL=$${testResult.pnl.toFixed(0)} | Buys=${testResult.buys} | WR=${testResult.holdWr.toFixed(1)}% | FillR=${testResult.fillRate.toFixed(1)}%`);
      console.log(`    Ratio=${ratio.toFixed(2)} | ${passed ? 'PASS' : 'FAIL'}`);
      console.log('');
    }
  }

  // Parameter sensitivity
  if (profitable.length > 0) {
    console.log(`  Parameter Sensitivity (avg PnL by parameter value, profitable configs only):\n`);
    for (const [param, values] of Object.entries(SWEEP)) {
      const row = (values as number[]).map((v) => {
        const matching = profitable.filter(r => (r.sweepCfg as any)[param] === v);
        const avgPnl = matching.length > 0 ? matching.reduce((s, r) => s + r.pnl, 0) / matching.length : 0;
        const label = param === 'gtcTimeout' ? `${v}s` : String(v);
        return `${label}→$${avgPnl.toFixed(0)}`;
      }).join('  ');
      console.log(`    ${pad(param, 14)}: ${row}`);
    }
    console.log('');
  }

  await db.end();
  console.log('Done.');
}

// ─── Simulation ───

function runSimulation(
  buySignals: DetectedSignal[],
  config: SweepConfig,
  excludeSlugs: string[],
  startingCapital: number,
  priceTicks: Map<string, PriceTick[]>,
  marketsMap: Map<string, MarketRow>,
  includeOpen: boolean,
): SweepResult {
  let capital = startingCapital;
  let fillCount = 0;
  let expiredCount = 0;

  const predDeployed = new Map<string, number>();
  const tokenPositions = new Map<string, number>(); // conditionId:oi -> USD
  const fills: Array<{ conditionId: string; outcome: string; fillPrice: number; copyAmount: number; eventSlug: string; timestamp: number }> = [];

  for (const signal of buySignals) {
    // Slug exclusion
    if (excludeSlugs.length > 0) {
      const slug = signal.eventSlug.toLowerCase();
      if (excludeSlugs.some(p => slug.includes(p))) continue;
    }

    // Min buy price + max 0.95
    if (signal.price < config.minBuyPrice || signal.price > 0.95) continue;

    // Sizing
    const fillUsd = signal.size * signal.price;
    if (fillUsd < 1) continue;

    let copyAmount = Math.min(fillUsd * config.copyPercent, config.maxTrade);

    // Per-prediction limit
    const predUsed = predDeployed.get(signal.conditionId) ?? 0;
    const predRemaining = config.maxPred - predUsed;
    if (predRemaining < 0.50) continue;
    copyAmount = Math.min(copyAmount, predRemaining);

    // Capital limit
    if (capital < 0.50) continue;
    copyAmount = Math.min(copyAmount, capital);

    // Hedge guard
    if (signal.price < 0.25) {
      // Resolve outcome index for position tracking
      const market = marketsMap.get(signal.conditionId);
      let oi = 0;
      if (market) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const idx = outcomes.findIndex(o => o.toLowerCase() === signal.outcome.toLowerCase());
          if (idx >= 0) oi = idx;
        } catch { /* default oi=0 */ }
      }
      const oppositeOi = oi === 0 ? 1 : 0;
      const oppositeKey = `${signal.conditionId}:${oppositeOi}`;
      const oppositeUsd = tokenPositions.get(oppositeKey) ?? 0;

      if (oppositeUsd < 0.01) {
        if (signal.price <= 0.10) continue; // block naked buys
      } else {
        copyAmount = Math.min(copyAmount, oppositeUsd * 0.20);
      }
    }

    if (copyAmount < 0.50) continue;

    // GTC fill simulation
    const gtcResult = simulateGtcFill(
      signal.tokenId,
      signal.price,
      signal.timestamp * 1000,
      config.gtcTimeout * 1000,
      priceTicks,
    );

    if (gtcResult.filled) {
      fillCount++;
      capital -= copyAmount;
      predDeployed.set(signal.conditionId, predUsed + copyAmount);

      // Track position for hedge guard using outcomeIndex
      const market = marketsMap.get(signal.conditionId);
      let oi = 0;
      if (market) {
        try {
          const outcomes: string[] = JSON.parse(market.outcomes);
          const idx = outcomes.findIndex(o => o.toLowerCase() === signal.outcome.toLowerCase());
          if (idx >= 0) oi = idx;
        } catch { /* default oi=0 */ }
      }
      const tokenKey = `${signal.conditionId}:${oi}`;
      tokenPositions.set(tokenKey, (tokenPositions.get(tokenKey) ?? 0) + copyAmount);

      fills.push({
        conditionId: signal.conditionId,
        outcome: signal.outcome,
        fillPrice: gtcResult.fillPrice,
        copyAmount,
        eventSlug: signal.eventSlug,
        timestamp: signal.timestamp,
      });
    } else {
      expiredCount++;
    }
  }

  // PnL resolution
  let totalPnl = 0;
  let totalDeployed = 0;
  let wins = 0;
  let losses = 0;
  let openCount = 0;
  const dailyPnl = new Map<string, number>();

  // Category tracking for scalpPct
  const catCounts = new Map<string, number>();

  for (const fill of fills) {
    totalDeployed += fill.copyAmount;

    const cat = categorize(fill.eventSlug);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

    const market = marketsMap.get(fill.conditionId);
    if (!market) continue;

    // Resolve outcome index
    let oi: number | null = null;
    try {
      const outcomes: string[] = JSON.parse(market.outcomes);
      const idx = outcomes.findIndex(o => o.toLowerCase() === fill.outcome.toLowerCase());
      if (idx >= 0) oi = idx;
    } catch { /* skip */ }
    if (oi === null) continue;

    let outcomeWon = false;
    let currentProb = 0;

    if (market.closed) {
      try {
        const prices: string[] = JSON.parse(market.outcomePrices);
        outcomeWon = parseFloat(prices[oi] ?? '0') >= 0.95;
      } catch { continue; }
    } else if (includeOpen) {
      try {
        const prices: string[] = JSON.parse(market.outcomePrices);
        currentProb = parseFloat(prices[oi] ?? '0');
        outcomeWon = currentProb >= 0.50;
      } catch { continue; }
    } else {
      openCount++;
      continue;
    }

    // Fee + PnL (matching engine lines 513-516, 595)
    const shares = fill.copyAmount / fill.fillPrice;
    const feeShares = shares * FEE_RATE * Math.pow(fill.fillPrice * (1 - fill.fillPrice), FEE_EXPONENT);
    const netShares = shares - feeShares;

    let pnl: number;
    if (!market.closed && includeOpen) {
      pnl = netShares * currentProb - fill.copyAmount;
    } else {
      pnl = (outcomeWon ? netShares * 1.0 : 0) - fill.copyAmount;
    }

    totalPnl += pnl;
    if (pnl > 0) wins++; else losses++;

    const day = new Date(fill.timestamp * 1000).toISOString().slice(0, 10);
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
  }

  // Compute metrics
  const roi = totalDeployed > 0 ? totalPnl / totalDeployed * 100 : 0;
  const holdWr = (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;
  const fillRate = (fillCount + expiredCount) > 0 ? fillCount / (fillCount + expiredCount) * 100 : 0;

  // Max drawdown from daily PnL
  let peakPnl = 0;
  let maxDd = 0;
  let cumPnl = 0;
  const sortedDays = Array.from(dailyPnl.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [, pnl] of sortedDays) {
    cumPnl += pnl;
    if (cumPnl > peakPnl) peakPnl = cumPnl;
    const dd = peakPnl - cumPnl;
    if (dd > maxDd) maxDd = dd;
  }
  const maxDdPct = startingCapital > 0 ? maxDd / startingCapital * 100 : 0;

  // Sharpe (annualized from daily returns)
  const dailyReturns = sortedDays.map(([, pnl]) => pnl);
  let sharpe = 0;
  if (dailyReturns.length >= 2) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
    const stdev = Math.sqrt(variance);
    sharpe = stdev > 0 ? (mean / stdev) * Math.sqrt(252) : 0;
  }

  // Days active and buys per day
  const daysActive = sortedDays.length || 1;
  const buysPerDay = fillCount / daysActive;

  // Scalp pct
  const totalCats = Array.from(catCounts.values()).reduce((a, b) => a + b, 0) || 1;
  const scalpCats = (catCounts.get('5m') ?? 0) + (catCounts.get('15m') ?? 0);
  const scalpPct = scalpCats / totalCats * 100;

  // scalpPct penalty disabled for GTC sweep — updown markets are the intended target
  const score = computeScore(totalPnl, roi, 0, fillCount, maxDdPct, MIN_BUYS_FOR_RANKING, buysPerDay);

  return {
    pnl: totalPnl,
    deployed: totalDeployed,
    roi,
    holdWr,
    buys: fillCount,
    wins,
    losses,
    fillRate,
    maxDdPct,
    sharpe,
    buysPerDay,
    scalpPct,
    score,
    sweepCfg: config,
  };
}

main().catch(e => { console.error(e); process.exit(1); });
