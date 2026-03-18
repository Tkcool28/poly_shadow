import pLimit from 'p-limit';
import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { normalizeOutcome } from '../lib/normalize';
import { getMarketsByConditionIds } from '../api/gamma-api';
import { redeemWinningPositions, type ClaimablePosition } from './position-claim';
import { checkOnChainResolution } from '../lib/ctf-resolution';
import { config } from '../config/env';

const log = createJobLogger('position-settlement');

// ─── Concurrency guard ──────────────────────────────────────────────────────
// Prevents overlap between the 5-min timer, startup sweep, and unclaimed sweep.
let sweepRunning = false;

interface OpenPosition {
  tokenId: string;
  followAllocationId: string;
  isPaper: boolean;
}

// ─── Claim persistence helper ───────────────────────────────────────────────
// Marks all CopyTrades for claimed conditionIds via DetectedTrade join,
// correctly covering all allocations + tokenIds for the same market.
export async function markConditionsClaimed(conditionIds: string[]): Promise<void> {
  if (conditionIds.length === 0) return;
  for (const conditionId of conditionIds) {
    await prisma.$executeRaw`
      UPDATE "CopyTrade" ct SET "claimedAt" = NOW()
      FROM "DetectedTrade" dt
      WHERE ct."detectedTradeId" = dt.id
        AND dt."conditionId" = ${conditionId}
        AND ct."isPaper" = false
        AND ct.status = 'SETTLED'
        AND ct."settlementPrice" BETWEEN 0.95 AND 1.0001
        AND ct."claimedAt" IS NULL
    `;
  }
  log.info('Claim status persisted', { conditionsClaimed: conditionIds.length });
}

export async function sweepPositionSettlements(): Promise<void> {
  if (sweepRunning) {
    log.debug('Settlement sweep: skipped (already running)');
    return;
  }
  sweepRunning = true;
  try {
    await doSweepPositionSettlements();
  } finally {
    sweepRunning = false;
  }
}

