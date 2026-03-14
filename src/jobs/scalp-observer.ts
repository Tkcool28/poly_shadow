import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initScalpExecutor } from '../services/scalp/scalp-executor';
import {
  discoverMarkets,
  loadMarketsIntoCache,
  getAllEsportsTokenIds,
  getCacheSize,
} from '../services/scalp/scalp-market-discovery';
import { ScalpFlowTracker } from '../services/scalp/scalp-flow-tracker';
import { ScalpSignalLogger } from '../services/scalp/scalp-signal-logger';

const JOB_NAME = 'scalp-observer';
const log = createJobLogger(JOB_NAME);
const TICK_INTERVAL_MS = 5000;

let flowTracker: ScalpFlowTracker | null = null;
let signalLogger: ScalpSignalLogger | null = null;

async function main() {
  let shuttingDown = false;

  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    if (flowTracker) try { flowTracker.stop(); } catch {}
    if (signalLogger) try { signalLogger.clearPendingTimers(); } catch {}
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  // Observer always runs regardless of SCALP_ENABLED since it's data-collection only.
  // Init read-only CLOB client for orderbook reads.
  try {
    await initScalpExecutor();
  } catch (err: any) {
    log.error(`Executor init failed: ${err.message}`);
  }

  // Discover esports markets
  try {
    await discoverMarkets();
  } catch (err: any) {
    log.error(`Market discovery failed: ${err.message}`);
    await loadMarketsIntoCache();
  }

  const tokenIds = getAllEsportsTokenIds();
  log.info('Observer starting', { markets: getCacheSize(), tokens: tokenIds.size });

  if (tokenIds.size === 0) {
    log.warn('No esports tokens found, will retry on periodic discovery');
  }

  // Create flow tracker + signal logger
  flowTracker = new ScalpFlowTracker();
  flowTracker.updateTokens(tokenIds);

  signalLogger = new ScalpSignalLogger();

  // Wire signal events to logger
  flowTracker.on('signal', (signal) => {
    signalLogger!.logSignal(signal).catch((err: any) =>
      log.error('Signal logging failed', { error: err.message }),
    );
  });

  flowTracker.start();
  log.info('Observer running — collecting trades + signals');

  // Main loop
  let lastDiscovery = Date.now();
  const DISCOVERY_INTERVAL = config.SCALP_MARKET_DISCOVERY_INTERVAL_MS;

  while (!shuttingDown && !isShuttingDown()) {
    const tickStart = Date.now();

    try {
      // Periodic market discovery refresh
      if (Date.now() - lastDiscovery >= DISCOVERY_INTERVAL) {
        try {
          await discoverMarkets();
          const freshTokens = getAllEsportsTokenIds();
          flowTracker.updateTokens(freshTokens);
          lastDiscovery = Date.now();
        } catch (err: any) {
          log.warn(`Periodic discovery failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      log.error(`Observer tick failed: ${err.message}`);
    }

    // Update health
    try {
      await prisma.systemHealth.upsert({
        where: { jobName: JOB_NAME },
        create: {
          jobName: JOB_NAME,
          lastRunAt: new Date(),
          lastRunDuration: Date.now() - tickStart,
          lastRunResult: 'success',
          processedCount: 0,
        },
        update: {
          lastRunAt: new Date(),
          lastRunDuration: Date.now() - tickStart,
          lastRunResult: 'success',
        },
      });
    } catch {}

    // Sleep remainder of tick interval
    const elapsed = Date.now() - tickStart;
    if (!shuttingDown && elapsed < TICK_INTERVAL_MS) {
      await new Promise(r => setTimeout(r, TICK_INTERVAL_MS - elapsed));
    }
  }
}

main();
