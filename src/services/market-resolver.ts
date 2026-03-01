import { prisma } from '../lib/prisma';
import { getMarketsByConditionIds } from '../api/gamma-api';
import { logger } from '../lib/logger';

/**
 * Resolves market metadata for condition IDs not yet in the database.
 * Fetches from Gamma API and caches in the Market table.
 */
export async function resolveMarkets(conditionIds: string[]): Promise<void> {
  if (conditionIds.length === 0) return;

  const unique = [...new Set(conditionIds)];

  // Find which ones we already have
  const existing = await prisma.market.findMany({
    where: { conditionId: { in: unique } },
    select: { conditionId: true },
  });
  const existingSet = new Set(existing.map((m) => m.conditionId));
  const missing = unique.filter((id) => !existingSet.has(id));

  if (missing.length === 0) return;

  logger.info(`Resolving ${missing.length} unknown markets from Gamma API`);

  const markets = await getMarketsByConditionIds(missing);

  let upserted = 0;
  for (const market of markets) {
    try {
      await prisma.market.upsert({
        where: { conditionId: market.conditionId },
        create: {
          id: market.id,
          conditionId: market.conditionId,
          question: market.question,
          slug: market.slug,
          category: market.category ?? null,
          outcomes: market.outcomes,
          outcomePrices: market.outcomePrices ?? null,
          endDate: market.endDate ? new Date(market.endDate) : null,
          closed: market.closed,
          active: market.active,
          volume: market.volume ?? null,
          liquidity: market.liquidity ?? null,
          image: market.image ?? null,
          icon: market.icon ?? null,
          eventSlug: market.eventSlug ?? null,
        },
        update: {
          question: market.question,
          outcomePrices: market.outcomePrices ?? null,
          closed: market.closed,
          active: market.active,
          volume: market.volume ?? null,
          liquidity: market.liquidity ?? null,
        },
      });
      upserted++;
    } catch (err: any) {
      logger.warn(`Failed to upsert market ${market.conditionId}: ${err.message}`);
    }
  }

  const stillMissing = missing.length - upserted;
  if (stillMissing > 0) {
    logger.warn(`${stillMissing} markets could not be resolved from Gamma API`);
  }

  logger.info(`Resolved ${upserted} markets`);
}
