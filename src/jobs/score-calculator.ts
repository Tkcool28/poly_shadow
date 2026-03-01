import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { setupGracefulShutdown, setupJobTimeout } from '../lib/shutdown';
import { JOB_MAX_RUNTIME_MS } from '../config/constants';
import { calculateAllScores } from '../services/scoring';

const JOB_NAME = 'score-calculator';
const log = createJobLogger(JOB_NAME);

async function main() {
  setupGracefulShutdown(JOB_NAME);
  setupJobTimeout(JOB_NAME, JOB_MAX_RUNTIME_MS);

  log.info('Score calculator started');
  const startTime = Date.now();

  try {
    const scoredCount = await calculateAllScores();
    const duration = Date.now() - startTime;

    await prisma.systemHealth.upsert({
      where: { jobName: JOB_NAME },
      create: {
        jobName: JOB_NAME,
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: 'success',
        processedCount: scoredCount,
      },
      update: {
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: 'success',
        processedCount: scoredCount,
        errorMessage: null,
      },
    });

    log.info(`Score calculator completed`, { scoredCount, durationMs: duration });
  } catch (err: any) {
    const duration = Date.now() - startTime;
    log.error(`Score calculator failed: ${err.message}`, { error: err.stack });

    await prisma.systemHealth.upsert({
      where: { jobName: JOB_NAME },
      create: {
        jobName: JOB_NAME,
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: 'error',
        processedCount: 0,
        errorMessage: err.message,
      },
      update: {
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: 'error',
        errorMessage: err.message,
      },
    });
  } finally {
    await prisma.$disconnect();
    process.exit(0);
  }
}

main();
