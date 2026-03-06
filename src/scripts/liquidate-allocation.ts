/**
 * Liquidate all open positions for a given FollowAllocation.
 *
 * Usage:
 *   npx tsx src/scripts/liquidate-allocation.ts <allocationId> [--dry-run]
 *
 * - Finds all net-positive positions (BUY > SELL) for the allocation
 * - Sells each position via the CLOB (FOK market order)
 * - Updates CopyTrade records and allocation capital
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { scanPositions, printPositionSummary, confirm, executeLiquidation } from './lib/liquidate';

const allocationId = process.argv[2];
const dryRun = process.argv.includes('--dry-run');

if (!allocationId) {
  console.error('Usage: npx tsx src/scripts/liquidate-allocation.ts <allocationId> [--dry-run]');
  process.exit(1);
}

async function main() {
  const allocation = await prisma.followAllocation.findUnique({
    where: { id: allocationId },
  });
  if (!allocation) {
    console.error(`Allocation ${allocationId} not found`);
    process.exit(1);
  }

  console.log(`Allocation: ${allocationId}`);
  console.log(`  Active: ${allocation.isActive}, Paper: ${allocation.isPaper}`);
  console.log(`  Capital: $${allocation.currentCapital.toFixed(2)} current, $${allocation.deployedCapital.toFixed(2)} deployed`);
  console.log(`  Dry run: ${dryRun}`);
  console.log();

  const positions = await scanPositions(allocationId, allocation.isPaper, allocation.proxyWallet);

  if (positions.length === 0) {
    console.log('No open positions found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${positions.length} open positions to liquidate:\n`);
  const totalEstUsd = printPositionSummary(positions);
  console.log(`\nTotal: ${positions.length} positions (~$${totalEstUsd.toFixed(2)} est.)`);

  if (dryRun) {
    console.log('\n--- DRY RUN --- No trades executed.');
    await prisma.$disconnect();
    return;
  }

  const ok = await confirm(`About to sell ${positions.length} positions worth ~$${totalEstUsd.toFixed(2)}. Continue?`);
  if (!ok) {
    console.log('Aborted.');
    await prisma.$disconnect();
    return;
  }

  const { soldCount, failCount, expiredCount, totalProceeds } = await executeLiquidation(positions);

  console.log('\n========================================');
  console.log('LIQUIDATION COMPLETE');
  console.log(`  Sold:    ${soldCount}/${positions.length}`);
  console.log(`  Failed:  ${failCount}`);
  console.log(`  Expired: ${expiredCount} (will auto-settle)`);
  console.log(`  Proceeds: $${totalProceeds.toFixed(2)}`);

  const updated = await prisma.followAllocation.findUnique({ where: { id: allocationId } });
  if (updated) {
    console.log(`\n  Updated allocation:`);
    console.log(`    Current capital:  $${updated.currentCapital.toFixed(2)}`);
    console.log(`    Deployed capital: $${updated.deployedCapital.toFixed(2)}`);
  }

  console.log('========================================');
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
