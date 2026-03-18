#!/usr/bin/env tsx
/**
 * Production-Faithful Backtest — 18 Discrepancy Fixes + 7 Strategy Variants
 *
 * Based on _bt-final-compilation.ts but with ALL production-faithful corrections:
 *   1. Starting capital $450 (not $150)
 *   2. Seeded PRNG (mulberry32) for reproducible results
 *   3. Slippage + fee simulation (FAK failure, GTC recovery, taker fees)
 *   4. Self-exclusion in MajorityAccumulator + numOutcomes tracking
 *   5. Both-sides requirement (numOutcomes >= 2)
 *   6. Signal source filter (CHAIN / CHAIN_MAKER only)
 *   7. LIVE_SELL_DISABLED = true (sells skipped as in production)
 *   8. POOL_MIN_AMOUNT_USD = 1.0 (not 0.50)
 *   9. HEDGE_ENABLED = true
 *  10. MAX_DAILY_LOSS_USD = 200 (not effectively disabled)
 *  11. MAJORITY_MIN_USD = 175
 *  12. Skip reason tracking for all filters
 *  13. Config sweep with fee/slippage toggles
 *  14. Monte Carlo with multiple seeds
 *  15. Detection source routing (SKIP_CHAIN_MAKER_FILLS + copyMakerFills)
 *  16. BUY failure cooldown (15s per-token after FAK failure)
 *  17. (already implemented) CLOB $1 minimum two-tier routing
 *  18. NOTE: Production pre-seeds ALL batch BUYs into accumulator before phaseA
 *      (copy-trader.ts:1387-1395). This backtest records sequentially — trade N only
 *      sees trades 1..N. Difference is marginal for $175 gate but documented here.
 *  19. Stale trade cutoff (10-min drain query window via detectedAt)
 *
 * Output sections:
 *   1. Summary table (sorted by PnL)
 *   2. Daily PnL grid (dynamic date range)
 *   3. Skip reason breakdown
 *   4. Monte Carlo results (PROD_FAITHFUL only)
 *   5. Data quality report
 *
 * Usage: npx tsx src/scripts/backtest-production-faithful.ts [--verbose] [--seed N]
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parseArgs } from 'util';

// ─── CLI Args ───
const { values: cliArgs } = parseArgs({
  options: {
    verbose: { type: 'boolean', default: false },
    seed: { type: 'string', default: '42' },
  },
});

const VERBOSE = cliArgs.verbose ?? false;
const BASE_SEED = parseInt(cliArgs.seed ?? '42', 10);

// ─── Seeded PRNG (mulberry32) ───
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── Strategy Types ───
// MAJORITY_GATE: Current production behavior — only buy when majority confirmed
// BOTH_SIDES: No majority gate — buy every signal that passes price/slug filters
// SWITCH_SELL: Track majority — when it flips, SELL current + BUY new side
// SWITCH_HEDGE: Track majority — when it flips, BUY other side to cover loss (no sell)
// EARLY_BIRD: Copy first N trades per prediction, no majority gate, low min price
// MIRROR: Copy ALL buys exactly (both sides, all prices, proportional sizing)
// HIGH_CONV: Only copy when majority ratio exceeds threshold (e.g., >70%)
type Strategy = 'MAJORITY_GATE' | 'BOTH_SIDES' | 'SWITCH_SELL' | 'SWITCH_HEDGE'
  | 'EARLY_BIRD' | 'MIRROR' | 'HIGH_CONV';

// ─── Config Definitions ───
interface RunConfig {
  name: string;
  gate: number;       // USD volume gate threshold
  maxTrade: number;   // MAX_POSITION_USD (per-trade cap)
  maxPred: number;    // MAX_PREDICTION_POSITION_USD (per-prediction cap)
  fees: boolean;      // enable taker fee simulation
  slippage: boolean;  // enable slippage + FAK failure simulation
  strategy: Strategy;
  switchThreshold?: number;  // majority ratio to trigger switch (for SWITCH/HIGH_CONV)
  minBuyPrice?: number;        // override global MIN_BUY_PRICE (default 0.60)
  maxFirstBuys?: number;       // EARLY_BIRD: max BUY trades per conditionId
  sizeMode?: 'fixed' | 'proportional';  // proportional = use per-trade USD, not majority aggregate
  assetFilter?: string[];      // only trade these assets (slug/title substring match)
}

const CONFIGS: RunConfig[] = [
  // Baseline — current production behavior
  { name: "PROD_FAITHFUL", gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE' },

  // A) EARLY_BIRD — Copy first N trades per prediction, no majority gate
  { name: "EARLY_5",   gate: 0, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'EARLY_BIRD', minBuyPrice: 0.30, maxFirstBuys: 5 },
  { name: "EARLY_10",  gate: 0, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'EARLY_BIRD', minBuyPrice: 0.30, maxFirstBuys: 10 },

  // B) LOW_PRICE — Same majority gate but lower price floor
  { name: "LOWPX_40",  gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.40 },
  { name: "LOWPX_50",  gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.50 },

  // C) MIRROR — Copy ALL buys, both sides, proportional sizing
  { name: "MIRROR",    gate: 0, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MIRROR', minBuyPrice: 0.01, sizeMode: 'proportional' },

  // D) HIGH_CONV — Only copy when majority ratio >70%
  { name: "CONV_70",   gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'HIGH_CONV', switchThreshold: 0.70, minBuyPrice: 0.40 },

  // E) BEST_ASSET — Only BTC predictions
  { name: "BTC_ONLY",  gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.40, assetFilter: ['btc', 'bitcoin'] },

  // F) SIZE_FOLLOW — Proportional to trader's per-trade size
  { name: "SZ_FOLLOW", gate: 175, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.40, sizeMode: 'proportional' },

  // G) GATE_LOWER — Lower majority gate to enter earlier
  { name: "GATE_50",   gate: 50,  maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.40 },
  { name: "GATE_100",  gate: 100, maxTrade: 8, maxPred: 30, fees: true, slippage: true, strategy: 'MAJORITY_GATE', minBuyPrice: 0.40 },
];

// ─── Shared Constants ───
const STARTING_CAPITAL = 450;
const MAJORITY_MIN_RATIO = 0.50;
const COMMITTED_SIDE_LOCK = true;
const MIN_BUY_PRICE = 0.60;
const COPY_TRADE_PERCENT = 0.10;
const MAX_TRADE_PERCENT = 0.50;
const TOKEN_SELL_COOLDOWN_MS = 60000;
const CLOB_MIN_ORDER_USD = 1.0;
const EXCLUDE_SLUG_PATTERNS = ['updown-5m', 'updown-15m'];
const POOL_MIN_AMOUNT_USD = 1.0;
const POOL_BURN_TIMEOUT_MS = 180000;
const MAX_DAILY_LOSS_USD = 200;
const LIVE_SELL_DISABLED = true;

// Hedge guard ENABLED
const HEDGE_ENABLED = true;
const HEDGE_PRICE_RATIO = 0.25;
const HEDGE_NAKED_MAX_PRICE = 0.10;
const HEDGE_MIN_OPPOSITE_USD = 5;
const HEDGE_MAX_RATIO = 0.20;

// Quality gates (disabled)
const MIN_COMPOSITE_SCORE = 0;
const MIN_SIGNAL_TRADE_USD = 0;

// D15: Detection source routing (matches .env.prod SKIP_CHAIN_MAKER_FILLS=true)
const SKIP_CHAIN_MAKER_FILLS = true;
const COPY_MAKER_FILLS = true;  // matches 0x8dxd allocation copyMakerFills=true

// D16: BUY failure cooldown (matches copy-trader.ts:449 isInBuyFailureCooldown)
const BUY_FAILURE_COOLDOWN_MS = 15000;

// D19: Stale trade cutoff (matches copy-trader.ts:1214 STALE_TRADE_CUTOFF_MS)
const STALE_TRADE_CUTOFF_MS = 600000;  // 10 min

// ─── Slippage + Fee Constants ───
const SLIPPAGE_UPSIDE_FRACTION = 0.05;
const SLIPPAGE_MIN_ABSOLUTE = 0.01;
const FAK_FAILURE_RATE = 0.12;
const GTC_RECOVERY_RATE = 0.50;
const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;

// ─── Slippage + Fee Simulation ───
function simulateFill(
  signalPrice: number,
  sizeUsd: number,
  rng: () => number,
  feesEnabled: boolean,
  slippageEnabled: boolean,
): { filled: boolean; fillPrice: number; netShares: number } {
  // FAK failure
  if (slippageEnabled && rng() < FAK_FAILURE_RATE) {
    if (rng() < GTC_RECOVERY_RATE) {
      // GTC recovery at signal price, 0% fee (maker)
      return { filled: true, fillPrice: signalPrice, netShares: sizeUsd / signalPrice };
    }
    return { filled: false, fillPrice: 0, netShares: 0 };
  }
  // Slippage
  let fillPrice = signalPrice;
  if (slippageEnabled) {
    const maxSlip = Math.max((1 - signalPrice) * SLIPPAGE_UPSIDE_FRACTION, SLIPPAGE_MIN_ABSOLUTE);
    fillPrice = Math.min(signalPrice + maxSlip * rng(), 0.99);
  }
  const grossShares = sizeUsd / fillPrice;
  // Taker fee
  let netShares = grossShares;
  if (feesEnabled) {
    const feeShares = grossShares * FEE_RATE * Math.pow(fillPrice * (1 - fillPrice), FEE_EXPONENT);
    netShares = grossShares - feeShares;
  }
  return { filled: true, fillPrice, netShares };
}

// ─── Data Types ───
interface Trade {
  id: string;
  side: 'BUY' | 'SELL';
  outcome: string;
  price: number;
  size: number;
  timestamp: number;
  conditionId: string;
  asset: string;
  eventSlug: string;
  title: string;
  detectionSource: string;
  detectedAt: string | null;  // D19: ISO timestamp for stale cutoff
}

interface SettlementEvent {
  timeMs: number;
  conditionId: string;
  winningOutcome: string;
}

// ─── CSV Parser ───
function parseCSVLine(line: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') { current += '"'; i++; }
        else inQuotes = false;
      } else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { fields.push(current); current = ''; }
      else current += ch;
    }
  }
  fields.push(current);
  return fields;
}

function parseCSV(text: string): Record<string, string>[] {
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return [];
  const headers = parseCSVLine(lines[0]);
  return lines.slice(1).map(line => {
    const vals = parseCSVLine(line);
    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) row[headers[j]] = vals[j] ?? '';
    return row;
  });
}

// ─── Load Data ───
const dataDir = join(__dirname, '../../backtest-data');

console.log('Loading production DetectedTrade data...');
const tradeRows = parseCSV(readFileSync(join(dataDir, 'bt-detected-trades.csv'), 'utf-8'));
const trades: Trade[] = tradeRows
  .map(r => ({
    id: r.id,
    side: r.side as 'BUY' | 'SELL',
    outcome: r.outcome || '',
    price: parseFloat(r.price),
    size: parseFloat(r.size),
    timestamp: parseInt(r.timestamp, 10),
    conditionId: r.conditionId,
    asset: r.asset,
    eventSlug: r.eventSlug || '',
    title: r.title || '',
    detectionSource: r.detectionSource || '',
    detectedAt: r.detectedAt || null,  // D19: may be absent in older CSV exports
  }))
  .filter(t => !isNaN(t.price) && !isNaN(t.size) && t.conditionId);

trades.sort((a, b) => a.timestamp - b.timestamp);
console.log(`  Loaded ${trades.length} DetectedTrade records`);

// Load market resolution data
const marketOutcomes = new Map<string, string>();
const marketEventSlugs = new Map<string, string>();

try {
  const resolvedRows = parseCSV(readFileSync(join(dataDir, 'bt-resolved-markets.csv'), 'utf-8'));
  for (const r of resolvedRows) {
    if (r.slug) marketEventSlugs.set(r.conditionId, r.slug);
    if (r.closed === 'true' && r.winningOutcome) {
      marketOutcomes.set(r.conditionId, r.winningOutcome);
    }
  }
} catch { /* fallback */ }

