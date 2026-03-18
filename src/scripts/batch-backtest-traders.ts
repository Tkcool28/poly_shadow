#!/usr/bin/env tsx
/**
 * Batch Backtest Pipeline — Backtests ALL completed traders from DB
 *
 * Uses INDIVIDUAL TRADES (not aggregated ClosedPositions) to match production behavior.
 * Processes fills sequentially in timestamp order with self-exclusion in majority gate.
 *
 * Connects to Hetzner DB via SSH tunnel (localhost:15438).
 * For each trader: simulates copy-trade at 10% sizing with fees/slippage.
 * Outputs ranked results.
 *
 * Usage:
 *   # Start SSH tunnel first:
 *   ssh -f -N -L 15438:localhost:5438 hetzner_finland_dockerapps
 *   # Then run:
 *   npx tsx src/scripts/batch-backtest-traders.ts [--limit N] [--min-positions 20] [--gate 175]
 */

import { Client } from 'pg';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '1000' },
    'min-positions': { type: 'string', default: '20' },
    gate: { type: 'string', default: '175' },
  },
});

const LIMIT = parseInt(args.limit ?? '1000', 10);
const MIN_POSITIONS = parseInt(args['min-positions'] ?? '20', 10);
const MAJORITY_GATE = parseInt(args.gate ?? '175', 10);

// Copy-trade simulation constants
const COPY_PERCENT = 0.10;
const MAX_TRADE_USD = 8;
const MAX_PRED_USD = 30;
const STARTING_CAPITAL = 450;
const FAK_FAILURE_RATE = 0.12;
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const MAX_DAILY_USD = 200;

// Seeded PRNG
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

interface TradeRow {
  conditionId: string;
  outcome: string;
  outcomeIndex: number | null;
  price: number;
  size: number;
  timestamp: number;
  side: string;
  eventSlug: string;
  outcomePrices: string;
  outcomes: string;
}

function resolveOutcomeIndex(trade: TradeRow): number | null {
  if (trade.outcomeIndex != null) return trade.outcomeIndex;
  try {
    const outcomes: string[] = JSON.parse(trade.outcomes);
    const idx = outcomes.findIndex(o => o.toLowerCase() === trade.outcome.toLowerCase());
    return idx >= 0 ? idx : null;
  } catch { return null; }
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
  trades: number;
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
  scalpPct: number;   // % of sells vs buys — high = scalper
  holdWr: number;     // WR based on market resolution (copied trades only)
  score: number;      // composite ranking score
}

