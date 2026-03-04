import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';
import { normalizeOutcome } from '../lib/normalize';
import { getMarketsByConditionIds } from '../api/gamma-api';

const log = createJobLogger('unrealized-pnl');

interface OpenPosition {
  tokenId: string;
  followAllocationId: string;
  isPaper: boolean;
}

export interface UnrealizedPnlResult {
  unrealizedPnl: number;
  marketValue: number;
  positions: number;
  hasStaleData: boolean;
}

export async function calculateUnrealizedPnl(
  allocationIds: string[],
): Promise<Map<string, UnrealizedPnlResult>> {
  const result = new Map<string, UnrealizedPnlResult>();

  // Initialize all requested allocations with zeros
  for (const id of allocationIds) {
    result.set(id, { unrealizedPnl: 0, marketValue: 0, positions: 0, hasStaleData: false });
  }

  if (allocationIds.length === 0) return result;

  // Step 1: Find open positions (same raw SQL as position-settlement.ts)
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

  // Filter to requested allocations
  const allocationSet = new Set(allocationIds);
  const relevantPositions = openPositions.filter(p => allocationSet.has(p.followAllocationId));

  if (relevantPositions.length === 0) return result;

  // Step 2: Map tokenId → conditionId + outcome via DetectedTrade
  const uniqueTokenIds = [...new Set(relevantPositions.map(p => p.tokenId))];
  const tokenMeta = new Map<string, { conditionId: string; outcome: string }>();

  const detectedTrades = await prisma.detectedTrade.findMany({
    where: { asset: { in: uniqueTokenIds } },
    select: { asset: true, conditionId: true, outcome: true },
    distinct: ['asset'],
  });

  for (const dt of detectedTrades) {
    tokenMeta.set(dt.asset, { conditionId: dt.conditionId, outcome: dt.outcome });
  }

  // Step 3: Fetch current prices from Gamma API (batch deduplicated)
  const uniqueConditionIds = [...new Set([...tokenMeta.values()].map(m => m.conditionId))];

  if (uniqueConditionIds.length === 0) return result;

  const freshMarkets = await getMarketsByConditionIds(uniqueConditionIds);

  // Build price map: conditionId → parsed outcomes/prices (ALL markets, not just closed)
  const priceMap = new Map<string, { outcomes: string[]; outcomePrices: number[] }>();
  const staleConditionIds = new Set<string>();

  for (const market of freshMarkets) {
    if (!market.outcomePrices || !market.outcomes) continue;
    try {
      const outcomes: string[] = JSON.parse(market.outcomes);
      const outcomePrices: number[] = JSON.parse(market.outcomePrices).map(Number);
      priceMap.set(market.conditionId, { outcomes, outcomePrices });
    } catch {
      log.debug('Failed to parse market data', { conditionId: market.conditionId });
    }
  }

  // Step 4: Fallback to cached Market table for missing conditionIds
  const fetchedConditionIds = new Set(freshMarkets.map(m => m.conditionId));
  const missingIds = uniqueConditionIds.filter(id => !fetchedConditionIds.has(id) && !priceMap.has(id));

  if (missingIds.length > 0) {
    const cached = await prisma.market.findMany({
      where: { conditionId: { in: missingIds }, outcomePrices: { not: null } },
      select: { conditionId: true, outcomes: true, outcomePrices: true },
    });

    for (const market of cached) {
      if (!market.outcomePrices || !market.outcomes) continue;
      try {
        const outcomes: string[] = JSON.parse(market.outcomes);
        const outcomePrices: number[] = JSON.parse(market.outcomePrices).map(Number);
        priceMap.set(market.conditionId, { outcomes, outcomePrices });
        staleConditionIds.add(market.conditionId);
      } catch {
        // Skip unparseable cached data
      }
    }
  }

  // Step 5: Calculate unrealized P&L per position
  for (const pos of relevantPositions) {
    const meta = tokenMeta.get(pos.tokenId);
    if (!meta) {
      log.debug('No DetectedTrade metadata for tokenId', { tokenId: pos.tokenId.slice(0, 20) });
      continue;
    }

    const marketData = priceMap.get(meta.conditionId);
    if (!marketData) {
      // No price available at all — flag stale
      const entry = result.get(pos.followAllocationId)!;
      entry.hasStaleData = true;
      continue;
    }

    // Find outcome price
    const normalizedOutcome = normalizeOutcome(meta.outcome);
    const outcomeIndex = marketData.outcomes.findIndex(o => normalizeOutcome(o) === normalizedOutcome);
    if (outcomeIndex < 0 || outcomeIndex >= marketData.outcomePrices.length) {
      log.debug('Outcome not found in market', { outcome: meta.outcome, tokenId: pos.tokenId.slice(0, 20) });
      continue;
    }

    const currentPrice = marketData.outcomePrices[outcomeIndex];
    if (!Number.isFinite(currentPrice)) continue;

    // Get fills for this position
    const fills = await prisma.copyTrade.findMany({
      where: {
        tokenId: pos.tokenId,
        followAllocationId: pos.followAllocationId,
        isPaper: pos.isPaper,
        status: 'FILLED',
      },
      select: { side: true, filledSize: true, filledPrice: true, requestedAmount: true },
    });

    // Calculate net shares and cost basis (average cost method)
    let totalBuyShares = 0;
    let totalBuyCost = 0;
    let totalSellShares = 0;

    for (const fill of fills) {
      if (fill.side === 'BUY') {
        totalBuyShares += fill.filledSize ?? (fill.requestedAmount / (fill.filledPrice ?? 1));
        totalBuyCost += (fill.filledSize != null && fill.filledPrice != null)
          ? fill.filledSize * fill.filledPrice
          : fill.requestedAmount;
      } else {
        totalSellShares += fill.filledSize ?? 0;
      }
    }

    const netShares = Math.max(totalBuyShares - totalSellShares, 0);
    if (netShares <= 0 || totalBuyShares <= 0) continue;

    const avgCostPerShare = totalBuyCost / totalBuyShares;
    const remainingCostBasis = avgCostPerShare * netShares;
    const currentValue = netShares * currentPrice;
    const positionPnl = currentValue - remainingCostBasis;

    // Aggregate into allocation result
    const entry = result.get(pos.followAllocationId)!;
    entry.unrealizedPnl += positionPnl;
    entry.marketValue += currentValue;
    entry.positions += 1;
    if (staleConditionIds.has(meta.conditionId)) {
      entry.hasStaleData = true;
    }
  }

  return result;
}