try {
  const mktRows = parseCSV(readFileSync(join(dataDir, 'bt-markets-db.csv'), 'utf-8'));
  for (const r of mktRows) {
    if (r.eventSlug && !marketEventSlugs.has(r.conditionId)) marketEventSlugs.set(r.conditionId, r.eventSlug);
    if (r.slug && !marketEventSlugs.has(r.conditionId)) marketEventSlugs.set(r.conditionId, r.slug);
    if (r.closed !== 't') continue;
    if (marketOutcomes.has(r.conditionId)) continue;
    try {
      const outcomes: string[] = JSON.parse(r.outcomes);
      const prices: string[] = JSON.parse(r.outcomePrices);
      for (let i = 0; i < outcomes.length; i++) {
        if (prices[i] === '1') { marketOutcomes.set(r.conditionId, outcomes[i]); break; }
      }
    } catch { /* skip */ }
  }
} catch { /* optional */ }

// Slug parser: matches /up-or-down-(?:march|april)-(\d+)(?:-\d{4})?-(\d+)(am|pm)-et$/i
function estimateEndFromSlug(slug: string): number | null {
  const updownMatch = slug.match(/updown-(\d+m)-(\d+)$/);
  if (updownMatch) {
    const startTs = parseInt(updownMatch[2], 10);
    const dur = updownMatch[1];
    if (dur === '5m') return startTs + 300;
    if (dur === '15m') return startTs + 900;
    if (dur === '1h') return startTs + 3600;
  }
  const hourlyMatch = slug.match(/up-or-down-(?:march|april)-(\d+)(?:-\d{4})?-(\d+)(am|pm)-et$/i);
  if (hourlyMatch) {
    const day = parseInt(hourlyMatch[1], 10);
    let hour = parseInt(hourlyMatch[2], 10);
    const ampm = hourlyMatch[3].toLowerCase();
    if (ampm === 'pm' && hour !== 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    const utcHour = hour + 4;
    const month = slug.includes('april') ? 3 : 2;
    const date = new Date(Date.UTC(2026, month, day, utcHour, 0, 0));
    return Math.floor(date.getTime() / 1000) + 3600;
  }
  const match12 = slug.match(/(\d+)-12(am|pm)-et$/i);
  if (match12) {
    const day = parseInt(match12[1], 10);
    let hour = 12;
    if (match12[2].toLowerCase() === 'am') hour = 0;
    const utcHour = hour + 4;
    const date = new Date(Date.UTC(2026, 2, day, utcHour, 0, 0));
    return Math.floor(date.getTime() / 1000) + 3600;
  }
  return null;
}

const tokenToCondition = new Map<string, string>();
const tokenToOutcome = new Map<string, string>();
const conditionTokens = new Map<string, Set<string>>();
for (const t of trades) {
  tokenToCondition.set(t.asset, t.conditionId);
  if (t.outcome) tokenToOutcome.set(t.asset, t.outcome);
  if (t.eventSlug && !marketEventSlugs.has(t.conditionId)) marketEventSlugs.set(t.conditionId, t.eventSlug);
  if (!conditionTokens.has(t.conditionId)) conditionTokens.set(t.conditionId, new Set());
  conditionTokens.get(t.conditionId)!.add(t.asset);
}

const marketEndTs = new Map<string, number>();
for (const [conditionId, slug] of marketEventSlugs) {
  const endTs = estimateEndFromSlug(slug);
  if (endTs) marketEndTs.set(conditionId, endTs);
}

const settlementEvents: SettlementEvent[] = [];
for (const [conditionId, winningOutcome] of marketOutcomes) {
  const endTs = marketEndTs.get(conditionId);
  settlementEvents.push({
    timeMs: endTs ? endTs * 1000 + 5 * 60 * 1000 : Date.now() + 365 * 86400_000,
    conditionId,
    winningOutcome,
  });
}
settlementEvents.sort((a, b) => a.timeMs - b.timeMs);

console.log(`  Resolved ${marketOutcomes.size} markets, ${settlementEvents.length} settlement events`);
console.log(`  Period: ${new Date(trades[0].timestamp * 1000).toISOString()} -> ${new Date(trades[trades.length - 1].timestamp * 1000).toISOString()}`);

// ─── Dynamic Date Range ───
function getDateRange(tradeList: Trade[]): string[] {
  if (tradeList.length === 0) return [];
  const startDate = new Date((tradeList[0].timestamp - 4 * 3600) * 1000);
  const endDate = new Date((tradeList[tradeList.length - 1].timestamp - 4 * 3600) * 1000);
  const dates: string[] = [];
  const d = new Date(startDate);
  d.setUTCHours(0, 0, 0, 0);
  while (d <= endDate) {
    dates.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dates;
}

const dateRange = getDateRange(trades);

// ─── Majority Accumulator (with self-exclusion + numOutcomes) ───
class MajorityAccumulator {
  private acc = new Map<string, Map<string, { count: number; totalUsd: number }>>();

  record(conditionId: string, outcome: string, usd: number): void {
    let m = this.acc.get(conditionId);
    if (!m) { m = new Map(); this.acc.set(conditionId, m); }
    const s = m.get(outcome) ?? { count: 0, totalUsd: 0 };
    s.count++; s.totalUsd += usd;
    m.set(outcome, s);
  }

  getMajority(
    conditionId: string,
    minUsd: number,
    excludeUsd?: { outcome: string; usd: number },
  ): { outcome: string; ratio: number; totalTrades: number; totalUsd: number; numOutcomes: number } | null {
    const m = this.acc.get(conditionId);
    if (!m) return null;

    let totalCount = 0, totalUsd = 0, maxUsd = 0, majorityOutcome = '';
    let numOutcomes = 0;

    for (const [outcome, s] of m) {
      let adjUsd = s.totalUsd;
      let adjCount = s.count;
      // Self-exclusion: subtract the current trade's contribution if matching
      if (excludeUsd && excludeUsd.outcome === outcome) {
        adjUsd -= excludeUsd.usd;
        adjCount = Math.max(0, adjCount - 1);
      }
      if (adjUsd < 0) adjUsd = 0;
      if (adjUsd > 0.001) numOutcomes++;
      totalCount += adjCount;
      totalUsd += adjUsd;
      if (adjUsd > maxUsd) { maxUsd = adjUsd; majorityOutcome = outcome; }
    }

    if (totalUsd < minUsd) return null;
    const ratio = totalUsd > 0 ? maxUsd / totalUsd : 0;
    if (ratio < MAJORITY_MIN_RATIO) return null;
    return { outcome: majorityOutcome, ratio, totalTrades: totalCount, totalUsd, numOutcomes };
  }
}

// ─── Position Tracker ───
class PositionTracker {
  private positions = new Map<string, { shares: number; costUsd: number }>();

  getNetPositionUsd(tokenId: string): number {
    const p = this.positions.get(tokenId);
    if (!p || p.costUsd < 0.01) return 0;
    return p.costUsd;
  }

  getHeldShares(tokenId: string): number {
    const p = this.positions.get(tokenId);
    if (!p || p.shares < 0.01) return 0;
    return p.shares;
  }

  getOppositePosition(conditionId: string, currentTokenId: string): { netUsd: number; avgBuyPrice: number } {
    const tokens = conditionTokens.get(conditionId);
    if (!tokens) return { netUsd: 0, avgBuyPrice: 0 };
    let netUsd = 0, buyCost = 0, buyShares = 0;
    for (const tokenId of tokens) {
      if (tokenId === currentTokenId) continue;
      const p = this.positions.get(tokenId);
      if (p && p.shares >= 0.01) {
        netUsd += p.costUsd; buyCost += p.costUsd; buyShares += p.shares;
      }
    }
    if (netUsd < 0) netUsd = 0;
    const avgBuyPrice = buyShares > 0 ? buyCost / buyShares : 0;
    return { netUsd, avgBuyPrice };
  }

  recordBuy(tokenId: string, usdAmount: number, netShares: number): void {
    const p = this.positions.get(tokenId) ?? { shares: 0, costUsd: 0 };
    p.shares += netShares; p.costUsd += usdAmount;
    this.positions.set(tokenId, p);
  }

  recordSell(tokenId: string, price: number): { soldShares: number; costBasis: number; proceeds: number } {
    const p = this.positions.get(tokenId);
    if (!p || p.shares < 0.01) return { soldShares: 0, costBasis: 0, proceeds: 0 };
    const soldShares = Math.floor(p.shares * 100) / 100;
    const costBasis = p.costUsd;
    const proceeds = soldShares * price;
    this.positions.set(tokenId, { shares: 0, costUsd: 0 });
    return { soldShares, costBasis, proceeds };
  }

  settleCondition(conditionId: string, winningOutcome: string): { pnl: number; costBasis: number; settled: number; wins: number; losses: number } {
    let totalPnl = 0, totalCost = 0, settled = 0, wins = 0, losses = 0;
    for (const [tokenId, pos] of this.positions) {
      if (pos.shares < 0.01) continue;
      if (tokenToCondition.get(tokenId) !== conditionId) continue;
      const ourOutcome = tokenToOutcome.get(tokenId) || '';
      const won = ourOutcome === winningOutcome;
      const settlementValue = won ? pos.shares * 1.0 : 0;
      const pnl = settlementValue - pos.costUsd;
      totalPnl += pnl; totalCost += pos.costUsd; settled++;
      if (won) wins++; else losses++;
      this.positions.set(tokenId, { shares: 0, costUsd: 0 });
    }
    return { pnl: totalPnl, costBasis: totalCost, settled, wins, losses };
  }

  getTotalDeployed(): number {
    let total = 0;
    for (const [_, p] of this.positions) if (p.shares > 0.01) total += p.costUsd;
    return total;
  }
}

// ─── Order Pool ───
class OrderPool {
  private pool = new Map<string, { amount: number; firstAddedTs: number }>();

  add(tokenId: string, usd: number, nowTs: number): void {
    const existing = this.pool.get(tokenId);
    if (existing) { existing.amount += usd; }
    else { this.pool.set(tokenId, { amount: usd, firstAddedTs: nowTs }); }
  }

  tryFire(tokenId: string): number | null {
    const entry = this.pool.get(tokenId);
    if (!entry || entry.amount < CLOB_MIN_ORDER_USD) return null;
    const amount = entry.amount;
    this.pool.delete(tokenId);
    return amount;
  }

  burnExpired(nowTs: number): number {
    const cutoffTs = nowTs - POOL_BURN_TIMEOUT_MS / 1000;
    let burned = 0;
    for (const [tokenId, entry] of this.pool) {
      if (entry.firstAddedTs < cutoffTs) { this.pool.delete(tokenId); burned++; }
    }
    return burned;
  }
}

// ─── Skip Reason Counters ───
interface SkipCounters {
  skipSlug: number;
  skipPrice: number;
  skipMarketClosed: number;
  skipSignalSource: number;
  skipChainMakerFiltered: number;  // D15
  skipBuyFailureCooldown: number;  // D16
  skipStaleCutoff: number;         // D19
  skipAssetFilter: number;         // E) asset filter
  skipEarlyBirdCap: number;        // A) early bird cap
  skipMajorityInsufficient: number;
  skipMajorityBothSides: number;
  skipMajorityMinority: number;
  skipCommittedLock: number;
  skipSellCooldown: number;
  skipSellDisabled: number;
  skipPredCap: number;
  skipHedge: number;
  skipCapital: number;
  skipDailyLimit: number;
  skipFakFailure: number;
  pooledCount: number;
  poolFiredCount: number;
}

function newSkipCounters(): SkipCounters {
  return {
    skipSlug: 0, skipPrice: 0, skipMarketClosed: 0, skipSignalSource: 0,
    skipChainMakerFiltered: 0, skipBuyFailureCooldown: 0, skipStaleCutoff: 0,
    skipAssetFilter: 0, skipEarlyBirdCap: 0,
    skipMajorityInsufficient: 0, skipMajorityBothSides: 0, skipMajorityMinority: 0,
    skipCommittedLock: 0, skipSellCooldown: 0, skipSellDisabled: 0,
    skipPredCap: 0, skipHedge: 0, skipCapital: 0, skipDailyLimit: 0,
    skipFakFailure: 0, pooledCount: 0, poolFiredCount: 0,
  };
}

// ─── Simulation Result ───
interface SimResult {
  configName: string;
  totalPnl: number;
  returnPct: number;
  winRate: number;
  maxDrawdown: number;
  sharpeLike: number;
  calmarLike: number;
  pnlPerDollarDeployed: number;
  buyCount: number;
  predictionsTraded: number;
  wins: number;
  losses: number;
  totalUsdDeployed: number;
  dailyPnl: Map<string, number>;
  dailyBuyCost: Map<string, number>;
  startingCapital: number;
  skips: SkipCounters;
}

// ─── Run a single simulation ───
function runSimulation(cfg: RunConfig, startingCapital: number, seed: number): SimResult {
  const rng = mulberry32(seed);
  const accumulator = new MajorityAccumulator();
  const positions = new PositionTracker();
  const pool = new OrderPool();
  const committedSides = new Map<string, string>();

  let currentCapital = startingCapital;
  let buyCount = 0;
  let totalUsdDeployed = 0;
  let wins = 0, losses = 0;

  let maxEquity = startingCapital;
  let maxDrawdown = 0;

  let settlementIdx = 0;

  const predCostBasis = new Map<string, number>();
  const predProceeds = new Map<string, number>();

  const sellCooldowns = new Map<string, number>();
  const buyFailureCooldowns = new Map<string, number>();  // D16: tokenId → cooldown expiry (ms)
  const earlyBirdCounts = new Map<string, number>();      // EARLY_BIRD: conditionId → buy count
  const dailySpend = new Map<string, number>();

  const dailyPnl = new Map<string, number>();
  const dailyBuyCost = new Map<string, number>();

  const skips = newSkipCounters();

  function getDateKey(ts: number): string {
    const d = new Date((ts - 4 * 3600) * 1000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
  }

  function getDayKey(ts: number): string {
    const d = new Date(ts * 1000);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }

  function recordDailySpend(ts: number, usd: number): void {
    const key = getDayKey(ts);
    dailySpend.set(key, (dailySpend.get(key) ?? 0) + usd);
  }

  function getDailyRemaining(ts: number): number {
    const key = getDayKey(ts);
    return MAX_DAILY_LOSS_USD - (dailySpend.get(key) ?? 0);
  }

  function computeEquity(): number {
    return currentCapital + positions.getTotalDeployed();
  }

  function trackEquity(): void {
    const eq = computeEquity();
    if (eq > maxEquity) maxEquity = eq;
    const dd = maxEquity > 0 ? (maxEquity - eq) / maxEquity : 0;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  function executeBuy(
    tokenId: string, conditionId: string, outcome: string,
    usdAmount: number, price: number, ts: number,
  ): boolean {
    const fill = simulateFill(price, usdAmount, rng, cfg.fees, cfg.slippage);
    if (!fill.filled) {
      // D16: Set buy failure cooldown (15s) — matches copy-trader.ts:449
      buyFailureCooldowns.set(tokenId, ts * 1000 + BUY_FAILURE_COOLDOWN_MS);
      skips.skipFakFailure++;
      return false;
    }

    positions.recordBuy(tokenId, usdAmount, fill.netShares);
    currentCapital -= usdAmount;
    totalUsdDeployed += usdAmount;
    buyCount++;
    recordDailySpend(ts, usdAmount);

    if (COMMITTED_SIDE_LOCK && !committedSides.has(conditionId)) {
      committedSides.set(conditionId, outcome);
    }

    predCostBasis.set(conditionId, (predCostBasis.get(conditionId) ?? 0) + usdAmount);

    const dateKey = getDateKey(ts);
    dailyBuyCost.set(dateKey, (dailyBuyCost.get(dateKey) ?? 0) + usdAmount);

    trackEquity();
    return true;
  }

  function trackEarlyBirdBuy(conditionId: string): void {
    if (cfg.strategy === 'EARLY_BIRD') {
      earlyBirdCounts.set(conditionId, (earlyBirdCounts.get(conditionId) ?? 0) + 1);
    }
  }

  function processSettlements(beforeMs: number): void {
    while (settlementIdx < settlementEvents.length && settlementEvents[settlementIdx].timeMs <= beforeMs) {
      const evt = settlementEvents[settlementIdx];
      const result = positions.settleCondition(evt.conditionId, evt.winningOutcome);
      if (result.settled > 0) {
        const settlementValue = result.costBasis + result.pnl;
        currentCapital += settlementValue;
        wins += result.wins; losses += result.losses;
        committedSides.delete(evt.conditionId);
        predProceeds.set(evt.conditionId, (predProceeds.get(evt.conditionId) ?? 0) + settlementValue);

        const dateKey = getDateKey(Math.floor(evt.timeMs / 1000));
        dailyPnl.set(dateKey, (dailyPnl.get(dateKey) ?? 0) + result.pnl);
      }
      settlementIdx++;
    }
  }

  for (const trade of trades) {
    const tradeMs = trade.timestamp * 1000;
    processSettlements(tradeMs);
    pool.burnExpired(trade.timestamp);

    // Record every BUY in accumulator (before filters)
    if (trade.side === 'BUY' && trade.outcome) {
      accumulator.record(trade.conditionId, trade.outcome, trade.size * trade.price);
    }

    const effectiveSlug = trade.eventSlug || marketEventSlugs.get(trade.conditionId) || '';

    // ── Signal source filter (BUY only) ──
    if (trade.side === 'BUY') {
      const src = (trade.detectionSource || '').toUpperCase();
      if (src !== '' && src !== 'CHAIN' && src !== 'CHAIN_MAKER') {
        skips.skipSignalSource++;
        continue;
      }
    }

    // D15: Detection source routing — CHAIN_MAKER excluded unless copyMakerFills=true
    if (trade.side === 'BUY' && SKIP_CHAIN_MAKER_FILLS) {
      const src = (trade.detectionSource || '').toUpperCase();
      if (src === 'CHAIN_MAKER' && !COPY_MAKER_FILLS) {
        skips.skipChainMakerFiltered++;
        continue;
      }
    }

    // D19: Stale trade cutoff — production filters signals where detectedAt < now - 10min
    // (copy-trader.ts:1214-1220). In batch mode there's no wall clock, so we approximate:
    // skip signals where detection was significantly DELAYED relative to chain timestamp
    // (detectedAt >> timestamp means backfill/delayed detection — would be stale when drain runs).
    // Normal chain detection: detectedAt ≈ timestamp + ~1s, so this rarely triggers.
    if (trade.side === 'BUY' && trade.detectedAt) {
      const detectedAtMs = new Date(trade.detectedAt).getTime();
      const tradeTimeMs = trade.timestamp * 1000;
      // Only skip if detection was delayed MORE than 10min after chain timestamp
      // (i.e., signal was backfilled long after the trade happened)
      if (detectedAtMs - tradeTimeMs > STALE_TRADE_CUTOFF_MS) {
        skips.skipStaleCutoff++;
        continue;
      }
    }

    // minBuyPrice filter (BUY only) — per-config override
    const effectiveMinBuyPrice = cfg.minBuyPrice ?? MIN_BUY_PRICE;
    if (trade.side === 'BUY' && trade.price < effectiveMinBuyPrice - 0.001) {
      skips.skipPrice++;
      continue;
    }

    // Event slug exclusion (BUY only, fail-closed)
    if (trade.side === 'BUY') {
      if (!effectiveSlug) {
        skips.skipSlug++;
        continue;
      }
      const slug = effectiveSlug.toLowerCase();
      if (EXCLUDE_SLUG_PATTERNS.some(p => slug.includes(p))) {
        skips.skipSlug++;
        continue;
      }
    }

    // Asset filter (BUY only) — only trade specified assets
    if (trade.side === 'BUY' && cfg.assetFilter && cfg.assetFilter.length > 0) {
      const slug = effectiveSlug.toLowerCase();
      const title = (trade.title || '').toLowerCase();
      if (!cfg.assetFilter.some(a => slug.includes(a) || title.includes(a))) {
        skips.skipAssetFilter++;
        continue;
      }
    }

    // Market-closed check (BUY only)
    if (trade.side === 'BUY') {
      const endTs = marketEndTs.get(trade.conditionId);
      if (endTs && trade.timestamp >= endTs) {
        skips.skipMarketClosed++;
        continue;
      }
    }

    // ── Strategy-specific majority gate + side logic ──
    let majorityTotalUsd: number | null = null;
    let switchSellTriggered = false;  // true if we should sell current + buy new side
    let switchHedgeTriggered = false; // true if we should hedge-buy the new side
    let hedgeCoverageUsd = 0;         // how much to buy to cover loss on current side

    if (trade.side === 'BUY') {
      if (cfg.strategy === 'EARLY_BIRD') {
        // A) Copy first N trades per prediction, no majority gate
        const count = earlyBirdCounts.get(trade.conditionId) ?? 0;
        if (cfg.maxFirstBuys && count >= cfg.maxFirstBuys) {
          skips.skipEarlyBirdCap++;
          continue;
        }
        majorityTotalUsd = trade.size * trade.price;

      } else if (cfg.strategy === 'MIRROR') {
        // C) Copy ALL buys, no filtering, both sides
        majorityTotalUsd = trade.size * trade.price;

      } else if (cfg.strategy === 'HIGH_CONV') {
        // D) Only copy when majority ratio exceeds threshold
        const selfUsd = { outcome: trade.outcome, usd: trade.size * trade.price };
        const majority = accumulator.getMajority(trade.conditionId, cfg.gate, selfUsd);
        if (!majority) { skips.skipMajorityInsufficient++; continue; }
        if (majority.numOutcomes < 2) { skips.skipMajorityBothSides++; continue; }
        const threshold = cfg.switchThreshold ?? 0.70;
        if (majority.ratio < threshold) { skips.skipMajorityMinority++; continue; }
        if (trade.outcome !== majority.outcome) { skips.skipMajorityMinority++; continue; }
        majorityTotalUsd = majority.totalUsd;

      } else if (cfg.strategy === 'BOTH_SIDES') {
        // V1: No majority gate — buy every qualifying signal
        // Still need volume gate to avoid dust signals
        if (cfg.gate > 0) {
          const selfUsd = { outcome: trade.outcome, usd: trade.size * trade.price };
          const majority = accumulator.getMajority(trade.conditionId, cfg.gate, selfUsd);
          if (!majority) { skips.skipMajorityInsufficient++; continue; }
        }
        majorityTotalUsd = trade.size * trade.price;
        // No committed side lock — allow both sides

      } else if (cfg.strategy === 'SWITCH_SELL' || cfg.strategy === 'SWITCH_HEDGE') {
        // V2/V3: Majority gate with switch detection
        const selfUsd = { outcome: trade.outcome, usd: trade.size * trade.price };
        const majority = accumulator.getMajority(trade.conditionId, cfg.gate, selfUsd);
        if (!majority) { skips.skipMajorityInsufficient++; continue; }
        if (majority.numOutcomes < 2) { skips.skipMajorityBothSides++; continue; }

        const threshold = cfg.switchThreshold ?? 0.50;
        const committed = committedSides.get(trade.conditionId);

        if (committed && committed !== majority.outcome && majority.ratio >= threshold) {
          // Majority has SWITCHED from our committed side
          if (cfg.strategy === 'SWITCH_SELL') {
            // V2: Sell current position + buy new majority side
            switchSellTriggered = true;
            // Execute sell of ALL tokens on committed side
            for (const tokenId of conditionTokens.get(trade.conditionId) ?? []) {
              const tokenOutcome = tokenToOutcome.get(tokenId);
              if (tokenOutcome === committed) {
                const heldShares = positions.getHeldShares(tokenId);
                if (heldShares >= 0.01) {
                  // Sell at current trade price (approximate market price)
                  const sellPrice = 1.0 - trade.price; // opposite side price
                  const result = positions.recordSell(tokenId, sellPrice);
                  if (result.soldShares >= 0.01) {
                    currentCapital += result.proceeds;
                    const sellPnl = result.proceeds - result.costBasis;
                    if (sellPnl >= 0) wins++; else losses++;
                    predProceeds.set(trade.conditionId, (predProceeds.get(trade.conditionId) ?? 0) + result.proceeds);
                    const dateKey = getDateKey(trade.timestamp);
                    dailyPnl.set(dateKey, (dailyPnl.get(dateKey) ?? 0) + sellPnl);
                    sellCooldowns.set(tokenId, trade.timestamp);
                    trackEquity();
                  }
                }
              }
            }
            // Update committed side to new majority
            committedSides.set(trade.conditionId, majority.outcome);
          } else {
            // V3: Hedge-buy — calculate coverage amount
            switchHedgeTriggered = true;
            // Calculate loss on current side if it loses (settles at 0)
            let currentSideCost = 0;
            for (const tokenId of conditionTokens.get(trade.conditionId) ?? []) {
              const tokenOutcome = tokenToOutcome.get(tokenId);
              if (tokenOutcome === committed) {
                const pos = positions.getNetPositionUsd(tokenId);
                currentSideCost += pos;
              }
            }
            // To cover loss: buy enough of new side so that if new side wins,
            // profit on new side >= loss on old side
            // If we buy $Y at price P, and it settles at $1: profit = Y/P - Y = Y(1/P - 1)
            // Need: Y(1/P - 1) >= currentSideCost → Y >= currentSideCost * P / (1 - P)
            if (trade.price < 0.99 && currentSideCost > 0) {
              hedgeCoverageUsd = currentSideCost * trade.price / (1.0 - trade.price);
            }
            // Don't update committed side — we're holding both
          }
          majorityTotalUsd = majority.totalUsd;
        } else if (trade.outcome === majority.outcome) {
          // Normal majority-aligned signal — proceed as usual
          majorityTotalUsd = majority.totalUsd;
        } else {
          // Minority side or threshold not reached — skip
          skips.skipMajorityMinority++;
          continue;
        }

      } else {
        // MAJORITY_GATE: Original production behavior
        const selfUsd = { outcome: trade.outcome, usd: trade.size * trade.price };
        const majority = accumulator.getMajority(trade.conditionId, cfg.gate, selfUsd);
        if (!majority) { skips.skipMajorityInsufficient++; continue; }
        if (majority.numOutcomes < 2) { skips.skipMajorityBothSides++; continue; }
        if (trade.outcome !== majority.outcome) { skips.skipMajorityMinority++; continue; }
        majorityTotalUsd = majority.totalUsd;
      }
    }

    // Committed side lock (BUY only) — only for MAJORITY_GATE and HIGH_CONV
    if (trade.side === 'BUY' && COMMITTED_SIDE_LOCK
        && (cfg.strategy === 'MAJORITY_GATE' || cfg.strategy === 'HIGH_CONV')) {
      const committed = committedSides.get(trade.conditionId);
      if (committed && committed !== trade.outcome) {
        skips.skipCommittedLock++;
        continue;
      }
    }

    // Token sell cooldown (BUY only, 60s)
    if (trade.side === 'BUY') {
      const lastSell = sellCooldowns.get(trade.asset);
      if (lastSell && (trade.timestamp - lastSell) < TOKEN_SELL_COOLDOWN_MS / 1000) {
        skips.skipSellCooldown++;
        continue;
      }
    }

    // D16: BUY failure cooldown (15s per-token after FAK failure)
    if (trade.side === 'BUY') {
      const cooldownExpiry = buyFailureCooldowns.get(trade.asset) ?? 0;
      if (trade.timestamp * 1000 < cooldownExpiry) {
        skips.skipBuyFailureCooldown++;
        continue;
      }
    }

    // ── SELL ──
    if (trade.side === 'SELL') {
      // Live sell disabled — skip all sells (except SWITCH strategies handle sells internally)
      if (LIVE_SELL_DISABLED) {
        skips.skipSellDisabled++;
        continue;
      }
      const heldShares = positions.getHeldShares(trade.asset);
      if (heldShares < 0.01) continue;
      const result = positions.recordSell(trade.asset, trade.price);
      if (result.soldShares < 0.01) continue;
      currentCapital += result.proceeds;
      const sellPnl = result.proceeds - result.costBasis;
      if (sellPnl >= 0) wins++; else losses++;
      predProceeds.set(trade.conditionId, (predProceeds.get(trade.conditionId) ?? 0) + result.proceeds);

      const dateKey = getDateKey(trade.timestamp);
      dailyPnl.set(dateKey, (dailyPnl.get(dateKey) ?? 0) + sellPnl);

      sellCooldowns.set(trade.asset, trade.timestamp);
      trackEquity();
      continue;
    }

    // ── BUY SIZING ──
    if (currentCapital <= 0) {
      skips.skipCapital++;
      continue;
    }

    const fragmentUsd = trade.size * trade.price;
    const traderTradeUsd = majorityTotalUsd ?? fragmentUsd;

    if (MIN_COMPOSITE_SCORE > 0) continue;
    if (MIN_SIGNAL_TRADE_USD > 0 && traderTradeUsd < MIN_SIGNAL_TRADE_USD) continue;

    // Trade-proportional sizing (or hedge coverage for SWITCH_HEDGE)
    let copyAmountUsd: number;
    if (switchHedgeTriggered && hedgeCoverageUsd > 0) {
      // V3: Use coverage amount — enough to break even if new side wins
      // Take max of: coverage amount, or normal copy sizing (whichever is higher)
      const normalCopy = Math.min(traderTradeUsd * COPY_TRADE_PERCENT, cfg.maxTrade);
      copyAmountUsd = Math.max(hedgeCoverageUsd, normalCopy);
      copyAmountUsd = Math.min(copyAmountUsd, cfg.maxPred); // cap at per-prediction
    } else if (cfg.sizeMode === 'proportional') {
      // Size proportional to THIS specific trade's USD, not majority aggregate
      const thisTradeUsd = trade.size * trade.price;
      copyAmountUsd = thisTradeUsd * COPY_TRADE_PERCENT;
      copyAmountUsd = Math.min(copyAmountUsd, cfg.maxTrade);
    } else {
      copyAmountUsd = traderTradeUsd * COPY_TRADE_PERCENT;
      copyAmountUsd = Math.min(copyAmountUsd, cfg.maxTrade);
    }

    const positionUsd = positions.getNetPositionUsd(trade.asset);

    // Per-prediction position cap (V3 hedge may exceed normal cap, use maxPred as hard limit)
    if (cfg.maxPred > 0) {
      // For hedge strategies, count TOTAL position across both sides of this condition
      let totalConditionUsd = positionUsd;
      if (cfg.strategy === 'SWITCH_HEDGE' || cfg.strategy === 'BOTH_SIDES'
          || cfg.strategy === 'MIRROR' || cfg.strategy === 'EARLY_BIRD') {
        for (const tokenId of conditionTokens.get(trade.conditionId) ?? []) {
          if (tokenId !== trade.asset) {
            totalConditionUsd += positions.getNetPositionUsd(tokenId);
          }
        }
      }
      const remaining = cfg.maxPred - totalConditionUsd;
      if (remaining < 0.01) {
        skips.skipPredCap++;
        continue;
      }
      if (copyAmountUsd > remaining) copyAmountUsd = remaining;
    }

    // Hedge guard — skip for strategies that intentionally buy both sides
    const skipHedgeGuard = cfg.strategy === 'BOTH_SIDES' || cfg.strategy === 'MIRROR' || cfg.strategy === 'EARLY_BIRD';
    let hedgeMaxUsd = Infinity;
    if (HEDGE_ENABLED && HEDGE_PRICE_RATIO > 0 && trade.price < HEDGE_PRICE_RATIO && !skipHedgeGuard) {
      const oppositePos = positions.getOppositePosition(trade.conditionId, trade.asset);
      const hasOpposite = oppositePos.avgBuyPrice > 0 && oppositePos.netUsd >= 0.01;
      if (!hasOpposite) {
        if (HEDGE_NAKED_MAX_PRICE > 0 && trade.price <= HEDGE_NAKED_MAX_PRICE) {
          skips.skipHedge++;
          continue;
        }
      } else {
        const isHedge = trade.price < HEDGE_PRICE_RATIO * oppositePos.avgBuyPrice;
        if (isHedge) {
          if (oppositePos.netUsd < HEDGE_MIN_OPPOSITE_USD) {
            skips.skipHedge++;
            continue;
          }
          hedgeMaxUsd = oppositePos.netUsd * HEDGE_MAX_RATIO;
          if (copyAmountUsd > hedgeMaxUsd) copyAmountUsd = hedgeMaxUsd;
        }
      }
    }

    // MAX_TRADE_PERCENT: cap at 50% of current capital
    const maxTradeFromCapital = currentCapital * MAX_TRADE_PERCENT;
    if (copyAmountUsd > maxTradeFromCapital) copyAmountUsd = maxTradeFromCapital;

    // CLOB $1 minimum
    if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
      if (positionUsd < 0.01) {
        copyAmountUsd = Math.min(CLOB_MIN_ORDER_USD, hedgeMaxUsd);
        if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
          skips.skipCapital++;
          continue;
        }
      } else {
        if (copyAmountUsd < 0.01) {
          skips.skipCapital++;
          continue;
        }
        pool.add(trade.asset, copyAmountUsd, trade.timestamp);
        skips.pooledCount++;
        const poolAmount = pool.tryFire(trade.asset);
        if (poolAmount != null) {
          let fireAmount = poolAmount;
          if (fireAmount > currentCapital) {
            if (currentCapital >= CLOB_MIN_ORDER_USD) fireAmount = currentCapital;
            else continue;
          }
          const dailyRemaining = getDailyRemaining(trade.timestamp);
          if (dailyRemaining <= 0) {
            skips.skipDailyLimit++;
            continue;
          }
          if (fireAmount > dailyRemaining) fireAmount = dailyRemaining;
          if (fireAmount < CLOB_MIN_ORDER_USD) continue;
          const fired = executeBuy(trade.asset, trade.conditionId, trade.outcome, fireAmount, trade.price, trade.timestamp);
          if (fired) { skips.poolFiredCount++; trackEarlyBirdBuy(trade.conditionId); }
        }
        continue;
      }
    }

    // Global daily loss limit
    const dailyRemaining = getDailyRemaining(trade.timestamp);
    if (dailyRemaining <= 0) {
      skips.skipDailyLimit++;
      continue;
    }
    if (copyAmountUsd > dailyRemaining) copyAmountUsd = dailyRemaining;

    if (copyAmountUsd <= 0) continue;

    // Pool if below threshold
    if (copyAmountUsd < POOL_MIN_AMOUNT_USD) {
      pool.add(trade.asset, copyAmountUsd, trade.timestamp);
      skips.pooledCount++;
      const poolAmount = pool.tryFire(trade.asset);
      if (poolAmount != null) {
        let fireAmount = poolAmount;
        if (fireAmount > currentCapital) {
          if (currentCapital >= CLOB_MIN_ORDER_USD) fireAmount = currentCapital;
          else continue;
        }
        const fired = executeBuy(trade.asset, trade.conditionId, trade.outcome, fireAmount, trade.price, trade.timestamp);
        if (fired) { skips.poolFiredCount++; trackEarlyBirdBuy(trade.conditionId); }
      }
      continue;
    }

    // Capital check
    if (copyAmountUsd > currentCapital) {
      if (currentCapital >= CLOB_MIN_ORDER_USD) copyAmountUsd = currentCapital;
      else {
        skips.skipCapital++;
        continue;
      }
    }

    const bought = executeBuy(trade.asset, trade.conditionId, trade.outcome, copyAmountUsd, trade.price, trade.timestamp);
    if (bought) { trackEarlyBirdBuy(trade.conditionId); }
  }

  // Settle remaining
  processSettlements(Date.now() + 365 * 86400_000);

  const finalEquity = computeEquity();
  const totalPnl = finalEquity - startingCapital;
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const pnlPerDollarDeployed = totalUsdDeployed > 0 ? totalPnl / totalUsdDeployed : 0;

  // Compute per-prediction PnL stats for Sharpe
  const allConditionIds = new Set<string>();
  for (const cid of predCostBasis.keys()) allConditionIds.add(cid);
  for (const cid of predProceeds.keys()) allConditionIds.add(cid);

  const predPnls: number[] = [];
  for (const cid of allConditionIds) {
    const cost = predCostBasis.get(cid) ?? 0;
    const proceeds = predProceeds.get(cid) ?? 0;
    predPnls.push(proceeds - cost);
  }

  let stdPredPnl = 0;
  if (predPnls.length > 1) {
    const mean = predPnls.reduce((a, b) => a + b, 0) / predPnls.length;
    const variance = predPnls.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (predPnls.length - 1);
    stdPredPnl = Math.sqrt(variance);
  }

  const sharpeLike = stdPredPnl > 0 ? totalPnl / stdPredPnl : 0;
  const calmarLike = maxDrawdown > 0 ? totalPnl / (maxDrawdown * startingCapital) : (totalPnl > 0 ? Infinity : 0);

  return {
    configName: cfg.name,
    totalPnl,
    returnPct: totalPnl / startingCapital * 100,
    winRate,
    maxDrawdown,
    sharpeLike,
    calmarLike,
    pnlPerDollarDeployed,
    buyCount,
    predictionsTraded: allConditionIds.size,
    wins,
    losses,
    totalUsdDeployed,
    dailyPnl,
    dailyBuyCost,
    startingCapital,
    skips,
  };
}

// ─── Formatting Helpers ───
function padR(s: string, w: number): string { return s.length >= w ? s.slice(0, w) : s + ' '.repeat(w - s.length); }
function padL(s: string, w: number): string { return s.length >= w ? s.slice(0, w) : ' '.repeat(w - s.length) + s; }
function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(0)}` : `-$${Math.abs(v).toFixed(0)}`; }
function fmtPnl2(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtPct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

function shortDate(dateKey: string): string {
  const parts = dateKey.split('-');
  const monthNum = parseInt(parts[1], 10);
  const day = parseInt(parts[2], 10);
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${monthNames[monthNum - 1]}${day}`;
}

