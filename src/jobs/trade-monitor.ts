import 'dotenv/config';
import { setupGracefulShutdown, isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { detectNewTrades } from '../services/trade-detector';

const JOB_NAME = 'trade-monitor';
const log = createJobLogger(JOB_NAME);

async function runCycle(): Promise<number> {
  return await detectNewTrades();
}

async function main() {
  setupGracefulShutdown(JOB_NAME);

  log.info('Trade monitor daemon started', {
    pollInterval: config.TRADE_MONITOR_INTERVAL_MS,
  });

  while (!isShuttingDown()) {
    const start = Date.now();
    let detectedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      detectedCount = await runCycle();
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Monitor cycle failed: ${err.message}`, { stack: err.stack });
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
          processedCount: detectedCount,
          errorMessage: errorMessage ?? null,
        },
        update: {
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount: detectedCount,
          errorMessage: errorMessage ?? null,
        },
      });
    } catch {}

    if (detectedCount > 0) {
      log.info(`Cycle complete: detected ${detectedCount} new trades`, { durationMs: duration });
    } else {
      log.debug(`Cycle complete: no new trades`, { durationMs: duration });
    }

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, config.TRADE_MONITOR_INTERVAL_MS));
    }
  }
}

main();
