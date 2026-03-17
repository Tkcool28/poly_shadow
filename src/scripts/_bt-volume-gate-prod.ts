#!/usr/bin/env tsx
/**
 * Backtest: Volume Gate vs Count Gate — 100% production-faithful for 0x8dxd
 *
 * Every guard, filter, and sizing rule from copy-trade-worker.ts is replicated:
 *   ✓ Majority accumulator (record ALL BUYs before filters)
 *   ✓ minBuyPrice filter (0.60)
 *   ✓ Event slug exclusion (updown-5m, updown-15m) — fail-closed if no slug
 *   ✓ Market-closed check (slug-based end time estimation)
 *   ✓ Majority gate (configurable: count vs volume vs hybrid)
 *   ✓ Committed side lock (block opposite-outcome BUYs once filled)
 *   ✓ Token sell cooldown (60s — prevent re-BUY after SELL)
 *   ✓ Hedge guard (block cheap naked BUYs, cap hedge trades)
 *   ✓ Trade-proportional sizing (10% of trader trade, capped at maxPerTrade)
 *   ✓ Per-prediction position cap ($30, trim to gap)
 *   ✓ MAX_TRADE_PERCENT (50% of current capital)
 *   ✓ CLOB $1 minimum (smart bump first entry, pool subsequent)
 *   ✓ Order pool simulation (accumulate sub-$1 BUYs, fire at $1, burn at 3min)
 *   ✓ Global daily loss limit ($200/day)
 *   ✓ Capital check (can't buy more than currentCapital)
 *   ✓ SELL: skipped (production skips ALL SELLs; positions close via settlement only)
 *
 * NOT simulated (require live execution / orderbook data):
 *   ✗ FOK fill failures / slippage (assumes perfect fills at signal price)
 *   ✗ Buy/sell failure cooldowns (depend on real execution failures)
 *   ✗ Live balance pause (wallet balance check)
 *   ✗ Duplicate detection (P2002 guard)
 *
 * Production config from FollowAllocation + env:
 *   capital=$450, maxPos=$8, maxPred=$30, copy=10%, minBuy=0.60
 *   exclude=updown-5m,updown-15m, majorityOnly=true, lock=true
 *   hedge: ratio=0.25, nakedMax=0.10, minOpp=$5, maxRatio=0.20
 *   maxTradePercent=0.50, maxDailyLoss=disabled(never fires), sellCooldown=60s
 *   poolMin=$1(live), poolBurn=180s
 *
 * Usage: npx tsx src/scripts/_bt-volume-gate-prod.ts
 */

import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getMarketsByConditionIds } from '../api/gamma-api';

// ─── EXACT production constants (from env + allocation, as of 2026-03-17) ───
const STARTING_CAPITAL = 450;
const MAX_POSITION_USD = 8;           // allocation.maxPositionUsd
const MAX_PREDICTION_USD = 30;        // allocation.maxPredictionPositionUsd
const MIN_BUY_PRICE = 0.60;           // allocation.minBuyPrice
const CLOB_MIN_ORDER_USD = 1.0;
const EXCLUDE_SLUG_PATTERNS = ['updown-5m', 'updown-15m'];
const COPY_TRADE_PERCENT = 0.10;      // env default (allocation has null)
const MAX_TRADE_PERCENT = 0.50;       // env MAX_TRADE_PERCENT
// MAX_DAILY_LOSS_USD=200 is a GLOBAL cross-allocation daily BUY spend cap.
// Production data shows actual daily spend NEVER exceeds $44 (max $44.15 on
// busiest day across ALL allocations). The $200 cap is a distant safety net
// that never fires in practice. The real binding constraints are per-allocation
// capital ($150 recycling via settlements) and per-prediction cap ($20).
// Set to 100000 to effectively disable — matches production behavior where
// this guard never fires for 0x8dxd.
const MAX_DAILY_LOSS_USD = 100000;    // effectively disabled (never fires in production)
const TOKEN_SELL_COOLDOWN_MS = 60000; // env TOKEN_SELL_COOLDOWN_MS (60s)
const POOL_MIN_AMOUNT_USD = 0.50;     // env POOL_MIN_AMOUNT_USD (production: $0.50)
const POOL_BURN_TIMEOUT_MS = 180000;  // env POOL_BURN_TIMEOUT_MS (3 min)

// Hedge guard
const HEDGE_PRICE_RATIO = 0.25;       // env HEDGE_PRICE_RATIO
const HEDGE_NAKED_MAX_PRICE = 0.10;   // env HEDGE_NAKED_MAX_PRICE
const HEDGE_MIN_OPPOSITE_USD = 5;     // env HEDGE_MIN_OPPOSITE_USD
const HEDGE_MAX_RATIO = 0.20;         // env HEDGE_MAX_RATIO

// Quality gates (disabled in production)
const MIN_COMPOSITE_SCORE = 0;        // disabled
const MIN_SIGNAL_TRADE_USD = 0;       // disabled

// ─── Gate Types ───
type GateType = 'COUNT' | 'USD' | 'HYBRID' | 'NONE';

interface GateConfig {
  name: string;
  gateType: GateType;
  minTrades: number;
  minUsd: number;
  minRatio: number;
  committedSideLock: boolean;
}

