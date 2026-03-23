#!/usr/bin/env tsx
/**
 * Config Sweep Backtest — Find optimal copy-trade parameters per trader
 *
 * Uses the shared simulation engine (lib/backtest-engine.ts) with full fidelity:
 *   - Capital lockup, slug exclusion, empirical slippage/FAK, net position tracking
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 aws_ireland_dockerapps
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader FloatyBoi --trader LampStore
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader 0x38c6fd3ae5db...
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --exclude-slugs "" --no-capital-lockup
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader LampStore --hours 24
 */

import { parseArgs } from 'util';
import type { SimConfig, SimResult, TradeRow } from './lib/backtest-engine';
import { simulateCopy, computeScore, categorize } from './lib/backtest-engine';
import { connectBacktestDb, calibrateFromProduction } from './lib/backtest-db';
import { COMMON_FLAGS, buildSimConfig, pad, rpad, getTimeWindow } from './lib/backtest-cli';

const { values: args } = parseArgs({
  options: {
    ...COMMON_FLAGS,
    trader: { type: 'string', multiple: true },
    top: { type: 'string', default: '20' },
  },
});

const traderInputs = args.trader ?? ['FloatyBoi', 'LampStore'];
const TOP_N = parseInt(args.top ?? '20', 10);
const MIN_BUYS_FOR_RANKING = 10;

// ─── Sweep Dimensions ───
// majorityOn: true → gate=175 (matches production MAJORITY_MIN_USD), false → gate=0
// warmupHours: 0 = full history, 24 = simulate production cold-start (first 24h warms accumulator only)
const SWEEP = {
  minBuyPrice:  [0.20, 0.30, 0.40, 0.50, 0.60],
  majorityOn:   [false, true],
  warmupHours:  [0, 24],
  maxTrade:     [3, 5, 8, 12],
  maxPred:      [10, 20, 30, 50],
  copyPercent:  [0.05, 0.10, 0.15, 0.20],
};

const MAJORITY_GATE_USD = 175;  // must match production MAJORITY_MIN_USD
const MIN_BUYS_PER_DAY = 0.5;   // hard filter: configs below this are excluded from ranking

interface SweepConfig {
  minBuyPrice: number;
  majorityOn: boolean;
  warmupHours: number;
  maxTrade: number;
  maxPred: number;
  copyPercent: number;
}

function generateSweepConfigs(): SweepConfig[] {
  const configs: SweepConfig[] = [];
  for (const minBuyPrice of SWEEP.minBuyPrice) {
    for (const majorityOn of SWEEP.majorityOn) {
      for (const warmupHours of SWEEP.warmupHours) {
        for (const maxTrade of SWEEP.maxTrade) {
          for (const maxPred of SWEEP.maxPred) {
            for (const copyPercent of SWEEP.copyPercent) {
              configs.push({ minBuyPrice, majorityOn, warmupHours, maxTrade, maxPred, copyPercent });
            }
          }
        }
      }
    }
  }
  return configs;
}

