import { prisma } from '../lib/prisma';
import { auditAllAllocations, auditPhantomPositions, type AllocationAudit } from '../lib/capital-audit';
import { config } from '../config/env';

export async function reconcileCapital(options: {
  fix?: boolean;
  verbose?: boolean;
  full?: boolean;
  claim?: boolean;
  realign?: boolean;
}): Promise<void> {
  const { fix = false, verbose = false, full = false, claim = false, realign = false } = options;

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

  // Polymarket API cross-reference (always fetch portfolio value)
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

  // ─── Full API Snapshot ───
  if (full) {
    await printFullSnapshot();
  }

  // ─── Fix mode ───
  // Skip --fix when --realign is also set (realign overwrites CC/DC from wallet, making audit fix redundant)
  if (fix && realign) {
    console.log('\n--realign supersedes --fix (skipping audit replay fix)');
  } else if (fix && liveDiscrepancies.length > 0) {
    // Print rollback SQL before applying
    console.log('\n── Rollback SQL (save before proceeding) ──');
    for (const audit of liveDiscrepancies) {
      console.log(`UPDATE "FollowAllocation" SET "currentCapital"=${Number(audit.actualCC.toFixed(10))}, "deployedCapital"=${Number(audit.actualDC.toFixed(10))} WHERE id='${audit.id}';`);
    }

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

  // ─── Realign to wallet balance ───
  if (realign) {
    await realignToWallet();
  }

  // ─── Claim sweep ───
  if (claim) {
    await triggerClaimSweep();
  }
}

// ─── CLOB Client Lazy Init ─────────────────────────────────────────────────────

let clobInitialized = false;

async function ensureClobInit(): Promise<void> {
  if (clobInitialized) return;
  const { initialize } = await import('../services/trade-executor.js');
  await initialize();
  clobInitialized = true;
}

async function fetchWalletUSDC(): Promise<number | null> {
  try {
    await ensureClobInit();
    const { getWalletBalance } = await import('../services/trade-executor.js');
    const bal = await getWalletBalance();
    return bal?.balance ?? null;
  } catch {
    return null;
  }
}

// ─── Full API Snapshot ─────────────────────────────────────────────────────────

async function printFullSnapshot(): Promise<void> {
  const funder = config.FUNDER_ADDRESS;
  if (!funder) {
    console.log('\n── Full Snapshot: skipped (FUNDER_ADDRESS not set) ──');
    return;
  }

  console.log('\n=== Polymarket API Snapshot ===\n');

  // 1. Wallet USDC balance (requires CLOB client)
  const walletUSDC = await fetchWalletUSDC();

  if (walletUSDC != null) {
    console.log(`Wallet USDC:         $${walletUSDC.toFixed(2)}`);
  } else {
    console.log(`Wallet USDC:         N/A (no CLOB credentials)`);
  }

  // 2. API positions
  let apiPositionValue = 0;
  let positionCounts = { total: 0, claimable: 0, resolvedLost: 0, active: 0, dust: 0 };
  try {
    const { getAllPositions } = await import('../api/data-api.js');
    const positions = await getAllPositions(funder);
    positionCounts.total = positions.length;

    for (const p of positions) {
      const price = p.curPrice ?? 0;
      const size = p.size;
      const value = p.currentValue ?? 0;
      apiPositionValue += value;

      if (p.redeemable || (price >= 0.95 && size > 0.5)) {
        positionCounts.claimable++;
      } else if (price <= 0.01 && size > 0.5) {
        positionCounts.resolvedLost++;
      } else if (size <= 0.5) {
        positionCounts.dust++;
      } else {
        positionCounts.active++;
      }
    }

    console.log(`API positions:       ${positionCounts.total} total (${positionCounts.claimable} claimable, ${positionCounts.active} active, ${positionCounts.resolvedLost} resolved-lost, ${positionCounts.dust} dust)`);
  } catch (err: any) {
    console.log(`API positions:       failed (${err.message})`);
  }

  // 3. Unclaimed settlements
  const unclaimed = await prisma.$queryRaw<{ count: bigint; total_value: number }[]>`
    SELECT COUNT(*)::bigint as count, COALESCE(SUM("settlementValue"), 0) as total_value
    FROM "CopyTrade"
    WHERE status = 'SETTLED'
      AND "claimedAt" IS NULL
      AND "isPaper" = false
      AND "settlementPrice" BETWEEN 0.95 AND 1.0001
  `;
  const unclaimedCount = Number(unclaimed[0]?.count ?? 0);
  const unclaimedValue = unclaimed[0]?.total_value ?? 0;
  console.log(`Unclaimed wins:      ${unclaimedCount} trades, $${unclaimedValue.toFixed(2)} value`);
  console.log(`  Config: AUTO_CLAIM_ENABLED=${config.AUTO_CLAIM_ENABLED}, SIGNATURE_TYPE=${config.SIGNATURE_TYPE}`);

  // 4. All allocation totals (active + inactive)
  const allAllocations = await prisma.followAllocation.findMany({
    where: { isPaper: false },
    select: { isActive: true, currentCapital: true, deployedCapital: true, initialCapital: true },
  });

  let activeCC = 0, activeDC = 0, activeCount = 0;
  let inactiveCC = 0, inactiveDC = 0, inactiveCount = 0;
  for (const a of allAllocations) {
    if (a.isActive) {
      activeCC += a.currentCapital; activeDC += a.deployedCapital; activeCount++;
    } else {
      inactiveCC += a.currentCapital; inactiveDC += a.deployedCapital; inactiveCount++;
    }
  }
  const totalCC = activeCC + inactiveCC;
  const totalDC = activeDC + inactiveDC;

  console.log(`\nDB Capital (all non-paper):`);
  console.log(`  Active:   CC=$${activeCC.toFixed(2)}  DC=$${activeDC.toFixed(2)}  Total=$${(activeCC + activeDC).toFixed(2)}  (${activeCount} allocations)`);
  console.log(`  Inactive: CC=$${inactiveCC.toFixed(2)}  DC=$${inactiveDC.toFixed(2)}  Total=$${(inactiveCC + inactiveDC).toFixed(2)}  (${inactiveCount} allocations)`);
  console.log(`  All:      CC=$${totalCC.toFixed(2)}  DC=$${totalDC.toFixed(2)}  Total=$${(totalCC + totalDC).toFixed(2)}`);

  // 5. Capital equation
  console.log('\n=== Capital Equation ===\n');
  const walletStr = walletUSDC != null ? `$${walletUSDC.toFixed(2)}` : '???';
  const totalOnPoly = (walletUSDC ?? 0) + apiPositionValue;
  console.log(`Wallet + Positions = ${walletStr} + $${apiPositionValue.toFixed(2)} = $${totalOnPoly.toFixed(2)} (total on Polymarket)`);
  console.log(`All CC + All DC    = $${totalCC.toFixed(2)} + $${totalDC.toFixed(2)} = $${(totalCC + totalDC).toFixed(2)} (DB-tracked)`);
  const gap = totalOnPoly - (totalCC + totalDC);
  console.log(`Gap                = $${gap.toFixed(2)} (unclaimed settlements + inactive residuals + rounding)`);

  // 6. Phantom position cross-reference
  console.log('\n=== Position Cross-Reference ===\n');
  try {
    const phantomResults = await auditPhantomPositions(funder);
    const phantoms = phantomResults.filter(p => p.isPhantom);
    const confirmed = phantomResults.filter(p => !p.isPhantom && !p.heldByOtherStrategy);

    if (phantoms.length > 0) {
      console.log(`Phantoms: ${phantoms.length} (DB says FILLED, API shows 0 shares)`);
      for (const p of phantoms) {
        console.log(`  token=${p.tokenId.slice(0, 16)}... dbShares=${p.dbShares.toFixed(4)} cost=$${p.dbCostBasis.toFixed(2)} alloc=${p.followAllocationId}`);
      }
    } else {
      console.log('Phantoms: 0 (all DB positions confirmed on API)');
    }
    console.log(`API-confirmed open positions: ${confirmed.length}`);
  } catch (err: any) {
    console.log(`Position cross-reference failed: ${err.message}`);
  }
}

// ─── Realign to Wallet Balance ──────────────────────────────────────────────────

async function realignToWallet(): Promise<void> {
  console.log('\n=== Realign to Wallet Balance ===\n');

  // 1. Fetch actual wallet USDC
  const walletUSDC = await fetchWalletUSDC();
  if (walletUSDC == null) {
    console.log('Failed to fetch wallet balance.');
    console.log('CLOB credentials required for --realign. Set PRIVATE_KEY, CLOB_API_KEY, etc.');
    return;
  }
  console.log(`Wallet USDC:  $${walletUSDC.toFixed(2)}`);

  // 2. Find the single active live allocation
  const activeLive = await prisma.followAllocation.findMany({
    where: { isActive: true, isPaper: false },
  });

  if (activeLive.length === 0) {
    console.log('No active live allocations found.');
    return;
  }
  if (activeLive.length > 1) {
    console.log(`Multiple active live allocations (${activeLive.length}). Realign only works with 1 active allocation.`);
    console.log('Deactivate extra allocations first, then re-run.');
    return;
  }

  const alloc = activeLive[0];

  // 3. Check for open FILLED positions (DC should reflect their cost basis)
  const filledBuys = await prisma.copyTrade.aggregate({
    where: { followAllocationId: alloc.id, status: 'FILLED', side: 'BUY', isPaper: false },
    _sum: { requestedAmount: true },
    _count: true,
  });
  const openPositionCost = filledBuys._sum.requestedAmount ?? 0;
  const openPositionCount = filledBuys._count;

  // 4. Compute new values
  const newDC = openPositionCost; // cost basis of unsettled positions (usually 0)
  const newCC = walletUSDC;       // all available USDC goes to this allocation

  console.log(`\nActive allocation: ${alloc.id}`);
  console.log(`  Wallet: ${alloc.proxyWallet}`);
  console.log(`  Open FILLED positions: ${openPositionCount} (cost basis: $${openPositionCost.toFixed(2)})`);
  console.log(`\n  Current:  CC=$${alloc.currentCapital.toFixed(2)}  DC=$${alloc.deployedCapital.toFixed(2)}  Init=$${alloc.initialCapital.toFixed(2)}`);
  console.log(`  New:      CC=$${newCC.toFixed(2)}  DC=$${newDC.toFixed(2)}  Init=$${alloc.initialCapital.toFixed(2)}`);

  // 5. Check inactive allocations with stale CC
  const inactiveAllocations = await prisma.followAllocation.findMany({
    where: { isActive: false, isPaper: false, currentCapital: { gt: 0.01 } },
    select: { id: true, proxyWallet: true, currentCapital: true, deployedCapital: true },
  });
  const inactiveCC = inactiveAllocations.reduce((s, a) => s + a.currentCapital, 0);
  const inactiveDC = inactiveAllocations.reduce((s, a) => s + a.deployedCapital, 0);

  if (inactiveAllocations.length > 0) {
    console.log(`\n  Inactive allocations with stale CC: ${inactiveAllocations.length} (total CC=$${inactiveCC.toFixed(2)}, DC=$${inactiveDC.toFixed(2)})`);
    console.log(`  Will zero out inactive CC/DC (capital consolidated into active allocation)`);
  }

  // 6. Print rollback SQL
  console.log('\n── Rollback SQL ──');
  console.log(`UPDATE "FollowAllocation" SET "currentCapital"=${Number(alloc.currentCapital.toFixed(10))}, "deployedCapital"=${Number(alloc.deployedCapital.toFixed(10))} WHERE id='${alloc.id}';`);
  for (const ia of inactiveAllocations) {
    console.log(`UPDATE "FollowAllocation" SET "currentCapital"=${Number(ia.currentCapital.toFixed(10))}, "deployedCapital"=${Number(ia.deployedCapital.toFixed(10))} WHERE id='${ia.id}';`);
  }

  // 7. Apply
  console.log('\nApplying realignment...');

  const updates = [
    // Set active allocation CC to wallet balance, DC to open position cost
    prisma.followAllocation.update({
      where: { id: alloc.id },
      data: { currentCapital: newCC, deployedCapital: newDC },
    }),
    // Zero out all inactive non-paper allocations' CC/DC
    ...(inactiveAllocations.length > 0 ? [
      prisma.followAllocation.updateMany({
        where: { isActive: false, isPaper: false, currentCapital: { gt: 0.01 } },
        data: { currentCapital: 0, deployedCapital: 0 },
      }),
    ] : []),
  ];

  await prisma.$transaction(updates);

  console.log(`  ${alloc.proxyWallet.slice(0, 10)}...  CC: $${alloc.currentCapital.toFixed(2)} -> $${newCC.toFixed(2)}  DC: $${alloc.deployedCapital.toFixed(2)} -> $${newDC.toFixed(2)}`);
  if (inactiveAllocations.length > 0) {
    console.log(`  Zeroed ${inactiveAllocations.length} inactive allocations (was CC=$${inactiveCC.toFixed(2)})`);
  }
  console.log('\nDone. Run `reconcile --verbose --full` to verify.');
}

// ─── Claim Sweep ───────────────────────────────────────────────────────────────

async function triggerClaimSweep(): Promise<void> {
  console.log('\n=== Claim Sweep ===\n');

  if (!config.AUTO_CLAIM_ENABLED) {
    console.log('AUTO_CLAIM_ENABLED=false — set to true in .env to enable claiming');
    return;
  }

  if (config.SIGNATURE_TYPE === 2) {
    console.log('SIGNATURE_TYPE=2 (Gnosis Safe) — on-chain claiming not supported');
    console.log('Claim manually on polymarket.com or set SIGNATURE_TYPE=1 if wallet is POLY_PROXY');
    return;
  }

  console.log('Triggering unclaimed settlement sweep...');
  try {
    const { sweepUnclaimedSettledPositions } = await import('../services/position-settlement.js');
    await sweepUnclaimedSettledPositions();
    console.log('Sweep complete.');
  } catch (err: any) {
    console.log(`Sweep failed: ${err.message}`);
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

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
