import 'dotenv/config';
import { setupGracefulShutdown, isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { claimTradersForBackfill, backfillTrader } from '../services/history-backfill';
import { config } from '../config/env';

const JOB_NAME = 'history-backfiller';
const log = createJobLogger(JOB_NAME);
const BATCH_SIZE = 10;
const TRADER_CONCURRENCY = 3;

async function runCycle(): Promise<number> {
  const wallets = await claimTradersForBackfill(BATCH_SIZE);

  if (wallets.length === 0) {
    log.debug('No traders pending backfill');
    return 0;
  }

  log.info(`Processing ${wallets.length} traders (concurrency: ${TRADER_CONCURRENCY})`);

  // Process traders with bounded concurrency
  let failed = 0;
  for (let i = 0; i < wallets.length; i += TRADER_CONCURRENCY) {
    if (isShuttingDown()) break;
    const chunk = wallets.slice(i, i + TRADER_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((wallet) => backfillTrader(wallet))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        log.error(`Trader backfill unexpected failure: ${r.reason?.message}`);
      }
    }
  }

  if (failed > 0) {
    log.warn(`${failed}/${wallets.length} traders failed in this cycle`);
  }

  return wallets.length;
}

async function main() {
  setupGracefulShutdown(JOB_NAME);

  log.info('Backfiller daemon started', {
    pollInterval: config.BACKFILL_POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    concurrency: TRADER_CONCURRENCY,
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
      if (processedCount > 0) {
        // More work likely available, short delay then continue
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        // No work found, use full poll interval
        await new Promise((resolve) => setTimeout(resolve, config.BACKFILL_POLL_INTERVAL_MS));
      }
    }
  }
}

main();
