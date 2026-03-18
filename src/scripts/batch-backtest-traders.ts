#!/usr/bin/env tsx
/**
 * Batch Backtest Pipeline — Backtests ALL completed traders from DB
 *
 * Uses INDIVIDUAL TRADES (not aggregated ClosedPositions) to match production behavior.
 * Processes fills sequentially in timestamp order with self-exclusion in majority gate.
 *
 * Fidelity features:
 *   - Capital lockup: capital locked until Market.endDate (not instant PnL)
 *   - Slug exclusion: matches production allocation (default: updown-5m,updown-15m)
 *   - Empirical slippage: calibrated from CopyTrade.slippageBps (fallback: category-based)
 *   - Empirical FAK rate: calibrated from CopyTrade data + 15s cooldown
 *   - Net position tracking: SELL decrements predDeployed (allows re-entry)
 *   - Sharpe on returns: PnL/deployed, not raw dollar PnL
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 hetzner_finland_dockerapps
 *   npx tsx src/scripts/batch-backtest-traders.ts [--limit N] [--min-positions 20] [--gate 175]
 *   npx tsx src/scripts/batch-backtest-traders.ts --exclude-slugs "" --min-buy-price 0.40 --no-capital-lockup  # reproduce old
 */

import { Client } from 'pg';
import { parseArgs } from 'util';
import { writeFileSync } from 'fs';

const { values: args } = parseArgs({
  options: {
    limit: { type: 'string', default: '1000' },
    'min-positions': { type: 'string', default: '20' },
    gate: { type: 'string', default: '175' },
    'min-buy-price': { type: 'string', default: '0.60' },
    'exclude-slugs': { type: 'string', default: 'updown-5m,updown-15m' },
    'no-empirical-slippage': { type: 'boolean', default: false },
    'no-capital-lockup': { type: 'boolean', default: false },
    'min-trader-roi': { type: 'string', default: '0' },
    'min-copy-buys': { type: 'string', default: '10' },
    output: { type: 'string', default: '' },
  },
});