// ════════════════════════════════════════════════════════════════════
// RUN ALL SIMULATIONS
// ════════════════════════════════════════════════════════════════════

console.log('\n' + '='.repeat(140));
console.log('PRODUCTION-FAITHFUL BACKTEST — 7 STRATEGY VARIANTS');
console.log(`Capital: $${STARTING_CAPITAL} | Configs: ${CONFIGS.length} | Gate: USD volume | Ratio: ${MAJORITY_MIN_RATIO} | Lock: ${COMMITTED_SIDE_LOCK}`);
console.log(`MinBuy: ${MIN_BUY_PRICE} | Copy: ${COPY_TRADE_PERCENT * 100}% | MaxTrade%: ${MAX_TRADE_PERCENT * 100}% | SellCooldown: ${TOKEN_SELL_COOLDOWN_MS / 1000}s | Hedge: ${HEDGE_ENABLED ? 'ENABLED' : 'DISABLED'}`);
console.log(`LiveSellDisabled: ${LIVE_SELL_DISABLED} | Pool: $${POOL_MIN_AMOUNT_USD} | DailyLossLimit: $${MAX_DAILY_LOSS_USD} | Seed: ${BASE_SEED}`);
console.log(`SlippageFraction: ${SLIPPAGE_UPSIDE_FRACTION} | FAK_Fail: ${FAK_FAILURE_RATE} | GTC_Recovery: ${GTC_RECOVERY_RATE} | FeeRate: ${FEE_RATE}`);
console.log('='.repeat(140));

