/**
 * One-time migration script to fix historical data:
 *
 * Part A: Normalize NegRisk fills (raw token counts → standard share denomination)
 * Part B: Backfill settlement fields for existing SETTLED records
 *
 * Usage:
 *   npx tsx src/scripts/fix-negrisk-fills.ts           # dry-run
 *   npx tsx src/scripts/fix-negrisk-fills.ts --apply    # apply changes
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';

const apply = process.argv.includes('--apply');
const force = process.argv.includes('--force'); // re-backfill even if settlementPnl already set

async function main() {
  console.log(`\n=== Historical Data Fix ${apply ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  // ─── Part A: NegRisk normalization ───

  console.log('── Part A: NegRisk Fill Normalization ──\n');

  const negRiskFills = await prisma.copyTrade.findMany({
    where: {
      filledPrice: { lt: 0.05 },
      filledSize: { not: null },
      requestedPrice: { gte: 0.05 },
      status: { in: ['FILLED', 'SETTLED'] },
    },
    select: {
      id: true,
      tokenId: true,
      side: true,
      filledSize: true,
      filledPrice: true,
      requestedAmount: true,
      requestedPrice: true,
      failReason: true,
      status: true,
    },
  });

  let fixedCount = 0;
  let skippedCount = 0;

  for (const fill of negRiskFills) {
    if (fill.filledSize == null || fill.filledPrice == null) continue;

    const rawUsdCost = fill.filledSize * fill.filledPrice;
    // Sanity check: raw USD cost should be within 50% of requestedAmount
    if (fill.requestedAmount <= 0 || Math.abs(rawUsdCost - fill.requestedAmount) / fill.requestedAmount > 0.5) {
      console.log(`  SKIP ${fill.id}: USD cost mismatch (raw=$${rawUsdCost.toFixed(2)}, requested=$${fill.requestedAmount.toFixed(2)})`);
      skippedCount++;
      continue;
    }

    const normalizedSize = rawUsdCost / fill.requestedPrice;
    const normalizedPrice = fill.requestedPrice;

    console.log(
      `  ${apply ? 'FIX' : 'WOULD FIX'} ${fill.id} [${fill.side}/${fill.status}]: ` +
      `${fill.filledSize.toFixed(4)} @ $${fill.filledPrice.toFixed(6)} → ` +
      `${normalizedSize.toFixed(4)} @ $${normalizedPrice.toFixed(4)} ` +
      `(USD: $${rawUsdCost.toFixed(2)})`
    );

    if (apply) {
      // Preserve original values in failReason for rollback
      const annotation = `[negrisk-fix] original: size=${fill.filledSize.toFixed(6)}, price=${fill.filledPrice.toFixed(6)}`;
      const newFailReason = fill.failReason
        ? `${fill.failReason} | ${annotation}`
        : annotation;

      await prisma.copyTrade.update({
        where: { id: fill.id },
        data: {
          filledSize: normalizedSize,
          filledPrice: normalizedPrice,
          failReason: newFailReason,
        },
      });
    }

    fixedCount++;
  }

  console.log(`\nNegRisk: ${fixedCount} ${apply ? 'fixed' : 'would fix'}, ${skippedCount} skipped\n`);

  // ─── Part B: Backfill settlement fields ───

  console.log('── Part B: Backfill Settlement Fields ──\n');

  // The old settlement code wrote POSITION-level PnL to EVERY BUY trade's failReason.
  // We need to pro-rate: divide position value/PnL by number of trades in the same position group.
  const settledWithoutFields = await prisma.copyTrade.findMany({
    where: {
      status: 'SETTLED',
      side: 'BUY',
      failReason: { contains: 'market resolved:' },
    },
    select: {
      id: true,
      tokenId: true,
      followAllocationId: true,
      isPaper: true,
      failReason: true,
      filledSize: true,
      filledPrice: true,
      requestedAmount: true,
      createdAt: true,
      settlementPnl: true,
    },
  });

  // Regex handles both formats:
  //   "pnl=+$0.00" / "pnl=-$0.00" (sign before $)
  //   "pnl=$0.00" / "pnl=$-0.00"  (sign after $ — old format for losses)
  const pnlRegex = /price=([\d.]+),\s*value=\$([\d.]+),\s*pnl=([+-])?\$(-?[\d.]+)/;

  // Group by position (tokenId + followAllocationId + isPaper)
  const positionGroups = new Map<string, typeof settledWithoutFields>();
  for (const record of settledWithoutFields) {
    const key = `${record.tokenId}|${record.followAllocationId}|${record.isPaper}`;
    const group = positionGroups.get(key) ?? [];
    group.push(record);
    positionGroups.set(key, group);
  }

  let backfilledCount = 0;
  let parseFailCount = 0;
  let alreadyDoneCount = 0;

  for (const [_key, group] of positionGroups) {
    // Parse position-level values from any trade in the group (all have the same failReason values)
    const first = group[0];
    if (!first.failReason) { parseFailCount += group.length; continue; }

    const match = first.failReason.match(pnlRegex);
    if (!match) { parseFailCount += group.length; continue; }

    const price = parseFloat(match[1]);
    const positionValue = parseFloat(match[2]);
    // Handle both "pnl=-$2.00" (match[3]='-', match[4]='2.00')
    //          and "pnl=$-2.00" (match[3]=undefined, match[4]='-2.00')
    const positionPnl = match[3] === '-'
      ? -Math.abs(parseFloat(match[4]))
      : parseFloat(match[4]);

    if (!Number.isFinite(price) || !Number.isFinite(positionValue) || !Number.isFinite(positionPnl)) {
      parseFailCount += group.length;
      continue;
    }

    // Compute total cost for pro-rating
    let totalCost = 0;
    for (const trade of group) {
      totalCost += (trade.filledSize != null && trade.filledPrice != null)
        ? trade.filledSize * trade.filledPrice
        : trade.requestedAmount;
    }

    for (const trade of group) {
      // Skip if already backfilled (e.g. by the new settlement code) unless --force
      if (trade.settlementPnl != null && !force) {
        alreadyDoneCount++;
        continue;
      }

      const tradeCost = (trade.filledSize != null && trade.filledPrice != null)
        ? trade.filledSize * trade.filledPrice
        : trade.requestedAmount;
      const proportion = totalCost > 0 ? tradeCost / totalCost : 1 / group.length;
      const tradeValue = positionValue * proportion;
      const tradePnl = positionPnl * proportion;

      if (apply) {
        await prisma.copyTrade.update({
          where: { id: trade.id },
          data: {
            settlementPrice: price,
            settlementValue: tradeValue,
            settlementPnl: tradePnl,
            settledAt: trade.createdAt,
          },
        });
      }

      backfilledCount++;
    }
  }

  console.log(`Backfill: ${backfilledCount} ${apply ? 'updated' : 'would update'}, ${parseFailCount} parse failures\n`);

  if (!apply && (fixedCount > 0 || backfilledCount > 0)) {
    console.log('Run with --apply to write changes.\n');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Script failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