async function doSweepPositionSettlements(): Promise<void> {
  // Step 1: Find all open positions (tokens with net BUY > SELL, status FILLED)
  const openPositions = await prisma.$queryRaw<OpenPosition[]>`
    SELECT "tokenId", "followAllocationId", "isPaper"
    FROM "CopyTrade"
    WHERE status = 'FILLED' AND "followAllocationId" IS NOT NULL
    GROUP BY "tokenId", "followAllocationId", "isPaper"
    HAVING SUM(CASE WHEN side = 'BUY'
               THEN COALESCE("filledSize", "requestedAmount" / NULLIF("filledPrice", 0))
               ELSE 0 END) >
           SUM(CASE WHEN side = 'SELL'
               THEN COALESCE("filledSize", 0)
               ELSE 0 END)
  `;

  if (openPositions.length === 0) {
    log.debug('Settlement sweep: no open positions');
    return;
  }

  // Step 2: Map tokenId → conditionId + outcome via DetectedTrade
  const uniqueTokenIds = [...new Set(openPositions.map(p => p.tokenId))];
  const tokenMeta = new Map<string, { conditionId: string; outcome: string }>();

  const detectedTrades = await prisma.detectedTrade.findMany({
    where: { asset: { in: uniqueTokenIds } },
    select: { asset: true, conditionId: true, outcome: true },
    distinct: ['asset'],
  });

  for (const dt of detectedTrades) {
    tokenMeta.set(dt.asset, { conditionId: dt.conditionId, outcome: dt.outcome });
  }

  // Step 3: Refresh market data from Gamma API and check resolution
  const uniqueConditionIds = [...new Set([...tokenMeta.values()].map(m => m.conditionId))];

  if (uniqueConditionIds.length === 0) {
    log.debug('Settlement sweep: no condition IDs to check');
    return;
  }

  // Split conditionIds by negRisk flag to avoid Gamma garbage for NegRisk markets
  const marketRows = await prisma.market.findMany({
    where: { conditionId: { in: uniqueConditionIds } },
    select: { conditionId: true, negRisk: true, outcomes: true },
  });
  const negRiskSet = new Set(marketRows.filter(m => m.negRisk).map(m => m.conditionId));
  const standardIds = uniqueConditionIds.filter(id => !negRiskSet.has(id));
  const negRiskIds = uniqueConditionIds.filter(id => negRiskSet.has(id));

  // Standard markets: Gamma API (existing path)
  const freshMarkets = standardIds.length > 0
    ? await getMarketsByConditionIds(standardIds)
    : [];

  // Update cache (batched)
  if (freshMarkets.length > 0) {
    await prisma.$transaction(
      freshMarkets.map((market) =>
        prisma.market.updateMany({
          where: { conditionId: market.conditionId },
          data: {
            closed: market.closed,
            active: market.active,
            outcomePrices: market.outcomePrices ?? null,
            endDate: market.endDate ? new Date(market.endDate) : undefined,
            negRisk: market.negRisk ?? undefined,
          },
        })
      )
    );
  }

  // Build tokenId→outcome map from Gamma API data (for Rust-originated trades with empty outcome)
  const tokenOutcomeMap = new Map<string, string>();
  for (const market of freshMarkets) {
    const raw = market as Record<string, unknown>;
    let tokenIds: string[] = [];
    if (typeof raw.clobTokenIds === 'string') {
      try { tokenIds = JSON.parse(raw.clobTokenIds as string); } catch {}
    } else if (Array.isArray(raw.clobTokenIds)) {
      tokenIds = (raw.clobTokenIds as unknown[]).filter((v): v is string => typeof v === 'string');
    }
    if (tokenIds.length === 0) continue;
    try {
      const outcomes: string[] = JSON.parse(market.outcomes);
      for (let i = 0; i < Math.min(tokenIds.length, outcomes.length); i++) {
        tokenOutcomeMap.set(tokenIds[i], outcomes[i]);
      }
    } catch { /* skip parse failures */ }
  }

  // Patch empty outcomes in tokenMeta using the Gamma token mapping
  for (const [tokenId, meta] of tokenMeta.entries()) {
    if (meta.outcome && meta.outcome.trim() !== '') continue;
    const resolved = tokenOutcomeMap.get(tokenId);
    if (resolved) {
      tokenMeta.set(tokenId, { ...meta, outcome: resolved });
      log.info('Patched empty outcome from Gamma', { tokenId: tokenId.slice(0, 20), outcome: resolved });
    }
  }

  // Build resolved market map: conditionId → market data
  const resolvedMarkets = new Map<string, { outcomes: string; outcomePrices: string }>();
  for (const market of freshMarkets) {
    if (market.closed && market.outcomePrices) {
      resolvedMarkets.set(market.conditionId, {
        outcomes: market.outcomes ?? '[]',
        outcomePrices: market.outcomePrices,
      });
    }
  }

  // ── Price-based resolution: Gamma API lag workaround ────────────────────────
  // Gamma sometimes returns terminal outcomePrices (e.g. ["0.9995","0.0005"])
  // but keeps closed=false for hours. Detect these by checking if maxPrice >= 0.99
  // AND endDate has passed (with a short 5-min grace to avoid premature settlement).
  if (freshMarkets.length > 0) {
    const unresolvedWithPrices = freshMarkets.filter(
      m => !m.closed && m.outcomePrices && !resolvedMarkets.has(m.conditionId)
    );
    if (unresolvedWithPrices.length > 0) {
      const conditionIds = unresolvedWithPrices.map(m => m.conditionId);
      const endDates = await prisma.market.findMany({
        where: { conditionId: { in: conditionIds } },
        select: { conditionId: true, endDate: true },
      });
      const endDateMap = new Map(endDates.map(m => [m.conditionId, m.endDate]));
      const priceGraceMs = 300_000; // 5 minutes after endDate
      const now = Date.now();

      for (const market of unresolvedWithPrices) {
        try {
          const prices = JSON.parse(market.outcomePrices!).map(Number);
          const maxPrice = Math.max(...prices);
          if (maxPrice < 0.99) continue;

          const endDate = endDateMap.get(market.conditionId);
          if (!endDate || endDate.getTime() + priceGraceMs > now) continue;

          resolvedMarkets.set(market.conditionId, {
            outcomes: market.outcomes ?? '[]',
            outcomePrices: market.outcomePrices!,
          });
          // Also mark closed in DB to prevent re-checking
          await prisma.market.updateMany({
            where: { conditionId: market.conditionId },
            data: { closed: true },
          });
          log.warn('Settlement: price-based resolution (Gamma closed=false lag)', {
            conditionId: market.conditionId,
            maxPrice,
            endDate: endDate.toISOString(),
          });
        } catch { /* parse failure — skip */ }
      }
    }
  }

  // NegRisk markets: on-chain resolution (Gamma returns wrong data for these)
  if (negRiskIds.length > 0) {
    const negRiskMarkets = marketRows.filter(m => negRiskSet.has(m.conditionId));
    const rpcLimit = pLimit(3);
    const onChainResults = await Promise.allSettled(
      negRiskMarkets.map(m => rpcLimit(async () => {
        const outcomes: string[] = JSON.parse(m.outcomes);
        const resolution = await checkOnChainResolution(m.conditionId, outcomes.length);
        return { conditionId: m.conditionId, outcomes, resolution };
      }))
    );
    for (const result of onChainResults) {
      if (result.status !== 'fulfilled') continue;
      const { conditionId, outcomes, resolution } = result.value;
      if (!resolution.resolved) continue;
      await prisma.market.updateMany({
        where: { conditionId },
        data: { closed: true, outcomePrices: JSON.stringify(resolution.payouts) },
      });
      resolvedMarkets.set(conditionId, {
        outcomes: JSON.stringify(outcomes),
        outcomePrices: JSON.stringify(resolution.payouts),
      });
      log.info('Settlement: NegRisk market resolved on-chain', { conditionId, payouts: resolution.payouts });
    }
  }

  // ── Fallback: on-chain resolution for overdue standard markets ──
  if (config.SETTLEMENT_ONCHAIN_FALLBACK_ENABLED) {
    const unresolvedConditionIds = standardIds.filter(cid => !resolvedMarkets.has(cid));
    if (unresolvedConditionIds.length > 0) {
      const marketEndDates = await prisma.market.findMany({
        where: { conditionId: { in: unresolvedConditionIds } },
        select: { conditionId: true, endDate: true, outcomes: true },
      });

      const graceMs = config.SETTLEMENT_ENDDATE_GRACE_MS;
      const now = Date.now();
      const overdueMarkets = marketEndDates.filter(
        m => m.endDate && m.endDate.getTime() + graceMs < now
      );

      if (overdueMarkets.length > 0) {
        log.info(`Settlement: checking ${overdueMarkets.length} overdue market(s) on-chain`);

        const onChainResults = await Promise.allSettled(
          overdueMarkets.map(async (m) => {
            const outcomes: string[] = JSON.parse(m.outcomes);
            const resolution = await checkOnChainResolution(m.conditionId, outcomes.length);
            return { conditionId: m.conditionId, outcomes, resolution };
          })
        );

        for (const result of onChainResults) {
          if (result.status !== 'fulfilled') continue;
          const { conditionId, outcomes, resolution } = result.value;
          if (!resolution.resolved) continue;

          await prisma.market.updateMany({
            where: { conditionId },
            data: { closed: true, outcomePrices: JSON.stringify(resolution.payouts) },
          });
          resolvedMarkets.set(conditionId, {
            outcomes: JSON.stringify(outcomes),
            outcomePrices: JSON.stringify(resolution.payouts),
          });
          log.warn('Settlement: resolved via on-chain fallback (Gamma API lag)', {
            conditionId,
            payouts: resolution.payouts,
          });
        }
      }
    }
  }

  if (resolvedMarkets.size === 0) {
    log.debug(`Settlement sweep: checked ${uniqueConditionIds.length} markets, none resolved`);
    return;
  }

  // Step 4-5: Settle resolved positions
  let settledCount = 0;
  let totalPositionsSettled = 0;
  const claimablePositions: ClaimablePosition[] = [];

  for (const pos of openPositions) {
    const meta = tokenMeta.get(pos.tokenId);
    if (!meta) continue;

    const marketData = resolvedMarkets.get(meta.conditionId);
    if (!marketData) continue;

    // Determine settlement price
    let outcomePrices: number[];
    let outcomes: string[];
    try {
      outcomePrices = JSON.parse(marketData.outcomePrices).map(Number);
      outcomes = JSON.parse(marketData.outcomes);
    } catch {
      log.warn('Settlement: failed to parse market data', { conditionId: meta.conditionId });
      continue;
    }

    // Normalize before comparing — API outcome strings sometimes differ in apostrophes/quotes
    // e.g. DB: "Anyones Legend" vs API: "Anyone's Legend" → both normalize to "anyones legend"
    const normalizedOutcome = normalizeOutcome(meta.outcome);
    let outcomeIndex = outcomes.findIndex(o => normalizeOutcome(o) === normalizedOutcome);

    // Fallback: resolve from tokenId→outcome map (handles Rust IPC trades with outcome="")
    if (outcomeIndex < 0 || outcomeIndex >= outcomePrices.length) {
      const fallbackOutcome = tokenOutcomeMap.get(pos.tokenId);
      if (fallbackOutcome) {
        outcomeIndex = outcomes.findIndex(o => normalizeOutcome(o) === normalizeOutcome(fallbackOutcome));
      }
      if (outcomeIndex < 0 || outcomeIndex >= outcomePrices.length) {
        log.warn('Settlement: outcome not found in market', {
          outcome: meta.outcome,
          fallbackOutcome: fallbackOutcome ?? 'none',
          outcomes,
          tokenId: pos.tokenId,
        });
        continue;
      }
    }

    const settlementPrice = outcomePrices[outcomeIndex];
    if (!Number.isFinite(settlementPrice)) continue;

    // Get all FILLED CopyTrades for this position
    const fills = await prisma.copyTrade.findMany({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        status: 'FILLED',
      },
      select: { id: true, side: true, filledSize: true, requestedAmount: true, filledPrice: true },
    });

    // Calculate net shares and cost basis (average cost method — matches unrealized-pnl.ts)
    let totalBuyShares = 0;
    let totalBuyCost = 0;
    let totalSellShares = 0;
    for (const fill of fills) {
      if (fill.side === 'BUY') {
        totalBuyShares += fill.filledSize ?? (fill.requestedAmount / (fill.filledPrice ?? 1));
        // Prefer actual fill value over requested amount (accounts for slippage)
        totalBuyCost += (fill.filledSize != null && fill.filledPrice != null)
          ? fill.filledSize * fill.filledPrice
          : fill.requestedAmount;
      } else {
        totalSellShares += fill.filledSize ?? 0;
      }
    }
    const netShares = Math.max(totalBuyShares - totalSellShares, 0);

    if (netShares <= 0 || totalBuyShares <= 0) continue;

    // Guard: defer settlement if a recent SELL is in-flight — prevents double-credit
    // with pre-resolution seller. 120s recency window ensures stale PENDING SELLs
    // from prior crashes (handled by reconcileStalePending at startup) don't block
    // settlement permanently.
    const pendingSell = await prisma.copyTrade.findFirst({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        side: 'SELL',
        status: 'PENDING',
        createdAt: { gte: new Date(Date.now() - 120_000) },
      },
      select: { id: true },
    });
    if (pendingSell) {
      log.debug('Settlement: deferring — recent SELL in-flight', {
        tokenId: pos.tokenId.slice(0, 20),
        pendingSellId: pendingSell.id,
      });
      continue;
    }

    const avgCostPerShare = totalBuyCost / totalBuyShares;
    const remainingCostBasis = avgCostPerShare * netShares;
    const settlementValue = netShares * settlementPrice;
    const pnl = settlementValue - remainingCostBasis;

    // Apply settlement in transaction
    await prisma.$transaction(async (tx) => {
      const fresh = await tx.followAllocation.findUniqueOrThrow({
        where: { id: pos.followAllocationId },
      });

      await tx.followAllocation.update({
        where: { id: pos.followAllocationId },
        data: {
          currentCapital: { increment: settlementValue },
          deployedCapital: { decrement: Math.min(remainingCostBasis, fresh.deployedCapital) },
        },
      });

      // Settle BUY fills with per-trade pro-rated PnL (eliminates duplication when aggregating)
      const buyFills = fills.filter(f => f.side === 'BUY');
      const now = new Date();
      for (const fill of buyFills) {
        const fillCost = (fill.filledSize != null && fill.filledPrice != null)
          ? fill.filledSize * fill.filledPrice
          : fill.requestedAmount;
        const costProportion = totalBuyCost > 0 ? fillCost / totalBuyCost : 0;
        const tradeValue = settlementValue * costProportion;
        const tradePnl = pnl * costProportion;

        await tx.copyTrade.update({
          where: { id: fill.id },
          data: {
            status: 'SETTLED',
            settlementPrice,
            settlementValue: tradeValue,
            settlementPnl: tradePnl,
            settledAt: now,
            failReason: `market resolved: price=${settlementPrice.toFixed(4)}, value=$${tradeValue.toFixed(2)}, pnl=${tradePnl >= 0 ? '+' : ''}$${tradePnl.toFixed(2)}`,
          },
        });
      }

      // Close SELL fills — mark settled without overwriting their original failReason
      await tx.copyTrade.updateMany({
        where: {
          tokenId: pos.tokenId,
          followAllocationId: pos.followAllocationId,
          isPaper: pos.isPaper,
          status: 'FILLED',
          side: 'SELL',
        },
        data: { status: 'SETTLED', settledAt: now },
      });

      // Circuit breaker: check if settlement loss pushed allocation below threshold (live only)
      if (config.ALLOCATION_CIRCUIT_BREAKER_ENABLED && !pos.isPaper && pnl < 0) {
        const updated = await tx.followAllocation.findUniqueOrThrow({
          where: { id: pos.followAllocationId },
        });
        if (updated.initialCapital <= 0) return; // guard: avoid division by zero from bad data
        const ratio = (updated.currentCapital + updated.deployedCapital) / updated.initialCapital;
        if (ratio < config.ALLOCATION_CIRCUIT_BREAKER_THRESHOLD) {
          await tx.followAllocation.update({
            where: { id: pos.followAllocationId },
            data: { isActive: false },
          });
          log.warn('Circuit breaker tripped after settlement loss', {
            allocationId: pos.followAllocationId,
            ratio: ratio.toFixed(3),
            pnl: pnl.toFixed(2),
          });
        }
      }
    });

    settledCount++;
    totalPositionsSettled += fills.length;

    // Collect for on-chain claiming after all DB work is done
    // Use range check to handle float precision (e.g. 0.9999999 from Gamma API)
    if (!pos.isPaper && settlementPrice >= 0.95 && settlementPrice <= 1.0001) {
      claimablePositions.push({
        conditionId: meta.conditionId,
        outcomeIndex,
        netShares,
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
      });
    }

    log.info(`SETTLEMENT: ${pos.tokenId.slice(0, 20)}...`, {
      settlementPrice,
      netShares: netShares.toFixed(4),
      settlementValue: settlementValue.toFixed(2),
      pnl: pnl.toFixed(2),
      followAllocationId: pos.followAllocationId,
      isPaper: pos.isPaper,
    });
  }

  // Trigger on-chain redemption for winning positions and persist claim status
  const claimedConditionIds = await redeemWinningPositions(claimablePositions).catch((err: any) => {
    log.warn('Auto-claim batch failed', { error: err.message });
    return [] as string[];
  });
  await markConditionsClaimed(claimedConditionIds);

  // Notify Rust copier about settled markets (fire-and-forget)
  // Send market_closed for each resolved conditionId — Rust handles capital release internally
  // via its own position tracker + capital tracker (seeded from DB at startup).
  if (settledCount > 0) {
    try {
      const { sendToRust } = await import('./unix-socket-bridge.js');
      for (const conditionId of resolvedMarkets.keys()) {
        // Parse outcome prices for this market
        const marketData = resolvedMarkets.get(conditionId)!;
        let prices: number[] = [];
        try { prices = JSON.parse(marketData.outcomePrices).map(Number); } catch {}
        // Rust's MarketCache knows token_ids for each conditionId. Send prices in outcome order.
        // Rust receiver matches settlement_prices[i] to its cached token_ids[i].
        sendToRust({
          type: 'market_settled',
          condition_id: conditionId,
          token_ids: [], // Rust resolves from its MarketCache
          settlement_prices: prices,
        });
      }
    } catch {
      // IPC bridge may not be running — non-fatal
    }
  }

  log.info('Settlement sweep complete', {
    marketsChecked: uniqueConditionIds.length,
    marketsResolved: resolvedMarkets.size,
    positionsSettled: settledCount,
    tradesSettled: totalPositionsSettled,
  });
}