const LIMIT = parseInt(args.limit ?? '1000', 10);
const MIN_POSITIONS = parseInt(args['min-positions'] ?? '20', 10);
const MAJORITY_GATE = parseInt(args.gate ?? '175', 10);
const MIN_BUY_PRICE = parseFloat(args['min-buy-price'] ?? '0.60');
const EXCLUDE_SLUGS = (args['exclude-slugs'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const USE_EMPIRICAL_SLIPPAGE = !args['no-empirical-slippage'];
const USE_CAPITAL_LOCKUP = !args['no-capital-lockup'];
const MIN_TRADER_ROI = parseFloat(args['min-trader-roi'] ?? '0');
const MIN_COPY_BUYS = parseInt(args['min-copy-buys'] ?? '10', 10);
const OUTPUT_FILE = args.output ?? '';

// Copy-trade simulation constants
const COPY_PERCENT = 0.10;
const MAX_TRADE_USD = 8;
const MAX_PRED_USD = 30;
const STARTING_CAPITAL = 450;
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const FALLBACK_FAK_FAILURE_RATE = 0.12;
const BUY_FAILURE_COOLDOWN_SEC = 15;
const FALLBACK_LOCKUP_SEC = 7 * 24 * 60 * 60; // 7 days for markets missing endDate

// Seeded PRNG
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// Empirical calibration data (populated at startup)
interface SlippageModel { p50: number; p75: number; p90: number; }
let empiricalSlippage: SlippageModel | null = null;
let fakFailureRate = FALLBACK_FAK_FAILURE_RATE;

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
  endDate: number | null;  // market resolution timestamp (unix seconds)
}

interface LockedPosition {
  deployedUsd: number;
  netShares: number;
  outcomeWon: boolean;
  resolvesAt: number;
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

function computeSlippage(cat: string, rng: () => number): number {
  if (empiricalSlippage) {
    // Empirical: right-skewed triangular distribution from production data
    const u = rng();
    const bps = u < 0.8
      ? empiricalSlippage.p50 + (empiricalSlippage.p75 - empiricalSlippage.p50) * Math.sqrt(u / 0.8)
      : empiricalSlippage.p75 + (empiricalSlippage.p90 - empiricalSlippage.p75) * ((u - 0.8) / 0.2);
    return Math.max(0, bps / 10000);
  }
  // Fallback: category-based uniform
  if (cat === '5m')       return 0.03 + 0.05 * rng();
  if (cat === '15m')      return 0.02 + 0.04 * rng();
  if (cat === '1h')       return 0.02 + 0.03 * rng();
  return 0.01 + 0.02 * rng();
}

interface TraderResult {
  wallet: string;
  name: string;
  trades: number;
  traderPnl: number;
  traderBought: number;
  traderRoi: number;
  traderWr: number;
  copyPnl: number;
  copyDeployed: number;
  copyRoi: number;
  copyWr: number;
  copyBuys: number;
  copyMaxDd: number;
  copyMaxDdPct: number;
  copySharpe: number;
  winDays: number;
  lossDays: number;
  dayWr: number;
  maxWinStreak: number;
  maxLossStreak: number;
  mainCategory: string;
  cryptoPct: number;
  pnlPerDay: number;
  daysActive: number;
  scalpPct: number;
  holdWr: number;
  score: number;
}

function simulateCopy(trades: TradeRow[]): Omit<TraderResult, 'wallet' | 'name' | 'trades' | 'traderPnl' | 'traderBought' | 'traderRoi' | 'traderWr'> {
  const rng = mulberry32(42);

  trades.sort((a, b) => a.timestamp - b.timestamp);

  let buyCount = 0;
  let wins = 0, losses = 0;
  let peakPnl = 0;
  let maxDd = 0;

  // Capital lockup state
  const lockupQueue: LockedPosition[] = [];
  let lockupReleasePtr = 0;
  let currentlyLocked = 0;
  let releasedPnl = 0;

  // Instant-mode state (when capital lockup disabled)
  let totalDeployed = 0;
  let totalPnl = 0;

  const predDeployed = new Map<string, number>();
  const committedSides = new Map<string, string>();
  const dailyPnl = new Map<string, number>();
  const dailyDeployed = new Map<string, number>();
  const catCounts = new Map<string, number>();

  let sellCount = 0, totalBuyCount = 0;
  let holdWins = 0, holdTotal = 0;

  const traderAccum = new Map<string, Map<string, number>>();
  const buyFailureCooldown = new Map<string, number>();

  // Helper: release matured lockup positions
  function releaseMatured(currentTs: number) {
    while (lockupReleasePtr < lockupQueue.length
           && currentTs >= lockupQueue[lockupReleasePtr].resolvesAt) {
      const pos = lockupQueue[lockupReleasePtr++];
      const pnl = (pos.outcomeWon ? pos.netShares : 0) - pos.deployedUsd;
      releasedPnl += pnl;
      currentlyLocked -= pos.deployedUsd;
      const resolveDay = new Date(pos.resolvesAt * 1000).toISOString().slice(0, 10);
      dailyPnl.set(resolveDay, (dailyPnl.get(resolveDay) ?? 0) + pnl);
      dailyDeployed.set(resolveDay, (dailyDeployed.get(resolveDay) ?? 0) + pos.deployedUsd);
      holdTotal++; if (pos.outcomeWon) holdWins++;
      if (pnl > 0) wins++; else losses++;
      if (releasedPnl > peakPnl) peakPnl = releasedPnl;
      const dd = peakPnl - releasedPnl;
      if (dd > maxDd) maxDd = dd;
    }
  }

  for (const trade of trades) {
    const cat = categorize(trade.eventSlug);
    const fillUsd = trade.size * trade.price;

    // Track SELLs for scalp detection + net pred tracking
    if (trade.side === 'SELL') {
      sellCount++;
      // Fix 5: Reduce predDeployed for re-entry allowance (matches production getNetPositionUsd)
      const predUsed = predDeployed.get(trade.conditionId) ?? 0;
      const sellUsd = trade.size * trade.price;
      predDeployed.set(trade.conditionId, Math.max(0, predUsed - sellUsd));
      continue;
    }
    // Only BUY trades below this point

    // Fix 2a: Slug exclusion BEFORE accumulator (production: excludeEventSlugPatterns)
    if (EXCLUDE_SLUGS.length > 0) {
      const slug = trade.eventSlug.toLowerCase();
      if (EXCLUDE_SLUGS.some(p => slug.includes(p))) continue;
    }

    // Count after slug exclusion so scalpPct/cryptoPct denominators are accurate
    totalBuyCount++;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

    // Feed majority accumulator (only non-excluded trades reach here)
    if (!traderAccum.has(trade.conditionId)) traderAccum.set(trade.conditionId, new Map());
    const outcomeMap = traderAccum.get(trade.conditionId)!;
    outcomeMap.set(trade.outcome, (outcomeMap.get(trade.outcome) ?? 0) + fillUsd);

    const oi = resolveOutcomeIndex(trade);
    if (oi == null) continue;

    // === PRODUCTION GUARDS ===

    // Guard 1: Min buy price (Fix 2b: parameterized, default 0.60)
    if (trade.price < MIN_BUY_PRICE || trade.price > 0.95) continue;
    if (fillUsd < 1) continue;

    // Guard 2: Majority gate WITH self-exclusion
    {
      let totalCidVol = 0;
      let maxOutcomeVol = 0;
      let majorityOutcome = '';
      let numOutcomes = 0;
      for (const [oc, vol] of outcomeMap) {
        const adjVol = (oc === trade.outcome) ? Math.max(0, vol - fillUsd) : vol;
        totalCidVol += adjVol;
        if (adjVol > 0) numOutcomes++;
        if (adjVol > maxOutcomeVol) { maxOutcomeVol = adjVol; majorityOutcome = oc; }
      }

      if (totalCidVol < MAJORITY_GATE) continue;
      if (numOutcomes < 2) continue;
      if (trade.outcome !== majorityOutcome) continue;
      if (totalCidVol > 0 && maxOutcomeVol / totalCidVol < 0.50) continue;
    }

    // Guard 3: Committed side lock
    const committed = committedSides.get(trade.conditionId);
    if (committed && committed !== trade.outcome) continue;

    const day = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);

    // Guard 4: Available capital
    let available: number;
    if (USE_CAPITAL_LOCKUP) {
      releaseMatured(trade.timestamp);
      available = STARTING_CAPITAL - currentlyLocked + releasedPnl;
    } else {
      available = STARTING_CAPITAL - totalDeployed + totalPnl;
    }
    if (available < 1) continue;

    // Sizing
    let copyAmount = Math.min(fillUsd * COPY_PERCENT, MAX_TRADE_USD);

    const predUsed = predDeployed.get(trade.conditionId) ?? 0;
    const predRemaining = MAX_PRED_USD - predUsed;
    if (predRemaining < 1) continue;
    if (copyAmount > predRemaining) copyAmount = predRemaining;
    if (copyAmount > available) copyAmount = available;
    if (copyAmount < 1.0) continue;

    // Fix 4: FAK failure with cooldown
    const cooldownExpiry = buyFailureCooldown.get(trade.conditionId);
    if (cooldownExpiry && trade.timestamp < cooldownExpiry) continue;
    if (rng() < fakFailureRate) {
      buyFailureCooldown.set(trade.conditionId, trade.timestamp + BUY_FAILURE_COOLDOWN_SEC);
      continue;
    }

    // Fix 3: Empirical or category-based slippage
    const slippagePct = computeSlippage(cat, rng);
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

    // Track results
    predDeployed.set(trade.conditionId, predUsed + copyAmount);
    if (!committed) committedSides.set(trade.conditionId, trade.outcome);
    buyCount++;

    if (USE_CAPITAL_LOCKUP) {
      // Fix 1: Push to lockup queue — PnL credited at resolution, not now
      const endDateTs = trade.endDate ?? (trade.timestamp + FALLBACK_LOCKUP_SEC);

      // Binary insert to maintain sorted order by resolvesAt
      let lo = lockupReleasePtr, hi = lockupQueue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lockupQueue[mid].resolvesAt <= endDateTs) lo = mid + 1; else hi = mid;
      }
      lockupQueue.splice(lo, 0, { deployedUsd: copyAmount, netShares, outcomeWon, resolvesAt: endDateTs });
      currentlyLocked += copyAmount;
    } else {
      // Instant PnL mode (old behavior)
      const pnl = (outcomeWon ? netShares * 1.0 : 0) - copyAmount;
      holdTotal++;
      if (outcomeWon) holdWins++;
      totalPnl += pnl;
      totalDeployed += copyAmount;
      if (pnl > 0) wins++; else losses++;
      if (totalPnl > peakPnl) peakPnl = totalPnl;
      const dd = peakPnl - totalPnl;
      if (dd > maxDd) maxDd = dd;
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
      dailyDeployed.set(day, (dailyDeployed.get(day) ?? 0) + copyAmount);
    }
  }

  // Flush remaining locked positions
  if (USE_CAPITAL_LOCKUP) {
    for (let i = lockupReleasePtr; i < lockupQueue.length; i++) {
      const pos = lockupQueue[i];
      const pnl = (pos.outcomeWon ? pos.netShares : 0) - pos.deployedUsd;
      releasedPnl += pnl;
      const resolveDay = new Date(pos.resolvesAt * 1000).toISOString().slice(0, 10);
      dailyPnl.set(resolveDay, (dailyPnl.get(resolveDay) ?? 0) + pnl);
      dailyDeployed.set(resolveDay, (dailyDeployed.get(resolveDay) ?? 0) + pos.deployedUsd);
      holdTotal++; if (pos.outcomeWon) holdWins++;
      if (pnl > 0) wins++; else losses++;
      if (releasedPnl > peakPnl) peakPnl = releasedPnl;
      const dd = peakPnl - releasedPnl;
      if (dd > maxDd) maxDd = dd;
    }
  }

  const copyPnl = USE_CAPITAL_LOCKUP ? releasedPnl : totalPnl;
  const copyDeployed = USE_CAPITAL_LOCKUP
    ? lockupQueue.reduce((s, p) => s + p.deployedUsd, 0)
    : totalDeployed;
  const copyRoi = copyDeployed > 0 ? copyPnl / copyDeployed * 100 : 0;
  const copyWr = (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;
  const copyMaxDdPct = STARTING_CAPITAL > 0 ? maxDd / STARTING_CAPITAL * 100 : 0;

  // Daily consistency
  const dailyVals = [...dailyPnl.values()];
  const winDays = dailyVals.filter(v => v > 0).length;
  const lossDays = dailyVals.filter(v => v <= 0).length;
  const dayWr = dailyVals.length > 0 ? winDays / dailyVals.length * 100 : 0;

  // Fix 6: Sharpe on returns (PnL/deployed), not raw dollar PnL
  let sharpe = 0;
  const dailyReturns: number[] = [];
  for (const [day, pnl] of dailyPnl) {
    const deployed = dailyDeployed.get(day) ?? 1;
    dailyReturns.push(deployed > 0 ? pnl / deployed : 0);
  }
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
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

  // Calendar day span for $/day (first activity to last resolution)
  const allDays = [...dailyPnl.keys()].sort();
  const calendarDays = allDays.length > 0
    ? Math.max(1, Math.round((new Date(allDays[allDays.length - 1]).getTime() - new Date(allDays[0]).getTime()) / (24 * 60 * 60 * 1000)) + 1)
    : 0;

  // Logarithmic sample-size penalty: reaches 1.0 at ~50 copied buys
  const samplePenalty = Math.min(1, Math.log(1 + buyCount) / Math.log(1 + 50));
  const score = copyPnl > 0
    ? copyRoi * (1 - scalpPct / 100) * samplePenalty * (1 / (1 + copyMaxDdPct / 20))
    : -1;

  return {
    copyPnl, copyDeployed, copyRoi, copyWr, copyBuys: buyCount,
    copyMaxDd: maxDd, copyMaxDdPct, copySharpe: sharpe,
    winDays, lossDays, dayWr, maxWinStreak, maxLossStreak,
    mainCategory: mainCat, cryptoPct,
    pnlPerDay: calendarDays > 0 ? copyPnl / calendarDays : 0,
    daysActive: calendarDays,
    scalpPct, holdWr, score,
  };
}

