#!/usr/bin/env tsx
/**
 * Config Sweep Backtest — Find optimal copy-trade parameters per trader
 *
 * Uses INDIVIDUAL TRADES (not aggregated ClosedPositions) to match production behavior.
 * Processes fills sequentially with self-exclusion in majority gate.
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
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader FloatyBoi --trader LampStore
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --trader 0x38c6fd3ae5db...
 *   npx tsx src/scripts/batch-backtest-config-sweep.ts --exclude-slugs "" --no-capital-lockup  # old behavior
 */

import { Client } from 'pg';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    trader: { type: 'string', multiple: true },
    seed: { type: 'string', default: '42' },
    top: { type: 'string', default: '20' },
    'exclude-slugs': { type: 'string', default: 'updown-5m,updown-15m' },
    'no-empirical-slippage': { type: 'boolean', default: false },
    'no-capital-lockup': { type: 'boolean', default: false },
  },
});

const traderInputs = args.trader ?? ['FloatyBoi', 'LampStore'];
const BASE_SEED = parseInt(args.seed ?? '42', 10);
const TOP_N = parseInt(args.top ?? '20', 10);
const EXCLUDE_SLUGS = (args['exclude-slugs'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
const USE_EMPIRICAL_SLIPPAGE = !args['no-empirical-slippage'];
const USE_CAPITAL_LOCKUP = !args['no-capital-lockup'];

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
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const MIN_BUYS_FOR_RANKING = 10;
const FALLBACK_FAK_FAILURE_RATE = 0.12;
const BUY_FAILURE_COOLDOWN_SEC = 15;
const FALLBACK_LOCKUP_SEC = 7 * 24 * 60 * 60; // 7 days

// Empirical calibration (populated at startup)
interface SlippageModel { p50: number; p75: number; p90: number; }
let empiricalSlippage: SlippageModel | null = null;
let fakFailureRate = FALLBACK_FAK_FAILURE_RATE;

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
  endDate: number | null;
}

interface LockedPosition {
  deployedUsd: number;
  netShares: number;
  outcomeWon: boolean;
  resolvesAt: number;
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
    const u = rng();
    const bps = u < 0.8
      ? empiricalSlippage.p50 + (empiricalSlippage.p75 - empiricalSlippage.p50) * Math.sqrt(u / 0.8)
      : empiricalSlippage.p75 + (empiricalSlippage.p90 - empiricalSlippage.p75) * ((u - 0.8) / 0.2);
    return Math.max(0, bps / 10000);
  }
  if (cat === '5m')       return 0.03 + 0.05 * rng();
  if (cat === '15m')      return 0.02 + 0.04 * rng();
  if (cat === '1h')       return 0.02 + 0.03 * rng();
  return 0.01 + 0.02 * rng();
}