// ─── Unclaimed backlog sweep ────────────────────────────────────────────────
// Recovers positions that were settled but never claimed on-chain:
// - From previous container runs (in-memory retry queue lost on restart)
// - Accumulated across cycles but individually below threshold
// Runs at startup (chained after settlement) and hourly (capital audit timer).
export async function sweepUnclaimedSettledPositions(): Promise<void> {
  if (sweepRunning) {
    log.debug('Unclaimed sweep: skipped (settlement running)');
    return;
  }
  sweepRunning = true;
  try {
    await doSweepUnclaimedSettledPositions();
  } finally {
    sweepRunning = false;
  }
}

async function doSweepUnclaimedSettledPositions(): Promise<void> {
  // Aggregate ALL unclaimed settled wins by conditionId (across all allocations + cycles)
  const rows = await prisma.$queryRaw<{
    conditionId: string;
    outcome: string;
    tokenId: string;
    followAllocationId: string;
    netShares: number;
  }[]>`
    SELECT dt."conditionId", dt.outcome,
           (array_agg(ct."tokenId"))[1] as "tokenId",
           (array_agg(ct."followAllocationId"))[1] as "followAllocationId",
           SUM(CASE WHEN ct.side='BUY' THEN COALESCE(ct."filledSize", ct."requestedAmount" / NULLIF(ct."filledPrice", 0)) ELSE 0 END) -
           SUM(CASE WHEN ct.side='SELL' THEN COALESCE(ct."filledSize", 0) ELSE 0 END) as "netShares"
    FROM "CopyTrade" ct
    JOIN "DetectedTrade" dt ON ct."detectedTradeId" = dt.id
    WHERE ct."isPaper" = false
      AND ct.status = 'SETTLED'
      AND ct."settlementPrice" BETWEEN 0.95 AND 1.0001
      AND ct."claimedAt" IS NULL
    GROUP BY dt."conditionId", dt.outcome
    HAVING SUM(CASE WHEN ct.side='BUY' THEN COALESCE(ct."filledSize", ct."requestedAmount" / NULLIF(ct."filledPrice", 0)) ELSE 0 END) >
           SUM(CASE WHEN ct.side='SELL' THEN COALESCE(ct."filledSize", 0) ELSE 0 END)
  `;

  if (rows.length === 0) return;
  log.info(`Unclaimed sweep: found ${rows.length} unclaimed conditionId(s)`);

  // Derive outcomeIndex via Market table (batched query, same pattern as test-claim.ts)
  const uniqueConditionIds = [...new Set(rows.map(r => r.conditionId))];
  const markets = await prisma.market.findMany({
    where: { conditionId: { in: uniqueConditionIds } },
    select: { conditionId: true, outcomes: true },
  });
  const marketMap = new Map(markets.map(m => [m.conditionId, m.outcomes]));

  const claimable: ClaimablePosition[] = [];
  for (const r of rows) {
    const outcomesRaw = marketMap.get(r.conditionId);
    if (!outcomesRaw) continue;

    let outcomes: string[];
    try { outcomes = JSON.parse(outcomesRaw); } catch { continue; }

    const outcomeIndex = outcomes.findIndex(
      o => normalizeOutcome(o) === normalizeOutcome(r.outcome)
    );
    if (outcomeIndex < 0) continue;
    if (r.netShares <= 0) continue;

    claimable.push({
      conditionId: r.conditionId,
      outcomeIndex,
      netShares: r.netShares,
      tokenId: r.tokenId,
      followAllocationId: r.followAllocationId,
    });
  }

  if (claimable.length === 0) return;

  const claimedIds = await redeemWinningPositions(claimable).catch(() => [] as string[]);
  await markConditionsClaimed(claimedIds);
  if (claimedIds.length > 0) {
    log.info(`Unclaimed sweep: claimed ${claimedIds.length} conditionId(s)`);
  }
}