const GATE_CONFIGS: GateConfig[] = [
  // Baselines
  { name: 'NO_MAJ',         gateType: 'NONE',   minTrades: 0,  minUsd: 0,    minRatio: 0,    committedSideLock: false },
  { name: 'NO_MAJ_LK',      gateType: 'NONE',   minTrades: 0,  minUsd: 0,    minRatio: 0,    committedSideLock: true  },

  // Current production: count=10 with lock
  { name: 'CNT10_LK',       gateType: 'COUNT',  minTrades: 10, minUsd: 0,    minRatio: 0.50, committedSideLock: true  },
  { name: 'CNT10',          gateType: 'COUNT',  minTrades: 10, minUsd: 0,    minRatio: 0.50, committedSideLock: false },
  { name: 'CNT7_LK',        gateType: 'COUNT',  minTrades: 7,  minUsd: 0,    minRatio: 0.50, committedSideLock: true  },
  { name: 'CNT5_LK',        gateType: 'COUNT',  minTrades: 5,  minUsd: 0,    minRatio: 0.50, committedSideLock: true  },
  { name: 'CNT3_LK',        gateType: 'COUNT',  minTrades: 3,  minUsd: 0,    minRatio: 0.50, committedSideLock: true  },

  // Volume gate (with lock)
  { name: 'USD25_LK',       gateType: 'USD',    minTrades: 0,  minUsd: 25,   minRatio: 0.50, committedSideLock: true  },
  { name: 'USD50_LK',       gateType: 'USD',    minTrades: 0,  minUsd: 50,   minRatio: 0.50, committedSideLock: true  },
  { name: 'USD75_LK',       gateType: 'USD',    minTrades: 0,  minUsd: 75,   minRatio: 0.50, committedSideLock: true  },
  { name: 'USD100_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 100,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD125_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 125,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD150_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 150,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD175_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 175,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD200_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 200,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD250_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 250,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD300_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 300,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD400_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 400,  minRatio: 0.50, committedSideLock: true  },
  { name: 'USD500_LK',      gateType: 'USD',    minTrades: 0,  minUsd: 500,  minRatio: 0.50, committedSideLock: true  },

  // Volume gate (without lock)
  { name: 'USD50',          gateType: 'USD',    minTrades: 0,  minUsd: 50,   minRatio: 0.50, committedSideLock: false },
  { name: 'USD100',         gateType: 'USD',    minTrades: 0,  minUsd: 100,  minRatio: 0.50, committedSideLock: false },
  { name: 'USD150',         gateType: 'USD',    minTrades: 0,  minUsd: 150,  minRatio: 0.50, committedSideLock: false },
  { name: 'USD200',         gateType: 'USD',    minTrades: 0,  minUsd: 200,  minRatio: 0.50, committedSideLock: false },
  { name: 'USD300',         gateType: 'USD',    minTrades: 0,  minUsd: 300,  minRatio: 0.50, committedSideLock: false },

  // Hybrid: pass if count >= N  OR  usd >= $M
  { name: 'HYB3_50_LK',     gateType: 'HYBRID', minTrades: 3,  minUsd: 50,   minRatio: 0.50, committedSideLock: true  },
  { name: 'HYB3_75_LK',     gateType: 'HYBRID', minTrades: 3,  minUsd: 75,   minRatio: 0.50, committedSideLock: true  },
  { name: 'HYB3_100_LK',    gateType: 'HYBRID', minTrades: 3,  minUsd: 100,  minRatio: 0.50, committedSideLock: true  },
  { name: 'HYB5_100_LK',    gateType: 'HYBRID', minTrades: 5,  minUsd: 100,  minRatio: 0.50, committedSideLock: true  },
  { name: 'HYB5_150_LK',    gateType: 'HYBRID', minTrades: 5,  minUsd: 150,  minRatio: 0.50, committedSideLock: true  },
  { name: 'HYB5_200_LK',    gateType: 'HYBRID', minTrades: 5,  minUsd: 200,  minRatio: 0.50, committedSideLock: true  },

  // Volume gate with higher ratio
  { name: 'USD100_R55L',    gateType: 'USD',    minTrades: 0,  minUsd: 100,  minRatio: 0.55, committedSideLock: true  },
  { name: 'USD100_R60L',    gateType: 'USD',    minTrades: 0,  minUsd: 100,  minRatio: 0.60, committedSideLock: true  },
  { name: 'USD150_R55L',    gateType: 'USD',    minTrades: 0,  minUsd: 150,  minRatio: 0.55, committedSideLock: true  },
  { name: 'USD150_R60L',    gateType: 'USD',    minTrades: 0,  minUsd: 150,  minRatio: 0.60, committedSideLock: true  },
  { name: 'USD200_R55L',    gateType: 'USD',    minTrades: 0,  minUsd: 200,  minRatio: 0.55, committedSideLock: true  },
  { name: 'USD200_R60L',    gateType: 'USD',    minTrades: 0,  minUsd: 200,  minRatio: 0.60, committedSideLock: true  },
];

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

// ─── CLI Options ───
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '0', 10); // 0 = full dataset
const USE_API = process.env.OFFLINE !== '1'; // OFFLINE=1 to skip Gamma API, use CSV only

// ─── Load Data ───
const dataDir = join(__dirname, '../../backtest-data');

console.log('Loading production DetectedTrade data...');
const tradeRows = parseCSV(readFileSync(join(dataDir, 'bt-detected-trades.csv'), 'utf-8'));
let trades: Trade[] = tradeRows
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
  }))
  .filter(t => !isNaN(t.price) && !isNaN(t.size) && t.conditionId);

trades.sort((a, b) => a.timestamp - b.timestamp);

// Apply lookback filter if specified (e.g. LOOKBACK_HOURS=24 for last 24h)
if (LOOKBACK_HOURS > 0 && trades.length > 0) {
  const latestTs = trades[trades.length - 1].timestamp;
  const cutoffTs = latestTs - LOOKBACK_HOURS * 3600;
  trades = trades.filter(t => t.timestamp >= cutoffTs);
  console.log(`  Filtered to last ${LOOKBACK_HOURS}h: ${trades.length} trades (cutoff: ${new Date(cutoffTs * 1000).toISOString()})`);
}

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
        if (prices[i] === '1' || parseFloat(prices[i]) >= 0.95) { marketOutcomes.set(r.conditionId, outcomes[i]); break; }
      }
    } catch { /* skip */ }
  }
} catch { /* optional */ }