const results: SimResult[] = [];
for (const cfg of CONFIGS) {
  const r = runSimulation(cfg, STARTING_CAPITAL, BASE_SEED);
  results.push(r);
  process.stdout.write(`  ${padR(cfg.name, 16)} PnL: ${fmtPnl2(r.totalPnl)} | Buys: ${r.buyCount} | Preds: ${r.predictionsTraded}\n`);
}

// ════════════════════════════════════════════════════════════════════
// SECTION 1: Summary Table
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(140));
console.log('SECTION 1: SUMMARY TABLE (sorted by PnL)');
console.log('='.repeat(140));

const byPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl);

console.log(
  padR('Config', 16) +
  padL('PnL', 9) +
  padL('Ret%', 8) +
  padL('WR%', 7) +
  padL('MaxDD%', 8) +
  padL('Sharpe', 8) +
  padL('Calmar', 8) +
  padL('$/dep', 7) +
  padL('Buys', 6) +
  padL('#Pred', 7) +
  padL('W/L', 9) +
  padL('Deployed', 10)
);
console.log('-'.repeat(103));

for (const r of byPnl) {
  console.log(
    padR(r.configName, 16) +
    padL(fmtPnl(r.totalPnl), 9) +
    padL(`${r.returnPct.toFixed(1)}%`, 8) +
    padL(fmtPct(r.winRate), 7) +
    padL(`${(r.maxDrawdown * 100).toFixed(1)}%`, 8) +
    padL(r.sharpeLike.toFixed(2), 8) +
    padL(r.calmarLike === Infinity ? 'Inf' : r.calmarLike.toFixed(2), 8) +
    padL(r.pnlPerDollarDeployed.toFixed(3), 7) +
    padL(String(r.buyCount), 6) +
    padL(String(r.predictionsTraded), 7) +
    padL(`${r.wins}/${r.losses}`, 9) +
    padL(`$${r.totalUsdDeployed.toFixed(0)}`, 10)
  );
}

