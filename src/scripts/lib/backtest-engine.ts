/**
 * Shared Backtest Simulation Engine
 *
 * Single source of truth for copy-trade simulation logic used by:
 *   - backtest-single-trader.ts
 *   - batch-backtest-traders.ts
 *   - batch-backtest-config-sweep.ts
 *
 * Pure function — no module-level mutable state. Calibration data
 * is passed through SimConfig.
 */

// ─── Types ───

export interface TradeRow {
  conditionId: string;
  outcome: string;
  outcomeIndex: number | null;
  price: number;
  size: number;
  timestamp: number;
  side: string;
  eventSlug: string;
  question?: string;       // optional — only single-trader populates
  outcomePrices: string;
  outcomes: string;
  endDate: number | null;
  closed?: boolean;        // optional — only single-trader populates (for open market mark-to-market)
}

export interface SlippageModel {
  p50: number;
  p75: number;
  p90: number;
}

export interface SimConfig {
  copyPercent: number;
  maxTradeUsd: number;
  maxPredUsd: number;
  startingCapital: number;
  minBuyPrice: number;
  majorityGate: number;       // 0 = disabled
  excludeSlugs: string[];
  useCapitalLockup: boolean;
  followAll: boolean;
  seed: number;
  // Calibration (passed in, not loaded inside engine)
  empiricalSlippage: SlippageModel | null;
  fakFailureRate: number;
  // Feature flags
  includeOpenMarkets?: boolean;
  trackPredictions?: boolean;
}

export interface PredictionBreakdown {
  conditionId: string;
  question: string;
  eventSlug: string;
  traderBuys: number;
  traderSells: number;
  traderBuyUsd: number;
  traderSellUsd: number;
  copyBuys: number;
  copyDeployed: number;
  copyPnl: number;
  outcomeWon: boolean | null;
  copiedOutcome: string;
  marketClosed: boolean;
}

export interface SimResult {
  copyPnl: number;
  copyDeployed: number;
  copyRoi: number;
  copyWr: number;
  copyBuys: number;
  wins: number;
  losses: number;
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
  scalpPct: number;
  holdWr: number;
  pnlPerDay: number;
  daysActive: number;
  score: number;
  skips: {
    slug: number;
    price: number;
    gate: number;
    pred: number;
    fak: number;
    capital: number;
  };
  predictions: PredictionBreakdown[];
  config: SimConfig;
}

interface LockedPosition {
  deployedUsd: number;
  netShares: number;
  outcomeWon: boolean;
  resolvesAt: number;
  conditionId: string;
}

// ─── Constants ───

const FEE_RATE = 0.25;
const FEE_EXPONENT = 2;
const BUY_FAILURE_COOLDOWN_SEC = 15;
const FALLBACK_LOCKUP_SEC = 7 * 24 * 60 * 60;
export const FALLBACK_FAK_FAILURE_RATE = 0.12;

// ─── Utility Functions ───

export function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function resolveOutcomeIndex(trade: TradeRow): number | null {
  if (trade.outcomeIndex != null) return trade.outcomeIndex;
  try {
    const outcomes: string[] = JSON.parse(trade.outcomes);
    const idx = outcomes.findIndex(o => o.toLowerCase() === trade.outcome.toLowerCase());
    return idx >= 0 ? idx : null;
  } catch { return null; }
}

