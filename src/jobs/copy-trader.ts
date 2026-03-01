import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initialize as initExecutor } from '../services/trade-executor';
import { processCopyTrade } from '../services/copy-trade-worker';

const JOB_NAME = 'copy-trader';
const log = createJobLogger(JOB_NAME);
const POLL_INTERVAL_MS = 2000; // 2s drain interval

async function main() {
  // Custom shutdown handler (no setupGracefulShutdown — we handle it here)
  let shuttingDown = false;
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  if (!config.COPY_TRADE_ENABLED) {
    log.info('Copy trading disabled (COPY_TRADE_ENABLED=false), exiting');
    return;
  }

  // Validate required credentials
  if (!config.PRIVATE_KEY || !config.CLOB_API_KEY || !config.CLOB_API_SECRET || !config.CLOB_API_PASSPHRASE || !config.FUNDER_ADDRESS) {
    log.error('Missing required credentials. Set PRIVATE_KEY, CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE, FUNDER_ADDRESS');
    process.exit(1);
  }

  // Initialize CLOB client
  try {
    await initExecutor();
    log.info('Copy-trader daemon started');
  } catch (err: any) {
    log.error(`Failed to initialize trade executor: ${err.message}`);
    process.exit(1);
  }

  // Main loop: drain DetectedTrade queue
  while (!shuttingDown && !isShuttingDown()) {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      // Fetch unprocessed detected trades (no linked CopyTrade, within last 5 min)
      const staleCutoff = new Date(Date.now() - 5 * 60 * 1000);
      const pending = await prisma.detectedTrade.findMany({
        where: {
          copyTrade: null,
          compositeScore: { gte: config.MIN_COMPOSITE_SCORE },
          detectedAt: { gte: staleCutoff },
        },
        orderBy: { detectedAt: 'asc' },
        take: 10,
      });

      for (const trade of pending) {
        if (shuttingDown || isShuttingDown()) break;
        try {
          await processCopyTrade(trade);
          processedCount++;
        } catch (err: any) {
          log.error(`Failed to process copy trade: ${err.message}`, {
            detectedTradeId: trade.id,
            stack: err.stack,
          });
        }
      }
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Copy-trader cycle failed: ${err.message}`, { stack: err.stack });
    }

    // Update system health (silent catch)
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

    if (!shuttingDown && !isShuttingDown()) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    }
  }
}

main();
