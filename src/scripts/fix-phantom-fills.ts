/**
 * Repair script for phantom fills — DB shows FILLED/SETTLED but no on-chain position.
 *
 * Two-pass repair:
 *   Pass A: FILLED phantoms — detected via Data API position check
 *   Pass B: SETTLED phantoms — detected via CLOB getOrder() check
 *
 * After marking phantoms as SKIPPED, uses auditAllocation() to recompute
 * correct capital and SET it directly.
 *
 * Usage:
 *   npx tsx src/scripts/fix-phantom-fills.ts                    # dry-run both passes
 *   npx tsx src/scripts/fix-phantom-fills.ts --apply            # apply both passes
 *   npx tsx src/scripts/fix-phantom-fills.ts --pass-a-only      # only FILLED phantoms
 *   npx tsx src/scripts/fix-phantom-fills.ts --pass-b-only      # only SETTLED phantoms
 *   npx tsx src/scripts/fix-phantom-fills.ts --allocation <id>  # single allocation
 */
import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { auditAllocation } from '../lib/capital-audit';
import { getAllPositions } from '../api/data-api';
import { initialize, getClient } from '../services/trade-executor';
import { config } from '../config/env';

const apply = process.argv.includes('--apply');
const passAOnly = process.argv.includes('--pass-a-only');
const passBOnly = process.argv.includes('--pass-b-only');
const allocationFilter = (() => {
  const idx = process.argv.indexOf('--allocation');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();
const walletFilter = (() => {
  const idx = process.argv.indexOf('--wallet');
  return idx >= 0 ? process.argv[idx + 1] : null;
})();

function appendAnnotation(existing: string | null, annotation: string): string {
  return existing ? `${existing} | ${annotation}` : annotation;
}

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface PhantomTrade {
  id: string;
  tokenId: string;
  followAllocationId: string;
  side: string;
  status: string;
  orderId: string | null;
  filledSize: number | null;
  filledPrice: number | null;
  failReason: string | null;
}

async function main() {
  console.log(`\n=== Phantom Fill Repair ${apply ? '(APPLY)' : '(DRY RUN)'} ===\n`);

  // ─── Load allocations ───

  const allocWhere: { isActive: boolean; isPaper: boolean; id?: string } = { isActive: true, isPaper: false };
  if (allocationFilter) allocWhere.id = allocationFilter;

  let allocations = await prisma.followAllocation.findMany({
    where: allocWhere,
    include: { trader: { select: { userName: true } } },
  });

  if (walletFilter) {
    allocations = allocations.filter(a =>
      a.proxyWallet.toLowerCase().includes(walletFilter!.toLowerCase()),
    );
  }

  console.log(`Found ${allocations.length} active live allocation(s)\n`);

  // ─── Fetch API positions for funder wallet ───

  const funderAddress = config.FUNDER_ADDRESS;
  if (!funderAddress) throw new Error('FUNDER_ADDRESS not configured');

  console.log(`Fetching positions for funder wallet ${funderAddress.slice(0, 10)}...`);
  const apiPositions = await getAllPositions(funderAddress);
  const apiPositionMap = new Map<string, number>();
  for (const pos of apiPositions) {
    apiPositionMap.set(pos.asset, pos.size);
  }
  console.log(`  ${apiPositions.length} positions from API\n`);

  // ─── Fetch scalp/arb positions to exclude from phantom detection ───

  const scalpTokenIds = new Set<string>();
  const scalpCycles = await prisma.scalpCycle.findMany({
    where: { status: 'ENTERED' },
    select: { tokenId: true },
  });
  for (const sc of scalpCycles) {
    if (sc.tokenId) scalpTokenIds.add(sc.tokenId);
  }

  const arbTokenIds = new Set<string>();
  const arbCycles = await prisma.arbCycle.findMany({
    where: { status: 'ENTERED' },
    select: { tokenId: true },
  });
  for (const ac of arbCycles) {
    if (ac.tokenId) arbTokenIds.add(ac.tokenId);
  }

  if (scalpTokenIds.size > 0 || arbTokenIds.size > 0) {
    console.log(`Excluding ${scalpTokenIds.size} scalp + ${arbTokenIds.size} arb active positions\n`);
  }

  // ─── Initialize CLOB client for getOrder() ───

  await initialize();
  const client = getClient();
  if (!client) throw new Error('CLOB client not initialized');

  // Track all phantoms per allocation for capital correction
  const allocationPhantoms = new Map<string, PhantomTrade[]>();

  // ═══════════════════════════════════════════════════════════════
  // PASS A: FILLED phantoms (detected via API position check)
  // ═══════════════════════════════════════════════════════════════

  if (!passBOnly) {
    console.log('══ Pass A: FILLED Phantoms (API position check) ══\n');

    for (const alloc of allocations) {
      const traderName = (alloc as any).trader?.userName ?? alloc.proxyWallet.slice(0, 10);

      // Get all FILLED trades for this allocation
      const filledTrades = await prisma.copyTrade.findMany({
        where: {
          followAllocationId: alloc.id,
          status: 'FILLED',
          isPaper: false,
        },
        select: {
          id: true, tokenId: true, side: true, status: true, orderId: true,
          filledSize: true, filledPrice: true, failReason: true,
        },
      });

      // Group by tokenId
      const byToken = new Map<string, typeof filledTrades>();
      for (const t of filledTrades) {
        const group = byToken.get(t.tokenId) ?? [];
        group.push(t);
        byToken.set(t.tokenId, group);
      }

      for (const [tokenId, trades] of byToken) {
        // Compute net DB shares
        let netShares = 0;
        for (const t of trades) {
          if (t.side === 'BUY') netShares += t.filledSize ?? 0;
          else netShares -= t.filledSize ?? 0;
        }
        if (netShares <= 0.001) continue; // no meaningful position

        // Check API
        const apiShares = apiPositionMap.get(tokenId) ?? 0;
        if (apiShares > 0.001) continue; // position exists on-chain

        // Exclude if held by scalp/arb
        if (scalpTokenIds.has(tokenId) || arbTokenIds.has(tokenId)) {
          console.log(`  [SKIP] ${traderName} token ${tokenId.slice(0, 16)}... held by scalp/arb`);
          continue;
        }

        // Skip already-fixed trades
        if (trades.every(t => t.failReason?.includes('[phantom-fix]'))) continue;

        // Corroborate via CLOB getOrder()
        let allOrdersNull = true;
        for (const t of trades) {
          if (!t.orderId) continue;
          try {
            const order = await client.getOrder(t.orderId);
            if (order) {
              allOrdersNull = false;
              break;
            }
          } catch {
            // getOrder failure — inconclusive, skip this token
            allOrdersNull = false;
            break;
          }
          await sleep(100);
        }

        if (!allOrdersNull) {
          console.log(`  [MANUAL] ${traderName} token ${tokenId.slice(0, 16)}... getOrder returned non-null, needs manual review`);
          continue;
        }

        // Confirmed phantom — all trades for this token+allocation
        const buyCost = trades
          .filter(t => t.side === 'BUY')
          .reduce((sum, t) => sum + (t.filledSize ?? 0) * (t.filledPrice ?? 0), 0);

        console.log(
          `  ${apply ? 'FIX' : 'WOULD FIX'} ${traderName} token ${tokenId.slice(0, 16)}... ` +
          `(${trades.length} trades, $${buyCost.toFixed(2)} buy cost, ${netShares.toFixed(4)} net shares, API=0)`,
        );

        const phantoms = allocationPhantoms.get(alloc.id) ?? [];
        phantoms.push(...trades as PhantomTrade[]);
        allocationPhantoms.set(alloc.id, phantoms);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // PASS B: SETTLED phantoms (detected via CLOB getOrder() check)
  // ═══════════════════════════════════════════════════════════════

  if (!passAOnly) {
    console.log('\n══ Pass B: SETTLED Phantoms (getOrder check) ══\n');

    for (const alloc of allocations) {
      const traderName = (alloc as any).trader?.userName ?? alloc.proxyWallet.slice(0, 10);

      const settledTrades = await prisma.copyTrade.findMany({
        where: {
          followAllocationId: alloc.id,
          status: 'SETTLED',
          isPaper: false,
        },
        select: {
          id: true, tokenId: true, side: true, status: true, orderId: true,
          filledSize: true, filledPrice: true, failReason: true,
        },
      });

      // Group by tokenId
      const byToken = new Map<string, typeof settledTrades>();
      for (const t of settledTrades) {
        const group = byToken.get(t.tokenId) ?? [];
        group.push(t);
        byToken.set(t.tokenId, group);
      }

      for (const [tokenId, trades] of byToken) {
        // Skip already-fixed trades
        if (trades.every(t => t.failReason?.includes('[phantom-fix]'))) continue;

        // Only check BUY trades' orderIds (SELL orderIds may not exist)
        const buyTrades = trades.filter(t => t.side === 'BUY' && t.orderId);
        if (buyTrades.length === 0) continue;

        // Check getOrder() for all BUY orderIds
        let allOrdersNull = true;
        for (const t of buyTrades) {
          try {
            const order = await client.getOrder(t.orderId!);
            if (order) {
              allOrdersNull = false;
              break;
            }
          } catch {
            // getOrder failure — inconclusive, skip
            allOrdersNull = false;
            break;
          }
          await sleep(100);
        }

        if (!allOrdersNull) continue; // real trades, skip

        const buyCost = buyTrades
          .reduce((sum, t) => sum + (t.filledSize ?? 0) * (t.filledPrice ?? 0), 0);

        console.log(
          `  ${apply ? 'FIX' : 'WOULD FIX'} ${traderName} token ${tokenId.slice(0, 16)}... ` +
          `(${trades.length} SETTLED trades, $${buyCost.toFixed(2)} buy cost, all getOrder=null)`,
        );

        const phantoms = allocationPhantoms.get(alloc.id) ?? [];
        phantoms.push(...trades as PhantomTrade[]);
        allocationPhantoms.set(alloc.id, phantoms);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════
  // Apply repairs + capital correction
  // ═══════════════════════════════════════════════════════════════

  console.log('\n══ Summary ══\n');

  let totalPhantoms = 0;
  let totalAllocationsAffected = 0;

  for (const [allocId, phantoms] of allocationPhantoms) {
    const alloc = allocations.find(a => a.id === allocId)!;
    const traderName = (alloc as any).trader?.userName ?? alloc.proxyWallet.slice(0, 10);
    const uniqueTokens = new Set(phantoms.map(p => p.tokenId));

    totalPhantoms += phantoms.length;
    totalAllocationsAffected++;

    console.log(`${traderName} (${allocId}):`);
    console.log(`  Phantom trades: ${phantoms.length} across ${uniqueTokens.size} token(s)`);
    console.log(`  Current CC: $${alloc.currentCapital.toFixed(2)}, DC: $${alloc.deployedCapital.toFixed(2)}`);

    if (apply) {
      // Mark phantom trades as SKIPPED in a transaction
      await prisma.$transaction(async (tx) => {
        for (const trade of phantoms) {
          // Skip if already fixed
          if (trade.failReason?.includes('[phantom-fix]')) continue;

          const annotation = `[phantom-fix] original: status=${trade.status}, filledSize=${trade.filledSize}, filledPrice=${trade.filledPrice}`;
          await tx.copyTrade.update({
            where: { id: trade.id },
            data: {
              status: 'SKIPPED',
              failReason: appendAnnotation(trade.failReason, annotation),
            },
          });
        }
      });

      // Re-compute capital via audit replay (runs after txn commits, sees SKIPPED)
      const audit = await auditAllocation(allocId);
      await prisma.followAllocation.update({
        where: { id: allocId },
        data: {
          currentCapital: audit.computedCC,
          deployedCapital: audit.computedDC,
        },
      });

      console.log(`  FIXED → CC: $${audit.computedCC.toFixed(2)}, DC: $${audit.computedDC.toFixed(2)}`);
      console.log(`  Delta: CC ${(audit.computedCC - alloc.currentCapital) >= 0 ? '+' : ''}$${(audit.computedCC - alloc.currentCapital).toFixed(2)}, DC ${(audit.computedDC - alloc.deployedCapital) >= 0 ? '+' : ''}$${(audit.computedDC - alloc.deployedCapital).toFixed(2)}`);
    } else {
      // Dry-run: simulate what audit would compute
      // We can't change status in dry-run, but we can show the phantom cost
      const phantomBuyCost = phantoms
        .filter(p => p.side === 'BUY')
        .reduce((sum, p) => sum + (p.filledSize ?? 0) * (p.filledPrice ?? 0), 0);
      const phantomSellProceeds = phantoms
        .filter(p => p.side === 'SELL')
        .reduce((sum, p) => sum + (p.filledSize ?? 0) * (p.filledPrice ?? 0), 0);
      console.log(`  Phantom BUY cost: $${phantomBuyCost.toFixed(2)}, SELL proceeds: $${phantomSellProceeds.toFixed(2)}`);
      console.log(`  Expected CC correction: ~+$${(phantomBuyCost - phantomSellProceeds).toFixed(2)}`);
    }
    console.log();
  }

  console.log(`Total: ${totalPhantoms} phantom trades across ${totalAllocationsAffected} allocation(s)\n`);

  if (!apply && totalPhantoms > 0) {
    console.log('Run with --apply to write changes.');
    console.log('After applying, run: pm2 restart copy-trader\n');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('Script failed:', err);
  await prisma.$disconnect();
  process.exit(1);
});
