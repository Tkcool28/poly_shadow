import 'dotenv/config';
import { setupGracefulShutdown, setupJobTimeout } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { discoverFromLeaderboard } from '../services/trader-discovery';
import { JOB_MAX_RUNTIME_MS } from '../config/constants';

const JOB_NAME = 'leaderboard-scanner';
const log = createJobLogger(JOB_NAME);

async function main() {
  setupGracefulShutdown(JOB_NAME);
  setupJobTimeout(JOB_NAME, JOB_MAX_RUNTIME_MS);

  const start = Date.now();
  log.info('Starting leaderboard scan');

  let result = 'success';
  let processedCount = 0;
  let errorMessage: string | undefined;

  try {
    const { newTraders, updatedTraders, screenedOut, passedScreen } =
      await discoverFromLeaderboard();
    processedCount = newTraders + updatedTraders;
    log.info('Scan complete', {
      newTraders,
      updatedTraders,
      screenedOut,
      passedScreen,
    });
  } catch (err: any) {
    result = 'error';
    errorMessage = err.message?.slice(0, 500);
    log.error(`Scan failed: ${err.message}`, { stack: err.stack });
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
  } catch (err: any) {
    log.error(`Failed to update system health: ${err.message}`);
  }

  await prisma.$disconnect();
  process.exit(result === 'error' ? 1 : 0);
}

main();