// ─── Stale market refresh sweep ─────────────────────────────────────────────
// Periodically refreshes ALL non-closed markets (not just those with open positions).
// Standard markets use Gamma API; NegRisk markets use on-chain CTF resolution
// (Gamma returns wrong data for NegRisk conditionIds).
let marketRefreshRunning = false;

export async function sweepStaleMarkets(): Promise<void> {
  if (marketRefreshRunning) return;
  marketRefreshRunning = true;
  try {
    await doSweepStaleMarkets();
  } finally {
    marketRefreshRunning = false;
  }
}

async function doSweepStaleMarkets(): Promise<void> {
  const MAX_BATCH = 100;

  const staleMarkets = await prisma.market.findMany({
    where: { closed: false },
    select: { conditionId: true, negRisk: true, outcomes: true },
    orderBy: { updatedAt: 'asc' },
    take: MAX_BATCH,
  });

  if (staleMarkets.length === 0) return;

  const standardMarkets = staleMarkets.filter(m => !m.negRisk);
  const negRiskMarkets = staleMarkets.filter(m => m.negRisk);
  let newlyClosed = 0;

  // Standard markets: refresh via Gamma API
  if (standardMarkets.length > 0) {
    const ids = standardMarkets.map(m => m.conditionId);
    try {
      const fresh = await getMarketsByConditionIds(ids);
      if (fresh.length > 0) {
        await prisma.$transaction(
          fresh.map(market => prisma.market.updateMany({
            where: { conditionId: market.conditionId },
            data: {
              closed: market.closed,
              active: market.active,
              outcomePrices: market.outcomePrices ?? null,
              endDate: market.endDate ? new Date(market.endDate) : undefined,
              negRisk: market.negRisk ?? undefined,
            },
          }))
        );
        newlyClosed += fresh.filter(m => m.closed).length;
      }
    } catch (err: any) {
      log.warn(`Market refresh: Gamma API failed: ${err.message}`);
    }
  }

  // NegRisk markets: on-chain CTF resolution
  if (negRiskMarkets.length > 0) {
    const limit = pLimit(3);
    const results = await Promise.allSettled(
      negRiskMarkets.map(m => limit(async () => {
        const outcomes: string[] = JSON.parse(m.outcomes);
        const res = await checkOnChainResolution(m.conditionId, outcomes.length);
        return { conditionId: m.conditionId, res };
      }))
    );

    for (const result of results) {
      if (result.status === 'rejected') {
        log.debug('Market refresh: NegRisk on-chain check failed', { error: String(result.reason) });
        continue;
      }
      const { conditionId, res } = result.value;
      if (!res.resolved) continue;
      await prisma.market.updateMany({
        where: { conditionId },
        data: { closed: true, outcomePrices: JSON.stringify(res.payouts) },
      });
      newlyClosed++;
    }
  }

  log.info('Market refresh sweep', {
    totalNonClosed: staleMarkets.length,
    standard: standardMarkets.length,
    negRisk: negRiskMarkets.length,
    newlyClosed,
  });
}
