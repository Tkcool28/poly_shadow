#!/usr/bin/env tsx
/**
 * Batch Backtest Pipeline — Backtests ALL completed traders from DB
 * 
 * Connects to Hetzner DB via SSH tunnel (localhost:15438).
 * For each trader: simulates copy-trade at 10% sizing with fees/slippage.
 * Outputs ranked results.
 * 
 * Usage:
 *   # Start SSH tunnel first:
 *   ssh -f -N -L 15438:localhost:5438 hetzner_finland_dockerapps
 *   # Then run:
 *   npx tsx src/scripts/batch-backtest-traders.ts [--limit N] [--min-positions 20]
 */

import { Client } from 'pg';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '1000' },
    'min-positions': { type: 'string', default: '20' },
  },
});

const LIMIT = parseInt(args.limit ?? '1000', 10);
const MIN_POSITIONS = parseInt(args['min-positions'] ?? '20', 10);

// Copy-trade simulation constants
const COPY_PERCENT = 0.10;
const MAX_TRADE_USD = 8;
const MAX_PRED_USD = 30;
const STARTING_CAPITAL = 450;
const FAK_FAILURE_RATE = 0.12;
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const SLIPPAGE_FRACTION = 0.05;

// Seeded PRNG
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

interface Position {
  conditionId: string;
  outcome: string;
  outcomeIndex: number;
  avgPrice: number;
  totalBought: number;
  realizedPnl: number;
  eventSlug: string;
  endDate: string;
  outcomePrices: string;  // JSON array e.g. '["1","0"]'
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

interface TraderResult {
  wallet: string;
  name: string;
  positions: number;
  traderPnl: number;
  traderBought: number;
  traderRoi: number;
  traderWr: number;
  // Copy simulation
  copyPnl: number;
  copyDeployed: number;
  copyRoi: number;
  copyWr: number;
  copyBuys: number;
  copyMaxDd: number;
  copyMaxDdPct: number;
  copySharpe: number;
  // Consistency
  winDays: number;
  lossDays: number;
  dayWr: number;
  maxWinStreak: number;
  maxLossStreak: number;
  // Category
  mainCategory: string;
  cryptoPct: number;
  // Daily
  pnlPerDay: number;
  daysActive: number;
  // Scalp detection
  scalpPct: number;   // % of trader's profitable positions where outcome actually lost
  holdWr: number;     // WR based on market resolution (not trader PnL)
  score: number;      // composite ranking score
}

function simulateCopy(positions: Position[]): Omit<TraderResult, 'wallet' | 'name' | 'positions' | 'traderPnl' | 'traderBought' | 'traderRoi' | 'traderWr'> {
  const rng = mulberry32(42);

  // Sort chronologically
  positions.sort((a, b) => (a.endDate || '').localeCompare(b.endDate || ''));

  // Fixed capital — NO compounding (production doesn't auto-compound)
  const capital = STARTING_CAPITAL;
  let totalDeployed = 0;
  let totalPnl = 0;
  let buyCount = 0;
  let wins = 0, losses = 0;
  let peakPnl = 0;
  let maxDd = 0;

  const predDeployed = new Map<string, number>();
  const committedSides = new Map<string, string>(); // conditionId → first outcome we bought
  const dailyPnl = new Map<string, number>();
  let dailySpend = new Map<string, number>();
  const MAX_DAILY_USD = 200;

  // Category tracking
  const catCounts = new Map<string, number>();

  // Scalp detection: computed on ALL positions (before guards)
  let allScalpWins = 0, allScalpTotal = 0, allHoldWins = 0, allHoldTotal = 0;
  // Hold WR: computed on positions we actually copy (after guards)
  let holdWins = 0, holdTotal = 0;

  // Majority accumulator: track trader's USD per outcome per conditionId
  const traderAccum = new Map<string, Map<string, number>>(); // cid → outcome → USD

  for (const pos of positions) {
    const cat = categorize(pos.eventSlug);
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

    // Feed majority accumulator regardless of filters
    if (!traderAccum.has(pos.conditionId)) traderAccum.set(pos.conditionId, new Map());
    const outcomeMap = traderAccum.get(pos.conditionId)!;
    outcomeMap.set(pos.outcome, (outcomeMap.get(pos.outcome) ?? 0) + pos.totalBought);

    // Scalp metric: compute on ALL positions BEFORE guards (shows trader nature)
    try {
      const prices: string[] = JSON.parse(pos.outcomePrices);
      const sp = parseFloat(prices[pos.outcomeIndex] ?? '0');
      const ow = sp >= 0.95;
      allHoldTotal++;
      if (ow) allHoldWins++;
      if (pos.realizedPnl > 0) { allScalpTotal++; if (!ow) allScalpWins++; }
    } catch {}

    // === PRODUCTION GUARDS ===

    // Guard 1: Min buy price (production: 0.40 for SZ_FOLLOW, 0.60 for PROD_FAITHFUL)
    if (pos.avgPrice < 0.40 || pos.avgPrice > 0.95) continue;
    if (pos.totalBought < 1) continue;

    // Guard 2: Majority gate — need $175+ total volume on this conditionId
    const totalCidVolume = [...(traderAccum.get(pos.conditionId)?.values() ?? [])].reduce((a, b) => a + b, 0);
    if (totalCidVolume < 175) continue;

    // Guard 3: Majority check — this outcome must be the majority (>50%)
    const thisOutcomeVol = outcomeMap.get(pos.outcome) ?? 0;
    const majorityRatio = thisOutcomeVol / totalCidVolume;
    if (majorityRatio < 0.50) continue;

    // Guard 4: Both-sides requirement — need at least 2 outcomes seen
    if (outcomeMap.size < 2) continue;

    // Guard 5: Committed side lock — once we buy one outcome, block the other
    const committed = committedSides.get(pos.conditionId);
    if (committed && committed !== pos.outcome) continue;

    // Guard 6: Daily spend limit ($200/day)
    const day = (pos.endDate || '').slice(0, 10);
    const daySpent = dailySpend.get(day) ?? 0;
    if (daySpent >= MAX_DAILY_USD) continue;

    // Guard 7: Available capital (non-compounding: use fixed pool minus total deployed in open positions)
    // Simplified: just check we haven't deployed more than starting capital
    const availableCapital = capital - totalDeployed + totalPnl; // rough available
    if (availableCapital < 1) continue;

    // Sizing: 10% of trader's position, capped at $8/trade
    let copyAmount = Math.min(pos.totalBought * COPY_PERCENT, MAX_TRADE_USD);

    // Per-prediction cap
    const predUsed = predDeployed.get(pos.conditionId) ?? 0;
    const predRemaining = MAX_PRED_USD - predUsed;
    if (predRemaining < 1) continue;
    if (copyAmount > predRemaining) copyAmount = predRemaining;

    // Cap at available capital
    if (copyAmount > availableCapital) copyAmount = availableCapital;
    // Cap at daily remaining
    const dailyRemaining = MAX_DAILY_USD - daySpent;
    if (copyAmount > dailyRemaining) copyAmount = dailyRemaining;
    if (copyAmount < 1.0) continue; // CLOB $1 minimum

    // FAK failure simulation (12%)
    if (rng() < FAK_FAILURE_RATE) continue;

    // Category-aware slippage: we enter LATER than trader, price has moved
    let slippagePct: number;
    if (cat === '5m')       slippagePct = 0.03 + 0.05 * rng();  // 3-8% (5m moves fast)
    else if (cat === '15m') slippagePct = 0.02 + 0.04 * rng();  // 2-6%
    else if (cat === '1h')  slippagePct = 0.02 + 0.03 * rng();  // 2-5%
    else                    slippagePct = 0.01 + 0.02 * rng();   // 1-3% (sports/other)
    const fillPrice = Math.min(pos.avgPrice * (1 + slippagePct), 0.99);

    // Taker fee: 0.25 × (p(1-p))^2
    const shares = copyAmount / fillPrice;
    const feeShares = shares * FEE_RATE * Math.pow(fillPrice * (1 - fillPrice), FEE_EXPONENT);
    const netShares = shares - feeShares;

    // Did the OUTCOME actually win at settlement? (NOT trader's PnL)
    let outcomeWon = false;
    try {
      const prices: string[] = JSON.parse(pos.outcomePrices);
      const settlementPrice = parseFloat(prices[pos.outcomeIndex] ?? '0');
      outcomeWon = settlementPrice >= 0.95;
    } catch {
      continue; // skip unparseable — don't fallback to realizedPnl
    }
    const settlementValue = outcomeWon ? netShares * 1.0 : 0;
    const pnl = settlementValue - copyAmount;

    // Track hold WR (guarded positions only)
    holdTotal++;
    if (outcomeWon) holdWins++;

    totalPnl += pnl;
    totalDeployed += copyAmount;
    buyCount++;
    if (pnl > 0) wins++; else losses++;
    predDeployed.set(pos.conditionId, predUsed + copyAmount);
    if (!committed) committedSides.set(pos.conditionId, pos.outcome);
    dailySpend.set(day, daySpent + copyAmount);

    // Drawdown (on cumulative PnL, not equity — since non-compounding)
    if (totalPnl > peakPnl) peakPnl = totalPnl;
    const dd = peakPnl - totalPnl;
    if (dd > maxDd) maxDd = dd;

    // Daily PnL
    dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
  }

  const copyPnl = totalPnl;
  const copyRoi = totalDeployed > 0 ? copyPnl / totalDeployed * 100 : 0;
  const copyWr = (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;
  const copyMaxDdPct = STARTING_CAPITAL > 0 ? maxDd / STARTING_CAPITAL * 100 : 0;

  // Daily consistency
  const dailyVals = [...dailyPnl.values()];
  const winDays = dailyVals.filter(v => v > 0).length;
  const lossDays = dailyVals.filter(v => v <= 0).length;
  const dayWr = dailyVals.length > 0 ? winDays / dailyVals.length * 100 : 0;

  // Sharpe
  let sharpe = 0;
  if (dailyVals.length > 1) {
    const mean = dailyVals.reduce((a, b) => a + b, 0) / dailyVals.length;
    const variance = dailyVals.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyVals.length - 1);
    const stdev = Math.sqrt(variance);
    sharpe = stdev > 0 ? mean / stdev : 0;
  }

  // Streaks
  let maxWinStreak = 0, maxLossStreak = 0, curWin = 0, curLoss = 0;
  for (const v of dailyVals) {
    if (v > 0) { curWin++; curLoss = 0; if (curWin > maxWinStreak) maxWinStreak = curWin; }
    else { curLoss++; curWin = 0; if (curLoss > maxLossStreak) maxLossStreak = curLoss; }
  }

  // Main category
  let mainCat = 'unknown';
  let maxCatCount = 0;
  for (const [c, n] of catCounts) {
    if (n > maxCatCount) { maxCatCount = n; mainCat = c; }
  }
  const cryptoCount = (catCounts.get('5m') ?? 0) + (catCounts.get('15m') ?? 0) + (catCounts.get('1h') ?? 0);
  const cryptoPct = positions.length > 0 ? cryptoCount / positions.length * 100 : 0;

  const scalpPct = allScalpTotal > 0 ? allScalpWins / allScalpTotal * 100 : 0;
  const holdWr = holdTotal > 0 ? holdWins / holdTotal * 100 : 0;

  // Composite score: penalize scalpers, low sample, high DD
  const score = copyPnl > 0
    ? copyRoi * (1 - scalpPct / 100) * Math.min(buyCount / 20, 1) * (1 / (1 + copyMaxDdPct / 20))
    : -1; // unprofitable = unranked

  return {
    copyPnl, copyDeployed: totalDeployed, copyRoi, copyWr, copyBuys: buyCount,
    copyMaxDd: maxDd, copyMaxDdPct, copySharpe: sharpe,
    winDays, lossDays, dayWr, maxWinStreak, maxLossStreak,
    mainCategory: mainCat, cryptoPct,
    pnlPerDay: dailyVals.length > 0 ? copyPnl / dailyVals.length : 0,
    daysActive: dailyVals.length,
    scalpPct, holdWr, score,
  };
}

async function main() {
  const db = new Client({
    host: 'localhost',
    port: 15438,
    user: 'polymarket',
    password: process.env.HETZNER_PG_PASSWORD ?? '',
    database: 'polymarket_copytrade',
  });

  await db.connect();
  console.log('Connected to Hetzner DB via SSH tunnel');

  // Get all completed traders
  const traders = await db.query(`
    SELECT t."proxyWallet", t."userName",
           COUNT(cp.id) as pos_count
    FROM "Trader" t
    JOIN "ClosedPosition" cp ON cp."proxyWallet" = t."proxyWallet"
    WHERE t."backfillStatus" = 'COMPLETED'
    GROUP BY t."proxyWallet", t."userName"
    HAVING COUNT(cp.id) >= $1
    ORDER BY COUNT(cp.id) DESC
    LIMIT $2
  `, [MIN_POSITIONS, LIMIT]);

  console.log(`Found ${traders.rows.length} traders with >= ${MIN_POSITIONS} closed positions`);

  const results: TraderResult[] = [];
  let processed = 0;

  for (const trader of traders.rows) {
    // Fetch closed positions with market resolution data
    const posResult = await db.query(`
      SELECT cp."conditionId", cp.outcome, cp."outcomeIndex",
             cp."avgPrice", cp."totalBought", cp."realizedPnl",
             cp."eventSlug", cp."endDate"::text,
             m."outcomePrices"
      FROM "ClosedPosition" cp
      JOIN "Market" m ON cp."conditionId" = m."conditionId"
      WHERE cp."proxyWallet" = $1
        AND m.closed = true
      ORDER BY cp."endDate" ASC
    `, [trader.proxyWallet]);

    const positions: Position[] = posResult.rows.map(r => ({
      conditionId: r.conditionId,
      outcome: r.outcome || '',
      outcomeIndex: parseInt(r.outcomeIndex) || 0,
      avgPrice: parseFloat(r.avgPrice) || 0.5,
      totalBought: parseFloat(r.totalBought) || 0,
      realizedPnl: parseFloat(r.realizedPnl) || 0,
      eventSlug: r.eventSlug || '',
      endDate: r.endDate || '',
      outcomePrices: r.outcomePrices || '[]',
    }));

    // Trader stats
    const traderWins = positions.filter(p => p.realizedPnl > 0).length;
    const traderPnl = positions.reduce((s, p) => s + p.realizedPnl, 0);
    const traderBought = positions.reduce((s, p) => s + p.totalBought, 0);

    // Run copy simulation
    const sim = simulateCopy(positions);

    results.push({
      wallet: trader.proxyWallet,
      name: (trader.userName || trader.proxyWallet.slice(0, 10)).slice(0, 20),
      positions: positions.length,
      traderPnl,
      traderBought,
      traderRoi: traderBought > 0 ? traderPnl / traderBought * 100 : 0,
      traderWr: positions.length > 0 ? traderWins / positions.length * 100 : 0,
      ...sim,
    });

    processed++;
    if (processed % 50 === 0) console.log(`  Processed ${processed}/${traders.rows.length}...`);
  }

  await db.end();

  // Split profitable / unprofitable, rank by composite score
  const profitable = results.filter(r => r.copyPnl > 0);
  const unprofitable = results.filter(r => r.copyPnl <= 0);
  profitable.sort((a, b) => b.score - a.score);
  unprofitable.sort((a, b) => b.copyPnl - a.copyPnl);

  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  const rpad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;

  // Output
  console.log(`\n${'='.repeat(190)}`);
  console.log(`BATCH BACKTEST — ${results.length} traders | Market resolution oracle | Copy: 10%, $8/trade, $30/pred, $450 cap, fees+slippage ON, majority gate $175`);
  console.log(`${'='.repeat(190)}\n`);

  const header =
    `${pad('Rank', 5)}${pad('Trader', 22)}${rpad('Pos', 6)}${rpad('TrROI%', 7)}${rpad('TrWR%', 7)}` +
    `${rpad('CpPnL$', 9)}${rpad('CpROI%', 8)}${rpad('HldWR%', 7)}${rpad('CpBuys', 7)}` +
    `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 8)}` +
    `${rpad('Scalp%', 7)}${rpad('Score', 8)}` +
    `${rpad('$/day', 8)}${rpad('Days', 5)}${rpad('Cry%', 5)}${pad('  Category', 12)}`;

  console.log(`PROFITABLE TRADERS (${profitable.length}):`);
  console.log(header);
  console.log('-'.repeat(190));

  for (let i = 0; i < Math.min(profitable.length, 50); i++) {
    const r = profitable[i];
    console.log(
      `${pad(String(i + 1), 5)}${pad(r.name, 22)}` +
      `${rpad(String(r.positions), 6)}${rpad(r.traderRoi.toFixed(1), 7)}${rpad(r.traderWr.toFixed(1), 7)}` +
      `${rpad('$' + r.copyPnl.toFixed(0), 9)}${rpad(r.copyRoi.toFixed(1), 8)}${rpad(r.holdWr.toFixed(1), 7)}${rpad(String(r.copyBuys), 7)}` +
      `${rpad(r.copyMaxDdPct.toFixed(1), 8)}${rpad(r.copySharpe.toFixed(2), 8)}${rpad(r.dayWr.toFixed(0), 8)}` +
      `${rpad(r.scalpPct.toFixed(0), 7)}${rpad(r.score.toFixed(2), 8)}` +
      `${rpad('$' + r.pnlPerDay.toFixed(0), 8)}${rpad(String(r.daysActive), 5)}${rpad(r.cryptoPct.toFixed(0), 5)}${pad('  ' + r.mainCategory, 12)}`
    );
  }

  const cryptoProfitable = profitable.filter(r => r.cryptoPct > 50);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total traders tested: ${results.length}`);
  console.log(`Profitable (copy PnL > 0): ${profitable.length} (${(profitable.length / results.length * 100).toFixed(1)}%)`);
  console.log(`Unprofitable: ${unprofitable.length}`);
  console.log(`Profitable crypto traders: ${cryptoProfitable.length}`);
  console.log(`\nTop 5 by composite score:`);
  for (const r of profitable.slice(0, 5)) {
    console.log(`  ${r.name}: Score=${r.score.toFixed(2)} | CopyPnL=$${r.copyPnl.toFixed(0)} | HoldWR=${r.holdWr.toFixed(1)}% | Scalp=${r.scalpPct.toFixed(0)}% | ${r.mainCategory}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
