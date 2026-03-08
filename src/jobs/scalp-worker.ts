import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initScalpExecutor } from '../services/scalp/scalp-executor';
import { discoverMarkets, loadMarketsIntoCache, getAllEsportsTokenIds, getCacheSize } from '../services/scalp/scalp-market-discovery';
import { ScalpBotDetector } from '../services/scalp/scalp-bot-detector';
import { ScalpEngine, cleanupProcessingLocks } from '../services/scalp/scalp-engine';
import { sweepScalpSettlements } from '../services/scalp/scalp-settlement';
import { CS2Feed } from '../services/scalp/feeds/cs2-feed';
import { Dota2Feed } from '../services/scalp/feeds/dota2-feed';
import { ScalpCycleStatus } from '../../prisma/generated/prisma/client/enums';
import type { GameFeed } from '../services/scalp/scalp-types';

const JOB_NAME = 'scalp-worker';
const log = createJobLogger(JOB_NAME);

const EXIT_TICK_INTERVAL_MS = config.SCALP_ORDER_POLL_INTERVAL_MS; // 5s
const LOCK_CLEANUP_INTERVAL_MS = 30_000; // 30s

// Module-level for cleanup handler
const feeds: GameFeed[] = [];
let botDetector: ScalpBotDetector | null = null;

/**
 * Bootstrap ScalpCapital record if it doesn't exist.
 */
async function bootstrapCapital(): Promise<void> {
  const existing = await prisma.scalpCapital.findFirst({
    where: { isPaper: config.SCALP_IS_PAPER },
  });

  if (!existing) {
    await prisma.scalpCapital.create({
      data: {
        initialCapital: config.SCALP_INITIAL_CAPITAL_USD,
        currentCapital: config.SCALP_INITIAL_CAPITAL_USD,
        deployedCapital: 0,
        isPaper: config.SCALP_IS_PAPER,
      },
    });
    log.info('Created ScalpCapital', {
      initialCapital: config.SCALP_INITIAL_CAPITAL_USD,
      isPaper: config.SCALP_IS_PAPER,
    });
  } else {
    log.info('ScalpCapital loaded', {
      currentCapital: existing.currentCapital.toFixed(2),
      deployedCapital: existing.deployedCapital.toFixed(2),
      totalPnl: existing.totalPnl.toFixed(2),
      totalCycles: existing.totalCycles,
      totalWins: existing.totalWins,
    });
  }
}

/**
 * Recover orphaned ENTERED cycles from a previous crash.
 * - Timed out → fail and refund
 * - Still within timeout → re-add to exit manager for active convergence/stop-loss monitoring
 */
async function recoverOrphans(engine: ScalpEngine): Promise<void> {
  const orphans = await prisma.scalpCycle.findMany({
    where: { status: ScalpCycleStatus.ENTERED, isPaper: config.SCALP_IS_PAPER },
  });

  if (orphans.length === 0) return;

  log.warn(`Found ${orphans.length} orphaned ENTERED cycles from previous run`);

  for (const cycle of orphans) {
    try {
      // Check settlement timeout
      if (cycle.enteredAt && Date.now() - cycle.enteredAt.getTime() > config.SCALP_SETTLEMENT_TIMEOUT_MS) {
        await prisma.$transaction(async (tx) => {
          const fresh = await tx.scalpCycle.findUnique({ where: { id: cycle.id } });
          if (!fresh || fresh.status !== ScalpCycleStatus.ENTERED) return;

          await tx.scalpCycle.update({
            where: { id: cycle.id },
            data: { status: ScalpCycleStatus.FAILED, failReason: 'orphan: settlement timeout at restart' },
          });
          const refund = cycle.entryAmountUsd ?? 0;
          await tx.scalpCapital.updateMany({
            where: { isPaper: config.SCALP_IS_PAPER },
            data: {
              currentCapital: { increment: refund },
              deployedCapital: { decrement: refund },
            },
          });
        });
        log.warn(`Orphan ${cycle.slug}: timed out, refunded $${(cycle.entryAmountUsd ?? 0).toFixed(2)}`);
      } else if (cycle.tokenId && cycle.entryPrice && cycle.entryShares) {
        // Re-add to exit manager for active convergence sell + stop-loss monitoring
        engine.exitManager.addPosition(
          cycle.id,
          cycle.tokenId,
          cycle.entryPrice,
          cycle.entryShares,
          Math.max(cycle.estimatedEdge ?? 0, config.SCALP_MIN_EDGE_CENTS),
          cycle.entryAmountUsd ?? 0,
        );
        log.info(`Orphan ${cycle.slug}: re-added to exit manager`, { cycleId: cycle.id.slice(0, 12) });
      } else {
        // Missing entry data — leave for settlement sweep
        log.info(`Orphan ${cycle.slug}: incomplete entry data, will be handled by settlement`);
      }
    } catch (err: any) {
      log.error(`Orphan recovery failed for ${cycle.slug}: ${err.message}`);
    }
  }
}