async function calibrateFromProduction(db: Client) {
  // Empirical slippage distribution
  if (USE_EMPIRICAL_SLIPPAGE) {
    try {
      const res = await db.query(`
        SELECT COUNT(*) as n,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY "slippageBps") as p50,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "slippageBps") as p75,
          PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY "slippageBps") as p90
        FROM "CopyTrade"
        WHERE status = 'FILLED' AND "slippageBps" IS NOT NULL AND "slippageBps" >= 0 AND side = 'BUY'
      `);
      const row = res.rows[0];
      if (row && parseInt(row.n) >= 50) {
        empiricalSlippage = {
          p50: parseFloat(row.p50),
          p75: parseFloat(row.p75),
          p90: parseFloat(row.p90),
        };
        console.log(`Empirical slippage: p50=${empiricalSlippage.p50.toFixed(0)}bps p75=${empiricalSlippage.p75.toFixed(0)}bps p90=${empiricalSlippage.p90.toFixed(0)}bps (n=${row.n})`);
      } else {
        console.log(`Empirical slippage: insufficient data (n=${row?.n ?? 0}), using category-based fallback`);
      }
    } catch (e) {
      console.log(`Empirical slippage: query failed, using category-based fallback`);
    }
  }

  // Empirical FAK failure rate
  try {
    const res = await db.query(`
      SELECT COUNT(CASE WHEN status='FILLED' THEN 1 END)::float / NULLIF(COUNT(*), 0) as fill_rate,
             COUNT(*) as total
      FROM "CopyTrade" WHERE "executionMethod" = 'FAK'
    `);
    const row = res.rows[0];
    if (row && parseInt(row.total) >= 50 && row.fill_rate != null) {
      fakFailureRate = 1 - parseFloat(row.fill_rate);
      console.log(`FAK failure rate: ${(fakFailureRate * 100).toFixed(1)}% (empirical from ${row.total} attempts) + ${BUY_FAILURE_COOLDOWN_SEC}s cooldown`);
    } else {
      console.log(`FAK failure rate: insufficient data (n=${row?.total ?? 0}), using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
    }
  } catch {
    console.log(`FAK failure rate: query failed, using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
  }
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

  // Log config
  const flags: string[] = [];
  if (EXCLUDE_SLUGS.length > 0) flags.push(`slugExclude=[${EXCLUDE_SLUGS.join(',')}]`);
  if (USE_CAPITAL_LOCKUP) flags.push('capitalLockup=ON'); else flags.push('capitalLockup=OFF');
  if (USE_EMPIRICAL_SLIPPAGE) flags.push('empiricalSlippage=ON'); else flags.push('empiricalSlippage=OFF');
  console.log(`Config: minBuyPrice=${MIN_BUY_PRICE} gate=$${MAJORITY_GATE} ${flags.join(' ')}`);

  // Calibrate from production data
  await calibrateFromProduction(db);

  // Get all completed traders
  const traders = await db.query(`
    SELECT t."proxyWallet", tr."userName",
           COUNT(*) as trade_count
    FROM "Trade" t
    JOIN "Trader" tr ON tr."proxyWallet" = t."proxyWallet"
    WHERE tr."backfillStatus" = 'COMPLETED'
    GROUP BY t."proxyWallet", tr."userName"
    HAVING COUNT(*) >= $1
    ORDER BY COUNT(*) DESC
    LIMIT $2
  `, [MIN_POSITIONS, LIMIT]);

  console.log(`Found ${traders.rows.length} traders with >= ${MIN_POSITIONS} trades`);

  // Batch fetch official Polymarket P&L from ClosedPosition + Position tables
  const wallets = traders.rows.map((r: any) => r.proxyWallet);
  console.log('Fetching official Polymarket P&L from ClosedPosition + Position tables...');

  const closedPnlResult = await db.query(`
    SELECT "proxyWallet",
           COALESCE(SUM("realizedPnl"), 0) as realized_pnl,
           COALESCE(SUM("totalBought"), 0) as total_bought,
           COUNT(*) as num_positions,
           COUNT(CASE WHEN "realizedPnl" > 0 THEN 1 END) as wins
    FROM "ClosedPosition"
    WHERE "proxyWallet" = ANY($1::text[])
    GROUP BY "proxyWallet"
  `, [wallets]);

  const openPnlResult = await db.query(`
    SELECT "proxyWallet",
           COALESCE(SUM("cashPnl"), 0) as unrealized_pnl,
           COALESCE(SUM("initialValue"), 0) as open_capital
    FROM "Position"
    WHERE "proxyWallet" = ANY($1::text[])
    GROUP BY "proxyWallet"
  `, [wallets]);

  const closedPnlMap = new Map<string, any>(
    closedPnlResult.rows.map((r: any) => [r.proxyWallet, r])
  );
  const openPnlMap = new Map<string, any>(
    openPnlResult.rows.map((r: any) => [r.proxyWallet, r])
  );

  const cappedTraders = closedPnlResult.rows.filter((r: any) => parseInt(r.num_positions) >= 10000);
  if (cappedTraders.length > 0) {
    console.log(`WARNING: ${cappedTraders.length} traders hit 10K ClosedPosition cap — realized PnL may be incomplete`);
  }
  console.log(`Loaded P&L for ${closedPnlResult.rows.length} traders (closed) + ${openPnlResult.rows.length} (open positions)`);

  const results: TraderResult[] = [];
  let processed = 0;

  for (const trader of traders.rows) {
    const tradeResult = await db.query(`
      SELECT t."conditionId", t.outcome, t."outcomeIndex",
             t.price, t.size, t.timestamp, t.side,
             t."eventSlug",
             m."outcomePrices", m.outcomes, m."endDate"
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
      endDate: r.endDate ? Math.floor(new Date(r.endDate).getTime() / 1000) : null,
    }));

    // Trader stats from Trade data
    const buyTrades = trades.filter(t => t.side === 'BUY');
    const traderBought = buyTrades.reduce((s, t) => s + t.size * t.price, 0);

    // Official Polymarket P&L from ClosedPosition + Position (batch-fetched above)
    const closedData = closedPnlMap.get(trader.proxyWallet);
    const openData = openPnlMap.get(trader.proxyWallet);
    const realizedPnl = parseFloat(closedData?.realized_pnl ?? '0');
    const unrealizedPnl = parseFloat(openData?.unrealized_pnl ?? '0');
    const totalTraderCapital = parseFloat(closedData?.total_bought ?? '0')
                             + parseFloat(openData?.open_capital ?? '0');
    const actualTraderPnl = realizedPnl + unrealizedPnl;
    const actualTraderRoi = totalTraderCapital > 0
      ? actualTraderPnl / totalTraderCapital * 100 : 0;
    const numPositions = parseInt(closedData?.num_positions ?? '0');
    const traderWins = parseInt(closedData?.wins ?? '0');
    const traderWr = numPositions > 0 ? traderWins / numPositions * 100 : 0;

    const sim = simulateCopy(trades);

    results.push({
      wallet: trader.proxyWallet,
      name: (trader.userName || trader.proxyWallet.slice(0, 10)).slice(0, 20),
      trades: trades.length,
      traderPnl: actualTraderPnl,
      traderBought,
      traderRoi: actualTraderRoi,
      traderWr,
      ...sim,
    });

    processed++;
    if (processed % 50 === 0) console.log(`  Processed ${processed}/${traders.rows.length}...`);
  }

  await db.end();

  const allCopyPositive = results.filter(r => r.copyPnl > 0);
  const filteredOutByTraderRoi = allCopyPositive.filter(r => r.traderRoi < MIN_TRADER_ROI);
  const filteredOutByMinBuys = allCopyPositive.filter(r => r.traderRoi >= MIN_TRADER_ROI && r.copyBuys < MIN_COPY_BUYS);
  const profitable = allCopyPositive
    .filter(r => r.traderRoi >= MIN_TRADER_ROI)
    .filter(r => r.copyBuys >= MIN_COPY_BUYS);
  const unprofitable = results.filter(r => r.copyPnl <= 0);
  profitable.sort((a, b) => b.score - a.score);
  unprofitable.sort((a, b) => b.copyPnl - a.copyPnl);

  const pad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
  const rpad = (s: string, n: number) => s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;

  const lockupLabel = USE_CAPITAL_LOCKUP ? 'lockup ON' : 'lockup OFF';
  const slippageLabel = empiricalSlippage ? 'empirical slippage' : 'category slippage';
  console.log(`\n${'='.repeat(200)}`);
  console.log(`BATCH BACKTEST (Trade-level) — ${results.length} traders | ${lockupLabel} | ${slippageLabel} | FAK=${(fakFailureRate*100).toFixed(0)}%+${BUY_FAILURE_COOLDOWN_SEC}s cd | Copy: 10%, $8/trade, $30/pred, $450 cap, minBuy=$${MIN_BUY_PRICE} gate=$${MAJORITY_GATE} | minTraderROI=${MIN_TRADER_ROI}% minCpBuys=${MIN_COPY_BUYS} | PnL=ClosedPosition+Position | slugExclude=[${EXCLUDE_SLUGS.join(',')}]`);
  console.log(`${'='.repeat(200)}\n`);

  const header =
    `${pad('Rank', 5)}${pad('Trader', 22)}${rpad('Trd', 6)}${rpad('TrROI%', 7)}${rpad('TrWR%', 7)}${rpad('ActPnL$', 11)}` +
    `${rpad('CpPnL$', 9)}${rpad('CpROI%', 8)}${rpad('HldWR%', 7)}${rpad('CpBuys', 7)}` +
    `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 8)}` +
    `${rpad('Scalp%', 7)}${rpad('Score', 8)}` +
    `${rpad('$/day', 8)}${rpad('Days', 5)}${rpad('Cry%', 5)}${pad('  Category', 12)}`;

  console.log(`PROFITABLE TRADERS (${profitable.length}):`);
  console.log(header);
  console.log('-'.repeat(200));

  for (let i = 0; i < Math.min(profitable.length, 50); i++) {
    const r = profitable[i];
    const actPnlStr = (r.traderPnl >= 0 ? '+$' : '-$') + Math.abs(r.traderPnl).toFixed(0);
    console.log(
      `${pad(String(i + 1), 5)}${pad(r.name, 22)}` +
      `${rpad(String(r.trades), 6)}${rpad(r.traderRoi.toFixed(1), 7)}${rpad(r.traderWr.toFixed(1), 7)}${rpad(actPnlStr, 11)}` +
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
  console.log(`Profitable (copyPnL>0, traderROI>=${MIN_TRADER_ROI}%, copyBuys>=${MIN_COPY_BUYS}): ${profitable.length} (${(profitable.length / results.length * 100).toFixed(1)}%)`);
  if (filteredOutByTraderRoi.length > 0) {
    console.log(`Filtered out (copyPnL>0 but traderROI<${MIN_TRADER_ROI}%): ${filteredOutByTraderRoi.length} traders`);
  }
  if (filteredOutByMinBuys.length > 0) {
    console.log(`Filtered out (copyPnL>0 but copyBuys<${MIN_COPY_BUYS}): ${filteredOutByMinBuys.length} traders`);
  }
  console.log(`Unprofitable: ${unprofitable.length}`);
  console.log(`Profitable crypto traders: ${cryptoProfitable.length}`);
  console.log(`\nTop 5 by composite score:`);
  for (const r of profitable.slice(0, 5)) {
    console.log(`  ${r.name}: Score=${r.score.toFixed(2)} | CopyPnL=$${r.copyPnl.toFixed(0)} | ActPnL=$${r.traderPnl.toFixed(0)} | HoldWR=${r.holdWr.toFixed(1)}% | ${r.mainCategory}`);
  }

  // CSV output
  if (OUTPUT_FILE) {
    const csvHeaders = [
      'rank','name','wallet','trades','actualPnl','actualRoi','traderWr',
      'copyPnl','copyRoi','holdWr','copyBuys','maxDdPct','sharpe','dayWr',
      'scalpPct','score','pnlPerDay','daysActive','cryptoPct','category'
    ];
    const allSorted = [...profitable, ...unprofitable];
    const csvRows = allSorted.map((r, i) => [
      i + 1, `"${r.name}"`, r.wallet, r.trades,
      r.traderPnl.toFixed(2), r.traderRoi.toFixed(2), r.traderWr.toFixed(1),
      r.copyPnl.toFixed(2), r.copyRoi.toFixed(1), r.holdWr.toFixed(1),
      r.copyBuys, r.copyMaxDdPct.toFixed(1), r.copySharpe.toFixed(2), r.dayWr.toFixed(0),
      r.scalpPct.toFixed(0), r.score.toFixed(2), r.pnlPerDay.toFixed(2),
      r.daysActive, r.cryptoPct.toFixed(0), r.mainCategory
    ].join(','));
    writeFileSync(OUTPUT_FILE, [csvHeaders.join(','), ...csvRows].join('\n'));
    console.log(`\nResults saved to ${OUTPUT_FILE}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
