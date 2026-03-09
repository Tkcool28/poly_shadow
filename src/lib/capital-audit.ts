import { prisma } from './prisma';
import { createJobLogger } from './logger';
import { getAllPositions } from '../api/data-api';
import { getOrCreateMutex } from './allocation-mutex';
import { config } from '../config/env';

const log = createJobLogger('capital-audit');

/** Estimate share count, guarding against zero/null price → Infinity. */
function estimateShares(filledSize: number | null, filledPrice: number | null, requestedAmount: number): number {
  if (filledSize != null) return filledSize;
  if (filledPrice && filledPrice > 0) return requestedAmount / filledPrice;
  return requestedAmount;
}

export interface AllocationAudit {
  id: string;
  proxyWallet: string;
  isPaper: boolean;
  initialCapital: number;
  // Actual DB values
  actualCC: number;
  actualDC: number;
  // Computed values
  computedCC: number;
  computedDC: number;
  // Deltas
  deltaCC: number;
  deltaDC: number;
}

/**
 * Audit a single allocation by replaying trade history to compute expected capital.
 *
 * Capital flow (event-based replay):
 *   BUY event  (at createdAt):  cc -= min(cost, cc);  dc += min(cost, cc)
 *   SELL event (at createdAt):  cc += proceeds;        dc -= min(costBasis, dc)
 *   SETTLEMENT (at settledAt):  cc += settlementValue;  dc -= min(costBasis, dc)
 *
 * SETTLED BUYs are split into two events so that cc accurately drops between
 * BUY execution and settlement — matching the real system's capital pressure.
 */
