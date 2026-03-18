#!/usr/bin/env tsx
/**
 * Config Sweep Backtest — Find optimal copy-trade parameters per trader
 *
 * Connects to Hetzner DB via SSH tunnel (localhost:15438).
 * Sweeps 1,600 config combinations per trader, ranked by composite score.
 * Monte Carlo on top 3 configs for consistency validation.
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 hetzner_finland_dockerapps
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader FloatyBoi --trader LampStore
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader 0x38c6fd3ae5db...  # wallet also works
 */

import { Client } from 'pg';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    trader: { type: 'string', multiple: true },
    seed: { type: 'string', default: '42' },
    top: { type: 'string', default: '20' },
  },
});

const traderInputs = args.trader ?? ['FloatyBoi', 'LampStore'];
const BASE_SEED = parseInt(args.seed ?? '42', 10);
const TOP_N = parseInt(args.top ?? '20', 10);

const DB_PASSWORD = process.env.HETZNER_PG_PASSWORD ?? '';

// ─── Sweep Dimensions ───
const SWEEP = {
  minBuyPrice:  [0.20, 0.30, 0.40, 0.50, 0.60],
  gate:         [0, 50, 100, 175, 250],
  maxTrade:     [3, 5, 8, 12],
  maxPred:      [10, 20, 30, 50],
  copyPercent:  [0.05, 0.10, 0.15, 0.20],
};

// Fixed constants (not swept)
const STARTING_CAPITAL = 450;
const FAK_FAILURE_RATE = 0.12;
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const MAX_DAILY_USD = 200;
const MIN_BUYS_FOR_RANKING = 10;

// ─── Config Interface ───
interface SimConfig {
  minBuyPrice: number;
  gate: number;
  maxTrade: number;
  maxPred: number;
  copyPercent: number;
  seed: number;
}

// ─── Data Types ───
interface Position {
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  eventSlug: string;
  endDate: string;
  outcomePrices: string;
}

interface SimResult {
  config: SimConfig;
  copyPnl: number;
  copyRoi: number;
  holdWr: number;
  copyBuys: number;
  maxDdPct: number;
  sharpe: number;
  dayWr: number;
  scalpPct: number;
  score: number;
  totalDeployed: number;
}

// ─── Seeded PRNG ───
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

function categorize(slug: string): string {
  if (!slug) return 'unknown';
  if (slug.includes('updown-5m')) return '5m';
  if (slug.includes('updown-15m')) return '15m';
  if (slug.includes('updown-1h') || slug.includes('up-or-down')) return '1h';
  if (slug.match(/nba-|nfl-|nhl-|mlb-/)) return 'sports';
  if (slug.match(/lol-|cs2-|dota-|valorant-/)) return 'esports';
  if (slug.match(/atp-|wta-/)) return 'tennis';
  if (slug.match(/ucl-|epl-|laliga-|bundesliga-/)) return 'soccer';
  return 'other';
}

