import { prisma } from '../lib/prisma';
import { createJobLogger } from '../lib/logger';

const log = createJobLogger('reset-follows');

interface ResetOptions {
  capital: number;
  dryRun: boolean;
  reactivate: boolean;
}

export async function resetFollows(options: ResetOptions): Promise<void> {
  const { capital, dryRun, reactivate } = options;

  // 1. Load all live allocations
  const allocations = await prisma.followAllocation.findMany({
    where: { isPaper: false },
    include: { trader: { select: { userName: true } } },
  });

  if (allocations.length === 0) {
    console.log('No live allocations found.');
    return;
  }

  // 2. Show current state
  console.log('\n=== Current State ===\n');
  console.log('Trader       | Active | Initial | Current  | Deployed');
  console.log('-------------|--------|---------|----------|--------');
  for (const a of allocations) {
    const name = (a.trader?.userName ?? a.proxyWallet.slice(0, 10)).padEnd(12);
    const active = a.isActive ? 'YES' : 'NO ';
    console.log(
      `${name} | ${active}    | $${a.initialCapital.toFixed(0).padStart(5)} | $${a.currentCapital.toFixed(2).padStart(7)} | $${a.deployedCapital.toFixed(2).padStart(7)}`,
    );
  }

  // 3. Count open FILLED/POOLED trades that will be affected
  const allocationIds = allocations.map(a => a.id);
  const filledCount = await prisma.copyTrade.count({
    where: {
      followAllocationId: { in: allocationIds },
      isPaper: false,
      status: 'FILLED',
    },
  });
  const pooledCount = await prisma.copyTrade.count({
    where: {
      followAllocationId: { in: allocationIds },
      isPaper: false,
      status: 'POOLED',
    },
  });

  const activeCount = reactivate
    ? allocations.length
    : allocations.filter(a => a.isActive).length;
  const totalCapital = activeCount * capital;

  console.log(`\n=== Reset Plan ===\n`);
  console.log(`Allocations to reset: ${activeCount} (${reactivate ? 'including reactivated' : 'active only'})`);
  console.log(`Capital per allocation: $${capital}`);
  console.log(`Total new capital: $${totalCapital}`);
  console.log(`FILLED trades to soft-settle: ${filledCount}`);
  console.log(`POOLED trades to cancel: ${pooledCount}`);

  const deployedTotal = allocations.reduce((s, a) => s + a.deployedCapital, 0);
  if (deployedTotal > 0) {
    console.log(`\nNote: ~$${deployedTotal.toFixed(2)} in open CLOB positions will settle on-chain naturally.`);
  }

  if (dryRun) {
    console.log('\n[DRY RUN] No changes made.');
    return;
  }

  // 4. Execute reset in transaction
  await prisma.$transaction(async (tx) => {
    // 4a. Mark all FILLED → SETTLED (soft close, prevents double-settlement)
    if (filledCount > 0) {
      const updated = await tx.copyTrade.updateMany({
        where: {
          followAllocationId: { in: allocationIds },
          isPaper: false,
          status: 'FILLED',
        },
        data: {
          status: 'SETTLED',
          failReason: 'manual reset: positions written off, will settle on-chain',
        },
      });
      log.info('Soft-settled FILLED trades', { count: updated.count });
    }

    // 4b. Mark all POOLED → SKIPPED (cancel pending pools)
    if (pooledCount > 0) {
      const updated = await tx.copyTrade.updateMany({
        where: {
          followAllocationId: { in: allocationIds },
          isPaper: false,
          status: 'POOLED',
        },
        data: {
          status: 'SKIPPED',
          failReason: 'manual reset: pool cancelled',
        },
      });
      log.info('Cancelled POOLED trades', { count: updated.count });
    }

    // 4c. Reset each allocation
    for (const alloc of allocations) {
      const shouldActivate = reactivate || alloc.isActive;
      await tx.followAllocation.update({
        where: { id: alloc.id },
        data: {
          initialCapital: capital,
          currentCapital: capital,
          deployedCapital: 0,
          isActive: shouldActivate,
        },
      });
    }

    log.info('Reset allocations', {
      count: allocations.length,
      capitalPerAllocation: capital,
      reactivate,
    });
  });

  // 5. Show new state
  console.log('\n=== Reset Complete ===\n');
  const updated = await prisma.followAllocation.findMany({
    where: { isPaper: false },
    include: { trader: { select: { userName: true } } },
  });
  for (const a of updated) {
    const name = (a.trader?.userName ?? a.proxyWallet.slice(0, 10)).padEnd(12);
    console.log(
      `${name} | $${a.currentCapital.toFixed(2)} available | ${a.isActive ? 'ACTIVE' : 'INACTIVE'}`,
    );
  }
  console.log(`\nTotal: $${updated.reduce((s, a) => s + a.currentCapital, 0).toFixed(2)}`);
  console.log('\nReminder: Restart ipc-bridge: docker compose restart ipc-bridge');
}
