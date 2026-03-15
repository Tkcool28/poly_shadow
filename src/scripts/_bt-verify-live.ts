/**
 * USD200_LK Live Verification Script
 *
 * Fetches the last N settled predictions for trader 0x8dxd from fresh Polymarket API data,
 * replays the USD200_LK backtest logic on the trader's actual trades, then compares
 * what production DID vs what the backtest WOULD have done.
 *
 * Goal: continuously verify that real-world production behavior matches the USD200_LK
 * backtest predictions. If they diverge, the backtest results may be invalid and we
 * could be losing real money.
 *
 * Data sources:
 *   1. Polymarket Data API: trader's trades (getTrades), closed positions (resolution data)
 *   2. Polymarket Gamma API: market metadata (question, closed, outcomes, eventSlug)
 *   3. Production DB via SSH: our CopyTrade records for the allocation
 *
 * Usage: source ~/.nvm/nvm.sh && npx tsx src/scripts/_bt-verify-live.ts
 * Loop:  /loop 1h source ~/.nvm/nvm.sh && npx tsx src/scripts/_bt-verify-live.ts
 */
import 'dotenv/config';
import { execSync } from 'child_process';
import { getTrades } from '../api/data-api';
import { getMarketsByConditionIds } from '../api/gamma-api';
import type { TradeData, GammaMarketData } from '../api/types';

// ─── Config (must match production USD200_LK) ───
const TRADER_PROXY = '0x63ce342161250d705dc0b16df89036c8e5f9ba9a';
const ALLOC_ID = 'fa_0x8dxd_live_1773336058';
const LOOKBACK_HOURS = parseInt(process.env.LOOKBACK_HOURS ?? '24', 10); // look at predictions with trader activity in last N hours
const MAX_PREDICTIONS = 10;     // check at most N settled predictions
const DEPLOY_TS = 1773473040;   // 2026-03-14T07:24:00Z — USD200_LK deployed (commit c383819)

// USD200_LK production config
const MAJORITY_MIN_USD = 200;
const MAJORITY_MIN_RATIO = 0.50;
const COMMITTED_SIDE_LOCK = true;
const MIN_BUY_PRICE = 0.60;
const MAX_POSITION_USD = 5;
const MAX_PREDICTION_USD = 20;
const COPY_TRADE_PERCENT = 0.10;
const MAX_TRADE_PERCENT = 0.50;
const TOKEN_SELL_COOLDOWN_MS = 60000;
const CLOB_MIN_ORDER_USD = 1.0;
const HEDGE_PRICE_RATIO = 0.25;
const HEDGE_NAKED_MAX_PRICE = 0.10;
const HEDGE_MIN_OPPOSITE_USD = 5;
const HEDGE_MAX_RATIO = 0.20;
const EXCLUDE_SLUG_PATTERNS = ['updown-5m', 'updown-15m'];

// ─── Helpers ───
/** Sanitize a conditionId/allocationId for safe SQL interpolation (hex strings only) */
function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_\-x]/g, '');
}

function sshQuery(sql: string): string[][] {
  // Pipe the SQL via stdin to avoid shell quoting hell with nested SSH + docker exec
  const oneLinerSql = sql.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  const script = `docker exec -i polymarket_postgres psql -U polymarket -d polymarket_copytrade -t -A -F'|' <<'EOSQL'\n${oneLinerSql}\nEOSQL`;
  try {
    const out = execSync('ssh hetzner_finland_dockerapps bash -s', {
      input: script,
      encoding: 'utf-8',
      timeout: 30_000,
      maxBuffer: 10 * 1024 * 1024, // 10MB — DetectedTrade queries can return 10k+ rows
    }).trim();
    if (!out) return [];
    return out.split('\n').filter(l => l.trim()).map(l => l.split('|'));
  } catch (err: any) {
    console.error('SSH/DB error:', err.message?.slice(0, 300));
    process.exit(1);
  }
}

/** Fetch trader's DetectedTrade records from production DB — same signals production saw.
 *  Deduplicates by transactionHash (same trade detected by CHAIN + RAPID_POLL = 1 signal). */
function fetchDetectedTrades(proxyWallet: string, cutoffTs: number): TradeData[] {
  const rows = sshQuery(`
    SELECT DISTINCT ON ("transactionHash")
           "conditionId", outcome, side, asset, size::text, price::text,
           timestamp::text, "eventSlug", "transactionHash"
    FROM "DetectedTrade"
    WHERE "proxyWallet" = '${sanitizeId(proxyWallet)}'
      AND timestamp >= ${Math.floor(cutoffTs)}
    ORDER BY "transactionHash", "detectedAt" ASC
  `);

  return rows.map(r => ({
    proxyWallet,
    conditionId: r[0],
    outcome: r[1],
    side: r[2] as 'BUY' | 'SELL',
    asset: r[3],
    size: parseFloat(r[4]) || 0,
    price: parseFloat(r[5]) || 0,
    timestamp: parseInt(r[6]) || 0,
    eventSlug: r[7] || undefined,
    transactionHash: r[8] || '',
    outcomeIndex: 0,
  })) as TradeData[];
}

