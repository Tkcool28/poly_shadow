/**
 * One-time backfill: tag Market rows with negRisk=true and fix stale resolution data.
 *
 * Strategy:
 * 1. For all markets: detect NegRisk via slug/question heuristic
 * 2. For all non-closed markets: check on-chain resolution and update if resolved
 *
 * Usage: npx tsx scripts/backfill-market-negrisk.ts
 */
import 'dotenv/config';
import { PrismaClient } from '../prisma/generated/prisma/client';
import { checkOnChainResolution } from '../src/lib/ctf-resolution';

const prisma = new PrismaClient();
const CONCURRENCY = 5;

// Heuristic: NegRisk markets have distinctive slug/question patterns
const NEGRISK_SLUG_PATTERNS = [
  /btc.*price/i,
  /bitcoin.*price/i,
  /sol.*price/i,
  /solana.*price/i,
  /eth.*price/i,
  /ethereum.*price/i,
  /crypto.*5.*min/i,
  /\d+.*minute.*candle/i,
  /updown/i,
];

function isLikelyNegRisk(slug: string, question: string): boolean {
  const text = `${slug || ''} ${question || ''}`;
  return NEGRISK_SLUG_PATTERNS.some(p => p.test(text));
}

// Simple concurrency limiter (avoids pLimit dependency in scripts)
async function mapWithLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  let idx = 0;
  async function next(): Promise<void> {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

async function main() {
  const allMarkets = await prisma.market.findMany({
    select: { conditionId: true, slug: true, question: true, closed: true, negRisk: true, outcomes: true },
  });

  console.log(`Total markets: ${allMarkets.length}`);
  console.log(`Already closed: ${allMarkets.filter(m => m.closed).length}`);
  console.log(`Already negRisk: ${allMarkets.filter(m => m.negRisk).length}`);

  // Step 1: Tag negRisk via slug heuristic
  let negRiskTagged = 0;
  for (const m of allMarkets) {
    if (m.negRisk) continue;
    if (isLikelyNegRisk(m.slug, m.question)) {
      await prisma.market.updateMany({
        where: { conditionId: m.conditionId },
        data: { negRisk: true },
      });
      negRiskTagged++;
    }
  }
  console.log(`Tagged ${negRiskTagged} markets as negRisk via slug heuristic`);

  // Step 2: Fix stale markets — check on-chain resolution for all non-closed
  const nonClosed = allMarkets.filter(m => !m.closed);
  console.log(`\nChecking ${nonClosed.length} non-closed markets on-chain (concurrency=${CONCURRENCY})...`);

  let resolved = 0;
  let errors = 0;

  await mapWithLimit(nonClosed, CONCURRENCY, async (m) => {
    try {
      const outcomes: string[] = JSON.parse(m.outcomes);
      const res = await checkOnChainResolution(m.conditionId, outcomes.length);
      if (res.resolved) {
        await prisma.market.updateMany({
          where: { conditionId: m.conditionId },
          data: { closed: true, outcomePrices: JSON.stringify(res.payouts) },
        });
        resolved++;
        console.log(`  RESOLVED: ${m.question.slice(0, 60)} → payouts=${JSON.stringify(res.payouts)}`);
      }
    } catch (err: any) {
      errors++;
      if (errors <= 5) {
        console.warn(`  ERROR: ${m.conditionId.slice(0, 20)}... ${err.message}`);
      }
    }
  });

  console.log(`\nDone. Resolved ${resolved} stale markets. Errors: ${errors}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