export async function auditAllocation(allocationId: string): Promise<AllocationAudit> {
  const allocation = await prisma.followAllocation.findUniqueOrThrow({
    where: { id: allocationId },
  });

  // Get all trades ordered chronologically (filter by allocation's current mode)
  const trades = await prisma.copyTrade.findMany({
    where: {
      followAllocationId: allocationId,
      status: { in: ['FILLED', 'SETTLED'] },
      isPaper: allocation.isPaper,
    },
    select: {
      id: true,
      tokenId: true,
      side: true,
      status: true,
      requestedAmount: true,
      filledSize: true,
      filledPrice: true,
      settlementValue: true,
      settlementPnl: true,
      failReason: true,
      createdAt: true,
      settledAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  // Build event list: SETTLED BUYs produce two events (BUY deduction + settlement credit)
  // so that cc accurately drops between execution and settlement.
  type AuditEvent = { type: 'BUY' | 'SELL' | 'SETTLEMENT'; timestamp: Date; trade: typeof trades[number] };
  const events: AuditEvent[] = [];

  for (const trade of trades) {
    events.push({
      type: trade.side as 'BUY' | 'SELL',
      timestamp: trade.createdAt,
      trade,
    });

    if (trade.status === 'SETTLED' && trade.side === 'BUY') {
      events.push({
        type: 'SETTLEMENT',
        timestamp: trade.settledAt ?? trade.createdAt, // fallback for legacy trades without settledAt
        trade,
      });
    }
  }

  events.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  let cc = allocation.initialCapital;
  let dc = 0;

  // Per-token cost accumulators for average cost method
  const tokenCost = new Map<string, { buyCost: number; buyShares: number }>();

  for (const event of events) {
    const { trade } = event;
    const usd = (trade.filledSize != null && trade.filledPrice != null)
      ? trade.filledSize * trade.filledPrice
      : trade.requestedAmount;

    if (event.type === 'BUY') {
      const shares = estimateShares(trade.filledSize, trade.filledPrice, trade.requestedAmount);
      const prev = tokenCost.get(trade.tokenId) ?? { buyCost: 0, buyShares: 0 };
      tokenCost.set(trade.tokenId, {
        buyCost: prev.buyCost + usd,
        buyShares: prev.buyShares + shares,
      });

      // BUY: deduct from available capital (capped to prevent negative)
      const deducted = Math.min(usd, Math.max(cc, 0));
      cc -= deducted;
      dc += deducted;
    } else if (event.type === 'SELL') {
      // SELL: use per-token avg cost for deployedCapital release
      const soldShares = estimateShares(trade.filledSize, trade.filledPrice, trade.requestedAmount);
      const tok = tokenCost.get(trade.tokenId);
      const avgCost = (tok && tok.buyShares > 0) ? tok.buyCost / tok.buyShares : 0;
      const costBasis = avgCost * soldShares;

      cc += usd;
      dc -= Math.min(costBasis, dc);
    } else {
      // SETTLEMENT: credit settlement value, release deployed capital
      let settleValue = trade.settlementValue;

      // Fallback: parse from failReason if new fields not populated
      if (settleValue == null && trade.failReason) {
        const match = trade.failReason.match(/value=\$([\d.]+)/);
        if (match) settleValue = parseFloat(match[1]);
      }

      if (settleValue != null && Number.isFinite(settleValue)) {
        const shares = estimateShares(trade.filledSize, trade.filledPrice, trade.requestedAmount);
        const tok = tokenCost.get(trade.tokenId);
        const avgCost = (tok && tok.buyShares > 0) ? tok.buyCost / tok.buyShares : 0;
        const costBasis = avgCost * shares;

        cc += settleValue;
        dc -= Math.min(costBasis, dc);
      } else {
        log.warn('Settlement value missing for SETTLED BUY trade', {
          tradeId: trade.id, allocationId,
          hasSettlementValue: trade.settlementValue != null,
          hasFailReason: trade.failReason != null,
        });
      }
    }
  }

  // Also account for POOLED trades (capital reserved but not yet executed)
  const pooledSum = await prisma.copyTrade.aggregate({
    where: { followAllocationId: allocationId, side: 'BUY', status: 'POOLED', isPaper: allocation.isPaper },
    _sum: { requestedAmount: true },
  });
  const pooled = pooledSum._sum.requestedAmount ?? 0;
  dc += pooled;

  return {
    id: allocation.id,
    proxyWallet: allocation.proxyWallet,
    isPaper: allocation.isPaper,
    initialCapital: allocation.initialCapital,
    actualCC: allocation.currentCapital,
    actualDC: allocation.deployedCapital,
    computedCC: cc,
    computedDC: dc,
    deltaCC: Math.abs(cc - allocation.currentCapital),
    deltaDC: Math.abs(dc - allocation.deployedCapital),
  };
}

/**
 * Audit all live (non-paper) allocations. Returns array of audits with discrepancies.
 */
export async function auditAllAllocations(options?: {
  isPaper?: boolean;
  threshold?: number;
}): Promise<AllocationAudit[]> {
  const threshold = options?.threshold ?? 1.0; // $1 tolerance
  const allocations = await prisma.followAllocation.findMany({
    where: options?.isPaper != null ? { isPaper: options.isPaper } : {},
    select: { id: true },
  });

  const results: AllocationAudit[] = [];
  for (const alloc of allocations) {
    try {
      const audit = await auditAllocation(alloc.id);
      results.push(audit);
    } catch (err: any) {
      log.warn(`Audit failed for allocation ${alloc.id}`, { error: err.message });
    }
  }

  const discrepancies = results.filter(r => r.deltaCC > threshold || r.deltaDC > threshold);
  if (discrepancies.length > 0) {
    log.warn(`Capital audit: ${discrepancies.length}/${results.length} allocations have discrepancies > $${threshold}`, {
      discrepancies: discrepancies.map(d => ({
        wallet: d.proxyWallet.slice(0, 10),
        deltaCC: d.deltaCC.toFixed(2),
        deltaDC: d.deltaDC.toFixed(2),
      })),
    });
  } else {
    log.info(`Capital audit: ${results.length} allocations checked, all within $${threshold} tolerance`);
  }

  return results;
}

export interface PhantomPositionAudit {
  tokenId: string;
  followAllocationId: string;
  dbShares: number;
  dbCostBasis: number;
  apiShares: number;
  isPhantom: boolean;
  heldByOtherStrategy: boolean;
}

/**
 * Detect phantom positions: DB says FILLED BUYs exist, but API shows 0 shares.
 * Only checks FILLED trades (not SETTLED) — SETTLED phantoms need getOrder() verification.
 */
export async function auditPhantomPositions(funderAddress: string): Promise<PhantomPositionAudit[]> {
  // 1. Get all FILLED BUY positions from DB (live only)
  const filledBuys = await prisma.copyTrade.findMany({
    where: {
      status: 'FILLED',
      side: 'BUY',
      isPaper: false,
      followAllocation: { isActive: true },
    },
    select: {
      tokenId: true,
      followAllocationId: true,
      filledSize: true,
      filledPrice: true,
    },
  });

  // Group by (tokenId, followAllocationId)
  const positionMap = new Map<string, { tokenId: string; allocId: string; shares: number; cost: number }>();
  for (const t of filledBuys) {
    if (!t.followAllocationId) continue;
    const key = `${t.tokenId}|${t.followAllocationId}`;
    const existing = positionMap.get(key) ?? { tokenId: t.tokenId, allocId: t.followAllocationId, shares: 0, cost: 0 };
    existing.shares += t.filledSize ?? 0;
    existing.cost += (t.filledSize ?? 0) * (t.filledPrice ?? 0);
    positionMap.set(key, existing);
  }

  // Also subtract FILLED SELLs
  const filledSells = await prisma.copyTrade.findMany({
    where: {
      status: 'FILLED',
      side: 'SELL',
      isPaper: false,
      followAllocation: { isActive: true },
    },
    select: { tokenId: true, followAllocationId: true, filledSize: true, filledPrice: true },
  });
  for (const t of filledSells) {
    if (!t.followAllocationId) continue;
    const key = `${t.tokenId}|${t.followAllocationId}`;
    const existing = positionMap.get(key);
    if (existing) {
      existing.shares -= t.filledSize ?? 0;
      existing.cost -= (t.filledSize ?? 0) * (t.filledPrice ?? 0);
    }
  }
  // Floor cost to zero (SELLs can exceed BUY cost due to price appreciation)
  for (const [, pos] of positionMap) {
    pos.cost = Math.max(pos.cost, 0);
  }

  // 2. Fetch API positions
  const apiPositions = await getAllPositions(funderAddress);

  // GUARD: If API returned 0 positions but DB shows active fills, likely API outage — abort to prevent mass phantom marking
  if (apiPositions.length === 0 && positionMap.size > 0) {
    log.warn('Phantom audit aborted: API returned 0 positions but DB has active fills (possible API outage)');
    return [];
  }

  const apiMap = new Map<string, number>();
  for (const pos of apiPositions) {
    apiMap.set(pos.asset, pos.size);
  }

  // 3. Query scalp/arb active positions
  const otherStrategyTokens = new Set<string>();
  const scalpCycles = await prisma.scalpCycle.findMany({
    where: { status: 'ENTERED' },
    select: { tokenId: true },
  });
  for (const sc of scalpCycles) {
    if (sc.tokenId) otherStrategyTokens.add(sc.tokenId);
  }
  const arbCycles = await prisma.arbCycle.findMany({
    where: { status: 'ENTERED' },
    select: { tokenId: true },
  });
  for (const ac of arbCycles) {
    if (ac.tokenId) otherStrategyTokens.add(ac.tokenId);
  }

  // 4. Compare
  const results: PhantomPositionAudit[] = [];
  for (const [, pos] of positionMap) {
    if (pos.shares <= 0.001) continue; // no meaningful position

    const apiShares = apiMap.get(pos.tokenId) ?? 0;
    const heldByOther = otherStrategyTokens.has(pos.tokenId);

    if (apiShares <= 0.001 && !heldByOther) {
      results.push({
        tokenId: pos.tokenId,
        followAllocationId: pos.allocId,
        dbShares: pos.shares,
        dbCostBasis: pos.cost,
        apiShares,
        isPhantom: true,
        heldByOtherStrategy: false,
      });
    } else if (apiShares <= 0.001 && heldByOther) {
      results.push({
        tokenId: pos.tokenId,
        followAllocationId: pos.allocId,
        dbShares: pos.shares,
        dbCostBasis: pos.cost,
        apiShares,
        isPhantom: false,
        heldByOtherStrategy: true,
      });
    }
  }

  return results;
}

// ─── Phantom Auto-Cleanup ───

export interface PhantomCleanupResult {
  cleaned: number;
  capitalCorrections: number;
}

/**
 * Detect and auto-fix phantom positions: mark phantom FILLED trades as SKIPPED,
 * then replay capital to correct CC/DC on affected allocations.
 *
 * Safeguards:
 *  - Cost basis threshold prevents auto-fixing real positions during API glitches
 *  - Annotation dedup prevents double cleanup
 *  - Per-allocation mutex prevents race conditions with drain pipeline
 */
export async function cleanupPhantomPositions(funderAddress: string): Promise<PhantomCleanupResult> {
  const maxCost = config.PHANTOM_AUTO_CLEANUP_MAX_COST_USD;
  const phantomResults = await auditPhantomPositions(funderAddress);
  const confirmedPhantoms = phantomResults.filter(p => p.isPhantom);

  if (confirmedPhantoms.length === 0) {
    return { cleaned: 0, capitalCorrections: 0 };
  }

  let cleaned = 0;
  const affectedAllocations = new Set<string>();

  for (const phantom of confirmedPhantoms) {
    // Conservative guard: skip high-cost positions that might be real but API-inconsistent
    if (phantom.dbCostBasis > maxCost) {
      log.warn('Phantom cleanup: skipping high-cost position (manual review needed)', {
        tokenId: phantom.tokenId.slice(0, 16),
        allocation: phantom.followAllocationId,
        dbCost: phantom.dbCostBasis.toFixed(2),
        maxCost,
      });
      continue;
    }

    // Find all FILLED trades for this phantom token+allocation
    const trades = await prisma.copyTrade.findMany({
      where: {
        tokenId: phantom.tokenId,
        followAllocationId: phantom.followAllocationId,
        status: 'FILLED',
        isPaper: false,
      },
      select: { id: true, status: true, filledSize: true, filledPrice: true, failReason: true },
    });

    if (trades.length === 0) continue;

    // Mark phantom trades as SKIPPED with annotation (skip if already annotated)
    let markedCount = 0;
    for (const trade of trades) {
      if (trade.failReason?.includes('[phantom-fix') || trade.failReason?.includes('[ghost-fill-recovered]')) continue; // idempotent: skip already-fixed or recovered trades

      const annotation = `[phantom-fix-auto] original: status=${trade.status}, filledSize=${trade.filledSize}, filledPrice=${trade.filledPrice}`;
      await prisma.copyTrade.update({
        where: { id: trade.id },
        data: {
          status: 'SKIPPED',
          failReason: trade.failReason ? `${trade.failReason} | ${annotation}` : annotation,
        },
      });
      markedCount++;
    }

    if (markedCount > 0) {
      cleaned += markedCount;
      affectedAllocations.add(phantom.followAllocationId);
      log.info('Phantom cleanup: marked trades as SKIPPED', {
        tokenId: phantom.tokenId.slice(0, 16),
        allocation: phantom.followAllocationId,
        tradesFixed: markedCount,
        dbShares: phantom.dbShares.toFixed(4),
        dbCost: phantom.dbCostBasis.toFixed(2),
      });
    }
  }

  // Replay capital for affected allocations under mutex to prevent race with drain pipeline
  let capitalCorrections = 0;
  for (const allocId of affectedAllocations) {
    try {
      const mutex = getOrCreateMutex(allocId);
      await mutex.runExclusive(async () => {
        const audit = await auditAllocation(allocId);
        await prisma.followAllocation.update({
          where: { id: allocId },
          data: {
            currentCapital: audit.computedCC,
            deployedCapital: audit.computedDC,
          },
        });
        log.info('Phantom cleanup: corrected capital', {
          allocationId: allocId,
          ccBefore: audit.actualCC.toFixed(2),
          ccAfter: audit.computedCC.toFixed(2),
          dcBefore: audit.actualDC.toFixed(2),
          dcAfter: audit.computedDC.toFixed(2),
        });
      });
      capitalCorrections++;
    } catch (err: any) {
      log.error('Phantom cleanup: capital correction failed', {
        allocationId: allocId,
        error: err.message,
      });
    }
  }

  return { cleaned, capitalCorrections };
}

// ─── Per-Allocation Circuit Breaker ───

export interface CircuitBreakerResult {
  allocationId: string;
  proxyWallet: string;
  traderName: string | null;
  initialCapital: number;
  remainingCapital: number;
  drawdownPercent: number;
}

/**
 * Check all active live allocations for deep drawdown and auto-deactivate.
 * Scoped to live only (isPaper=false) — paper allocations don't risk real capital.
 */
export async function checkCircuitBreakers(threshold: number): Promise<CircuitBreakerResult[]> {
  const allocations = await prisma.followAllocation.findMany({
    where: { isActive: true, isPaper: false },
    include: { trader: { select: { userName: true } } },
  });

  const tripped: CircuitBreakerResult[] = [];

  for (const alloc of allocations) {
    if (alloc.initialCapital <= 0) continue; // guard: avoid division by zero from bad data

    const remaining = alloc.currentCapital + alloc.deployedCapital;
    const ratio = remaining / alloc.initialCapital;

    if (ratio < threshold) {
      await prisma.followAllocation.update({
        where: { id: alloc.id },
        data: { isActive: false },
      });

      const result: CircuitBreakerResult = {
        allocationId: alloc.id,
        proxyWallet: alloc.proxyWallet,
        traderName: alloc.trader?.userName ?? null,
        initialCapital: alloc.initialCapital,
        remainingCapital: remaining,
        drawdownPercent: (1 - ratio) * 100,
      };
      tripped.push(result);

      log.warn('Circuit breaker tripped: deactivating allocation', {
        trader: result.traderName ?? alloc.proxyWallet.slice(0, 10),
        initialCapital: alloc.initialCapital.toFixed(2),
        remainingCapital: remaining.toFixed(2),
        drawdownPercent: result.drawdownPercent.toFixed(1),
        threshold: (threshold * 100).toFixed(0) + '%',
      });
    }
  }

  return tripped;
}