// ─── Simulation Engine (parameterized) ───
function simulateCopy(positions: Position[], cfg: SimConfig): SimResult {
  const rng = mulberry32(cfg.seed);

  positions.sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

  let totalDeployed = 0, totalPnl = 0, buyCount = 0;
  let wins = 0, losses = 0, peakPnl = 0, maxDd = 0;
  let holdWins = 0, holdTotal = 0;
  let allScalpWins = 0, allScalpTotal = 0;

  const predDeployed = new Map<string, number>();
  const committedSides = new Map<string, string>();
  const dailyPnl = new Map<string, number>();
  const dailySpend = new Map<string, number>();
  const traderAccum = new Map<string, Map<string, number>>();

  for (const pos of positions) {
    const cat = categorize(pos.eventSlug);

    // Feed majority accumulator
    if (!traderAccum.has(pos.conditionId)) traderAccum.set(pos.conditionId, new Map());
    const outcomeMap = traderAccum.get(pos.conditionId)!;
    outcomeMap.set(pos.outcome, (outcomeMap.get(pos.outcome) ?? 0) + pos.totalBought);

    // Scalp metric (ALL positions, before guards)
    try {
      const prices: string[] = JSON.parse(pos.outcomePrices);
      const sp = parseFloat(prices[pos.outcomeIndex] ?? '0');
      if (pos.realizedPnl > 0) { allScalpTotal++; if (sp < 0.95) allScalpWins++; }
    } catch {}

    // === PRODUCTION GUARDS ===
    if (pos.avgPrice < cfg.minBuyPrice || pos.avgPrice > 0.95) continue;
    if (pos.totalBought < 1) continue;

    // Majority gate
    if (cfg.gate > 0) {
      const totalCidVol = [...(traderAccum.get(pos.conditionId)?.values() ?? [])].reduce((a, b) => a + b, 0);
      if (totalCidVol < cfg.gate) continue;
      const thisVol = outcomeMap.get(pos.outcome) ?? 0;
      if (thisVol / totalCidVol < 0.50) continue;
      if (outcomeMap.size < 2) continue;
    }

    // Committed side lock
    const committed = committedSides.get(pos.conditionId);
    if (committed && committed !== pos.outcome) continue;

    // Daily spend limit
    const day = (pos.endDate || '').slice(0, 10);
    const daySpent = dailySpend.get(day) ?? 0;
    if (daySpent >= MAX_DAILY_USD) continue;

    // Available capital
    const available = STARTING_CAPITAL - totalDeployed + totalPnl;
    if (available < 1) continue;

    // Sizing
    let copyAmount = Math.min(pos.totalBought * cfg.copyPercent, cfg.maxTrade);
    const predUsed = predDeployed.get(pos.conditionId) ?? 0;
    const predRemaining = cfg.maxPred - predUsed;
    if (predRemaining < 1) continue;
    if (copyAmount > predRemaining) copyAmount = predRemaining;
    if (copyAmount > available) copyAmount = available;
    const dailyRemaining = MAX_DAILY_USD - daySpent;
    if (copyAmount > dailyRemaining) copyAmount = dailyRemaining;
    if (copyAmount < 1.0) continue;

    // FAK failure
    if (rng() < FAK_FAILURE_RATE) continue;

    // Category-aware slippage
    let slippagePct: number;
    if (cat === '5m')       slippagePct = 0.03 + 0.05 * rng();
    else if (cat === '15m') slippagePct = 0.02 + 0.04 * rng();
    else if (cat === '1h')  slippagePct = 0.02 + 0.03 * rng();
    else                    slippagePct = 0.01 + 0.02 * rng();
    const fillPrice = Math.min(pos.avgPrice * (1 + slippagePct), 0.99);

    // Taker fee
    const shares = copyAmount / fillPrice;
    const feeShares = shares * FEE_RATE * Math.pow(fillPrice * (1 - fillPrice), FEE_EXPONENT);
    const netShares = shares - feeShares;

    // Market resolution oracle
    let outcomeWon = false;
    try {
      const prices: string[] = JSON.parse(pos.outcomePrices);
      outcomeWon = parseFloat(prices[pos.outcomeIndex] ?? '0') >= 0.95;
    } catch { continue; }

    const pnl = (outcomeWon ? netShares * 1.0 : 0) - copyAmount;

    holdTotal++;
    if (outcomeWon) holdWins++;
    totalPnl += pnl;
    totalDeployed += copyAmount;
    buyCount++;
    if (pnl > 0) wins++; else losses++;
    predDeployed.set(pos.conditionId, predUsed + copyAmount);
    if (!committed) committedSides.set(pos.conditionId, pos.outcome);
    dailySpend.set(day, daySpent + copyAmount);

    if (totalPnl > peakPnl) peakPnl = totalPnl;
    const dd = peakPnl - totalPnl;
    if (dd > maxDd) maxDd = dd;
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
  }

  const copyRoi = totalDeployed > 0 ? totalPnl / totalDeployed * 100 : 0;
  const maxDdPct = STARTING_CAPITAL > 0 ? maxDd / STARTING_CAPITAL * 100 : 0;
  const holdWr = holdTotal > 0 ? holdWins / holdTotal * 100 : 0;
  const scalpPct = allScalpTotal > 0 ? allScalpWins / allScalpTotal * 100 : 0;

  const dailyVals = [...dailyPnl.values()];
  const winDays = dailyVals.filter(v => v > 0).length;
  const dayWr = dailyVals.length > 0 ? winDays / dailyVals.length * 100 : 0;

  let sharpe = 0;
  if (dailyVals.length > 1) {
    const mean = dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length;
    const variance = dailyVals.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyVals.length - 1);
    sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
  }

  const score = (totalPnl > 0 && buyCount >= MIN_BUYS_FOR_RANKING)
    ? copyRoi * (1 - scalpPct / 100) * Math.min(buyCount / 20, 1) * (1 / (1 + maxDdPct / 20))
    : -1;

  return {
    config: cfg, copyPnl: totalPnl, copyRoi, holdWr, copyBuys: buyCount,
    maxDdPct, sharpe, dayWr, scalpPct, score, totalDeployed,
  };
}