// ─── Majority Accumulator (exact USD200_LK logic) ───
class MajorityAccumulator {
  private acc = new Map<string, Map<string, { count: number; totalUsd: number }>>();

  record(conditionId: string, outcome: string, usd: number): void {
    let m = this.acc.get(conditionId);
    if (!m) { m = new Map(); this.acc.set(conditionId, m); }
    const s = m.get(outcome) ?? { count: 0, totalUsd: 0 };
    s.count++; s.totalUsd += usd;
    m.set(outcome, s);
  }

  getMajority(conditionId: string):
    { outcome: string; ratio: number; totalTrades: number; totalUsd: number } | null {
    const m = this.acc.get(conditionId);
    if (!m) return null;
    let totalCount = 0, totalUsd = 0, maxUsd = 0, majorityOutcome = '';
    for (const [outcome, s] of m) {
      totalCount += s.count; totalUsd += s.totalUsd;
      if (s.totalUsd > maxUsd) { maxUsd = s.totalUsd; majorityOutcome = outcome; }
    }
    // USD gate (USD200_LK)
    if (totalUsd < MAJORITY_MIN_USD) return null;
    const ratio = totalUsd > 0 ? maxUsd / totalUsd : 0;
    if (ratio < MAJORITY_MIN_RATIO) return null;
    return { outcome: majorityOutcome, ratio, totalTrades: totalCount, totalUsd };
  }

  getStats(conditionId: string): { totalUsd: number; totalCount: number } {
    const m = this.acc.get(conditionId);
    if (!m) return { totalUsd: 0, totalCount: 0 };
    let totalUsd = 0, totalCount = 0;
    for (const s of m.values()) { totalUsd += s.totalUsd; totalCount += s.count; }
    return { totalUsd, totalCount };
  }
}

// ─── Position Tracker (simplified for verification) ───
class PositionTracker {
  private positions = new Map<string, { shares: number; costUsd: number }>();

  getNetPositionUsd(tokenId: string): number {
    const p = this.positions.get(tokenId);
    return (p && p.costUsd >= 0.01) ? p.costUsd : 0;
  }

  getOppositePosition(conditionId: string, currentTokenId: string,
    tokenMap: Map<string, Set<string>>): { netUsd: number; avgBuyPrice: number } {
    const tokens = tokenMap.get(conditionId);
    if (!tokens) return { netUsd: 0, avgBuyPrice: 0 };
    let netUsd = 0, buyCost = 0, buyShares = 0;
    for (const tokenId of tokens) {
      if (tokenId === currentTokenId) continue;
      const p = this.positions.get(tokenId);
      if (p && p.shares >= 0.01) { netUsd += p.costUsd; buyCost += p.costUsd; buyShares += p.shares; }
    }
    return { netUsd: Math.max(netUsd, 0), avgBuyPrice: buyShares > 0 ? buyCost / buyShares : 0 };
  }

  recordBuy(tokenId: string, usdAmount: number, price: number): void {
    const p = this.positions.get(tokenId) ?? { shares: 0, costUsd: 0 };
    p.shares += usdAmount / price; p.costUsd += usdAmount;
    this.positions.set(tokenId, p);
  }
}

// ─── Simulated Decision for a single trade ───
interface SimDecision {
  action: 'BUY' | 'SELL' | 'SKIP';
  amount: number; // USD for BUY, shares for SELL
  reason: string;
}

// ─── Sim result (reusable across data sources) ───
interface SimResult {
  buys: number;
  buyUsd: number;
  skips: number;
  majorityOutcome: string | null;
  firstBuyOutcome: string | null;
}

// ─── Per-prediction comparison result ───
interface PredictionCheck {
  conditionId: string;
  question: string;
  eventSlug: string;
  closed: boolean;
  winningOutcome: string | null;
  traderTradeCount: number;
  traderTotalUsd: number;

  // Sim on Data API trades (public backtest view)
  apiSim: SimResult;
  // Sim on DetectedTrade signals (what production saw)
  dtSim: SimResult | null; // null if DetectedTrade data unavailable for this prediction
  dtTradeCount: number; // DetectedTrade signal count for this prediction

  // What production actually did
  prodBuys: number;
  prodBuyUsd: number;
  prodSells: number;
  prodSkips: number;
  prodFirstBuyOutcome: string | null;

  // Comparison
  preDeployment: boolean;
  decisionsMatch: boolean;
  mismatches: string[];
}

