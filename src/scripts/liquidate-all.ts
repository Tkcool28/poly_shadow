/**
 * Liquidate all open LIVE positions across every FollowAllocation.
 *
 * Usage:
 *   npx tsx src/scripts/liquidate-all.ts [--dry-run]
 *
 * - Finds all live allocations (isPaper=false) with net-positive positions
 * - Sells each position via the CLOB (FOK market order at best available price)
 * - Updates CopyTrade records and allocation capital
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { scanPositions, printPositionSummary, confirm, executeLiquidation, type OpenPosition } from './lib/liquidate';

const dryRun = process.argv.includes('--dry-run');

async function main() {
  const allocations = await prisma.followAllocation.findMany({
    where: { isPaper: false },
    include: { trader: { select: { userName: true } } },
  });

  if (allocations.length === 0) {
    console.log('No live allocations found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${allocations.length} live allocations. Scanning for open positions...\n`);

  const allPositions: OpenPosition[] = [];

  for (const alloc of allocations) {
    const positions = await scanPositions(alloc.id, false, alloc.proxyWallet);
    if (positions.length === 0) continue;

    const name = alloc.trader?.userName ?? alloc.proxyWallet.slice(0, 12);
    console.log(`── ${name} (capital: $${alloc.currentCapital.toFixed(2)}, deployed: $${alloc.deployedCapital.toFixed(2)})`);
    printPositionSummary(positions);
    console.log();

    allPositions.push(...positions);
  }

  if (allPositions.length === 0) {
    console.log('No open live positions found.');
    await prisma.$disconnect();
    return;
  }

  const grouped = new Map<string, OpenPosition[]>();
  for (const p of allPositions) {
    if (!grouped.has(p.followAllocationId)) grouped.set(p.followAllocationId, []);
    grouped.get(p.followAllocationId)!.push(p);
  }

  const totalEstUsd = allPositions.reduce((sum, p) => sum + p.netShares * p.lastPrice, 0);
  console.log(`Total: ${allPositions.length} positions across ${grouped.size} allocations (~$${totalEstUsd.toFixed(2)} est.)\n`);

  if (dryRun) {
    console.log('--- DRY RUN --- No trades executed.');
    await prisma.$disconnect();
    return;
  }

  const ok = await confirm(`About to sell ${allPositions.length} positions worth ~$${totalEstUsd.toFixed(2)}. Continue?`);
  if (!ok) {
    console.log('Aborted.');
    await prisma.$disconnect();
    return;
  }

  const { soldCount, failCount, expiredCount, totalProceeds } = await executeLiquidation(allPositions);

  console.log('\n========================================');
  console.log('LIQUIDATION COMPLETE');
  console.log(`  Sold:    ${soldCount}/${allPositions.length}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Expired: ${expiredCount} (will auto-settle)`);
  console.log(`  Proceeds: $${totalProceeds.toFixed(2)}`);

  for (const allocId of Array.from(grouped.keys())) {
    const updated = await prisma.followAllocation.findUnique({
      where: { id: allocId },
      include: { trader: { select: { userName: true } } },
    });
    if (updated) {
      const name = updated.trader?.userName ?? updated.proxyWallet.slice(0, 12);
      console.log(`\n  ${name}:`);
      console.log(`    Current capital:  $${updated.currentCapital.toFixed(2)}`);
      console.log(`    Deployed capital: $${updated.deployedCapital.toFixed(2)}`);
    }
  }

  console.log('========================================');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