// ─── Simulation Engine (parameterized) ───
function simulateCopy(trades: TradeRow[], cfg: SimConfig): SimResult {
  const rng = mulberry32(cfg.seed);

  let buyCount = 0;
  let wins = 0, losses = 0, peakPnl = 0, maxDd = 0;
  let holdWins = 0, holdTotal = 0;
  let sellCount = 0, totalBuyCount = 0;

  // Capital lockup state
  const lockupQueue: LockedPosition[] = [];
  let lockupReleasePtr = 0;
  let currentlyLocked = 0;
  let releasedPnl = 0;

  // Instant-mode state
  let totalDeployed = 0, totalPnl = 0;

  const predDeployed = new Map<string, number>();
  const committedSides = new Map<string, string>();
  const dailyPnl = new Map<string, number>();
  const dailyDeployed = new Map<string, number>();
  const traderAccum = new Map<string, Map<string, number>>();
  const buyFailureCooldown = new Map<string, number>();

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

    if (trade.side === 'SELL') {
      sellCount++;
      // Fix 5: Net position tracking
      const predUsed = predDeployed.get(trade.conditionId) ?? 0;
      predDeployed.set(trade.conditionId, Math.max(0, predUsed - fillUsd));
      continue;
    }
    // Fix 2a: Slug exclusion BEFORE accumulator
    if (EXCLUDE_SLUGS.length > 0) {
      const slug = trade.eventSlug.toLowerCase();
      if (EXCLUDE_SLUGS.some(p => slug.includes(p))) continue;
    }

    // Count after slug exclusion so scalpPct denominators are accurate
    totalBuyCount++;

    // Feed majority accumulator (only non-excluded trades)
    if (!traderAccum.has(trade.conditionId)) traderAccum.set(trade.conditionId, new Map());
    const outcomeMap = traderAccum.get(trade.conditionId)!;
    outcomeMap.set(trade.outcome, (outcomeMap.get(trade.outcome) ?? 0) + fillUsd);

    const oi = resolveOutcomeIndex(trade);
    if (oi == null) continue;

    // Guard 1: minBuyPrice (swept)
    if (trade.price < cfg.minBuyPrice || trade.price > 0.95) continue;
    if (fillUsd < 1) continue;

    // Guard 2: Majority gate WITH self-exclusion
    if (cfg.gate > 0) {
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
      if (totalCidVol < cfg.gate) continue;
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
    let copyAmount = Math.min(fillUsd * cfg.copyPercent, cfg.maxTrade);
    const predUsed = predDeployed.get(trade.conditionId) ?? 0;
    const predRemaining = cfg.maxPred - predUsed;
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

    // Taker fee
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
      const endDateTs = trade.endDate ?? (trade.timestamp + FALLBACK_LOCKUP_SEC);
      let lo = lockupReleasePtr, hi = lockupQueue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lockupQueue[mid].resolvesAt <= endDateTs) lo = mid + 1; else hi = mid;
      }
      lockupQueue.splice(lo, 0, { deployedUsd: copyAmount, netShares, outcomeWon, resolvesAt: endDateTs });
      currentlyLocked += copyAmount;
    } else {
      const pnl = (outcomeWon ? netShares * 1.0 : 0) - copyAmount;
      holdTotal++; if (outcomeWon) holdWins++;
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
  const deployed = USE_CAPITAL_LOCKUP
    ? lockupQueue.reduce((s, p) => s + p.deployedUsd, 0)
    : totalDeployed;
  const copyRoi = deployed > 0 ? copyPnl / deployed * 100 : 0;
  const maxDdPct = STARTING_CAPITAL > 0 ? maxDd / STARTING_CAPITAL * 100 : 0;
  const holdWr = holdTotal > 0 ? holdWins / holdTotal * 100 : 0;
  const scalpPct = totalBuyCount > 0 ? sellCount / totalBuyCount * 100 : 0;

  const dailyVals = [...dailyPnl.values()];
  const winDays = dailyVals.filter(v => v > 0).length;
  const dayWr = dailyVals.length > 0 ? winDays / dailyVals.length * 100 : 0;

  // Fix 6: Sharpe on returns (PnL/deployed)
  let sharpe = 0;
  const dailyReturns: number[] = [];
  for (const [day, pnl] of dailyPnl) {
    const dep = dailyDeployed.get(day) ?? 1;
    dailyReturns.push(dep > 0 ? pnl / dep : 0);
  }
  if (dailyReturns.length > 1) {
    const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
    const variance = dailyReturns.reduce((a, v) => a + (v - mean) ** 2, 0) / (dailyReturns.length - 1);
    sharpe = variance > 0 ? mean / Math.sqrt(variance) : 0;
  }

  const samplePenalty = Math.min(1, Math.log(1 + buyCount) / Math.log(1 + 50));
  const score = (copyPnl > 0 && buyCount >= MIN_BUYS_FOR_RANKING)
    ? copyRoi * (1 - scalpPct / 100) * samplePenalty * (1 / (1 + maxDdPct / 20))
    : -1;

  return {
    config: cfg, copyPnl, copyRoi, holdWr, copyBuys: buyCount,
    maxDdPct, sharpe, dayWr, scalpPct, score, totalDeployed: deployed,
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

async function calibrateFromProduction(db: Client) {
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
        empiricalSlippage = { p50: parseFloat(row.p50), p75: parseFloat(row.p75), p90: parseFloat(row.p90) };
        console.log(`Empirical slippage: p50=${empiricalSlippage.p50.toFixed(0)}bps p75=${empiricalSlippage.p75.toFixed(0)}bps p90=${empiricalSlippage.p90.toFixed(0)}bps (n=${row.n})`);
      } else {
        console.log(`Empirical slippage: insufficient data (n=${row?.n ?? 0}), using category-based fallback`);
      }
    } catch {
      console.log(`Empirical slippage: query failed, using category-based fallback`);
    }
  }

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
      console.log(`FAK failure rate: insufficient data, using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
    }
  } catch {
    console.log(`FAK failure rate: query failed, using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
  }
}

// ─── Main ───
async function main() {
  const db = new Client({
    host: 'localhost', port: 15438, user: 'polymarket',
    password: DB_PASSWORD, database: 'polymarket_copytrade',
  });
  await db.connect();
  console.log('Connected to Hetzner DB via SSH tunnel');

  const flags: string[] = [];
  if (EXCLUDE_SLUGS.length > 0) flags.push(`slugExclude=[${EXCLUDE_SLUGS.join(',')}]`);
  if (USE_CAPITAL_LOCKUP) flags.push('capitalLockup=ON'); else flags.push('capitalLockup=OFF');
  if (USE_EMPIRICAL_SLIPPAGE) flags.push('empiricalSlippage=ON'); else flags.push('empiricalSlippage=OFF');
  console.log(`Config: ${flags.join(' ')}`);

  await calibrateFromProduction(db);
  console.log('');

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

    const tradeResult = await db.query(`
      SELECT t."conditionId", t.outcome, t."outcomeIndex",
             t.price, t.size, t.timestamp, t.side,
             t."eventSlug",
             m."outcomePrices", m.outcomes, m."endDate"
      FROM "Trade" t
      JOIN "Market" m ON t."conditionId" = m."conditionId"
      WHERE t."proxyWallet" = $1 AND m.closed = true
      ORDER BY t.timestamp ASC
    `, [wallet]);

    const trades: TradeRow[] = tradeResult.rows.map(r => ({
      conditionId: r.conditionId, outcome: r.outcome || '',
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

    // Sort once — simulateCopy will use trades in-order
    trades.sort((a, b) => a.timestamp - b.timestamp);

    const buyTrades = trades.filter(t => t.side === 'BUY');
    const traderBought = buyTrades.reduce((s, t) => s + t.size * t.price, 0);
    const cats = new Map<string, number>();
    for (const t of buyTrades) { const c = categorize(t.eventSlug); cats.set(c, (cats.get(c) ?? 0) + 1); }
    const catStr = [...cats.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join(', ');

    // Official Polymarket P&L from ClosedPosition + Position
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

    const configs = generateConfigs(BASE_SEED);
    console.log(`Sweeping ${configs.length} configs...`);
    const startMs = Date.now();

    const results: SimResult[] = [];
    for (const cfg of configs) {
      results.push(simulateCopy(trades, cfg));
    }

    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    const profitable = results.filter(r => r.score > 0);
    console.log(`  Done in ${elapsed}s — ${profitable.length}/${configs.length} profitable (>= ${MIN_BUYS_FOR_RANKING} buys)\n`);

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
          const mcResult = simulateCopy(trades, mcCfg);
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

    // Parameter sensitivity
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