// ════════════════════════════════════════════════════════════════════
// SECTION 2: Daily PnL Table
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(140));
console.log('SECTION 2: DAILY PnL TABLE (settled PnL per day)');
console.log('='.repeat(140));

const dateHeaders = dateRange.map(d => shortDate(d));

// Print header
let hdr = padR('Config', 16);
for (const dh of dateHeaders) hdr += padL(dh, 8);
hdr += padL('Total', 9);
console.log(hdr);
console.log('-'.repeat(16 + dateHeaders.length * 8 + 9));

for (const r of byPnl) {
  let row = padR(r.configName, 16);
  let total = 0;
  for (const d of dateRange) {
    const pnl = r.dailyPnl.get(d) ?? 0;
    total += pnl;
    row += padL(fmtPnl(pnl), 8);
  }
  row += padL(fmtPnl(total), 9);
  console.log(row);
}

// ════════════════════════════════════════════════════════════════════
// SECTION 3: Skip Reason Breakdown
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(140));
console.log('SECTION 3: SKIP REASON BREAKDOWN');
console.log('='.repeat(140));

const skipLabels: { key: keyof SkipCounters; label: string }[] = [
  { key: 'skipSignalSource',         label: 'SignalSrc' },
  { key: 'skipChainMakerFiltered',   label: 'ChMaker' },   // D15
  { key: 'skipStaleCutoff',          label: 'Stale' },     // D19
  { key: 'skipPrice',                label: 'MinPrice' },
  { key: 'skipSlug',                 label: 'Slug/Excl' },
  { key: 'skipMarketClosed',         label: 'MktClosed' },
  { key: 'skipMajorityInsufficient', label: 'MajInsuf' },
  { key: 'skipMajorityBothSides',    label: 'MajBoth' },
  { key: 'skipMajorityMinority',     label: 'MajMinor' },
  { key: 'skipCommittedLock',        label: 'CommLock' },
  { key: 'skipSellCooldown',         label: 'SellCD' },
  { key: 'skipBuyFailureCooldown',   label: 'BuyFailCD' }, // D16
  { key: 'skipSellDisabled',         label: 'SellDisab' },
  { key: 'skipPredCap',              label: 'PredCap' },
  { key: 'skipHedge',                label: 'Hedge' },
  { key: 'skipCapital',              label: 'Capital' },
  { key: 'skipDailyLimit',           label: 'DailyLim' },
  { key: 'skipFakFailure',           label: 'FAKFail' },
  { key: 'skipAssetFilter',           label: 'Asset' },
  { key: 'skipEarlyBirdCap',         label: 'EBCap' },
  { key: 'pooledCount',              label: 'Pooled' },
  { key: 'poolFiredCount',           label: 'PoolFire' },
];