async function main() {
  const db = await connectBacktestDb();
  console.log('Connected to production DB via SSH tunnel');

  const timeWindow = getTimeWindow(args as unknown as Record<string, string | boolean | undefined>);
  const useEmpirical = !args['no-empirical-slippage'];
  const calibration = await calibrateFromProduction(db, useEmpirical);

  // Base config from CLI flags (used for non-swept params)
  const baseConfig = buildSimConfig(
    args as unknown as Record<string, string | boolean | undefined>,
    calibration,
  );

  const flags: string[] = [];
  if (baseConfig.excludeSlugs.length > 0) flags.push(`slugExclude=[${baseConfig.excludeSlugs.join(',')}]`);
  if (baseConfig.useCapitalLockup) flags.push('capitalLockup=ON'); else flags.push('capitalLockup=OFF');
  if (useEmpirical) flags.push('empiricalSlippage=ON'); else flags.push('empiricalSlippage=OFF');
  if (baseConfig.bothSides) flags.push('bothSides=ON');
  if (baseConfig.followSells) flags.push('followSells=ON');
  if (timeWindow) flags.push(`window=${timeWindow.days > 0 ? `${timeWindow.days}d` : `${timeWindow.hours}h`}`);
  console.log(`Config: ${flags.join(' ')}\n`);

  const includeOpen = !!args['include-open'];

  for (const input of traderInputs) {
    let wallet: string;
    let userName: string;
    if (input.startsWith('0x')) {
      wallet = input;
      const res = await db.query(`SELECT "userName" FROM "Trader" WHERE "proxyWallet" = $1`, [wallet]);
      userName = res.rows[0]?.userName || input.slice(0, 12);
    } else {
      const res = await db.query(`SELECT "proxyWallet", "userName" FROM "Trader" WHERE "userName" = $1`, [input]);
      if (res.rows.length === 0) { console.log(`Trader "${input}" not found in DB. Skipping.`); continue; }
      wallet = res.rows[0].proxyWallet;
      userName = res.rows[0].userName;
    }

    // Fetch trades
    let tradeQuery: string;
    let tradeParams: any[];

    if (timeWindow) {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND t.timestamp >= $2
         ORDER BY t.timestamp ASC`;
      tradeParams = [wallet, timeWindow.cutoffTs];
    } else if (includeOpen) {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1
         ORDER BY t.timestamp ASC`;
      tradeParams = [wallet];
    } else {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND m.closed = true
         ORDER BY t.timestamp ASC`;
      tradeParams = [wallet];
    }
    const tradeResult = await db.query(tradeQuery, tradeParams);

    const trades: TradeRow[] = tradeResult.rows.map((r: any) => ({
      conditionId: r.conditionId,
      outcome: r.outcome || '',
      outcomeIndex: r.outcomeIndex != null ? parseInt(r.outcomeIndex) : null,
      price: parseFloat(r.price) || 0,
      size: parseFloat(r.size) || 0,
      timestamp: parseInt(r.timestamp) || 0,
      side: r.side || '',
      eventSlug: r.eventSlug || '',
      outcomePrices: r.outcomePrices || '[]',
      outcomes: r.outcomes || '[]',
      endDate: r.endDate ? Math.floor(new Date(r.endDate).getTime() / 1000) : null,
      closed: r.closed ?? true,
    }));

    const buyTrades = trades.filter(t => t.side === 'BUY');
    const traderBought = buyTrades.reduce((s, t) => s + t.size * t.price, 0);
    const cats = new Map<string, number>();
    for (const t of buyTrades) { const c = categorize(t.eventSlug); cats.set(c, (cats.get(c) ?? 0) + 1); }
    const catStr = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', ');

    // Official Polymarket P&L
    const closedPnlResult = await db.query(`
      SELECT COALESCE(SUM("realizedPnl"), 0) as realized_pnl,
             COALESCE(SUM("totalBought"), 0) as total_bought,
             COUNT(*) as num_positions
      FROM "ClosedPosition" WHERE "proxyWallet" = $1
    `, [wallet]);
    const openPnlResult = await db.query(`
      SELECT COALESCE(SUM("cashPnl"), 0) as unrealized_pnl,
             COALESCE(SUM("initialValue"), 0) as open_capital
      FROM "Position" WHERE "proxyWallet" = $1
    `, [wallet]);
    const cd = closedPnlResult.rows[0];
    const od = openPnlResult.rows[0];
    const realizedPnl = parseFloat(cd?.realized_pnl ?? '0');
    const unrealizedPnl = parseFloat(od?.unrealized_pnl ?? '0');
    const totalTraderCapital = parseFloat(cd?.total_bought ?? '0') + parseFloat(od?.open_capital ?? '0');
    const actualTraderPnl = realizedPnl + unrealizedPnl;
    const actualTraderRoi = totalTraderCapital > 0 ? actualTraderPnl / totalTraderCapital * 100 : 0;
    const actPnlStr = (actualTraderPnl >= 0 ? '+$' : '-$') + Math.abs(actualTraderPnl).toFixed(0);
    if (parseInt(cd?.num_positions ?? '0') >= 10000) {
      console.log(`WARNING: ${userName} hit 10K ClosedPosition cap — realized PnL may be incomplete`);
    }

    console.log(`${'='.repeat(140)}`);
    console.log(`${userName} (${wallet.slice(0, 14)}...) — ${trades.length} trades (${buyTrades.length} buys, ${trades.length - buyTrades.length} sells) | ${catStr}`);
    console.log(`Actual PnL: ${actPnlStr} | ROI: ${actualTraderRoi.toFixed(1)}% | Volume: $${traderBought.toFixed(0)}`);
    console.log(`${'='.repeat(140)}\n`);

    // Train/test split — sweep on train set only for out-of-sample validation
    const useTrainTest = !args['no-train-test'];
    const MIN_TRADES_FOR_SPLIT = 30;
    const canSplit = useTrainTest && trades.length >= MIN_TRADES_FOR_SPLIT;

    let sweepTrades = trades;
    let trainTrades: TradeRow[] | null = null;
    let testTrades: TradeRow[] | null = null;

    if (canSplit) {
      const splitIdx = Math.floor(trades.length * 0.7);
      trainTrades = trades.slice(0, splitIdx);
      testTrades = trades.slice(splitIdx);
      sweepTrades = trainTrades;
      console.log(`  Train/test split: ${trainTrades.length} train, ${testTrades.length} test trades (split at trade #${splitIdx})`);
    } else if (useTrainTest) {
      console.log(`  WARNING: Only ${trades.length} trades — insufficient for train/test split (need ${MIN_TRADES_FOR_SPLIT}). Using full dataset.`);
    }

    const sweepConfigs = generateSweepConfigs();
    console.log(`Sweeping ${sweepConfigs.length} configs${canSplit ? ' (on train set)' : ''}...`);
    const startMs = Date.now();

    const results: (SimResult & { sweepCfg: SweepConfig })[] = [];
    for (const sc of sweepConfigs) {
      const simCfg: SimConfig = {
        ...baseConfig,
        copyPercent: sc.copyPercent,
        maxTradeUsd: sc.maxTrade,
        maxPredUsd: sc.maxPred,
        minBuyPrice: sc.minBuyPrice,
        majorityGate: sc.majorityOn ? MAJORITY_GATE_USD : 0,
        accumulatorWarmupSec: sc.warmupHours * 3600,
        trackPredictions: false,
        includeOpenMarkets: !!timeWindow || includeOpen,
      };
      const result = simulateCopy(sweepTrades, simCfg);
      results.push({ ...result, sweepCfg: sc, score: computeScore(result.copyPnl, result.copyRoi, result.scalpPct, result.copyBuys, result.copyMaxDdPct, MIN_BUYS_FOR_RANKING, result.buysPerDay) });
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const profitable = results.filter(r => r.score > 0 && r.buysPerDay >= MIN_BUYS_PER_DAY);
    console.log(`  Done in ${elapsed}s — ${profitable.length}/${sweepConfigs.length} profitable (>= ${MIN_BUYS_FOR_RANKING} buys, >= ${MIN_BUYS_PER_DAY} buys/day)\n`);

    profitable.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped: typeof profitable = [];
    for (const r of profitable) {
      const key = `${r.copyPnl.toFixed(2)}_${r.copyBuys}_${r.holdWr.toFixed(1)}_${r.copyMaxDdPct.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    console.log(`  Unique result profiles: ${deduped.length} (from ${profitable.length} profitable configs)`);

    // Median selection: when >80% configs profitable, "best" is noise — use median
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

    const subheader =
      `${pad('', 5)}${rpad('minBuy', 7)}${rpad('Maj', 5)}${rpad('Warm', 5)}${rpad('MaxTr', 7)}${rpad('MaxPrd', 7)}${rpad('Copy%', 6)}  ` +
      `${rpad('PnL$', 8)}${rpad('Depld$', 8)}${rpad('ROI%', 7)}${rpad('HldWR%', 7)}${rpad('Buys', 6)}` +
      `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('Tr/Day', 7)}${rpad('Score', 8)}`;
    console.log(subheader);
    console.log('-'.repeat(subheader.length));

    for (let i = 0; i < Math.min(deduped.length, TOP_N); i++) {
      const r = deduped[i];
      const c = r.sweepCfg;
      console.log(
        `${pad(String(i + 1), 5)}` +
        `${rpad(c.minBuyPrice.toFixed(2), 7)}${rpad(c.majorityOn ? 'Yes' : 'No', 5)}${rpad(c.warmupHours + 'h', 5)}${rpad('$' + c.maxTrade, 7)}${rpad('$' + c.maxPred, 7)}${rpad((c.copyPercent * 100).toFixed(0) + '%', 6)}  ` +
        `${rpad('$' + r.copyPnl.toFixed(0), 8)}${rpad('$' + r.copyDeployed.toFixed(0), 8)}${rpad(r.copyRoi.toFixed(1), 7)}${rpad(r.holdWr.toFixed(1), 7)}${rpad(String(r.copyBuys), 6)}` +
        `${rpad(r.copyMaxDdPct.toFixed(1), 8)}${rpad(r.copySharpe.toFixed(2), 8)}${rpad(r.buysPerDay.toFixed(1), 7)}${rpad(r.score.toFixed(2), 8)}`
      );
    }

    // Train/Test validation on top configs (replaces Monte Carlo when sufficient trades)
    if (canSplit && testTrades && trainTrades && deduped.length > 0) {
      const nValidate = Math.min(3, deduped.length);
      console.log(`\n  Train/Test Validation on top ${nValidate} configs:\n`);

      for (let i = 0; i < nValidate; i++) {
        const sc = deduped[i].sweepCfg;
        const simCfg: SimConfig = {
          ...baseConfig,
          copyPercent: sc.copyPercent,
          maxTradeUsd: sc.maxTrade,
          maxPredUsd: sc.maxPred,
          minBuyPrice: sc.minBuyPrice,
          majorityGate: sc.majorityOn ? MAJORITY_GATE_USD : 0,
          accumulatorWarmupSec: sc.warmupHours * 3600,
          trackPredictions: false,
          includeOpenMarkets: !!timeWindow || includeOpen,
        };

        // Train result reused from sweep (already computed on trainTrades)
        const trainPnl = deduped[i].copyPnl;
        const trainBuys = deduped[i].copyBuys;
        const trainWr = deduped[i].holdWr;

        // Test result — fresh run on test set, trainTrades warms majority accumulator
        const testResult = simulateCopy(testTrades, simCfg, trainTrades);
        const testPnl = testResult.copyPnl;
        const testBuys = testResult.copyBuys;
        const testWr = testResult.holdWr;

        const ratio = trainPnl > 0 ? testPnl / trainPnl : 0;
        const passed = trainPnl > 0 && testPnl > 0;

        console.log(`  Config #${i + 1} (minBuy=${sc.minBuyPrice} Maj=${sc.majorityOn ? 'Yes' : 'No'} Warm=${sc.warmupHours}h MaxTr=$${sc.maxTrade} MaxPr=$${sc.maxPred} Copy=${(sc.copyPercent * 100).toFixed(0)}%):`);
        console.log(`    Train: PnL=$${trainPnl.toFixed(0)} | Buys=${trainBuys} | WR=${trainWr.toFixed(1)}%`);
        console.log(`    Test:  PnL=$${testPnl.toFixed(0)} | Buys=${testBuys} | WR=${testWr.toFixed(1)}%`);
        console.log(`    Ratio=${ratio.toFixed(2)} | ${passed ? 'PASS' : 'FAIL'}`);
        console.log('');
      }
    } else if (profitable.length > 0) {
      // Fallback: Monte Carlo when <30 trades or --no-train-test
      console.log(`\n  Monte Carlo (10 seeds) — fallback (${trades.length < MIN_TRADES_FOR_SPLIT ? `only ${trades.length} trades` : '--no-train-test'}):\n`);
      for (let i = 0; i < Math.min(3, profitable.length); i++) {
        const baseSc = profitable[i].sweepCfg;
        const mcPnls: number[] = [];
        for (let s = 0; s < 10; s++) {
          const mcCfg: SimConfig = {
            ...baseConfig,
            copyPercent: baseSc.copyPercent,
            maxTradeUsd: baseSc.maxTrade,
            maxPredUsd: baseSc.maxPred,
            minBuyPrice: baseSc.minBuyPrice,
            majorityGate: baseSc.majorityOn ? MAJORITY_GATE_USD : 0,
            accumulatorWarmupSec: baseSc.warmupHours * 3600,
            seed: baseConfig.seed + s,
            trackPredictions: false,
            includeOpenMarkets: !!timeWindow || includeOpen,
          };
          mcPnls.push(simulateCopy(trades, mcCfg).copyPnl);
        }
        const mean = mcPnls.reduce((a, b) => a + b, 0) / mcPnls.length;
        const min = Math.min(...mcPnls);
        const max = Math.max(...mcPnls);
        const variance = mcPnls.reduce((a, v) => a + (v - mean) ** 2, 0) / (mcPnls.length - 1);
        const stdev = Math.sqrt(variance);
        const allPositive = mcPnls.every(p => p > 0);

        console.log(`  Config #${i + 1} (minBuy=${baseSc.minBuyPrice} Maj=${baseSc.majorityOn ? 'Yes' : 'No'} Warm=${baseSc.warmupHours}h MaxTr=${baseSc.maxTrade} MaxPr=${baseSc.maxPred} Copy=${(baseSc.copyPercent * 100).toFixed(0)}%):`);
        console.log(`    PnLs: ${mcPnls.map(p => '$' + p.toFixed(0)).join(', ')}`);
        console.log(`    Mean=$${mean.toFixed(0)} | Stdev=$${stdev.toFixed(0)} | Min=$${min.toFixed(0)} | Max=$${max.toFixed(0)} | All positive: ${allPositive ? 'YES' : 'NO'}`);
        console.log('');
      }
    }

    // Parameter sensitivity
    console.log(`  Parameter Sensitivity (avg PnL by parameter value, profitable configs only):\n`);
    for (const [param, values] of Object.entries(SWEEP)) {
      const row = (values as (number | boolean)[]).map((v) => {
        const matching = profitable.filter(r => (r.sweepCfg as any)[param] === v);
        const avgPnl = matching.length > 0 ? matching.reduce((s, r) => s + r.copyPnl, 0) / matching.length : 0;
        const label = typeof v === 'boolean' ? (v ? 'on' : 'off') : String(v);
        return `${label}→$${avgPnl.toFixed(0)}`;
      }).join('  ');
      console.log(`    ${pad(param, 14)}: ${row}`);
    }
    console.log('\n');
  }

  await db.end();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
