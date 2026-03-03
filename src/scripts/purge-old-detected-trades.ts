import 'dotenv/config';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { logger } from '../lib/logger';

async function main() {
  const cutoff = new Date(Date.now() - config.DATA_RETENTION_DAYS * 86400 * 1000);
  logger.info(
    `Purging DetectedTrade older than ${cutoff.toISOString()} (${config.DATA_RETENTION_DAYS} days)`,
  );

  const result = await prisma.detectedTrade.deleteMany({
    where: {
      detectedAt: { lt: cutoff },
      copyTrade: { is: null }, // Skip rows referenced by a CopyTrade (FK-safe)
    },
  });

  logger.info(`Purged ${result.count} old DetectedTrade records`);
  await prisma.$disconnect();
}

main().catch((err) => {
  logger.error(`Purge failed: ${err.message}`);
  process.exit(1);
});