async function main() {
  // Shutdown handler
  let shuttingDown = false;
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);

    // Stop bot detector
    if (botDetector) {
      try { botDetector.stop(); } catch {}
    }

    // Stop game feeds
    for (const feed of feeds) {
      try { feed.stop(); } catch {}
    }

    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  if (!config.SCALP_ENABLED) {
    log.info('Scalp worker disabled (SCALP_ENABLED=false), exiting');
    return;
  }

  // Initialize executor (paper: readOnlyClient only, live: full CLOB)
  try {
    await initScalpExecutor();
  } catch (err: any) {
    log.error(`Scalp executor init failed: ${err.message}`);
    if (!config.SCALP_IS_PAPER) {
      log.error('Cannot run live scalp without working executor, exiting');
      return;
    }
  }

  // Bootstrap capital
  await bootstrapCapital();

  // Discover markets (full pagination on startup)
  try {
    await discoverMarkets();
  } catch (err: any) {
    log.error(`Initial market discovery failed: ${err.message}`);
    // Try loading from DB cache instead
    await loadMarketsIntoCache();
  }

  if (getCacheSize() === 0) {
    log.warn('No esports markets found, will retry on periodic discovery');
  }

  // Create engine
  const engine = new ScalpEngine();

  // Recover orphaned ENTERED cycles → re-add to exit manager for active monitoring
  await recoverOrphans(engine);

  // Start bot detector
  botDetector = new ScalpBotDetector();
  botDetector.updateTokens(getAllEsportsTokenIds());
  botDetector.on('botSignal', (signal) => {
    engine.onBotSignal(signal).catch((err: any) =>
      log.error('Bot signal handler error', { error: err.message }),
    );
  });
  botDetector.start();

  // Start game feeds
  const cs2Feed = new CS2Feed();
  const dota2Feed = new Dota2Feed();

  const gameEventHandler = (event: any) => {
    engine.onGameEvent(event).catch((err: any) =>
      log.error('Game event handler error', { error: err.message }),
    );
  };

  cs2Feed.onEvent(gameEventHandler);
  dota2Feed.onEvent(gameEventHandler);

  feeds.push(cs2Feed, dota2Feed);

  await cs2Feed.start();
  await dota2Feed.start();

  log.info('Scalp worker started', {
    mode: config.SCALP_IS_PAPER ? 'PAPER' : 'LIVE',
    positionSize: `$${config.SCALP_POSITION_SIZE_USD}`,
    minEdge: `${config.SCALP_MIN_EDGE_CENTS}¢`,
    stopLoss: `${config.SCALP_STOP_LOSS_CENTS}¢`,
    maxDailyLoss: `$${config.SCALP_MAX_DAILY_LOSS_USD}`,
    marketsInCache: getCacheSize(),
    tokenIds: getAllEsportsTokenIds().size,
    botDetector: botDetector.isHealthy() ? 'connected' : 'connecting',
    cs2: cs2Feed.isHealthy() ? 'ready' : 'disabled',
    dota2: dota2Feed.isHealthy() ? 'ready' : 'disabled',
  });

  // Main loop: exit manager tick + settlement sweep + periodic discovery
  let lastSettlementSweep = 0;
  let lastDiscovery = Date.now(); // just ran on startup
  let lastLockCleanup = 0;

  while (!shuttingDown && !isShuttingDown()) {
    const tickStart = Date.now();
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      // Exit manager tick: check convergence sell + stop-loss on active positions
      await engine.exitManager.tick();

      // Periodic settlement sweep
      if (Date.now() - lastSettlementSweep >= config.SCALP_SETTLEMENT_SWEEP_INTERVAL_MS) {
        await sweepScalpSettlements();
        lastSettlementSweep = Date.now();
      }

      // Periodic market discovery refresh
      if (Date.now() - lastDiscovery >= config.SCALP_MARKET_DISCOVERY_INTERVAL_MS) {
        try {
          await discoverMarkets();
          // Update bot detector with fresh token set
          if (botDetector) {
            botDetector.updateTokens(getAllEsportsTokenIds());
          }
          lastDiscovery = Date.now();
        } catch (err: any) {
          log.warn(`Periodic market discovery failed: ${err.message}`);
        }
      }

      // Periodic lock cleanup
      if (Date.now() - lastLockCleanup >= LOCK_CLEANUP_INTERVAL_MS) {
        cleanupProcessingLocks();
        lastLockCleanup = Date.now();
      }
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Scalp tick failed: ${err.message}`, { stack: err.stack });
    }

    // Update system health
    const duration = Date.now() - tickStart;
    await updateHealth(duration, result, engine.exitManager.getActiveCount(), errorMessage);

    // Sleep remainder of tick interval
    const elapsed = Date.now() - tickStart;
    if (!shuttingDown && !isShuttingDown() && elapsed < EXIT_TICK_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, EXIT_TICK_INTERVAL_MS - elapsed));
    }
  }
}

async function updateHealth(
  duration: number,
  result: string,
  activePositions: number,
  errorMessage?: string,
): Promise<void> {
  try {
    await prisma.systemHealth.upsert({
      where: { jobName: JOB_NAME },
      create: {
        jobName: JOB_NAME,
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: result,
        processedCount: activePositions,
        errorMessage: errorMessage ?? null,
      },
      update: {
        lastRunAt: new Date(),
        lastRunDuration: duration,
        lastRunResult: result,
        processedCount: activePositions,
        errorMessage: errorMessage ?? null,
      },
    });
  } catch {}
}

main();