function simulateCopy(trades: TradeRow[]): Omit<TraderResult, 'wallet' | 'name' | 'trades' | 'traderPnl' | 'traderBought' | 'traderRoi' | 'traderWr'> {
  const rng = mulberry32(42);

  // Already sorted by timestamp ASC from SQL, but ensure
  trades.sort((a, b) => a.timestamp - b.timestamp);

  let totalDeployed = 0;
  let totalPnl = 0;
  let buyCount = 0;
  let wins = 0, losses = 0;
  let peakPnl = 0;
  let maxDd = 0;

  const predDeployed = new Map<string, number>();
  const committedSides = new Map<string, string>();
  const dailyPnl = new Map<string, number>();
  const dailySpend = new Map<string, number>();

  // Category tracking
  const catCounts = new Map<string, number>();

  // Scalp detection: sell count vs buy count
  let sellCount = 0, totalBuyCount = 0;
  // Hold WR: computed on trades we actually copy (after guards)
  let holdWins = 0, holdTotal = 0;

  // Majority accumulator: track trader's USD per outcome per conditionId
  const traderAccum = new Map<string, Map<string, number>>();

  for (const trade of trades) {
    const cat = categorize(trade.eventSlug);
    const fillUsd = trade.size * trade.price;

    // Track SELLs for scalp detection, then skip
    if (trade.side === 'SELL') {
      sellCount++;
      continue;
    }
    // Only BUY trades below this point (production only copies BUYs)

    totalBuyCount++;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

    // Feed majority accumulator with this fill's USD
    if (!traderAccum.has(trade.conditionId)) traderAccum.set(trade.conditionId, new Map());
    const outcomeMap = traderAccum.get(trade.conditionId)!;
    outcomeMap.set(trade.outcome, (outcomeMap.get(trade.outcome) ?? 0) + fillUsd);

    // Resolve outcomeIndex for settlement check
    const oi = resolveOutcomeIndex(trade);
    if (oi == null) continue;

    // === PRODUCTION GUARDS ===

    // Guard 1: Min buy price
    if (trade.price < 0.40 || trade.price > 0.95) continue;
    if (fillUsd < 1) continue;

    // Guard 2: Majority gate WITH self-exclusion (matches production getMajoritySide + excludeUsd)
    {
      let totalCidVol = 0;
      let maxOutcomeVol = 0;
      let majorityOutcome = '';
      let numOutcomes = 0;
      for (const [oc, vol] of outcomeMap) {
        // Exclude current fill's USD from its own outcome (production: excludeUsd)
        const adjVol = (oc === trade.outcome) ? Math.max(0, vol - fillUsd) : vol;
        totalCidVol += adjVol;
        if (adjVol > 0) numOutcomes++;
        if (adjVol > maxOutcomeVol) { maxOutcomeVol = adjVol; majorityOutcome = oc; }
      }

      if (totalCidVol < MAJORITY_GATE) continue;
      if (numOutcomes < 2) continue;                        // both-sides requirement
      if (trade.outcome !== majorityOutcome) continue;       // skip minority side
      if (totalCidVol > 0 && maxOutcomeVol / totalCidVol < 0.50) continue;
    }

    // Guard 3: Committed side lock
    const committed = committedSides.get(trade.conditionId);
    if (committed && committed !== trade.outcome) continue;

    // Guard 4: Daily spend limit
    const day = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);
    const daySpent = dailySpend.get(day) ?? 0;
    if (daySpent >= MAX_DAILY_USD) continue;

    // Guard 5: Available capital
    const available = STARTING_CAPITAL - totalDeployed + totalPnl;
    if (available < 1) continue;

    // Sizing: based on THIS fill's USD, not total position
    let copyAmount = Math.min(fillUsd * COPY_PERCENT, MAX_TRADE_USD);

    // Per-prediction cap
    const predUsed = predDeployed.get(trade.conditionId) ?? 0;
    const predRemaining = MAX_PRED_USD - predUsed;
    if (predRemaining < 1) continue;
    if (copyAmount > predRemaining) copyAmount = predRemaining;
    if (copyAmount > available) copyAmount = available;
    const dailyRemaining = MAX_DAILY_USD - daySpent;
    if (copyAmount > dailyRemaining) copyAmount = dailyRemaining;
    if (copyAmount < 1.0) continue; // CLOB $1 minimum

    // FAK failure simulation (12%)
    if (rng() < FAK_FAILURE_RATE) continue;

    // Category-aware slippage
    let slippagePct: number;
    if (cat === '5m')       slippagePct = 0.03 + 0.05 * rng();
    else if (cat === '15m') slippagePct = 0.02 + 0.04 * rng();
    else if (cat === '1h')  slippagePct = 0.02 + 0.03 * rng();
    else                    slippagePct = 0.01 + 0.02 * rng();
    const fillPrice = Math.min(trade.price * (1 + slippagePct), 0.99);

    // Taker fee: 0.25 × (p(1-p))^2
    const shares = copyAmount / fillPrice;
    const feeShares = shares * FEE_RATE * Math.pow(fillPrice * (1 - fillPrice), FEE_EXPONENT);
    const netShares = shares - feeShares;

    // Market resolution oracle
    let outcomeWon = false;
    try {
      const prices: string[] = JSON.parse(trade.outcomePrices);
      outcomeWon = parseFloat(prices[oi] ?? '0') >= 0.95;
    } catch { continue; }

    const pnl = (outcomeWon ? netShares * 1.0 : 0) - copyAmount;

    holdTotal++;
    if (outcomeWon) holdWins++;

    totalPnl += pnl;
    totalDeployed += copyAmount;
    buyCount++;
    if (pnl > 0) wins++; else losses++;
    predDeployed.set(trade.conditionId, predUsed + copyAmount);
    if (!committed) committedSides.set(trade.conditionId, trade.outcome);
    dailySpend.set(day, daySpent + copyAmount);

    // Drawdown
    if (totalPnl > peakPnl) peakPnl = totalPnl;
    const dd = peakPnl - totalPnl;
    if (dd > maxDd) maxDd = dd;

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
  const cryptoPct = totalBuyCount > 0 ? cryptoCount / totalBuyCount * 100 : 0;

  const scalpPct = totalBuyCount > 0 ? sellCount / totalBuyCount * 100 : 0;
  const holdWr = holdTotal > 0 ? holdWins / holdTotal * 100 : 0;

  // Composite score: penalize scalpers, low sample, high DD
  const score = copyPnl > 0
    ? copyRoi * (1 - scalpPct / 100) * Math.min(buyCount / 20, 1) * (1 / (1 + copyMaxDdPct / 20))
    : -1;

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

  // Get all completed traders — count from Trade table (not ClosedPosition)
  const traders = await db.query(`
    SELECT t."proxyWallet", tr."userName", tr."leaderboardPnl",
           COUNT(*) as trade_count
    FROM "Trade" t
    JOIN "Trader" tr ON tr."proxyWallet" = t."proxyWallet"
    WHERE tr."backfillStatus" = 'COMPLETED'
    GROUP BY t."proxyWallet", tr."userName", tr."leaderboardPnl"
    HAVING COUNT(*) >= $1
    ORDER BY COUNT(*) DESC
    LIMIT $2
  `, [MIN_POSITIONS, LIMIT]);

  console.log(`Found ${traders.rows.length} traders with >= ${MIN_POSITIONS} trades`);

  const results: TraderResult[] = [];
  let processed = 0;

  for (const trader of traders.rows) {
    // Fetch individual trades with market resolution data
    const tradeResult = await db.query(`
      SELECT t."conditionId", t.outcome, t."outcomeIndex",
             t.price, t.size, t.timestamp, t.side,
             t."eventSlug",
             m."outcomePrices", m.outcomes
      FROM "Trade" t
      JOIN "Market" m ON t."conditionId" = m."conditionId"
      WHERE t."proxyWallet" = $1
        AND m.closed = true
      ORDER BY t.timestamp ASC
    `, [trader.proxyWallet]);

    const trades: TradeRow[] = tradeResult.rows.map(r => ({
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
    }));

    // Trader stats from Trade data
    const buyTrades = trades.filter(t => t.side === 'BUY');
    const traderBought = buyTrades.reduce((s, t) => s + t.size * t.price, 0);

    // Trader WR: group by conditionId, find majority outcome, check if it won
    const cidOutcomes = new Map<string, Map<string, number>>();
    // Build lookup: conditionId:outcome → first TradeRow (for resolution data)
    const cidOutcomeSample = new Map<string, TradeRow>();
    for (const t of buyTrades) {
      if (!cidOutcomes.has(t.conditionId)) cidOutcomes.set(t.conditionId, new Map());
      const m = cidOutcomes.get(t.conditionId)!;
      m.set(t.outcome, (m.get(t.outcome) ?? 0) + t.size * t.price);
      const key = `${t.conditionId}:${t.outcome}`;
      if (!cidOutcomeSample.has(key)) cidOutcomeSample.set(key, t);
    }
    let traderWinPredictions = 0, traderTotalPredictions = 0;
    for (const [cid, outcomes] of cidOutcomes) {
      let maxVol = 0, majOutcome = '';
      for (const [oc, vol] of outcomes) { if (vol > maxVol) { maxVol = vol; majOutcome = oc; } }
      const sample = cidOutcomeSample.get(`${cid}:${majOutcome}`);
      if (!sample) continue;
      const oi = resolveOutcomeIndex(sample);
      if (oi == null) continue;
      try {
        const prices: string[] = JSON.parse(sample.outcomePrices);
        const won = parseFloat(prices[oi] ?? '0') >= 0.95;
        traderTotalPredictions++;
        if (won) traderWinPredictions++;
      } catch {}
    }

    const traderPnl = parseFloat(trader.leaderboardPnl) || 0;

    // Run copy simulation
    const sim = simulateCopy(trades);

    results.push({
      wallet: trader.proxyWallet,
      name: (trader.userName || trader.proxyWallet.slice(0, 10)).slice(0, 20),
      trades: trades.length,
      traderPnl,
      traderBought,
      traderRoi: traderBought > 0 ? traderPnl / traderBought * 100 : 0,
      traderWr: traderTotalPredictions > 0 ? traderWinPredictions / traderTotalPredictions * 100 : 0,
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
  console.log(`\n${'='.repeat(200)}`);
  console.log(`BATCH BACKTEST (Trade-level) — ${results.length} traders | Per-fill sequential | Self-exclusion majority | Copy: 10%, $8/trade, $30/pred, $450 cap, fees+slippage ON, gate $${MAJORITY_GATE}`);
  console.log(`${'='.repeat(200)}\n`);

  const header =
    `${pad('Rank', 5)}${pad('Trader', 22)}${rpad('Trd', 6)}${rpad('TrROI%', 7)}${rpad('TrWR%', 7)}` +
    `${rpad('CpPnL$', 9)}${rpad('CpROI%', 8)}${rpad('HldWR%', 7)}${rpad('CpBuys', 7)}` +
    `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 8)}` +
    `${rpad('Scalp%', 7)}${rpad('Score', 8)}` +
    `${rpad('$/day', 8)}${rpad('Days', 5)}${rpad('Cry%', 5)}${pad('  Category', 12)}`;

  console.log(`PROFITABLE TRADERS (${profitable.length}):`);
  console.log(header);
  console.log('-'.repeat(200));

  for (let i = 0; i < Math.min(profitable.length, 50); i++) {
    const r = profitable[i];
    console.log(
      `${pad(String(i + 1), 5)}${pad(r.name, 22)}` +
      `${rpad(String(r.trades), 6)}${rpad(r.traderRoi.toFixed(1), 7)}${rpad(r.traderWr.toFixed(1), 7)}` +
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
