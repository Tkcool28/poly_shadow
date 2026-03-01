import { normalizeCategory } from '../config/constants';

export interface CategoryMetrics {
  category: string;
  pnl: number;
  winRate: number;
  totalTrades: number;
  avgReturn: number;
  specializationScore: number;
}

interface ClosedPositionInput {
  conditionId: string;
  realizedPnl: number;
  totalBought: number;
}

interface MarketInput {
  conditionId: string;
  category: string | null;
}

export function computeCategoryScores(
  closedPositions: ClosedPositionInput[],
  markets: MarketInput[],
): CategoryMetrics[] {
  if (closedPositions.length === 0) return [];

  // Build conditionId → category map
  const marketCategoryMap = new Map<string, string>();
  for (const m of markets) {
    marketCategoryMap.set(m.conditionId, normalizeCategory(m.category));
  }

  // Group closed positions by category
  const byCategory = new Map<string, ClosedPositionInput[]>();
  for (const cp of closedPositions) {
    const cat = marketCategoryMap.get(cp.conditionId) ?? 'OTHER';
    const list = byCategory.get(cat) ?? [];
    list.push(cp);
    byCategory.set(cat, list);
  }

  const totalPositions = closedPositions.length;
  const results: CategoryMetrics[] = [];

  for (const [category, positions] of byCategory) {
    const pnl = positions.reduce((s, p) => s + p.realizedPnl, 0);
    const wins = positions.filter(p => p.realizedPnl > 0).length;
    const winRate = wins / positions.length;
    const totalBought = positions.reduce((s, p) => s + p.totalBought, 0);
    const avgReturn = totalBought > 0 ? pnl / totalBought : 0;
    // Specialization: share of total trades in this category
    const specializationScore = positions.length / totalPositions;

    results.push({
      category,
      pnl,
      winRate,
      totalTrades: positions.length,
      avgReturn,
      specializationScore,
    });
  }

  return results.sort((a, b) => b.totalTrades - a.totalTrades);
}