// ─── Config Generator ───
function generateConfigs(seed: number): SimConfig[] {
  const configs: SimConfig[] = [];
  for (const minBuyPrice of SWEEP.minBuyPrice) {
    for (const gate of SWEEP.gate) {
      for (const maxTrade of SWEEP.maxTrade) {
        for (const maxPred of SWEEP.maxPred) {
          for (const copyPercent of SWEEP.copyPercent) {
            configs.push({ minBuyPrice, gate, maxTrade, maxPred, copyPercent, seed });
          }
        }
      }
    }
  }
  return configs;
}

// ─── Output Helpers ───
const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
const rpad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;

// ─── Main ───
async function main() {
  const db = new Client({
    host: 'localhost', port: 15438, user: 'polymarket',
    password: DB_PASSWORD, database: 'polymarket_copytrade',
  });
  await db.connect();
  console.log('Connected to Hetzner DB via SSH tunnel\n');

  for (const input of traderInputs) {
    // Resolve trader: wallet (0x...) or userName
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

    // Fetch positions
    const posResult = await db.query(`
      SELECT cp."conditionId", cp.outcome, cp."outcomeIndex",
             cp."avgPrice", cp."totalBought", cp."realizedPnl",
             cp."eventSlug", cp."endDate"::text, m."outcomePrices"
      FROM "ClosedPosition" cp
      JOIN "Market" m ON cp."conditionId" = m."conditionId"
      WHERE cp."proxyWallet" = $1 AND m.closed = true
      ORDER BY cp."endDate" ASC
    `, [wallet]);

    const positions: Position[] = posResult.rows.map(r => ({
      conditionId: r.conditionId, outcome: r.outcome || '',
      outcomeIndex: parseInt(r.outcomeIndex) || 0,
      avgPrice: parseFloat(r.avgPrice) || 0.5,
      totalBought: parseFloat(r.totalBought) || 0,
      realizedPnl: parseFloat(r.realizedPnl) || 0,
      eventSlug: r.eventSlug || '', endDate: r.endDate || '',
      outcomePrices: r.outcomePrices || '[]',
    }));

    // Category breakdown
    const cats = new Map<string, number>();
    for (const p of positions) { const c = categorize(p.eventSlug); cats.set(c, (cats.get(c) ?? 0) + 1); }
    const catStr = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', ');

    console.log(`${'='.repeat(140)}`);
    console.log(`${userName} (${wallet.slice(0, 14)}...) — ${positions.length} positions | ${catStr}`);
    console.log(`${'='.repeat(140)}\n`);

    // Sweep all configs
    const configs = generateConfigs(BASE_SEED);
    console.log(`Sweeping ${configs.length} configs...`);
    const startMs = Date.now();

    const results: SimResult[] = [];
    for (const cfg of configs) {
      results.push(simulateCopy(positions, cfg));
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const profitable = results.filter(r => r.score > 0);
    console.log(`  Done in ${elapsed}s — ${profitable.length}/${configs.length} profitable (>= ${MIN_BUYS_FOR_RANKING} buys)\n`);

    // Rank by score, deduplicate configs with identical results
    profitable.sort((a, b) => b.score - a.score);
    const seen = new Set<string>();
    const deduped: SimResult[] = [];
    for (const r of profitable) {
      const key = `${r.copyPnl.toFixed(2)}_${r.copyBuys}_${r.holdWr.toFixed(1)}_${r.maxDdPct.toFixed(1)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(r);
    }

    console.log(`  Unique result profiles: ${deduped.length} (from ${profitable.length} profitable configs)\n`);

    // Print top N
    const header =
      `${pad('Rank', 5)}` +
      `${pad('── Config ──', 38)}` +
      `${pad('── Results ──', 60)}`;
    const subheader =
      `${pad('', 5)}${rpad('minBuy', 7)}${rpad('Gate$', 6)}${rpad('MaxTr', 7)}${rpad('MaxPrd', 7)}${rpad('Copy%', 6)}  ` +
      `${rpad('PnL$', 8)}${rpad('Depld$', 8)}${rpad('ROI%', 7)}${rpad('HldWR%', 7)}${rpad('Buys', 6)}` +
      `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 7)}${rpad('Score', 8)}`;
    console.log(subheader);
    console.log('-'.repeat(subheader.length));

    for (let i = 0; i < Math.min(deduped.length, TOP_N); i++) {
      const r = deduped[i];
      const c = r.config;
      console.log(
        `${pad(String(i + 1), 5)}` +
        `${rpad(c.minBuyPrice.toFixed(2), 7)}${rpad('$' + c.gate, 6)}${rpad('$' + c.maxTrade, 7)}${rpad('$' + c.maxPred, 7)}${rpad((c.copyPercent * 100).toFixed(0) + '%', 6)}  ` +
        `${rpad('$' + r.copyPnl.toFixed(0), 8)}${rpad('$' + r.totalDeployed.toFixed(0), 8)}${rpad(r.copyRoi.toFixed(1), 7)}${rpad(r.holdWr.toFixed(1), 7)}${rpad(String(r.copyBuys), 6)}` +
        `${rpad(r.maxDdPct.toFixed(1), 8)}${rpad(r.sharpe.toFixed(2), 8)}${rpad(r.dayWr.toFixed(0), 7)}${rpad(r.score.toFixed(2), 8)}`
      );
    }

    // Monte Carlo on top 3
    if (profitable.length > 0) {
      console.log(`\n  Monte Carlo (10 seeds) on top ${Math.min(3, profitable.length)} configs:\n`);
      for (let i = 0; i < Math.min(3, profitable.length); i++) {
        const baseCfg = profitable[i].config;
        const mcPnls: number[] = [];
        for (let s = 0; s < 10; s++) {
          const mcCfg = { ...baseCfg, seed: BASE_SEED + s };
          const mcResult = simulateCopy(positions, mcCfg);
          mcPnls.push(mcResult.copyPnl);
        }
        const mean = mcPnls.reduce((a, b) => a + b, 0) / mcPnls.length;
        const min = Math.min(...mcPnls);
        const max = Math.max(...mcPnls);
        const variance = mcPnls.reduce((a, v) => a + (v - mean) ** 2, 0) / (mcPnls.length - 1);
        const stdev = Math.sqrt(variance);
        const allPositive = mcPnls.every(p => p > 0);

        const c = baseCfg;
        console.log(`  Config #${i + 1} (minBuy=${c.minBuyPrice} Gate=${c.gate} MaxTr=${c.maxTrade} MaxPr=${c.maxPred} Copy=${(c.copyPercent * 100).toFixed(0)}%):`);
        console.log(`    PnLs: ${mcPnls.map(p => '$' + p.toFixed(0)).join(', ')}`);
        console.log(`    Mean=$${mean.toFixed(0)} | Stdev=$${stdev.toFixed(0)} | Min=$${min.toFixed(0)} | Max=$${max.toFixed(0)} | All positive: ${allPositive ? 'YES' : 'NO'}`);
        console.log('');
      }
    }

    // Summary: which parameters matter most?
    console.log(`  Parameter Sensitivity (avg PnL by parameter value, profitable configs only):\n`);
    for (const [param, values] of Object.entries(SWEEP)) {
      const row = values.map((v: number) => {
        const matching = profitable.filter(r => (r.config as any)[param] === v);
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
