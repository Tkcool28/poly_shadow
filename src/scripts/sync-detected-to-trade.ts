import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const BATCH_SIZE = 500;

async function main() {
  const total = await prisma.detectedTrade.count();
  logger.info(`Syncing ${total} DetectedTrade records to Trade table`);

  let offset = 0;
  let synced = 0;
  let skipped = 0;

  while (offset < total) {
    const batch = await prisma.detectedTrade.findMany({
      orderBy: { detectedAt: 'asc' },
      skip: offset,
      take: BATCH_SIZE,
    });
    if (batch.length === 0) break;

    for (const dt of batch) {
      try {
        await prisma.trade.upsert({
          where: {
            transactionHash_proxyWallet_asset_side_size_price: {
              transactionHash: dt.transactionHash,
              proxyWallet: dt.proxyWallet,
              asset: dt.asset,
              side: dt.side,
              size: dt.size,
              price: dt.price,
            },
          },
          create: {
            proxyWallet: dt.proxyWallet,
            side: dt.side,
            asset: dt.asset,
            conditionId: dt.conditionId,
            size: dt.size,
            price: dt.price,
            outcome: dt.outcome,
            outcomeIndex: null,
            timestamp: dt.timestamp,
            transactionHash: dt.transactionHash,
            title: dt.title ?? null,
            eventSlug: dt.eventSlug ?? null,
            usdValue: dt.size * dt.price,
          },
          update: {},
        });
        synced++;
      } catch (err: any) {
        if (err.code === 'P2002') {
          skipped++;
          continue;
        }
        logger.warn(`Failed to sync DetectedTrade ${dt.id}: ${err.message}`);
        skipped++;
      }
    }

    offset += batch.length;
    if (offset % 1000 < BATCH_SIZE) {
      logger.info(`Progress: ${offset}/${total} processed (${synced} synced, ${skipped} skipped)`);
    }
  }

  logger.info(`Migration complete: ${synced} synced, ${skipped} skipped`);
  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error(`Migration failed: ${err.message}`);
  process.exit(1);
});