/** Run USD200_LK simulation on a set of trades for a single prediction */
function simulatePrediction(
  trades: TradeData[],
  market: GammaMarketData | undefined,
  conditionTokens: Map<string, Set<string>>,
): SimResult {
  const accumulator = new MajorityAccumulator();
  const positions = new PositionTracker();
  const committedSides = new Map<string, string>();
  const sellCooldowns = new Map<string, number>();

  let simBuys = 0, simBuyUsd = 0, simSkips = 0;
  let simFirstBuyOutcome: string | null = null;
  let simMajorityOutcome: string | null = null;
  let simCurrentCapital = 150;

  for (const trade of trades) {
    if (trade.side === 'BUY' && trade.outcome) {
      accumulator.record(trade.conditionId, trade.outcome, trade.size * trade.price);
    }

    const effectiveSlug = trade.eventSlug ?? market?.eventSlug ?? '';

    if (trade.side === 'BUY' && trade.price < MIN_BUY_PRICE - 0.001) { simSkips++; continue; }

    if (trade.side === 'BUY') {
      if (!effectiveSlug) { simSkips++; continue; }
      if (EXCLUDE_SLUG_PATTERNS.some(p => effectiveSlug.toLowerCase().includes(p))) { simSkips++; continue; }
    }

    let majorityTotalUsd: number | null = null;
    if (trade.side === 'BUY') {
      const majority = accumulator.getMajority(trade.conditionId);
      if (!majority) { simSkips++; continue; }
      if (trade.outcome !== majority.outcome) { simSkips++; continue; }
      majorityTotalUsd = majority.totalUsd;
      if (!simMajorityOutcome) simMajorityOutcome = majority.outcome;
    }

    if (trade.side === 'BUY' && COMMITTED_SIDE_LOCK) {
      const committed = committedSides.get(trade.conditionId);
      if (committed && committed !== trade.outcome) { simSkips++; continue; }
    }

    if (trade.side === 'BUY') {
      const lastSell = sellCooldowns.get(trade.asset);
      if (lastSell && (trade.timestamp - lastSell) < TOKEN_SELL_COOLDOWN_MS / 1000) { simSkips++; continue; }
    }

    if (trade.side === 'SELL') {
      sellCooldowns.set(trade.asset, trade.timestamp);
      simSkips++;
      continue;
    }

    if (simCurrentCapital <= 0) { simSkips++; continue; }

    const fragmentUsd = trade.size * trade.price;
    const traderTradeUsd = majorityTotalUsd ?? fragmentUsd;

    let copyAmountUsd = traderTradeUsd * COPY_TRADE_PERCENT;
    copyAmountUsd = Math.min(copyAmountUsd, MAX_POSITION_USD);

    const positionUsd = positions.getNetPositionUsd(trade.asset);

    if (MAX_PREDICTION_USD > 0) {
      const remaining = MAX_PREDICTION_USD - positionUsd;
      if (remaining < 0.01) { simSkips++; continue; }
      if (copyAmountUsd > remaining) copyAmountUsd = remaining;
    }

    let hedgeMaxUsd = Infinity;
    if (HEDGE_PRICE_RATIO > 0 && trade.price < HEDGE_PRICE_RATIO) {
      const oppositePos = positions.getOppositePosition(trade.conditionId, trade.asset, conditionTokens);
      const hasOpposite = oppositePos.avgBuyPrice > 0 && oppositePos.netUsd >= 0.01;
      if (!hasOpposite) {
        if (HEDGE_NAKED_MAX_PRICE > 0 && trade.price <= HEDGE_NAKED_MAX_PRICE) { simSkips++; continue; }
      } else {
        const isHedge = trade.price < HEDGE_PRICE_RATIO * oppositePos.avgBuyPrice;
        if (isHedge) {
          if (oppositePos.netUsd < HEDGE_MIN_OPPOSITE_USD) { simSkips++; continue; }
          hedgeMaxUsd = oppositePos.netUsd * HEDGE_MAX_RATIO;
          if (copyAmountUsd > hedgeMaxUsd) copyAmountUsd = hedgeMaxUsd;
        }
      }
    }

    const maxTradeFromCapital = simCurrentCapital * MAX_TRADE_PERCENT;
    if (copyAmountUsd > maxTradeFromCapital) copyAmountUsd = maxTradeFromCapital;

    if (copyAmountUsd < CLOB_MIN_ORDER_USD) {
      if (positionUsd < 0.01) {
        copyAmountUsd = Math.min(CLOB_MIN_ORDER_USD, hedgeMaxUsd);
        if (copyAmountUsd < CLOB_MIN_ORDER_USD) { simSkips++; continue; }
      } else {
        simSkips++; continue;
      }
    }

    if (copyAmountUsd > simCurrentCapital) {
      if (simCurrentCapital >= CLOB_MIN_ORDER_USD) copyAmountUsd = simCurrentCapital;
      else { simSkips++; continue; }
    }

    positions.recordBuy(trade.asset, copyAmountUsd, trade.price);
    simCurrentCapital -= copyAmountUsd;
    simBuys++;
    simBuyUsd += copyAmountUsd;
    if (!simFirstBuyOutcome) simFirstBuyOutcome = trade.outcome;
    if (COMMITTED_SIDE_LOCK && !committedSides.has(trade.conditionId)) {
      committedSides.set(trade.conditionId, trade.outcome);
    }
  }

  return { buys: simBuys, buyUsd: simBuyUsd, skips: simSkips, majorityOutcome: simMajorityOutcome, firstBuyOutcome: simFirstBuyOutcome };
}