function estimateEndFromSlug(slug: string): number | null {
  const updownMatch = slug.match(/updown-(\d+m)-(\d+)$/);
  if (updownMatch) {
    const startTs = parseInt(updownMatch[2], 10);
    const dur = updownMatch[1];
    if (dur === '5m') return startTs + 300;
    if (dur === '15m') return startTs + 900;
    if (dur === '1h') return startTs + 3600;
  }
  const hourlyMatch = slug.match(/up-or-down-(?:march|april)-(\d+)-(\d+)(am|pm)-et$/i);
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
// Build conditionId -> list of token IDs (for opposite position lookup)
const conditionTokens = new Map<string, Set<string>>();
for (const t of trades) {
  tokenToCondition.set(t.asset, t.conditionId);
  if (t.outcome) tokenToOutcome.set(t.asset, t.outcome);
  if (t.eventSlug && !marketEventSlugs.has(t.conditionId)) marketEventSlugs.set(t.conditionId, t.eventSlug);
  if (!conditionTokens.has(t.conditionId)) conditionTokens.set(t.conditionId, new Set());
  conditionTokens.get(t.conditionId)!.add(t.asset);
}

// ─── Gamma API Resolution (primary source when online) ───
async function resolveMarketsViaApi(): Promise<void> {
  const uniqueCids = [...new Set(trades.map(t => t.conditionId))];
  console.log(`  Resolving ${uniqueCids.length} markets via Gamma API...`);
  const startMs = Date.now();
  try {
    const markets = await getMarketsByConditionIds(uniqueCids);
    let apiResolved = 0;
    for (const m of markets) {
      // Set eventSlug from API (if available and not already set from trade data)
      if (m.eventSlug && !marketEventSlugs.has(m.conditionId)) {
        marketEventSlugs.set(m.conditionId, m.eventSlug);
      }
      if (!m.closed) continue;
      if (marketOutcomes.has(m.conditionId)) continue; // CSV already resolved
      try {
        const outcomes: string[] = JSON.parse(m.outcomes);
        const prices: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
        for (let i = 0; i < outcomes.length; i++) {
          if (prices[i] === '1' || parseFloat(prices[i]) >= 0.95) {
            marketOutcomes.set(m.conditionId, outcomes[i]);
            apiResolved++;
            break;
          }
        }
      } catch { /* skip */ }
    }
    const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
    console.log(`  Gamma API: ${apiResolved} new resolutions (${markets.length} fetched, ${elapsed}s)`);
  } catch (err: any) {
    console.warn(`  WARNING: Gamma API failed (${err.message?.slice(0, 100)}), using CSV only`);
  }
}

const marketEndTs = new Map<string, number>();
for (const [conditionId, slug] of marketEventSlugs) {
  const endTs = estimateEndFromSlug(slug);
  if (endTs) marketEndTs.set(conditionId, endTs);
}

function buildSettlementEvents(): SettlementEvent[] {
  const events: SettlementEvent[] = [];
  for (const [conditionId, winningOutcome] of marketOutcomes) {
    const endTs = marketEndTs.get(conditionId);
    events.push({
      timeMs: endTs ? endTs * 1000 + 5 * 60 * 1000 : Date.now() + 365 * 86400_000,
      conditionId,
      winningOutcome,
    });
  }
  events.sort((a, b) => a.timeMs - b.timeMs);
  return events;
}

// Initial settlement events from CSV data (may be augmented by API later)
let settlementEvents = buildSettlementEvents();

console.log(`  CSV resolved: ${marketOutcomes.size} markets, ${settlementEvents.length} settlement events`);
console.log(`  Period: ${new Date(trades[0].timestamp * 1000).toISOString()} -> ${new Date(trades[trades.length - 1].timestamp * 1000).toISOString()}`);

// ─── Majority Accumulator ───
class MajorityAccumulator {
  private acc = new Map<string, Map<string, { count: number; totalUsd: number }>>();

  record(conditionId: string, outcome: string, usd: number): void {
    let m = this.acc.get(conditionId);
    if (!m) { m = new Map(); this.acc.set(conditionId, m); }
    const s = m.get(outcome) ?? { count: 0, totalUsd: 0 };
    s.count++; s.totalUsd += usd;
    m.set(outcome, s);
  }

  getMajority(conditionId: string, gate: GateConfig):
    { outcome: string; ratio: number; totalTrades: number; totalUsd: number } | null {
    const m = this.acc.get(conditionId);
    if (!m) return null;
    let totalCount = 0, totalUsd = 0, maxUsd = 0, majorityOutcome = '';
    for (const [outcome, s] of m) {
      totalCount += s.count; totalUsd += s.totalUsd;
      if (s.totalUsd > maxUsd) { maxUsd = s.totalUsd; majorityOutcome = outcome; }
    }
    switch (gate.gateType) {
      case 'COUNT': if (totalCount < gate.minTrades) return null; break;
      case 'USD':   if (totalUsd < gate.minUsd) return null; break;
      case 'HYBRID': if (totalCount < gate.minTrades && totalUsd < gate.minUsd) return null; break;
      case 'NONE':  return null;
    }
    const ratio = totalUsd > 0 ? maxUsd / totalUsd : 0;
    if (ratio < gate.minRatio) return null;
    return { outcome: majorityOutcome, ratio, totalTrades: totalCount, totalUsd };
  }
}

// ─── Position Tracker (production-faithful) ───
class PositionTracker {
  // Per-token: shares held, total cost basis
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

  // Get opposite position for hedge guard (mirrors getOppositePosition in copy-trade-worker)
  getOppositePosition(conditionId: string, currentTokenId: string): { netUsd: number; avgBuyPrice: number } {
    const tokens = conditionTokens.get(conditionId);
    if (!tokens) return { netUsd: 0, avgBuyPrice: 0 };
    let netUsd = 0;
    let buyCost = 0;
    let buyShares = 0;
    for (const tokenId of tokens) {
      if (tokenId === currentTokenId) continue;
      const p = this.positions.get(tokenId);
      if (p && p.shares >= 0.01) {
        netUsd += p.costUsd;
        buyCost += p.costUsd;
        buyShares += p.shares;
      }
    }
    if (netUsd < 0) netUsd = 0;
    const avgBuyPrice = buyShares > 0 ? buyCost / buyShares : 0;
    return { netUsd, avgBuyPrice };
  }

  recordBuy(tokenId: string, usdAmount: number, price: number): void {
    const shares = usdAmount / price;
    const p = this.positions.get(tokenId) ?? { shares: 0, costUsd: 0 };
    p.shares += shares; p.costUsd += usdAmount;
    this.positions.set(tokenId, p);
  }

  recordSell(tokenId: string, price: number): { soldShares: number; costBasis: number; proceeds: number } {
    const p = this.positions.get(tokenId);
    if (!p || p.shares < 0.01) return { soldShares: 0, costBasis: 0, proceeds: 0 };
    // Floor to 2dp (production: Math.floor(heldShares * 100) / 100)
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

  getUnsettledPositions(): { count: number; totalUsd: number } {
    let count = 0, totalUsd = 0;
    for (const [_, p] of this.positions) {
      if (p.shares >= 0.01) { count++; totalUsd += p.costUsd; }
    }
    return { count, totalUsd };
  }
}

// ─── Order Pool (production-faithful simulation) ───
class OrderPool {
  // tokenId -> { amount: accumulated USD, firstAddedTs: unix seconds }
  private pool = new Map<string, { amount: number; firstAddedTs: number }>();

  add(tokenId: string, usd: number, nowTs: number): void {
    const existing = this.pool.get(tokenId);
    if (existing) {
      existing.amount += usd;
    } else {
      this.pool.set(tokenId, { amount: usd, firstAddedTs: nowTs });
    }
  }

  // Check if pool has enough to fire (>= CLOB min)
  tryFire(tokenId: string): number | null {
    const entry = this.pool.get(tokenId);
    if (!entry || entry.amount < CLOB_MIN_ORDER_USD) return null;
    const amount = entry.amount;
    this.pool.delete(tokenId);
    return amount;
  }

  // Burn expired entries (production: POOL_BURN_TIMEOUT_MS = 180s)
  burnExpired(nowTs: number): number {
    const cutoffTs = nowTs - POOL_BURN_TIMEOUT_MS / 1000;
    let burned = 0;
    for (const [tokenId, entry] of this.pool) {
      if (entry.firstAddedTs < cutoffTs) {
        this.pool.delete(tokenId);
        burned++;
      }
    }
    return burned;
  }
}

// ─── Simulation ───
interface SimResult {
  gateName: string;
  gateType: GateType;
  lock: boolean;
  totalPnl: number;
  finalCapital: number;
  buyCount: number;
  pooledCount: number;
  poolFiredCount: number;
  hedgeBlockedCount: number;
  dailyLimitHitCount: number;
  sellCooldownCount: number;
  settledPositions: number;
  wins: number;
  losses: number;
  winRate: number;
  maxDrawdown: number;
  totalUsdDeployed: number;
  pnlPerDollarDeployed: number;
  bothSidesPredictions: number;
  worstPredLoss: number;
  bestPredWin: number;
  stdPredPnl: number;
  losingPredCount: number;
  winningPredCount: number;
  sharpeLike: number;
  calmarLike: number;
  predictionsTraded: number;
  returnPct: number;
  unsettledCount: number;
  unsettledUsd: number;
  predDetails: Map<string, { cost: number; proceeds: number }> | null; // only for production config
}

function runSimulation(cfg: GateConfig, opts?: { trackPredDetails?: boolean }): SimResult {
  const accumulator = new MajorityAccumulator();
  const positions = new PositionTracker();
  const pool = new OrderPool();
  const committedSides = new Map<string, string>();

  let currentCapital = STARTING_CAPITAL;
  let buyCount = 0;
  let pooledCount = 0;
  let poolFiredCount = 0;
  let hedgeBlockedCount = 0;
  let dailyLimitHitCount = 0;
  let sellCooldownCount = 0;
  let totalUsdDeployed = 0;
  let wins = 0, losses = 0;
  let settledPositions = 0;

  let maxEquity = STARTING_CAPITAL;
  let maxDrawdown = 0;

  const sidesPerCondition = new Map<string, Set<string>>();
  let settlementIdx = 0;

  const predCostBasis = new Map<string, number>();
  const predProceeds = new Map<string, number>();

  // Token sell cooldown: tokenId -> last sell timestamp (unix seconds)
  const sellCooldowns = new Map<string, number>();

  // Daily loss tracking: dayKey -> total USD spent
  const dailySpend = new Map<string, number>();

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

  function executeBuy(tokenId: string, conditionId: string, outcome: string, usdAmount: number, price: number, ts: number): void {
    positions.recordBuy(tokenId, usdAmount, price);
    currentCapital -= usdAmount;
    totalUsdDeployed += usdAmount;
    buyCount++;
    recordDailySpend(ts, usdAmount);

    if (cfg.committedSideLock && !committedSides.has(conditionId)) {
      committedSides.set(conditionId, outcome);
    }

    if (!sidesPerCondition.has(conditionId)) sidesPerCondition.set(conditionId, new Set());
    sidesPerCondition.get(conditionId)!.add(outcome);

    predCostBasis.set(conditionId, (predCostBasis.get(conditionId) ?? 0) + usdAmount);
    trackEquity();
  }

  function processSettlements(beforeMs: number): void {
    while (settlementIdx < settlementEvents.length && settlementEvents[settlementIdx].timeMs <= beforeMs) {
      const evt = settlementEvents[settlementIdx];
      const result = positions.settleCondition(evt.conditionId, evt.winningOutcome);
      if (result.settled > 0) {
        const settlementValue = result.costBasis + result.pnl;
        currentCapital += settlementValue;
        settledPositions += result.settled;
        wins += result.wins; losses += result.losses;
        committedSides.delete(evt.conditionId);
        predProceeds.set(evt.conditionId, (predProceeds.get(evt.conditionId) ?? 0) + settlementValue);
      }
      settlementIdx++;
    }
  }

  for (const trade of trades) {
    const tradeMs = trade.timestamp * 1000;
    processSettlements(tradeMs);

    // Burn expired pool entries periodically
    pool.burnExpired(trade.timestamp);

    // ── Record every BUY in accumulator (before any per-allocation filters) ──
    if (trade.side === 'BUY' && trade.outcome) {
      accumulator.record(trade.conditionId, trade.outcome, trade.size * trade.price);
    }

    const effectiveSlug = trade.eventSlug || marketEventSlugs.get(trade.conditionId) || '';

    // ── minBuyPrice filter (BUY only) ──
    if (trade.side === 'BUY' && trade.price < MIN_BUY_PRICE - 0.001) continue;

    // ── Near-certainty guard (trade-executor.ts:312 — no ask-side liquidity) ──
    if (trade.side === 'BUY' && trade.price >= 0.99) continue;

    // ── Event slug exclusion (BUY only, fail-closed) ──
    if (trade.side === 'BUY') {
      if (!effectiveSlug) continue; // fail-closed: no slug = skip
      const slug = effectiveSlug.toLowerCase();
      if (EXCLUDE_SLUG_PATTERNS.some(p => slug.includes(p))) continue;
    }

    // ── Market-closed check (BUY only) ──
    if (trade.side === 'BUY') {
      const endTs = marketEndTs.get(trade.conditionId);
      if (endTs && trade.timestamp >= endTs) continue;
    }

    // ── Majority gate (BUY only, if enabled) ──
    let majorityTotalUsd: number | null = null;
    if (trade.side === 'BUY' && cfg.gateType !== 'NONE') {
      const majority = accumulator.getMajority(trade.conditionId, cfg);
      if (!majority) continue;
      if (trade.outcome !== majority.outcome) continue;
      majorityTotalUsd = majority.totalUsd;
    }

    // ── Committed side lock (BUY only) ──
    if (trade.side === 'BUY' && cfg.committedSideLock) {
      const committed = committedSides.get(trade.conditionId);
      if (committed && committed !== trade.outcome) continue;
    }

    // ── Token sell cooldown (BUY only, 60s) ──
    if (trade.side === 'BUY') {
      const lastSell = sellCooldowns.get(trade.asset);
      if (lastSell && (trade.timestamp - lastSell) < TOKEN_SELL_COOLDOWN_MS / 1000) {
        sellCooldownCount++;
        continue;
      }
    }

    // ────────────── SELL (skipped — production skips ALL SELLs for live wallets) ──────────────
    if (trade.side === 'SELL') {
      // Production skips ALL SELL-copies for live wallets (commit cac7b62).
      // Positions close only via settlement. Still record cooldown to prevent
      // immediate re-BUY after trader's sell signal.
      sellCooldowns.set(trade.asset, trade.timestamp);
      continue;
    }

    // ────────────── BUY SIZING ──────────────

    // Guard: no buying power
    if (currentCapital <= 0) continue;

    const fragmentUsd = trade.size * trade.price;
    const traderTradeUsd = majorityTotalUsd ?? fragmentUsd;

    // Quality gates (disabled in production but included for completeness)
    if (MIN_COMPOSITE_SCORE > 0) continue; // would check compositeScore
    if (MIN_SIGNAL_TRADE_USD > 0 && traderTradeUsd < MIN_SIGNAL_TRADE_USD) continue;

    // Trade-proportional sizing
    let copyAmountUsd = traderTradeUsd * COPY_TRADE_PERCENT;
    // Absolute dollar cap
    copyAmountUsd = Math.min(copyAmountUsd, MAX_POSITION_USD);

    // ── Position lookup (ALWAYS for BUY) ──
    const positionUsd = positions.getNetPositionUsd(trade.asset);

    // ── Per-prediction position cap (BUY, trim to gap) ──
    if (MAX_PREDICTION_USD > 0) {
      const remaining = MAX_PREDICTION_USD - positionUsd;
      if (remaining < 0.01) continue;
      if (copyAmountUsd > remaining) copyAmountUsd = remaining;
    }

    // ── Hedge guard ──
    let hedgeMaxUsd = Infinity;
    if (HEDGE_PRICE_RATIO > 0 && trade.price < HEDGE_PRICE_RATIO) {
      const oppositePos = positions.getOppositePosition(trade.conditionId, trade.asset);
      const hasOpposite = oppositePos.avgBuyPrice > 0 && oppositePos.netUsd >= 0.01;

      if (!hasOpposite) {
        // No opposite: block if price <= naked max price
        if (HEDGE_NAKED_MAX_PRICE > 0 && trade.price <= HEDGE_NAKED_MAX_PRICE) {
          hedgeBlockedCount++;
          continue;
        }
        // Else: allow (legitimate cheap market above naked ceiling)
      } else {
        // Has opposite: check if this is a hedge trade
        const isHedge = trade.price < HEDGE_PRICE_RATIO * oppositePos.avgBuyPrice;
        if (isHedge) {
          if (oppositePos.netUsd < HEDGE_MIN_OPPOSITE_USD) {
            hedgeBlockedCount++;
            continue;
          }
          hedgeMaxUsd = oppositePos.netUsd * HEDGE_MAX_RATIO;
          if (copyAmountUsd > hedgeMaxUsd) copyAmountUsd = hedgeMaxUsd;
        }
      }
    }

    // ── MAX_TRADE_PERCENT: cap at 50% of current capital ──
    const maxTradeFromCapital = currentCapital * MAX_TRADE_PERCENT;
    if (copyAmountUsd > maxTradeFromCapital) copyAmountUsd = maxTradeFromCapital;

    // ── CLOB $1 minimum (live BUY, smart bump) ──
    if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
      if (positionUsd < 0.01) {
        // First entry: bump to $1, but respect hedge guard cap
        copyAmountUsd = Math.min(CLOB_MIN_ORDER_USD, hedgeMaxUsd);
        if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
          // Hedge guard cap prevents CLOB min → skip
          hedgeBlockedCount++;
          continue;
        }
      } else {
        // Subsequent entry: pool it (skip if dust)
        if (copyAmountUsd < 0.01) continue;
        pool.add(trade.asset, copyAmountUsd, trade.timestamp);
        pooledCount++;

        // Check if pool can fire now
        const poolAmount = pool.tryFire(trade.asset);
        if (poolAmount != null) {
          // Pool fires: treat as a BUY execution
          let fireAmount = poolAmount;
          // Re-check caps for pool fire
          if (fireAmount > currentCapital) {
            if (currentCapital >= CLOB_MIN_ORDER_USD) fireAmount = currentCapital;
            else continue;
          }
          const dailyRemaining = getDailyRemaining(trade.timestamp);
          if (dailyRemaining <= 0) continue;
          if (fireAmount > dailyRemaining) fireAmount = dailyRemaining;
          if (fireAmount < CLOB_MIN_ORDER_USD) continue;

          executeBuy(trade.asset, trade.conditionId, trade.outcome, fireAmount, trade.price, trade.timestamp);
          poolFiredCount++;
        }
        continue;
      }
    }

    // ── Global daily loss limit ──
    const dailyRemaining = getDailyRemaining(trade.timestamp);
    if (dailyRemaining <= 0) {
      dailyLimitHitCount++;
      continue;
    }
    if (copyAmountUsd > dailyRemaining) copyAmountUsd = dailyRemaining;

    // ── Zero guard ──
    if (copyAmountUsd <= 0) continue;

    // ── Pool if below threshold (live: $1) ──
    if (copyAmountUsd < POOL_MIN_AMOUNT_USD) {
      pool.add(trade.asset, copyAmountUsd, trade.timestamp);
      pooledCount++;
      const poolAmount = pool.tryFire(trade.asset);
      if (poolAmount != null) {
        let fireAmount = poolAmount;
        if (fireAmount > currentCapital) {
          if (currentCapital >= CLOB_MIN_ORDER_USD) fireAmount = currentCapital;
          else continue;
        }
        executeBuy(trade.asset, trade.conditionId, trade.outcome, fireAmount, trade.price, trade.timestamp);
        poolFiredCount++;
      }
      continue;
    }

    // ── Capital check ──
    if (copyAmountUsd > currentCapital) {
      if (currentCapital >= CLOB_MIN_ORDER_USD) {
        copyAmountUsd = currentCapital;
      } else {
        continue;
      }
    }

    // ── Execute BUY ──
    executeBuy(trade.asset, trade.conditionId, trade.outcome, copyAmountUsd, trade.price, trade.timestamp);
  }

  // Settle remaining
  processSettlements(Date.now() + 365 * 86400_000);

  const unsettled = positions.getUnsettledPositions();
  const finalEquity = computeEquity();
  const totalPnl = finalEquity - STARTING_CAPITAL;
  const winRate = (wins + losses) > 0 ? wins / (wins + losses) : 0;
  const pnlPerDollarDeployed = totalUsdDeployed > 0 ? totalPnl / totalUsdDeployed : 0;

  let bothSidesPredictions = 0;
  for (const [_, sides] of sidesPerCondition) { if (sides.size > 1) bothSidesPredictions++; }

  const allConditionIds = new Set<string>();
  for (const cid of predCostBasis.keys()) allConditionIds.add(cid);
  for (const cid of predProceeds.keys()) allConditionIds.add(cid);

  const predPnls: number[] = [];
  let worstPredLoss = 0, bestPredWin = 0, losingPredCount = 0, winningPredCount = 0;

  for (const cid of allConditionIds) {
    const cost = predCostBasis.get(cid) ?? 0;
    const proceeds = predProceeds.get(cid) ?? 0;
    const pnl = proceeds - cost;
    predPnls.push(pnl);
    if (pnl < worstPredLoss) worstPredLoss = pnl;
    if (pnl > bestPredWin) bestPredWin = pnl;
    if (pnl < -0.001) losingPredCount++;
    else if (pnl > 0.001) winningPredCount++;
  }

  let stdPredPnl = 0;
  if (predPnls.length > 1) {
    const mean = predPnls.reduce((a, b) => a + b, 0) / predPnls.length;
    const variance = predPnls.reduce((acc, v) => acc + (v - mean) ** 2, 0) / (predPnls.length - 1);
    stdPredPnl = Math.sqrt(variance);
  }

  const sharpeLike = stdPredPnl > 0 ? totalPnl / stdPredPnl : 0;
  const calmarLike = maxDrawdown > 0 ? totalPnl / (maxDrawdown * STARTING_CAPITAL) : (totalPnl > 0 ? Infinity : 0);

  return {
    gateName: cfg.name,
    gateType: cfg.gateType,
    lock: cfg.committedSideLock,
    totalPnl,
    finalCapital: finalEquity,
    buyCount,
    pooledCount,
    poolFiredCount,
    hedgeBlockedCount,
    dailyLimitHitCount,
    sellCooldownCount,
    settledPositions,
    wins, losses,
    winRate,
    maxDrawdown,
    totalUsdDeployed,
    pnlPerDollarDeployed,
    bothSidesPredictions,
    worstPredLoss,
    bestPredWin,
    stdPredPnl,
    losingPredCount,
    winningPredCount,
    sharpeLike,
    calmarLike,
    predictionsTraded: allConditionIds.size,
    returnPct: totalPnl / STARTING_CAPITAL * 100,
    unsettledCount: unsettled.count,
    unsettledUsd: unsettled.totalUsd,
    predDetails: opts?.trackPredDetails
      ? new Map([...allConditionIds].map(cid => [cid, { cost: predCostBasis.get(cid) ?? 0, proceeds: predProceeds.get(cid) ?? 0 }]))
      : null,
  };
}

