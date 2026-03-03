import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { redeemWinningPositions } from '../services/position-claim';

async function main() {
  // Step 1: Find SETTLED winning positions (real conditionIds we actually won)
  const rows = await prisma.$queryRaw<{
    conditionId: string;
    outcome: string;
    tokenId: string;
    followAllocationId: string;
  }[]>`
    SELECT DISTINCT dt."conditionId", dt.outcome, ct."tokenId", ct."followAllocationId"
    FROM "CopyTrade" ct
    JOIN "DetectedTrade" dt ON ct."detectedTradeId" = dt.id
    WHERE ct.status = 'SETTLED'
      AND ct."isPaper" = false
      AND ct."failReason" LIKE '%price=1.0000%'
    LIMIT 5
  `;

  if (rows.length === 0) {
    console.log('No SETTLED winning positions found.');
    await prisma.$disconnect();
    return;
  }

  console.log(`Found ${rows.length} SETTLED winning conditionIds:`);
  for (const r of rows) {
    console.log(`  conditionId=${r.conditionId.slice(0, 20)}... outcome=${r.outcome} tokenId=${r.tokenId.slice(0, 20)}...`);
  }

  // Step 2: Build ClaimablePosition objects
  // We need outcomeIndex from the market's outcomes array.
  // Use the Market table which caches outcomePrices / outcomes.
  const claimable = [];
  for (const r of rows) {
    const market = await prisma.market.findFirst({
      where: { conditionId: r.conditionId },
      select: { outcomes: true },
    });

    if (!market?.outcomes) {
      console.log(`  SKIP ${r.conditionId.slice(0, 20)}: no market cache`);
      continue;
    }

    let outcomes: string[] = [];
    try { outcomes = JSON.parse(market.outcomes); } catch { continue; }

    const normalizedOutcome = r.outcome.trim().toLowerCase();
    const outcomeIndex = outcomes.findIndex(o => o.trim().toLowerCase() === normalizedOutcome);
    if (outcomeIndex < 0) {
      console.log(`  SKIP ${r.conditionId.slice(0, 20)}: outcome "${r.outcome}" not in [${outcomes.join(', ')}]`);
      continue;
    }

    // Compute real net shares so MIN_CLAIM_USD threshold works correctly
    const fills = await prisma.copyTrade.findMany({
      where: { tokenId: r.tokenId, followAllocationId: r.followAllocationId, isPaper: false, status: 'SETTLED' },
      select: { side: true, filledSize: true, requestedAmount: true, filledPrice: true },
    });
    let totalBuy = 0, totalSell = 0;
    for (const f of fills) {
      if (f.side === 'BUY') totalBuy += f.filledSize ?? (f.requestedAmount / (f.filledPrice ?? 1));
      else totalSell += f.filledSize ?? 0;
    }
    const netShares = Math.max(totalBuy - totalSell, 0);

    claimable.push({
      conditionId: r.conditionId,
      outcomeIndex,
      netShares,
      tokenId: r.tokenId,
      followAllocationId: r.followAllocationId,
    });
  }

  if (claimable.length === 0) {
    console.log('No claimable positions after market lookup.');
    await prisma.$disconnect();
    return;
  }

  console.log(`\nAttempting to claim ${claimable.length} position(s) on-chain...`);
  console.log('Watch for [position-claim] logs below:\n');

  // Step 3: Call redeemWinningPositions directly (reads AUTO_CLAIM_ENABLED from env)
  await redeemWinningPositions(claimable);

  console.log('\nDone. Check logs above for success/failure.');
  await prisma.$disconnect();
}

main().catch(console.error);
