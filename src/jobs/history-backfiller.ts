import 'dotenv/config';
import { setupGracefulShutdown, isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { claimTradersForBackfill, backfillTrader } from '../services/history-backfill';
import { config } from '../config/env';

const JOB_NAME = 'history-backfiller';
const log = createJobLogger(JOB_NAME);
const BATCH_SIZE = 5;

async function runCycle(): Promise<number> {
  const wallets = await claimTradersForBackfill(BATCH_SIZE);

  if (wallets.length === 0) {
    log.debug('No traders pending backfill');
    return 0;
  }

  log.info(`Processing ${wallets.length} traders`);

  for (const wallet of wallets) {
    if (isShuttingDown()) break;
    await backfillTrader(wallet);
  }

  return wallets.length;
}

async function main() {
  setupGracefulShutdown(JOB_NAME);

  log.info('Backfiller daemon started', {
    pollInterval: config.BACKFILL_POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
  });

  while (!isShuttingDown()) {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      processedCount = await runCycle();
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Backfill cycle failed: ${err.message}`, { stack: err.stack });
    }

    // Update system health
    const duration = Date.now() - start;
    try {
      await prisma.systemHealth.upsert({
        where: { jobName: JOB_NAME },
        create: {
          jobName: JOB_NAME,
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount,
          errorMessage: errorMessage ?? null,
        },
        update: {
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount,
          errorMessage: errorMessage ?? null,
        },
      });
    } catch {}

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, config.BACKFILL_POLL_INTERVAL_MS));
    }
  }
}

main();