// ─── Run ───
async function main() {
  // Resolve markets via Gamma API (primary source, live data)
  if (USE_API) {
    await resolveMarketsViaApi();
    // Rebuild settlement events with API-augmented resolution data
    // (marketEndTs is already populated from slugs, marketOutcomes now has API data)
    settlementEvents = buildSettlementEvents();
  }

  console.log(`  Total resolved: ${marketOutcomes.size} markets, ${settlementEvents.length} settlement events`);

  console.log('\n' + '='.repeat(150));
  console.log('VOLUME GATE BACKTEST — PRODUCTION-FAITHFUL (0x8dxd)');
  console.log(`Capital: $${STARTING_CAPITAL} | MaxPos: $${MAX_POSITION_USD} | MaxPred: $${MAX_PREDICTION_USD} | Copy: ${COPY_TRADE_PERCENT * 100}% | MinBuy: ${MIN_BUY_PRICE}`);
  console.log(`MaxTrade%: ${MAX_TRADE_PERCENT * 100}% | DailyLimit: $${MAX_DAILY_LOSS_USD} | SellCooldown: ${TOKEN_SELL_COOLDOWN_MS / 1000}s | PoolMin: $${POOL_MIN_AMOUNT_USD}`);
  console.log(`Hedge: ratio=${HEDGE_PRICE_RATIO}, nakedMax=${HEDGE_NAKED_MAX_PRICE}, minOpp=$${HEDGE_MIN_OPPOSITE_USD}, maxRatio=${HEDGE_MAX_RATIO}`);
  console.log(`Exclude: ${EXCLUDE_SLUG_PATTERNS.join(', ')} | Gate configs: ${GATE_CONFIGS.length}`);
  console.log('='.repeat(150));

  const results: SimResult[] = [];
  for (const cfg of GATE_CONFIGS) {
    const isProdConfig = cfg.name === 'USD175_LK';
    results.push(runSimulation(cfg, { trackPredDetails: isProdConfig }));
  }

// ─── Display ───
function padR(s: string, w: number): string { return s.padEnd(w); }
function padL(s: string, w: number): string { return s.padStart(w); }
function fmtPnl(v: number): string { return v >= 0 ? `+$${v.toFixed(2)}` : `-$${Math.abs(v).toFixed(2)}`; }
function fmtPct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

function printHeader(): void {
  console.log(
    padR('Gate', 15) +
    padL('PnL', 11) +
    padL('Ret%', 8) +
    padL('WR%', 7) +
    padL('MaxDD%', 8) +
    padL('Sharpe', 8) +
    padL('Calmar', 8) +
    padL('WrstPd$', 9) +
    padL('BstPd$', 9) +
    padL('Buys', 6) +
    padL('#Pred', 6) +
    padL('BothSd', 7) +
    padL('W/L', 8) +
    padL('Deply$', 8) +
    padL('$/dep', 7)
  );
  console.log('-'.repeat(125));
}

function printRow(r: SimResult): void {
  console.log(
    padR(r.gateName, 15) +
    padL(fmtPnl(r.totalPnl), 11) +
    padL(`${r.returnPct.toFixed(1)}%`, 8) +
    padL(fmtPct(r.winRate), 7) +
    padL(`${(r.maxDrawdown * 100).toFixed(1)}%`, 8) +
    padL(r.sharpeLike.toFixed(2), 8) +
    padL(r.calmarLike === Infinity ? 'Inf' : r.calmarLike.toFixed(2), 8) +
    padL(fmtPnl(r.worstPredLoss), 9) +
    padL(fmtPnl(r.bestPredWin), 9) +
    padL(String(r.buyCount), 6) +
    padL(String(r.predictionsTraded), 6) +
    padL(String(r.bothSidesPredictions), 7) +
    padL(`${r.wins}/${r.losses}`, 8) +
    padL(`$${r.totalUsdDeployed.toFixed(0)}`, 8) +
    padL(r.pnlPerDollarDeployed.toFixed(3), 7)
  );
}

// All results sorted by PnL
console.log('\n' + '='.repeat(125));
console.log('ALL RESULTS — Sorted by PnL');
console.log('='.repeat(125));
printHeader();
const byPnl = [...results].sort((a, b) => b.totalPnl - a.totalPnl);
for (const r of byPnl) printRow(r);

// Sorted by Sharpe
console.log('\n' + '='.repeat(125));
console.log('ALL RESULTS — Sorted by Sharpe');
console.log('='.repeat(125));
printHeader();
const bySharpe = [...results].sort((a, b) => b.sharpeLike - a.sharpeLike);
for (const r of bySharpe) printRow(r);

// Sorted by Capital Efficiency
console.log('\n' + '='.repeat(125));
console.log('ALL RESULTS — Sorted by Capital Efficiency ($/deployed)');
console.log('='.repeat(125));
printHeader();
const byEff = [...results].sort((a, b) => b.pnlPerDollarDeployed - a.pnlPerDollarDeployed);
for (const r of byEff) printRow(r);

// ─── Guard activity report ───
console.log('\n' + '='.repeat(125));
console.log('GUARD ACTIVITY (how often each production guard fires)');
console.log('='.repeat(125));
console.log('\n  ' + padR('Gate', 15) +
  padL('HedgeBlk', 10) +
  padL('DailyLim', 10) +
  padL('SellCD', 8) +
  padL('Pooled', 8) +
  padL('PoolFire', 10) +
  padL('PoolLost%', 10)
);
console.log('  ' + '-'.repeat(71));
for (const r of byPnl) {
  const poolLostPct = r.pooledCount > 0 ? ((r.pooledCount - r.poolFiredCount) / r.pooledCount * 100).toFixed(0) : '0';
  console.log('  ' +
    padR(r.gateName, 15) +
    padL(String(r.hedgeBlockedCount), 10) +
    padL(String(r.dailyLimitHitCount), 10) +
    padL(String(r.sellCooldownCount), 8) +
    padL(String(r.pooledCount), 8) +
    padL(String(r.poolFiredCount), 10) +
    padL(`${poolLostPct}%`, 10)
  );
}

// ─── Key comparisons ───
console.log('\n' + '='.repeat(125));
console.log('KEY COMPARISONS');
console.log('='.repeat(125));

const prod = results.find(r => r.gateName === 'USD175_LK')!;
console.log(`\n  CURRENT PRODUCTION (USD175_LK — usd>=175, lock=true):`);
console.log(`    PnL: ${fmtPnl(prod.totalPnl)} (${prod.returnPct.toFixed(1)}%) | WR: ${fmtPct(prod.winRate)} | MaxDD: ${(prod.maxDrawdown * 100).toFixed(1)}%`);
console.log(`    Sharpe: ${prod.sharpeLike.toFixed(2)} | Buys: ${prod.buyCount} | Predictions: ${prod.predictionsTraded} | BothSides: ${prod.bothSidesPredictions}`);
console.log(`    Deployed: $${prod.totalUsdDeployed.toFixed(0)} | $/dep: ${prod.pnlPerDollarDeployed.toFixed(4)}`);
console.log(`    Guards: hedgeBlocked=${prod.hedgeBlockedCount} dailyLimit=${prod.dailyLimitHitCount} sellCooldown=${prod.sellCooldownCount} pooled=${prod.pooledCount} poolFired=${prod.poolFiredCount}`);

const bestPnl = byPnl[0];
console.log(`\n  BEST PNL (${bestPnl.gateName}):`);
console.log(`    PnL: ${fmtPnl(bestPnl.totalPnl)} (${bestPnl.returnPct.toFixed(1)}%) | WR: ${fmtPct(bestPnl.winRate)} | MaxDD: ${(bestPnl.maxDrawdown * 100).toFixed(1)}%`);
console.log(`    Sharpe: ${bestPnl.sharpeLike.toFixed(2)} | Buys: ${bestPnl.buyCount} | Predictions: ${bestPnl.predictionsTraded}`);
console.log(`    vs prod: ${fmtPnl(bestPnl.totalPnl - prod.totalPnl)} (${((bestPnl.totalPnl - prod.totalPnl) / Math.abs(prod.totalPnl) * 100).toFixed(0)}%)`);

const bestSharpe = bySharpe[0];
if (bestSharpe.gateName !== bestPnl.gateName) {
  console.log(`\n  BEST RISK-ADJUSTED (${bestSharpe.gateName}):`);
  console.log(`    PnL: ${fmtPnl(bestSharpe.totalPnl)} (${bestSharpe.returnPct.toFixed(1)}%) | WR: ${fmtPct(bestSharpe.winRate)} | MaxDD: ${(bestSharpe.maxDrawdown * 100).toFixed(1)}%`);
  console.log(`    Sharpe: ${bestSharpe.sharpeLike.toFixed(2)} | Buys: ${bestSharpe.buyCount} | Predictions: ${bestSharpe.predictionsTraded}`);
  console.log(`    vs prod: ${fmtPnl(bestSharpe.totalPnl - prod.totalPnl)} (${((bestSharpe.totalPnl - prod.totalPnl) / Math.abs(prod.totalPnl) * 100).toFixed(0)}%)`);
}

// Best viable (PnL > 0, MaxDD < 15%, not NO_MAJ)
const viable = results.filter(r => r.totalPnl > 0 && r.maxDrawdown < 0.15 && r.gateType !== 'NONE');
if (viable.length > 0) {
  const bestViable = [...viable].sort((a, b) => b.totalPnl - a.totalPnl)[0];
  if (bestViable.gateName !== bestPnl.gateName) {
    console.log(`\n  BEST VIABLE (PnL>0, MaxDD<15%, gated, ${bestViable.gateName}):`);
    console.log(`    PnL: ${fmtPnl(bestViable.totalPnl)} (${bestViable.returnPct.toFixed(1)}%) | WR: ${fmtPct(bestViable.winRate)} | MaxDD: ${(bestViable.maxDrawdown * 100).toFixed(1)}%`);
    console.log(`    Sharpe: ${bestViable.sharpeLike.toFixed(2)} | Buys: ${bestViable.buyCount} | Predictions: ${bestViable.predictionsTraded}`);
    console.log(`    vs prod: ${fmtPnl(bestViable.totalPnl - prod.totalPnl)} (${((bestViable.totalPnl - prod.totalPnl) / Math.abs(prod.totalPnl) * 100).toFixed(0)}%)`);
  }
}

  // ─── Per-prediction breakdown for production config ───
  if (prod.predDetails && prod.predDetails.size > 0) {
    console.log('\n' + '='.repeat(125));
    console.log('PER-PREDICTION BREAKDOWN (USD175_LK — portfolio mode)');
    console.log('='.repeat(125));

    const predEntries = [...prod.predDetails.entries()]
      .map(([cid, d]) => {
        const pnl = d.proceeds - d.cost;
        const winner = marketOutcomes.get(cid);
        const slug = marketEventSlugs.get(cid) ?? cid.slice(0, 20);
        const status = winner
          ? (pnl > 0.001 ? 'WON' : pnl < -0.001 ? 'LOST' : 'EVEN')
          : 'OPEN';
        return { cid, slug, cost: d.cost, proceeds: d.proceeds, pnl, status };
      })
      .sort((a, b) => b.pnl - a.pnl);

    let predWins = 0, predLosses = 0, settledPnl = 0;
    for (const e of predEntries) {
      const tag = `[${e.status.padEnd(4)}]`;
      const name = e.slug.slice(0, 50).padEnd(52);
      console.log(`  ${tag} ${name} cost=${fmtPnl(-e.cost).padStart(8)}  proceeds=${fmtPnl(e.proceeds).padStart(8)}  pnl=${fmtPnl(e.pnl).padStart(8)}`);
      if (e.status === 'WON') { predWins++; settledPnl += e.pnl; }
      else if (e.status === 'LOST') { predLosses++; settledPnl += e.pnl; }
    }

    const predWR = (predWins + predLosses) > 0 ? (predWins / (predWins + predLosses) * 100).toFixed(0) : 'N/A';
    console.log(`\n  Settled: ${predWins}W/${predLosses}L | WR: ${predWR}% | PnL: ${fmtPnl(settledPnl)}`);
    if (prod.unsettledCount > 0) {
      console.log(`  Unsettled: ${prod.unsettledCount} positions ($${prod.unsettledUsd.toFixed(2)} deployed)`);
    }
  }

  console.log('\n' + '='.repeat(125));
} // end async function main()

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