let skipHdr = padR('Config', 16);
for (const sl of skipLabels) skipHdr += padL(sl.label, 10);
console.log(skipHdr);
console.log('-'.repeat(16 + skipLabels.length * 10));

for (const r of byPnl) {
  let row = padR(r.configName, 16);
  for (const sl of skipLabels) {
    row += padL(String(r.skips[sl.key]), 10);
  }
  console.log(row);
}

// ════════════════════════════════════════════════════════════════════
// SECTION 4: Monte Carlo — Top 3 configs (10 seeds each)
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(140));
console.log('SECTION 4: MONTE CARLO — TOP 3 CONFIGS (10 seeds each)');
console.log('='.repeat(140));

const mcSeeds = Array.from({ length: 10 }, (_, i) => BASE_SEED + i);
const mcConfigNames = byPnl.slice(0, 3).map(r => r.configName);

for (const cfgName of mcConfigNames) {
  const mcCfg = CONFIGS.find(c => c.name === cfgName)!;
  const mcResults: SimResult[] = [];

  console.log(`\n  ── ${cfgName} ──`);
  console.log(
    padR('Seed', 8) +
    padL('PnL', 10) +
    padL('Ret%', 8) +
    padL('WR%', 7) +
    padL('MaxDD%', 8) +
    padL('Buys', 6) +
    padL('#Pred', 7) +
    padL('W/L', 9) +
    padL('FAKFail', 9)
  );
  console.log('-'.repeat(72));

  for (const seed of mcSeeds) {
    const r = runSimulation(mcCfg, STARTING_CAPITAL, seed);
    mcResults.push(r);
    console.log(
      padR(String(seed), 8) +
      padL(fmtPnl2(r.totalPnl), 10) +
      padL(`${r.returnPct.toFixed(1)}%`, 8) +
      padL(fmtPct(r.winRate), 7) +
      padL(`${(r.maxDrawdown * 100).toFixed(1)}%`, 8) +
      padL(String(r.buyCount), 6) +
      padL(String(r.predictionsTraded), 7) +
      padL(`${r.wins}/${r.losses}`, 9) +
      padL(String(r.skips.skipFakFailure), 9)
    );
  }

  const mcPnls = mcResults.map(r => r.totalPnl);
  const mcMean = mcPnls.reduce((a, b) => a + b, 0) / mcPnls.length;
  const mcMin = Math.min(...mcPnls);
  const mcMax = Math.max(...mcPnls);
  const mcVariance = mcPnls.reduce((acc, v) => acc + (v - mcMean) ** 2, 0) / (mcPnls.length - 1);
  const mcStdev = Math.sqrt(mcVariance);

  console.log('-'.repeat(72));
  console.log(`  Mean PnL: ${fmtPnl2(mcMean)} | Min: ${fmtPnl2(mcMin)} | Max: ${fmtPnl2(mcMax)} | Stdev: $${mcStdev.toFixed(2)}`);
  console.log(`  Range: $${(mcMax - mcMin).toFixed(2)} | CV: ${mcMean !== 0 ? (mcStdev / Math.abs(mcMean) * 100).toFixed(1) : 'N/A'}%`);

  const mcBuys = mcResults.map(r => r.buyCount);
  console.log(`  Mean Buys: ${(mcBuys.reduce((a, b) => a + b, 0) / mcBuys.length).toFixed(1)} | Min: ${Math.min(...mcBuys)} | Max: ${Math.max(...mcBuys)}`);
  console.log(`  Mean FAK failures: ${(mcResults.map(r => r.skips.skipFakFailure).reduce((a, b) => a + b, 0) / mcResults.length).toFixed(1)}`);
}

