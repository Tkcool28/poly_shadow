import { prisma } from '../lib/prisma';
import { auditAllAllocations, type AllocationAudit } from '../lib/capital-audit';
import { config } from '../config/env';

export async function reconcileCapital(options: {
  fix?: boolean;
  verbose?: boolean;
}): Promise<void> {
  const { fix = false, verbose = false } = options;

  console.log('\n=== Capital Reconciliation ===\n');

  // Audit all allocations (both paper and live)
  const allAudits = await auditAllAllocations({ threshold: 0.01 });

  if (allAudits.length === 0) {
    console.log('No allocations found.');
    return;
  }

  // Separate by type
  const liveAudits = allAudits.filter(a => !a.isPaper);
  const paperAudits = allAudits.filter(a => a.isPaper);

  // Display live allocations
  if (liveAudits.length > 0) {
    console.log('── Live Allocations ──\n');
    printAuditTable(liveAudits, verbose);
  }

  // Display paper allocations
  if (paperAudits.length > 0 && verbose) {
    console.log('\n── Paper Allocations ──\n');
    printAuditTable(paperAudits, verbose);
  }

  // Summary
  const liveDiscrepancies = liveAudits.filter(a => a.deltaCC > 1.0 || a.deltaDC > 1.0);
  console.log(`\nSummary: ${liveAudits.length} live allocations, ${liveDiscrepancies.length} with discrepancies > $1`);

  // Totals
  const totalInitial = liveAudits.reduce((s, a) => s + a.initialCapital, 0);
  const totalActualCC = liveAudits.reduce((s, a) => s + a.actualCC, 0);
  const totalActualDC = liveAudits.reduce((s, a) => s + a.actualDC, 0);
  const totalComputedCC = liveAudits.reduce((s, a) => s + a.computedCC, 0);
  const totalComputedDC = liveAudits.reduce((s, a) => s + a.computedDC, 0);

  console.log(`\nTotal initial:   $${totalInitial.toFixed(2)}`);
  console.log(`Total actual:    CC=$${totalActualCC.toFixed(2)}  DC=$${totalActualDC.toFixed(2)}  Total=$${(totalActualCC + totalActualDC).toFixed(2)}`);
  console.log(`Total computed:  CC=$${totalComputedCC.toFixed(2)}  DC=$${totalComputedDC.toFixed(2)}  Total=$${(totalComputedCC + totalComputedDC).toFixed(2)}`);
  console.log(`Capital PnL:     $${(totalActualCC + totalActualDC - totalInitial).toFixed(2)} (actual)  $${(totalComputedCC + totalComputedDC - totalInitial).toFixed(2)} (computed)`);

  // Settlement PnL cross-check
  const settlementPnl = await prisma.copyTrade.aggregate({
    where: { status: 'SETTLED', isPaper: false, settlementPnl: { not: null } },
    _sum: { settlementPnl: true },
  });
  if (settlementPnl._sum.settlementPnl != null) {
    console.log(`Settlement PnL:  $${settlementPnl._sum.settlementPnl.toFixed(2)} (from settlementPnl field)`);
  }

  // Polymarket API cross-reference
  if (config.FUNDER_ADDRESS) {
    try {
      const { getValue } = await import('../api/data-api.js');
      const value = await getValue(config.FUNDER_ADDRESS);
      console.log(`\nPolymarket API (${config.FUNDER_ADDRESS.slice(0, 10)}...):`);
      console.log(`  Portfolio value: $${value.value.toFixed(2)}`);
    } catch (err: any) {
      console.log(`\nPolymarket API: failed to fetch (${err.message})`);
    }
  }

  // Fix mode
  if (fix && liveDiscrepancies.length > 0) {
    console.log(`\nApplying fixes to ${liveDiscrepancies.length} allocations...\n`);

    await prisma.$transaction(
      liveDiscrepancies.map(audit =>
        prisma.followAllocation.update({
          where: { id: audit.id },
          data: {
            currentCapital: audit.computedCC,
            deployedCapital: audit.computedDC,
          },
        })
      )
    );

    for (const audit of liveDiscrepancies) {
      console.log(`  Fixed ${audit.proxyWallet.slice(0, 10)}...  CC: $${audit.actualCC.toFixed(2)} → $${audit.computedCC.toFixed(2)}  DC: $${audit.actualDC.toFixed(2)} → $${audit.computedDC.toFixed(2)}`);
    }

    console.log('\nDone. Run `reconcile` again to verify.');
  } else if (fix && liveDiscrepancies.length === 0) {
    console.log('\nNo discrepancies to fix.');
  } else if (liveDiscrepancies.length > 0) {
    console.log('\nRun with --fix to correct discrepancies.');
  }
}

function printAuditTable(audits: AllocationAudit[], verbose: boolean): void {
  const header = `${'Wallet'.padEnd(12)} ${'Init'.padStart(7)} ${'ActCC'.padStart(8)} ${'CmpCC'.padStart(8)} ${'ΔCC'.padStart(7)} ${'ActDC'.padStart(8)} ${'CmpDC'.padStart(8)} ${'ΔDC'.padStart(7)}`;
  console.log(header);
  console.log('─'.repeat(header.length));

  for (const a of audits) {
    const hasIssue = a.deltaCC > 1.0 || a.deltaDC > 1.0;
    if (!verbose && !hasIssue) continue;

    const flag = hasIssue ? ' ⚠' : '';
    console.log(
      `${a.proxyWallet.slice(0, 10).padEnd(12)} ` +
      `${('$' + a.initialCapital.toFixed(0)).padStart(7)} ` +
      `${('$' + a.actualCC.toFixed(2)).padStart(8)} ` +
      `${('$' + a.computedCC.toFixed(2)).padStart(8)} ` +
      `${('$' + a.deltaCC.toFixed(2)).padStart(7)} ` +
      `${('$' + a.actualDC.toFixed(2)).padStart(8)} ` +
      `${('$' + a.computedDC.toFixed(2)).padStart(8)} ` +
      `${('$' + a.deltaDC.toFixed(2)).padStart(7)}${flag}`
    );
  }
}
