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
const SWEEP = {
  minBuyPrice:  [0.20, 0.30, 0.40, 0.50, 0.60],
  gate:         [0, 50, 100, 175, 250],
  maxTrade:     [3, 5, 8, 12],
  maxPred:      [10, 20, 30, 50],
  copyPercent:  [0.05, 0.10, 0.15, 0.20],
};

interface SweepConfig {
  minBuyPrice: number;
  gate: number;
  maxTrade: number;
  maxPred: number;
  copyPercent: number;
}

function generateSweepConfigs(): SweepConfig[] {
  const configs: SweepConfig[] = [];
  for (const minBuyPrice of SWEEP.minBuyPrice) {
    for (const gate of SWEEP.gate) {
      for (const maxTrade of SWEEP.maxTrade) {
        for (const maxPred of SWEEP.maxPred) {
          for (const copyPercent of SWEEP.copyPercent) {
            configs.push({ minBuyPrice, gate, maxTrade, maxPred, copyPercent });
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
    const tradeQuery = timeWindow
      ? `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND t.timestamp >= $2
         ORDER BY t.timestamp ASC`
      : `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate"
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND m.closed = true
         ORDER BY t.timestamp ASC`;
    const tradeParams = timeWindow ? [wallet, timeWindow.cutoffTs] : [wallet];
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
      ...(timeWindow ? { closed: r.closed ?? true } : {}),
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

    const sweepConfigs = generateSweepConfigs();
    console.log(`Sweeping ${sweepConfigs.length} configs...`);
    const startMs = Date.now();

    const results: (SimResult & { sweepCfg: SweepConfig })[] = [];
    for (const sc of sweepConfigs) {
      const simCfg: SimConfig = {
        ...baseConfig,
        copyPercent: sc.copyPercent,
        maxTradeUsd: sc.maxTrade,
        maxPredUsd: sc.maxPred,
        minBuyPrice: sc.minBuyPrice,
        majorityGate: sc.gate,
        trackPredictions: false,
        includeOpenMarkets: !!timeWindow,
      };
      const result = simulateCopy(trades, simCfg);
      results.push({ ...result, sweepCfg: sc, score: computeScore(result.copyPnl, result.copyRoi, result.scalpPct, result.copyBuys, result.copyMaxDdPct, MIN_BUYS_FOR_RANKING) });
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const profitable = results.filter(r => r.score > 0);
    console.log(`  Done in ${elapsed}s — ${profitable.length}/${sweepConfigs.length} profitable (>= ${MIN_BUYS_FOR_RANKING} buys)\n`);

    profitable.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped: typeof profitable = [];
    for (const r of profitable) {
      const key = `${r.copyPnl.toFixed(2)}_${r.copyBuys}_${r.holdWr.toFixed(1)}_${r.copyMaxDdPct.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    console.log(`  Unique result profiles: ${deduped.length} (from ${profitable.length} profitable configs)\n`);

    const subheader =
      `${pad('', 5)}${rpad('minBuy', 7)}${rpad('Gate$', 6)}${rpad('MaxTr', 7)}${rpad('MaxPrd', 7)}${rpad('Copy%', 6)}  ` +
      `${rpad('PnL$', 8)}${rpad('Depld$', 8)}${rpad('ROI%', 7)}${rpad('HldWR%', 7)}${rpad('Buys', 6)}` +
      `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 7)}${rpad('Score', 8)}`;
    console.log(subheader);
    console.log('-'.repeat(subheader.length));

    for (let i = 0; i < Math.min(deduped.length, TOP_N); i++) {
      const r = deduped[i];
      const c = r.sweepCfg;
      console.log(
        `${pad(String(i + 1), 5)}` +
        `${rpad(c.minBuyPrice.toFixed(2), 7)}${rpad('$' + c.gate, 6)}${rpad('$' + c.maxTrade, 7)}${rpad('$' + c.maxPred, 7)}${rpad((c.copyPercent * 100).toFixed(0) + '%', 6)}  ` +
        `${rpad('$' + r.copyPnl.toFixed(0), 8)}${rpad('$' + r.copyDeployed.toFixed(0), 8)}${rpad(r.copyRoi.toFixed(1), 7)}${rpad(r.holdWr.toFixed(1), 7)}${rpad(String(r.copyBuys), 6)}` +
        `${rpad(r.copyMaxDdPct.toFixed(1), 8)}${rpad(r.copySharpe.toFixed(2), 8)}${rpad(r.dayWr.toFixed(0), 7)}${rpad(r.score.toFixed(2), 8)}`
      );
    }

    // Monte Carlo on top 3
    if (profitable.length > 0) {
      console.log(`\n  Monte Carlo (10 seeds) on top ${Math.min(3, profitable.length)} configs:\n`);
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
            majorityGate: baseSc.gate,
            seed: baseConfig.seed + s,
            trackPredictions: false,
            includeOpenMarkets: !!timeWindow,
          };
          mcPnls.push(simulateCopy(trades, mcCfg).copyPnl);
        }
        const mean = mcPnls.reduce((a, b) => a + b, 0) / mcPnls.length;
        const min = Math.min(...mcPnls);
        const max = Math.max(...mcPnls);
        const variance = mcPnls.reduce((a, v) => a + (v - mean) ** 2, 0) / (mcPnls.length - 1);
        const stdev = Math.sqrt(variance);
        const allPositive = mcPnls.every(p => p > 0);

        console.log(`  Config #${i + 1} (minBuy=${baseSc.minBuyPrice} Gate=${baseSc.gate} MaxTr=${baseSc.maxTrade} MaxPr=${baseSc.maxPred} Copy=${(baseSc.copyPercent * 100).toFixed(0)}%):`);
        console.log(`    PnLs: ${mcPnls.map(p => '$' + p.toFixed(0)).join(', ')}`);
        console.log(`    Mean=$${mean.toFixed(0)} | Stdev=$${stdev.toFixed(0)} | Min=$${min.toFixed(0)} | Max=$${max.toFixed(0)} | All positive: ${allPositive ? 'YES' : 'NO'}`);
        console.log('');
      }
    }

    // Parameter sensitivity
    console.log(`  Parameter Sensitivity (avg PnL by parameter value, profitable configs only):\n`);
    for (const [param, values] of Object.entries(SWEEP)) {
      const row = values.map((v: number) => {
        const matching = profitable.filter(r => (r.sweepCfg as any)[param] === v);
        const avgPnl = matching.length > 0 ? matching.reduce((s, r) => s + r.copyPnl, 0) / matching.length : 0;
        return `${v}→$${avgPnl.toFixed(0)}`;
      }).join('  ');
      console.log(`    ${pad(param, 14)}: ${row}`);
    }
    console.log('\n');
  }

  await db.end();
  console.log('Done.');
}

main().catch(e => { console.error(e); process.exit(1); });