// ─── Main ───
async function main() {
  const now = Date.now();
  const cutoffTs = Math.floor((now - LOOKBACK_HOURS * 3600_000) / 1000);

  console.log('============================================================');
  console.log(`USD200_LK LIVE VERIFICATION — ${new Date().toISOString().slice(0, 19)} UTC`);
  console.log(`Lookback: ${LOOKBACK_HOURS}h | Max predictions: ${MAX_PREDICTIONS}`);
  console.log('============================================================');

  // ─── Step 1: Fetch trader trades from BOTH sources ───
  // Source A: Polymarket Data API (public aggregated trades — the backtest view)
  // Source B: DetectedTrade table via SSH (exact signals production's chain watcher saw)
  console.log('\n[1/4] Fetching trader trades...');

  // Source A: Data API
  const apiTrades: TradeData[] = [];
  {
    let offset = 0;
    const MAX_OFFSET = 3000;
    while (offset < MAX_OFFSET) {
      let batch: TradeData[];
      try {
        batch = await getTrades({ user: TRADER_PROXY, limit: 500, offset });
      } catch (err: any) {
        if (err.response?.status === 400) break;
        throw err;
      }
      if (batch.length === 0) break;
      const recent = batch.filter(t => t.timestamp >= cutoffTs);
      apiTrades.push(...recent);
      if (batch[batch.length - 1].timestamp < cutoffTs || batch.length < 500) break;
      offset += batch.length;
    }
    apiTrades.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`  Data API:       ${apiTrades.length} trades (public, aggregated)`);
  }

  // Source B: DetectedTrade (production signals)
  let dtTrades: TradeData[] = [];
  {
    const dt = fetchDetectedTrades(TRADER_PROXY, cutoffTs);
    dtTrades = dt;
    dtTrades.sort((a, b) => a.timestamp - b.timestamp);
    console.log(`  DetectedTrade:  ${dtTrades.length} trades (production chain watcher signals)`);
  }

  // Use Data API as the primary for prediction discovery (always available, no offset limit issues)
  // DetectedTrade is used as a second sim source per-prediction
  const allTraderTrades = apiTrades;

  // Group Data API trades by conditionId
  const tradesByCondition = new Map<string, TradeData[]>();
  for (const t of allTraderTrades) {
    const arr = tradesByCondition.get(t.conditionId) ?? [];
    arr.push(t);
    tradesByCondition.set(t.conditionId, arr);
  }

  // Group DetectedTrade by conditionId
  const dtByCondition = new Map<string, TradeData[]>();
  for (const t of dtTrades) {
    const arr = dtByCondition.get(t.conditionId) ?? [];
    arr.push(t);
    dtByCondition.set(t.conditionId, arr);
  }

  // Merge conditionId sets (DetectedTrade may have predictions not in Data API and vice versa)
  const allConditionIds = new Set([...tradesByCondition.keys(), ...dtByCondition.keys()]);
  const conditionIds = [...allConditionIds];
  console.log(`  Combined:       ${conditionIds.length} predictions (last ${LOOKBACK_HOURS}h)`);

  if (conditionIds.length === 0) {
    console.log('\nNo trader activity in lookback window. Nothing to verify.');
    process.exit(0);
  }

  // ─── Step 2: Fetch market metadata from Gamma API ───
  console.log('\n[2/4] Fetching market data from Gamma API...');
  const marketMap = new Map<string, GammaMarketData>();
  const markets = await getMarketsByConditionIds(conditionIds);
  for (const m of markets) marketMap.set(m.conditionId, m);

  // Backfill missing eventSlugs from production DB (Gamma API often omits them for hourly markets)
  // Try Market table first, then fall back to DetectedTrade table (populated by CLOB API during trade detection)
  const missingSlugCids = conditionIds.filter(cid => !marketMap.get(cid)?.eventSlug);
  if (missingSlugCids.length > 0) {
    const slugCidList = missingSlugCids.map(c => `'${sanitizeId(c)}'`).join(',');
    // Query 1: Market table
    const slugRows = sshQuery(`
      SELECT "conditionId", "eventSlug" FROM "Market"
      WHERE "conditionId" IN (${slugCidList}) AND "eventSlug" IS NOT NULL AND "eventSlug" != ''
    `);
    let backfilled = 0;
    for (const [cid, slug] of slugRows) {
      const m = marketMap.get(cid);
      if (m && !m.eventSlug) { (m as any).eventSlug = slug; backfilled++; }
    }
    // Query 2: DetectedTrade table (CLOB API populates eventSlug here even when Market table is empty)
    const stillMissing = missingSlugCids.filter(cid => !marketMap.get(cid)?.eventSlug);
    if (stillMissing.length > 0) {
      const stillMissingList = stillMissing.map(c => `'${sanitizeId(c)}'`).join(',');
      const dtSlugRows = sshQuery(`
        SELECT DISTINCT "conditionId", "eventSlug" FROM "DetectedTrade"
        WHERE "conditionId" IN (${stillMissingList}) AND "eventSlug" IS NOT NULL AND "eventSlug" != ''
      `);
      for (const [cid, slug] of dtSlugRows) {
        const m = marketMap.get(cid);
        if (m && !m.eventSlug) { (m as any).eventSlug = slug; backfilled++; }
      }
    }
    if (backfilled > 0) console.log(`  Backfilled ${backfilled} eventSlugs from production DB`);
  }

  // Determine winning outcome for closed markets
  const winningOutcomes = new Map<string, string>();
  for (const [cid, m] of marketMap) {
    if (!m.closed) continue;
    try {
      const outcomes: string[] = JSON.parse(m.outcomes);
      const prices: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      for (let i = 0; i < outcomes.length; i++) {
        if (prices[i] === '1') { winningOutcomes.set(cid, outcomes[i]); break; }
      }
    } catch { /* skip */ }
  }

  // Filter to settled-only predictions
  const settledConditionIds = conditionIds.filter(cid => winningOutcomes.has(cid));
  console.log(`  ${markets.length} markets fetched, ${settledConditionIds.length} settled, ${conditionIds.length - settledConditionIds.length} still open`);

  const openConditionIds = conditionIds.filter(cid => !winningOutcomes.has(cid));

  if (settledConditionIds.length === 0 && openConditionIds.length === 0) {
    console.log('\nNo predictions in lookback window. Nothing to verify.');
    process.exit(0);
  }

  // Classify predictions: non-excluded (hourly/daily) are more informative than slug-excluded (5m/15m)
  const isSlugExcluded = (cid: string): boolean => {
    const m = marketMap.get(cid);
    const slug = m?.eventSlug ?? '';
    if (!slug) return true; // fail-closed = excluded
    return EXCLUDE_SLUG_PATTERNS.some(p => slug.includes(p));
  };
  const latestTradeTs = (cid: string): number => {
    const trades = tradesByCondition.get(cid) ?? [];
    return trades.length > 0 ? Math.max(...trades.map(t => t.timestamp)) : 0;
  };

  // Include non-excluded OPEN predictions too — we can verify outcome agreement even before settlement
  const nonExcludedOpen = openConditionIds.filter(cid => !isSlugExcluded(cid));
  const nonExcludedSettled = settledConditionIds.filter(cid => !isSlugExcluded(cid));
  const excludedSettled = settledConditionIds.filter(cid => isSlugExcluded(cid));

  // Sort each tier by recency (newest first), using copies to avoid mutation
  const byRecency = (ids: string[]) => [...ids].sort((a, b) => latestTradeTs(b) - latestTradeTs(a));

  // Priority: non-excluded settled > non-excluded open > excluded settled
  const sortedCandidates = [...byRecency(nonExcludedSettled), ...byRecency(nonExcludedOpen), ...byRecency(excludedSettled)];
  console.log(`  Non-excluded: ${nonExcludedSettled.length} settled + ${nonExcludedOpen.length} open | Excluded settled: ${excludedSettled.length}`);

  const targetConditionIds = sortedCandidates.slice(0, MAX_PREDICTIONS);

  // ─── Step 3: Fetch production CopyTrade records from DB ───
  console.log('\n[3/4] Fetching production CopyTrade records via SSH...');
  const cidList = targetConditionIds.map(c => `'${sanitizeId(c)}'`).join(',');

  // Query 1: CopyTrade records per conditionId (include createdAt for deploy-phase detection)
  const prodRows = sshQuery(`
    SELECT dt."conditionId", ct.side, ct.status,
      ct."requestedAmount"::numeric(10,4),
      COALESCE(ct."filledSize" * ct."filledPrice", ct."requestedAmount")::numeric(10,4),
      dt.outcome,
      ct."failReason",
      EXTRACT(EPOCH FROM ct."createdAt")::bigint
    FROM "CopyTrade" ct
    JOIN "DetectedTrade" dt ON dt.id = ct."detectedTradeId"
    WHERE ct."followAllocationId" = '${sanitizeId(ALLOC_ID)}'
      AND ct."isPaper" = false
      AND dt."conditionId" IN (${cidList})
    ORDER BY ct."createdAt"
  `);

  // Parse production actions per conditionId
  interface ProdAction {
    side: string;
    status: string;
    requestedAmount: number;
    fillUsd: number;
    outcome: string;
    failReason: string;
    createdAtTs: number; // unix seconds
  }

  const prodByCondition = new Map<string, ProdAction[]>();
  for (const r of prodRows) {
    const cid = r[0];
    const arr = prodByCondition.get(cid) ?? [];
    arr.push({
      side: r[1],
      status: r[2],
      requestedAmount: parseFloat(r[3]) || 0,
      fillUsd: parseFloat(r[4]) || 0,
      outcome: r[5],
      failReason: r[6] ?? '',
      createdAtTs: parseInt(r[7]) || 0,
    });
    prodByCondition.set(cid, arr);
  }

  console.log(`  ${prodRows.length} CopyTrade records across ${prodByCondition.size} predictions`);

  // ─── Step 4: Simulate USD200_LK decisions & compare ───
  console.log('\n[4/4] Simulating USD200_LK decisions and comparing...\n');

  // Build token -> conditionId map for opposite position lookup (from both sources)
  const conditionTokens = new Map<string, Set<string>>();
  for (const t of [...apiTrades, ...dtTrades]) {
    if (!conditionTokens.has(t.conditionId)) conditionTokens.set(t.conditionId, new Set());
    conditionTokens.get(t.conditionId)!.add(t.asset);
  }

  const results: PredictionCheck[] = [];

  for (const cid of targetConditionIds) {
    const market = marketMap.get(cid);
    const apiTradesForCid = tradesByCondition.get(cid) ?? [];
    const dtTradesForCid = dtByCondition.get(cid) ?? [];
    const prodActions = prodByCondition.get(cid) ?? [];
    const winOutcome = winningOutcomes.get(cid) ?? null;

    // ── Run sim on BOTH data sources ──
    const apiSim = simulatePrediction(apiTradesForCid, market, conditionTokens);
    const dtSim = dtTradesForCid.length > 0
      ? simulatePrediction(dtTradesForCid, market, conditionTokens)
      : null;

    // ── Parse production actions ──
    const prodFills = prodActions.filter(a => a.status === 'FILLED' || a.status === 'SETTLED');
    const prodBuyFills = prodFills.filter(a => a.side === 'BUY');
    const prodSellFills = prodFills.filter(a => a.side === 'SELL');
    const prodSkipActions = prodActions.filter(a => a.status === 'SKIPPED');
    const prodBuyUsd = prodBuyFills.reduce((s, a) => s + a.fillUsd, 0);
    const prodFirstBuyOutcome = prodBuyFills.length > 0 ? prodBuyFills[0].outcome : null;

    // ── Compare decisions: use DT sim as primary when available (same data source as production),
    //    fall back to API sim when DT data is unavailable ──
    const mismatches: string[] = [];
    const isOpen = !winOutcome;
    const primarySim = dtSim ?? apiSim;
    const primaryLabel = dtSim ? 'dt' : 'api';

    // Check 1: Outcome match (primary sim vs prod)
    if (primarySim.firstBuyOutcome && prodFirstBuyOutcome && primarySim.firstBuyOutcome !== prodFirstBuyOutcome) {
      mismatches.push(`OUTCOME MISMATCH: ${primaryLabel}="${primarySim.firstBuyOutcome}" prod="${prodFirstBuyOutcome}"`);
    }

    // Check 2: Buy/skip agreement
    if (primarySim.buys > 0 && prodBuyFills.length === 0) {
      const accumulating = prodSkipActions.some(a => a.failReason.includes('majority accumulating'));
      // Check ALL prodActions (not just SKIPPED) — GTC records may have various statuses
      const unfillable = prodActions.some(a =>
        a.side === 'BUY' && (
          a.failReason?.includes('FAK unmatched') ||
          a.failReason?.includes('insufficient liquidity') ||
          a.failReason?.includes('GTC fallback: unfilled') ||
          a.failReason?.includes('GTC fallback: placement failed') ||
          a.failReason?.includes('buy failure cooldown')
        )
      );
      // UNFILLABLE takes priority over GATE LAG — if both exist, the gate DID fire
      // but execution failed. "accumulating" records are from before the gate fired.
      if (unfillable) {
        mismatches.push(`UNFILLABLE: ${primaryLabel} would buy (${primarySim.buys} buys) but prod hit empty orderbook / execution failure`);
      } else if (accumulating) {
        mismatches.push(`GATE LAG: ${primaryLabel} would buy (${primarySim.buys} buys) but prod still accumulating${isOpen ? ' (open market, may self-resolve)' : ''}`);
      } else if (!isOpen) {
        mismatches.push(`MISSED BUY: ${primaryLabel}=${primarySim.buys} buys, prod=0 buys`);
      }
    }
    if (primarySim.buys === 0 && prodBuyFills.length > 0 && !isOpen) {
      mismatches.push(`EXTRA BUY: ${primaryLabel}=0 buys, prod=${prodBuyFills.length} buys`);
    }

    // Check 3: Buy count (settled only)
    if (!isOpen && primarySim.buys > 0 && prodBuyFills.length > 0) {
      const ratio = prodBuyFills.length / primarySim.buys;
      if (ratio > 3 || ratio < 0.33) {
        mismatches.push(`COUNT DIVERGE: ${primaryLabel}=${primarySim.buys} buys, prod=${prodBuyFills.length} buys (${ratio.toFixed(1)}x)`);
      }
    }

    // Check 4: USD deployed (settled only)
    if (!isOpen && primarySim.buyUsd > 1 && prodBuyUsd > 1) {
      const usdRatio = prodBuyUsd / primarySim.buyUsd;
      if (usdRatio > 2.0 || usdRatio < 0.5) {
        mismatches.push(`USD DIVERGE: ${primaryLabel}=$${primarySim.buyUsd.toFixed(2)}, prod=$${prodBuyUsd.toFixed(2)} (${usdRatio.toFixed(1)}x)`);
      }
    }

    // Check if production acted on this prediction before USD200_LK deployment
    const allTrades = [...apiTradesForCid, ...dtTradesForCid];
    const preDeployment = prodActions.length > 0
      ? Math.min(...prodActions.map(a => a.createdAtTs)) < DEPLOY_TS
      : allTrades.length > 0 ? Math.max(...allTrades.map(t => t.timestamp)) < DEPLOY_TS : false;

    results.push({
      conditionId: cid,
      question: (market?.question ?? cid).slice(0, 60),
      eventSlug: market?.eventSlug ?? '',
      closed: market?.closed ?? false,
      winningOutcome: winOutcome,
      traderTradeCount: apiTradesForCid.length,
      traderTotalUsd: apiTradesForCid.filter(t => t.side === 'BUY').reduce((s, t) => s + t.size * t.price, 0),
      apiSim,
      dtSim,
      dtTradeCount: dtTradesForCid.length,
      prodBuys: prodBuyFills.length, prodBuyUsd, prodSells: prodSellFills.length,
      prodSkips: prodSkipActions.length, prodFirstBuyOutcome,
      preDeployment,
      decisionsMatch: mismatches.length === 0,
      mismatches,
    });
  }

  // ─── Print Report ───
  console.log('='.repeat(120));
  console.log('PREDICTION-BY-PREDICTION COMPARISON (Sim = USD200_LK backtest, Prod = live production)');
  console.log('='.repeat(120));

  let totalMatch = 0, totalMismatch = 0, totalPreDeploy = 0, totalOpenDiff = 0, totalUnfillable = 0;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const isOpenPrediction = !r.winningOutcome;
    const hasUnfillableOnly = !r.decisionsMatch && r.mismatches.every(m =>
      m.startsWith('UNFILLABLE:') || m.startsWith('GATE LAG:')
    );
    const status = r.decisionsMatch ? 'MATCH'
      : r.preDeployment ? 'PRE-DEPLOY'
      : isOpenPrediction ? 'OPEN-DIFF'
      : hasUnfillableOnly ? 'UNFILLABLE'
      : 'MISMATCH';
    const primarySimResult = r.dtSim ?? r.apiSim;
    const wonLost = r.winningOutcome
      ? (primarySimResult.firstBuyOutcome === r.winningOutcome ? 'WON' : primarySimResult.firstBuyOutcome ? 'LOST' : 'N/A')
      : 'OPEN';

    console.log(`\n${i + 1}. [${status}] [${wonLost}] ${r.question}`);
    console.log(`   Trader: ${r.traderTradeCount} API trades, $${r.traderTotalUsd.toFixed(0)} BUY vol | ${r.dtTradeCount} DT signals | Winner: ${r.winningOutcome ?? '?'}`);
    console.log(`   API:  ${r.apiSim.buys} buys ($${r.apiSim.buyUsd.toFixed(2)}) | ${r.apiSim.skips} skips | majority="${r.apiSim.majorityOutcome ?? 'none'}" | bought="${r.apiSim.firstBuyOutcome ?? 'none'}"`);
    if (r.dtSim) {
      console.log(`   DT:   ${r.dtSim.buys} buys ($${r.dtSim.buyUsd.toFixed(2)}) | ${r.dtSim.skips} skips | majority="${r.dtSim.majorityOutcome ?? 'none'}" | bought="${r.dtSim.firstBuyOutcome ?? 'none'}"`);
    }
    console.log(`   Prod: ${r.prodBuys} buys ($${r.prodBuyUsd.toFixed(2)}) | ${r.prodSells} sells | ${r.prodSkips} skips | bought="${r.prodFirstBuyOutcome ?? 'none'}"`);
    if (r.mismatches.length > 0) {
      const isOpen = !r.winningOutcome;
      for (const m of r.mismatches) console.log(`   !! ${m}${r.preDeployment ? ' (pre-deploy, expected)' : isOpen ? ' (open, informational)' : ''}`);
      if (r.preDeployment) {
        totalPreDeploy++;
      } else if (isOpen) {
        totalOpenDiff++; // Open market mismatches are informational — don't count as failures
      } else if (hasUnfillableOnly) {
        totalUnfillable++; // Empty orderbook / execution failure — informational, not a logic bug
      } else {
        totalMismatch++;
      }
    } else {
      totalMatch++;
    }
  }

  // ─── Summary ───
  console.log('\n' + '='.repeat(120));
  console.log('SUMMARY');
  console.log('='.repeat(120));

  const apiWins = results.filter(r => r.apiSim.firstBuyOutcome && r.apiSim.firstBuyOutcome === r.winningOutcome).length;
  const apiLosses = results.filter(r => r.apiSim.firstBuyOutcome && r.winningOutcome && r.apiSim.firstBuyOutcome !== r.winningOutcome).length;
  const apiNoBuy = results.filter(r => !r.apiSim.firstBuyOutcome).length;
  const dtWins = results.filter(r => r.dtSim?.firstBuyOutcome && r.dtSim.firstBuyOutcome === r.winningOutcome).length;
  const dtLosses = results.filter(r => r.dtSim?.firstBuyOutcome && r.winningOutcome && r.dtSim.firstBuyOutcome !== r.winningOutcome).length;
  const dtNoBuy = results.filter(r => !r.dtSim?.firstBuyOutcome).length;
  const prodWins = results.filter(r => r.prodFirstBuyOutcome && r.prodFirstBuyOutcome === r.winningOutcome).length;
  const prodLosses = results.filter(r => r.prodFirstBuyOutcome && r.winningOutcome && r.prodFirstBuyOutcome !== r.winningOutcome).length;
  // DT↔Prod outcome agreement (how well DetectedTrade sim matches production decisions)
  const dtProdAgree = results.filter(r => r.dtSim && r.dtSim.firstBuyOutcome === r.prodFirstBuyOutcome).length;
  const dtAvailable = results.filter(r => r.dtSim).length;

  const openCount = results.filter(r => !r.winningOutcome).length;
  const settledCount = results.filter(r => !!r.winningOutcome).length;
  console.log(`  Predictions checked: ${results.length} (${settledCount} settled, ${openCount} open)`);
  console.log(`  Trade sources: ${apiTrades.length} API trades, ${dtTrades.length} DetectedTrade signals`);
  const primaryLabel = dtTrades.length > 0 ? 'DT' : 'API';
  console.log(`  Decisions matching (${primaryLabel} vs Prod):  ${totalMatch}/${results.length}`);
  console.log(`  Post-deploy mismatches (settled): ${totalMismatch}/${settledCount}`);
  if (totalUnfillable > 0) console.log(`  Unfillable (empty orderbook): ${totalUnfillable} (informational)`);
  if (totalOpenDiff > 0) console.log(`  Open market diffs: ${totalOpenDiff} (informational, timing-dependent)`);
  if (totalPreDeploy > 0) console.log(`  Pre-deploy mismatches: ${totalPreDeploy} (expected, old CNT10 gate)`);
  if (dtAvailable > 0) console.log(`  DT↔Prod outcome agreement: ${dtProdAgree}/${dtAvailable}`);
  console.log(`  API WR:  ${apiWins}W/${apiLosses}L/${apiNoBuy}skip = ${(apiWins + apiLosses) > 0 ? ((apiWins / (apiWins + apiLosses)) * 100).toFixed(0) : 'N/A'}%`);
  if (dtAvailable > 0) console.log(`  DT WR:   ${dtWins}W/${dtLosses}L/${dtNoBuy}skip = ${(dtWins + dtLosses) > 0 ? ((dtWins / (dtWins + dtLosses)) * 100).toFixed(0) : 'N/A'}%`);
  console.log(`  Prod WR: ${prodWins}W/${prodLosses}L = ${(prodWins + prodLosses) > 0 ? ((prodWins / (prodWins + prodLosses)) * 100).toFixed(0) : 'N/A'}%`);

  // Only fail on POST-deployment mismatches (pre-deploy expected to differ — old CNT10 gate)
  if (totalMismatch > 0) {
    console.log(`\n  RESULT: ${totalMismatch} POST-DEPLOY MISMATCH${totalMismatch > 1 ? 'ES' : ''} FOUND — backtest may not match production!`);
    const postDeployMismatches = results.filter(r => !r.preDeployment && !!r.winningOutcome && r.mismatches.length > 0);
    for (const r of postDeployMismatches) {
      console.log(`    ${r.question}:`);
      for (const m of r.mismatches) console.log(`      - ${m}`);
    }
    process.exit(1);
  } else {
    console.log(`\n  RESULT: ALL ${totalMatch} POST-DEPLOY PREDICTIONS MATCH — production behavior matches USD200_LK backtest`);
    if (totalPreDeploy > 0) console.log(`  (${totalPreDeploy} pre-deploy mismatches are expected and ignored)`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
