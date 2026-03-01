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

  if (markets.length === 0) {
    logger.warn(`${missing.length} markets could not be resolved from Gamma API`);
    return;
  }

  // Batch insert new markets, skip existing
  const marketCreateData = markets.map((market) => ({
    id: String(market.id),
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
  }));

  const { count: inserted } = await prisma.market.createMany({
    data: marketCreateData,
    skipDuplicates: true,
  });

  // Batch-update volatile fields on existing markets via $transaction
  if (markets.length > inserted) {
    const CHUNK_SIZE = 200;
    for (let i = 0; i < markets.length; i += CHUNK_SIZE) {
      const chunk = markets.slice(i, i + CHUNK_SIZE);
      try {
        await prisma.$transaction(
          chunk.map((market) =>
            prisma.market.updateMany({
              where: { conditionId: market.conditionId },
              data: {
                question: market.question,
                outcomePrices: market.outcomePrices ?? null,
                closed: market.closed,
                active: market.active,
                volume: market.volume ?? null,
                liquidity: market.liquidity ?? null,
              },
            })
          )
        );
      } catch (err: any) {
        logger.warn(`Market batch update failed: ${err.message}`);
      }
    }
  }

  const stillMissing = missing.length - markets.length;
  if (stillMissing > 0) {
    logger.warn(`${stillMissing} markets could not be resolved from Gamma API`);
  }

  logger.info(`Resolved ${markets.length} markets (${inserted} new)`);
}