// ════════════════════════════════════════════════════════════════════
// SECTION 5: Data Quality Report
// ════════════════════════════════════════════════════════════════════
console.log('\n' + '='.repeat(140));
console.log('SECTION 5: DATA QUALITY REPORT');
console.log('='.repeat(140));

// Count unresolved markets
const tradedConditionIds = new Set<string>();
for (const t of trades) {
  if (t.side === 'BUY') tradedConditionIds.add(t.conditionId);
}
let unresolvedCount = 0;
let missingSlugCount = 0;
const unresolvedConditions: string[] = [];
const missingSlugConditions: string[] = [];

for (const cid of tradedConditionIds) {
  if (!marketOutcomes.has(cid)) {
    unresolvedCount++;
    unresolvedConditions.push(cid);
  }
  if (!marketEventSlugs.has(cid)) {
    missingSlugCount++;
    missingSlugConditions.push(cid);
  }
}

console.log(`  Total traded conditions (BUY): ${tradedConditionIds.size}`);
console.log(`  Resolved markets: ${marketOutcomes.size}`);
console.log(`  Unresolved markets: ${unresolvedCount}`);
console.log(`  Missing slugs: ${missingSlugCount}`);
console.log(`  Settlement events: ${settlementEvents.length}`);
console.log(`  Markets with endTs: ${marketEndTs.size}`);