export function categorize(slug: string): string {
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

export function computeSlippage(cat: string, rng: () => number, model: SlippageModel | null): number {
  if (model) {
    const u = rng();
    const bps = u < 0.8
      ? model.p50 + (model.p75 - model.p50) * Math.sqrt(u / 0.8)
      : model.p75 + (model.p90 - model.p75) * ((u - 0.8) / 0.2);
    return Math.max(0, bps / 10000);
  }
  // Category-based fallback
  if (cat === '5m')  return 0.03 + 0.05 * rng();
  if (cat === '15m') return 0.02 + 0.04 * rng();
  if (cat === '1h')  return 0.02 + 0.03 * rng();
  return 0.01 + 0.02 * rng();
}

// ─── Scoring ───

export function computeScore(
  copyPnl: number, copyRoi: number, scalpPct: number,
  copyBuys: number, maxDdPct: number,
  minBuysForScore: number = 0,
): number {
  if (copyPnl <= 0 || copyBuys < minBuysForScore) return -1;
  const samplePenalty = Math.min(1, Math.log(1 + copyBuys) / Math.log(1 + 50));
  return copyRoi * (1 - scalpPct / 100) * samplePenalty * (1 / (1 + maxDdPct / 20));
}

// ─── Main Simulation ───

export function simulateCopy(
  trades: TradeRow[],
  config: SimConfig,
  priorTrades?: TradeRow[],
): SimResult {
  const {
    copyPercent, maxTradeUsd, maxPredUsd, startingCapital,
    minBuyPrice, majorityGate, excludeSlugs,
    useCapitalLockup, followAll, seed,
    empiricalSlippage, fakFailureRate,
    includeOpenMarkets, trackPredictions,
  } = config;

  const rng = mulberry32(seed);
  trades.sort((a, b) => a.timestamp - b.timestamp);

  let buyCount = 0, wins = 0, losses = 0;
  let peakPnl = 0, maxDd = 0;
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
  const catCounts = new Map<string, number>();
  const traderAccum = new Map<string, Map<string, number>>();
  const buyFailureCooldown = new Map<string, number>();
  const followAllPositions = new Map<string, { shares: number; costBasis: number; outcomeWon: boolean; endDateTs: number }>();

  // Per-prediction tracking (optional for performance)
  const predBreakdown = trackPredictions ? new Map<string, PredictionBreakdown>() : null;

  // Skip counters
  let skippedSlug = 0, skippedPrice = 0, skippedGate = 0;
  let skippedPred = 0, skippedFak = 0, skippedCapital = 0;

  // Warm up majority accumulator with prior trades
  if (priorTrades) {
    for (const t of priorTrades) {
      if (t.side !== 'BUY') continue;
      if (excludeSlugs.length > 0) {
        const slug = t.eventSlug.toLowerCase();
        if (excludeSlugs.some(p => slug.includes(p))) continue;
      }
      if (!traderAccum.has(t.conditionId)) traderAccum.set(t.conditionId, new Map());
      const om = traderAccum.get(t.conditionId)!;
      om.set(t.outcome, (om.get(t.outcome) ?? 0) + t.size * t.price);
    }
  }

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
      if (predBreakdown) {
        const pb = predBreakdown.get(pos.conditionId);
        if (pb) pb.copyPnl += pnl;
      }
    }
  }

  for (const trade of trades) {
    const cat = categorize(trade.eventSlug);
    const fillUsd = trade.size * trade.price;

    // Ensure prediction breakdown entry
    if (predBreakdown && !predBreakdown.has(trade.conditionId)) {
      predBreakdown.set(trade.conditionId, {
        conditionId: trade.conditionId,
        question: (trade.question ?? '').slice(0, 80),
        eventSlug: trade.eventSlug,
        traderBuys: 0, traderSells: 0,
        traderBuyUsd: 0, traderSellUsd: 0,
        copyBuys: 0, copyDeployed: 0, copyPnl: 0,
        outcomeWon: null, copiedOutcome: '',
        marketClosed: trade.closed ?? true,
      });
    }

    // Track SELLs
    if (trade.side === 'SELL') {
      sellCount++;
      if (predBreakdown) {
        const pb = predBreakdown.get(trade.conditionId);
        if (pb) { pb.traderSells++; pb.traderSellUsd += fillUsd; }
      }

      if (followAll) {
        const posKey = `${trade.conditionId}:${trade.outcome}`;
        const held = followAllPositions.get(posKey);
        if (held && held.shares > 0) {
          const sellProportion = Math.min(1, (trade.size * copyPercent) / held.shares);
          const sharesToSell = held.shares * sellProportion;
          const costBasis = held.costBasis * sellProportion;
          const sellRevenue = sharesToSell * trade.price;
          const feePct = FEE_RATE * Math.pow(trade.price * (1 - trade.price), FEE_EXPONENT);
          const netRevenue = sellRevenue * (1 - feePct);
          const pnl = netRevenue - costBasis;

          held.shares -= sharesToSell;
          held.costBasis -= costBasis;

          const predUsed = predDeployed.get(trade.conditionId) ?? 0;
          predDeployed.set(trade.conditionId, Math.max(0, predUsed - costBasis));
          totalPnl += pnl;
          totalDeployed -= costBasis;

          const day = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);
          dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
          dailyDeployed.set(day, (dailyDeployed.get(day) ?? 0) + Math.abs(costBasis));
          if (pnl > 0) wins++; else losses++;
          if (totalPnl > peakPnl) peakPnl = totalPnl;
          const dd = peakPnl - totalPnl;
          if (dd > maxDd) maxDd = dd;
          holdTotal++;
          if (pnl > 0) holdWins++;

          if (predBreakdown) {
            const pb = predBreakdown.get(trade.conditionId);
            if (pb) pb.copyPnl += pnl;
          }
        }
      } else {
        // Gate mode: just reduce predDeployed for re-entry allowance
        const predUsed = predDeployed.get(trade.conditionId) ?? 0;
        predDeployed.set(trade.conditionId, Math.max(0, predUsed - fillUsd));
      }
      continue;
    }

    // Only BUY trades below this point

    // Slug exclusion BEFORE accumulator (matches production)
    if (excludeSlugs.length > 0) {
      const slug = trade.eventSlug.toLowerCase();
      if (excludeSlugs.some(p => slug.includes(p))) { skippedSlug++; continue; }
    }

    // Count after slug exclusion so scalpPct/cryptoPct denominators are accurate
    totalBuyCount++;
    catCounts.set(cat, (catCounts.get(cat) ?? 0) + 1);

    if (predBreakdown) {
      const pb = predBreakdown.get(trade.conditionId);
      if (pb) { pb.traderBuys++; pb.traderBuyUsd += fillUsd; }
    }

    // Feed majority accumulator
    if (!traderAccum.has(trade.conditionId)) traderAccum.set(trade.conditionId, new Map());
    const outcomeMap = traderAccum.get(trade.conditionId)!;
    outcomeMap.set(trade.outcome, (outcomeMap.get(trade.outcome) ?? 0) + fillUsd);

    const oi = resolveOutcomeIndex(trade);
    if (oi == null) continue;

    // === PRODUCTION GUARDS ===

    // Guard 1: Min buy price
    if (trade.price < minBuyPrice || trade.price > 0.95) { skippedPrice++; continue; }
    if (fillUsd < 1) continue;

    if (!followAll && majorityGate > 0) {
      // Guard 2: Majority gate WITH self-exclusion
      let totalCidVol = 0, maxOutcomeVol = 0, majorityOutcome = '', numOutcomes = 0;
      for (const [oc, vol] of outcomeMap) {
        const adjVol = (oc === trade.outcome) ? Math.max(0, vol - fillUsd) : vol;
        totalCidVol += adjVol;
        if (adjVol > 0) numOutcomes++;
        if (adjVol > maxOutcomeVol) { maxOutcomeVol = adjVol; majorityOutcome = oc; }
      }

      if (totalCidVol < majorityGate) { skippedGate++; continue; }
      if (numOutcomes < 2) { skippedGate++; continue; }
      if (trade.outcome !== majorityOutcome) { skippedGate++; continue; }
      if (totalCidVol > 0 && maxOutcomeVol / totalCidVol < 0.50) { skippedGate++; continue; }

      // Guard 3: Committed side lock
      const committed = committedSides.get(trade.conditionId);
      if (committed && committed !== trade.outcome) { skippedGate++; continue; }
    }

    const day = new Date(trade.timestamp * 1000).toISOString().slice(0, 10);

    // Guard 4: Available capital
    let available: number;
    if (followAll) {
      available = startingCapital - totalDeployed + totalPnl;
    } else if (useCapitalLockup) {
      releaseMatured(trade.timestamp);
      available = startingCapital - currentlyLocked + releasedPnl;
    } else {
      available = startingCapital - totalDeployed + totalPnl;
    }
    if (available < 1) { skippedCapital++; continue; }

    // Sizing
    let copyAmount = Math.min(fillUsd * copyPercent, maxTradeUsd);

    const predUsed = predDeployed.get(trade.conditionId) ?? 0;
    const predRemaining = maxPredUsd - predUsed;
    if (predRemaining < 1) { skippedPred++; continue; }
    if (copyAmount > predRemaining) copyAmount = predRemaining;
    if (copyAmount > available) copyAmount = available;
    if (copyAmount < 1.0) continue;

    // FAK failure with cooldown
    const cooldownExpiry = buyFailureCooldown.get(trade.conditionId);
    if (cooldownExpiry && trade.timestamp < cooldownExpiry) { skippedFak++; continue; }
    if (rng() < fakFailureRate) {
      buyFailureCooldown.set(trade.conditionId, trade.timestamp + BUY_FAILURE_COOLDOWN_SEC);
      skippedFak++;
      continue;
    }

    // Slippage
    const slippagePct = computeSlippage(cat, rng, empiricalSlippage);
    const fillPrice = Math.min(trade.price * (1 + slippagePct), 0.99);

    // Taker fee: 0.25 × (p(1-p))^2
    const shares = copyAmount / fillPrice;
    const feeShares = shares * FEE_RATE * Math.pow(fillPrice * (1 - fillPrice), FEE_EXPONENT);
    const netShares = shares - feeShares;

    // Market resolution oracle
    let outcomeWon = false;
    const isOpenMarket = includeOpenMarkets && trade.closed === false;

    if (isOpenMarket) {
      // Open market: use outcomePrices as current probability
      try {
        const prices: string[] = JSON.parse(trade.outcomePrices);
        const currentProb = parseFloat(prices[oi] ?? '0');
        outcomeWon = currentProb >= 0.50;
      } catch { continue; }
    } else {
      try {
        const prices: string[] = JSON.parse(trade.outcomePrices);
        outcomeWon = parseFloat(prices[oi] ?? '0') >= 0.95;
      } catch { continue; }
    }

    // Track results
    predDeployed.set(trade.conditionId, predUsed + copyAmount);
    if (!followAll) {
      const committed = committedSides.get(trade.conditionId);
      if (!committed) committedSides.set(trade.conditionId, trade.outcome);
    }
    buyCount++;

    if (predBreakdown) {
      const pb = predBreakdown.get(trade.conditionId);
      if (pb) {
        pb.copyBuys++;
        pb.copyDeployed += copyAmount;
        pb.copiedOutcome = trade.outcome;
        pb.outcomeWon = outcomeWon;
      }
    }

    // Follow-all mode: track shares for sell-side exit
    if (followAll) {
      const posKey = `${trade.conditionId}:${trade.outcome}`;
      const held = followAllPositions.get(posKey) ?? { shares: 0, costBasis: 0, outcomeWon: false, endDateTs: 0 };
      held.shares += netShares;
      held.costBasis += copyAmount;
      held.outcomeWon = outcomeWon;
      held.endDateTs = trade.endDate ?? (trade.timestamp + FALLBACK_LOCKUP_SEC);
      followAllPositions.set(posKey, held);
    }

    if (followAll) {
      totalDeployed += copyAmount;
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + 0); // ensure day exists
      dailyDeployed.set(day, (dailyDeployed.get(day) ?? 0) + copyAmount);
    } else if (useCapitalLockup) {
      const endDateTs = trade.endDate ?? (trade.timestamp + FALLBACK_LOCKUP_SEC);
      // Binary insert to maintain sorted order by resolvesAt
      let lo = lockupReleasePtr, hi = lockupQueue.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (lockupQueue[mid].resolvesAt <= endDateTs) lo = mid + 1; else hi = mid;
      }
      lockupQueue.splice(lo, 0, { deployedUsd: copyAmount, netShares, outcomeWon, resolvesAt: endDateTs, conditionId: trade.conditionId });
      currentlyLocked += copyAmount;
    } else {
      // Instant PnL mode
      let pnl: number;
      if (isOpenMarket) {
        try {
          const prices: string[] = JSON.parse(trade.outcomePrices);
          const currentPrice = parseFloat(prices[oi] ?? '0');
          pnl = netShares * currentPrice - copyAmount;
        } catch {
          pnl = -copyAmount;
        }
      } else {
        pnl = (outcomeWon ? netShares * 1.0 : 0) - copyAmount;
      }
      holdTotal++; if (outcomeWon) holdWins++;
      totalPnl += pnl;
      totalDeployed += copyAmount;
      if (pnl > 0) wins++; else losses++;
      if (totalPnl > peakPnl) peakPnl = totalPnl;
      const dd = peakPnl - totalPnl;
      if (dd > maxDd) maxDd = dd;
      dailyPnl.set(day, (dailyPnl.get(day) ?? 0) + pnl);
      dailyDeployed.set(day, (dailyDeployed.get(day) ?? 0) + copyAmount);

      if (predBreakdown) {
        const pb = predBreakdown.get(trade.conditionId);
        if (pb) pb.copyPnl += pnl;
      }
    }
  }

  // Follow-all: resolve remaining unsold shares at market outcome
  if (followAll) {
    const remaining = [...followAllPositions.entries()]
      .filter(([, h]) => h.shares > 0.001)
      .sort((a, b) => a[1].endDateTs - b[1].endDateTs);
    for (const [key, held] of remaining) {
      const pnl = (held.outcomeWon ? held.shares : 0) - held.costBasis;
      totalPnl += pnl;
      holdTotal++;
      if (held.outcomeWon) holdWins++;
      if (pnl > 0) wins++; else losses++;
      if (totalPnl > peakPnl) peakPnl = totalPnl;
      const dd = peakPnl - totalPnl;
      if (dd > maxDd) maxDd = dd;
      const resolveDay = new Date(held.endDateTs * 1000).toISOString().slice(0, 10);
      dailyPnl.set(resolveDay, (dailyPnl.get(resolveDay) ?? 0) + pnl);
      dailyDeployed.set(resolveDay, (dailyDeployed.get(resolveDay) ?? 0) + held.costBasis);

      if (predBreakdown) {
        const condId = key.split(':')[0];
        const pb = predBreakdown.get(condId);
        if (pb) pb.copyPnl += pnl;
      }
    }
  }

  // Flush remaining locked positions
  if (useCapitalLockup && !followAll) {
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

      if (predBreakdown) {
        const pb = predBreakdown.get(pos.conditionId);
        if (pb) pb.copyPnl += pnl;
      }
    }
  }

  // ─── Compute Final Metrics ───

  const copyPnl = followAll ? totalPnl : (useCapitalLockup ? releasedPnl : totalPnl);
  const copyDeployed = followAll ? totalDeployed : (useCapitalLockup
    ? lockupQueue.reduce((s, p) => s + p.deployedUsd, 0)
    : totalDeployed);
  const copyRoi = copyDeployed > 0 ? copyPnl / copyDeployed * 100 : 0;
  const copyWr = (wins + losses) > 0 ? wins / (wins + losses) * 100 : 0;
  const copyMaxDdPct = startingCapital > 0 ? maxDd / startingCapital * 100 : 0;

  // Daily consistency
  const dailyVals = [...dailyPnl.values()];
  const winDays = dailyVals.filter(v => v > 0).length;
  const lossDays = dailyVals.filter(v => v <= 0).length;
  const dayWr = dailyVals.length > 0 ? winDays / dailyVals.length * 100 : 0;

  // Sharpe on returns (PnL/deployed)
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

  // Calendar day span
  const allDays = [...dailyPnl.keys()].sort();
  const calendarDays = allDays.length > 0
    ? Math.max(1, Math.round((new Date(allDays[allDays.length - 1]).getTime() - new Date(allDays[0]).getTime()) / (24 * 60 * 60 * 1000)) + 1)
    : 0;

  const score = computeScore(copyPnl, copyRoi, scalpPct, buyCount, copyMaxDdPct);

  return {
    copyPnl, copyDeployed, copyRoi, copyWr, copyBuys: buyCount,
    wins, losses,
    copyMaxDd: maxDd, copyMaxDdPct: copyMaxDdPct, copySharpe: sharpe,
    winDays, lossDays, dayWr, maxWinStreak, maxLossStreak,
    mainCategory: mainCat, cryptoPct, scalpPct, holdWr,
    pnlPerDay: calendarDays > 0 ? copyPnl / calendarDays : 0,
    daysActive: calendarDays,
    score,
    skips: { slug: skippedSlug, price: skippedPrice, gate: skippedGate, pred: skippedPred, fak: skippedFak, capital: skippedCapital },
    predictions: predBreakdown ? [...predBreakdown.values()] : [],
    config,
  };
}
