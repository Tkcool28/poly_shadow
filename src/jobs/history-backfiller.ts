import 'dotenv/config';
import { setupGracefulShutdown, isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { claimTradersForBackfill, backfillTrader } from '../services/history-backfill';
import { config } from '../config/env';

const JOB_NAME = 'history-backfiller';
const log = createJobLogger(JOB_NAME);
const BATCH_SIZE = 10;
const TRADER_CONCURRENCY = 1; // Reduced from 3: concurrent large traders (3000+ trades) cause OOM at 1.5GB limit

async function runCycle(): Promise<{ total: number; refreshCount: number }> {
  const claimed = await claimTradersForBackfill(
    BATCH_SIZE,
    config.BACKFILL_REFRESH_BATCH_SIZE,
  );

  if (claimed.length === 0) {
    log.debug('No traders pending backfill or refresh');
    return { total: 0, refreshCount: 0 };
  }

  const refreshCount = claimed.filter(c => c.isRefresh).length;
  const newCount = claimed.length - refreshCount;
  log.info(`Processing ${claimed.length} traders (${newCount} new, ${refreshCount} refresh, concurrency: ${TRADER_CONCURRENCY})`);

  // Process traders with bounded concurrency
  let failed = 0;
  for (let i = 0; i < claimed.length; i += TRADER_CONCURRENCY) {
    if (isShuttingDown()) break;
    const chunk = claimed.slice(i, i + TRADER_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((c) => backfillTrader(c.proxyWallet, { isRefresh: c.isRefresh }))
    );
    for (const r of results) {
      if (r.status === 'rejected') {
        failed++;
        log.error(`Trader backfill unexpected failure: ${r.reason?.message}`);
      }
    }
  }

  if (failed > 0) {
    log.warn(`${failed}/${claimed.length} traders failed in this cycle`);
  }

  return { total: claimed.length, refreshCount };
}

async function main() {
  setupGracefulShutdown(JOB_NAME);

  log.info('Backfiller daemon started', {
    pollInterval: config.BACKFILL_POLL_INTERVAL_MS,
    batchSize: BATCH_SIZE,
    concurrency: TRADER_CONCURRENCY,
    refreshAfterMs: config.BACKFILL_REFRESH_AFTER_MS,
    refreshBatchSize: config.BACKFILL_REFRESH_BATCH_SIZE,
  });

  while (!isShuttingDown()) {
    const start = Date.now();
    let processedCount = { total: 0, refreshCount: 0 };
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
          processedCount: processedCount.total,
          errorMessage: errorMessage ?? null,
        },
        update: {
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount: processedCount.total,
          errorMessage: errorMessage ?? null,
        },
      });
    } catch {}

    if (!isShuttingDown()) {
      if (processedCount.total > 0 && processedCount.total > processedCount.refreshCount) {
        // New backfills processed — more likely available, short delay
        await new Promise((resolve) => setTimeout(resolve, 2000));
      } else {
        // Refresh-only or no work — use full poll interval to avoid API churn
        await new Promise((resolve) => setTimeout(resolve, config.BACKFILL_POLL_INTERVAL_MS));
      }
    }
  }
}

main();