if (VERBOSE && unresolvedConditions.length > 0) {
  console.log('\n  Unresolved condition IDs:');
  for (const cid of unresolvedConditions.slice(0, 20)) {
    const slug = marketEventSlugs.get(cid) || '(no slug)';
    console.log(`    ${cid.slice(0, 12)}... -> ${slug}`);
  }
  if (unresolvedConditions.length > 20) {
    console.log(`    ... and ${unresolvedConditions.length - 20} more`);
  }
}

if (VERBOSE && missingSlugConditions.length > 0) {
  console.log('\n  Missing slug condition IDs:');
  for (const cid of missingSlugConditions.slice(0, 20)) {
    console.log(`    ${cid.slice(0, 12)}...`);
  }
  if (missingSlugConditions.length > 20) {
    console.log(`    ... and ${missingSlugConditions.length - 20} more`);
  }
}

// Detection source distribution
const srcCounts = new Map<string, number>();
for (const t of trades) {
  const src = t.detectionSource || '(empty)';
  srcCounts.set(src, (srcCounts.get(src) ?? 0) + 1);
}
console.log('\n  Detection source distribution:');
const srcEntries = [...srcCounts.entries()].sort((a, b) => b[1] - a[1]);
for (const [src, count] of srcEntries) {
  const pct = (count / trades.length * 100).toFixed(1);
  console.log(`    ${padR(src, 20)} ${padL(String(count), 6)} (${pct}%)`);
}

// Trade side distribution
let buyTotal = 0, sellTotal = 0;
for (const t of trades) {
  if (t.side === 'BUY') buyTotal++;
  else sellTotal++;
}
console.log(`\n  Trade side distribution: BUY=${buyTotal}, SELL=${sellTotal}`);

// Date range summary
console.log(`  Date range: ${dateRange[0]} to ${dateRange[dateRange.length - 1]} (${dateRange.length} days)`);

// ─── Final Summary ───
console.log('\n' + '-'.repeat(140));
const prod = results.find(r => r.configName === 'PROD_FAITHFUL')!;
const prodCfg = CONFIGS.find(c => c.name === 'PROD_FAITHFUL')!;
console.log('  PRODUCTION-FAITHFUL for reference:');
console.log(`    PROD_FAITHFUL: PnL=${fmtPnl2(prod.totalPnl)} | Ret=${prod.returnPct.toFixed(1)}% | WR=${fmtPct(prod.winRate)} | MaxDD=${(prod.maxDrawdown * 100).toFixed(1)}% | Sharpe=${prod.sharpeLike.toFixed(2)}`);
console.log(`    Config: Gate=$${prodCfg.gate} | MaxTrade=$${prodCfg.maxTrade} | MaxPred=$${prodCfg.maxPred} | Fees=${prodCfg.fees} | Slippage=${prodCfg.slippage}`);
console.log(`  Best variant: ${byPnl[0].configName} PnL=${fmtPnl2(byPnl[0].totalPnl)} | WR=${fmtPct(byPnl[0].winRate)} | Sharpe=${byPnl[0].sharpeLike.toFixed(2)}`);
console.log('-'.repeat(140));

console.log('\nDone.');
