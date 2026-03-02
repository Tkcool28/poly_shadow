/**
 * Detects expired/resolved open positions and converts them to synthetic
 * closed positions for accurate scoring.
 *
 * Problem: When a Polymarket market resolves, the Position record stays in the
 * DB with stale snapshot data. It never migrates to ClosedPosition. Scoring
 * modules that only look at ClosedPosition (consistency, recency, category)
 * miss these entirely — hiding both losses AND unredeemed wins.
 *
 * Solution: At scoring time, partition open positions into "truly open" vs
 * "expired/resolved", converting the latter into synthetic closed positions
 * that feed into all scoring modules.
 */

export interface ExpandedPositionRow {
  asset: string;
  conditionId: string;
  cashPnl: number | null;
  initialValue: number | null;
  curPrice: number | null;
  currentValue: number | null;
  endDate: Date | null;
  snapshotAt: Date;
}

export interface SyntheticClosedPosition {
  conditionId: string;
  realizedPnl: number;
  totalBought: number;
  timestamp: number;
}

export interface PartitionResult {
  trulyOpen: Array<{ cashPnl: number | null; initialValue: number | null }>;
  syntheticClosed: SyntheticClosedPosition[];
}

/**
 * Determines if an open position is effectively expired/resolved.
 *
 * Criterion A (market confirmed closed + terminal price):
 *   Market.closed = true AND curPrice is at a terminal value (<=0.05 or >=0.95 or null).
 *   Positions with ambiguous curPrice (0.05-0.95) in closed markets are skipped —
 *   their stale cashPnl may not reflect the final settlement.
 *
 * Criterion B (worthless position fallback):
 *   curPrice = 0 AND currentValue = 0, regardless of Market.closed status.
 *   Catches positions where our Market.closed flag is stale but the position is dead.
 */
export function isExpiredPosition(
  position: ExpandedPositionRow,
  closedMarketConditionIds: Set<string>,
): boolean {
  // Criterion A: Market confirmed closed + terminal price
  if (closedMarketConditionIds.has(position.conditionId)) {
    const price = position.curPrice;
    if (price == null || price <= 0.05 || price >= 0.95) {
      return true;
    }
    // Ambiguous price (0.05 < price < 0.95) in closed market — skip
  }

  // Criterion B: Position is definitively worthless
  if (position.curPrice === 0 && position.currentValue === 0) {
    return true;
  }

  return false;
}

/**
 * Partitions open positions into truly-open vs expired/resolved.
 *
 * Expired positions are converted to synthetic closed position format.
 * Deduplication is done at the asset level to avoid double-counting positions
 * that exist in both Position and ClosedPosition tables.
 */
export function partitionPositions(
  positions: ExpandedPositionRow[],
  closedMarketConditionIds: Set<string>,
  dbClosedAssets: Set<string>,
): PartitionResult {
  const trulyOpen: PartitionResult['trulyOpen'] = [];
  const syntheticClosed: SyntheticClosedPosition[] = [];

  for (const p of positions) {
    // Dedup: skip if this asset already exists in DB closed positions
    if (dbClosedAssets.has(p.asset)) {
      // Still count as truly open for unrealized PnL if not expired
      // (the DB closed position captures the realized portion)
      if (!isExpiredPosition(p, closedMarketConditionIds)) {
        trulyOpen.push({ cashPnl: p.cashPnl, initialValue: p.initialValue });
      }
      continue;
    }

    if (!isExpiredPosition(p, closedMarketConditionIds)) {
      trulyOpen.push({ cashPnl: p.cashPnl, initialValue: p.initialValue });
      continue;
    }

    // Null guard: skip if both cashPnl and initialValue are null
    if (p.cashPnl == null && p.initialValue == null) {
      continue;
    }

    syntheticClosed.push({
      conditionId: p.conditionId,
      realizedPnl: p.cashPnl ?? 0,
      totalBought: p.initialValue ?? 0,
      timestamp: p.endDate
        ? Math.floor(p.endDate.getTime() / 1000)
        : Math.floor(p.snapshotAt.getTime() / 1000),
    });
  }

  return { trulyOpen, syntheticClosed };
}
