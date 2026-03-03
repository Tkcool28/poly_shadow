import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initialize as initSharedExecutor } from '../services/trade-executor';
import { initArbExecutor } from '../services/arb/arb-executor';
import { CryptoPriceFeed } from '../services/arb/crypto-price-feed';
import { ArbEngine } from '../services/arb/arb-engine';
import { sweepArbSettlements } from '../services/arb/arb-settlement';
import { DURATION_CONFIGS, SUPPORTED_ASSETS, buildMarketConfig } from '../services/arb/arb-types';
import { ArbCycleStatus } from '../../prisma/generated/prisma/client/enums';
import { getMarketBySlug } from '../api/gamma-api';
import type { SupportedAsset } from '../services/arb/arb-types';

const JOB_NAME = 'arb-worker';
const log = createJobLogger(JOB_NAME);
const TICK_INTERVAL_MS = 1000; // 1-second engine tick

// Module-level so cleanup handler can access them
const priceFeeds: CryptoPriceFeed[] = [];

async function main() {
  // Shutdown handler
  let shuttingDown = false;
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    for (const feed of priceFeeds) feed.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  if (!config.ARB_ENABLED) {
    log.info('Arb worker disabled (ARB_ENABLED=false), exiting');
    return;
  }

  // Initialize shared CLOB client if credentials are present (for shared-wallet mode)
  if (!config.ARB_IS_PAPER && !config.ARB_PRIVATE_KEY
      && config.PRIVATE_KEY && config.CLOB_API_KEY) {
    try {
      await initSharedExecutor();
    } catch (err: any) {
      log.error(`Shared CLOB executor init failed: ${err.message}`);
    }
  }

  // Initialize arb executor (own wallet, shared wallet, or paper)
  try {
    await initArbExecutor();
  } catch (err: any) {
    log.error(`Arb executor init failed: ${err.message}`);
    if (!config.ARB_IS_PAPER) {
      log.error('Cannot run live arb without a working executor, exiting');
      return;
    }
  }

  // Determine active strategies
  const strategies = ['standard', ...(config.ARB_CONTRARIAN_ENABLED ? ['contrarian'] : [])];

  // Ensure ArbCapital record exists per strategy
  for (const strategy of strategies) {
    const initialCapital = strategy === 'contrarian'
      ? config.ARB_CONTRARIAN_INITIAL_CAPITAL_USD
      : (config.ARB_STANDARD_INITIAL_CAPITAL_USD ?? config.ARB_INITIAL_CAPITAL_USD);

    const capitalKey = { isPaper_strategy: { isPaper: config.ARB_IS_PAPER, strategy } };
    const existingCapital = await prisma.arbCapital.findUnique({ where: capitalKey });
    if (!existingCapital) {
      await prisma.arbCapital.create({
        data: {
          initialCapital,
          currentCapital: initialCapital,
          deployedCapital: 0,
          isPaper: config.ARB_IS_PAPER,
          strategy,
        },
      });
      log.info(`Created ArbCapital [${strategy}]`, { initialCapital, isPaper: config.ARB_IS_PAPER });
    } else {
      log.info(`ArbCapital [${strategy}] loaded`, {
        currentCapital: existingCapital.currentCapital.toFixed(2),
        deployedCapital: existingCapital.deployedCapital.toFixed(2),
        totalPnl: existingCapital.totalPnl.toFixed(2),
        totalCycles: existingCapital.totalCycles,
        totalWins: existingCapital.totalWins,
      });
    }
  }

  // Recover orphaned ENTERED cycles from previous crash
  const orphanedCycles = await prisma.arbCycle.findMany({
    where: { status: ArbCycleStatus.ENTERED, isPaper: config.ARB_IS_PAPER },
  });

  if (orphanedCycles.length > 0) {
    log.warn(`Found ${orphanedCycles.length} orphaned ENTERED cycles from previous run`);
    for (const cycle of orphanedCycles) {
      try {
        const market = await getMarketBySlug(cycle.slug);
        if (market?.closed && market.outcomePrices) {
          // Market resolved while we were down — queue for background settlement sweep
          await prisma.arbCycle.update({
            where: { id: cycle.id },
            data: { settlementStartedAt: new Date() },
          });
          log.info(`Orphan ${cycle.slug}: market resolved, queued for settlement`);
        } else {
          // Market unresolved — fail and refund atomically
          await prisma.$transaction(async (tx) => {
            const capitalKey = { isPaper_strategy: { isPaper: cycle.isPaper, strategy: cycle.strategy } };
            const fresh = await tx.arbCapital.findUniqueOrThrow({
              where: capitalKey,
            });
            const refundAmount = cycle.entryAmountUsd ?? 0;
            await tx.arbCapital.update({
              where: capitalKey,
              data: {
                currentCapital: { increment: refundAmount },
                deployedCapital: { decrement: Math.min(refundAmount, fresh.deployedCapital) },
              },
            });
            await tx.arbCycle.update({
              where: { id: cycle.id },
              data: {
                status: ArbCycleStatus.FAILED,
                failReason: 'orphan recovery: market unresolved at restart',
              },
            });
          });
          log.warn(`Orphan ${cycle.slug}: failed & refunded $${(cycle.entryAmountUsd ?? 0).toFixed(2)}`);
        }
      } catch (err: any) {
        log.error(`Orphan recovery failed for ${cycle.slug}: ${err.message}`);
        // Leave in ENTERED — background sweep will pick it up
      }
    }
  }

  // Parse assets and durations
  const assets = config.ARB_ASSETS.split(',').map((a) => a.trim().toLowerCase())
    .filter((a): a is SupportedAsset => (SUPPORTED_ASSETS as readonly string[]).includes(a));
  const durations = config.ARB_MARKET_TYPES.split(',').map((t) => t.trim())
    .filter((t) => DURATION_CONFIGS[t]);

  if (assets.length === 0) {
    log.error(`No valid assets in ARB_ASSETS="${config.ARB_ASSETS}". Valid: ${SUPPORTED_ASSETS.join(', ')}`);
    return;
  }
  if (durations.length === 0) {
    log.error(`No valid durations in ARB_MARKET_TYPES="${config.ARB_MARKET_TYPES}". Valid: ${Object.keys(DURATION_CONFIGS).join(', ')}`);
    return;
  }

  // Create one price feed per unique asset
  const feedMap = new Map<string, CryptoPriceFeed>();
  for (const asset of assets) {
    const feed = new CryptoPriceFeed(asset, config.ARB_SNAP_BUFFER_SIZE);
    feed.connect();
    feedMap.set(asset, feed);
    priceFeeds.push(feed);
  }

  // Wait for initial prices (max 15s)
  const priceWaitStart = Date.now();
  while (Date.now() - priceWaitStart < 15_000) {
    const allReady = [...feedMap.values()].every((f) => f.lastPrice > 0);
    if (allReady) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  for (const [asset, feed] of feedMap) {
    if (feed.lastPrice > 0) {
      log.info(`${asset.toUpperCase()} price feed ready: $${feed.lastPrice.toFixed(2)}`);
    } else {
      log.warn(`${asset.toUpperCase()} price feed not yet available, engines will skip until price arrives`);
    }
  }

  // Create one engine per (asset, duration, strategy) combination
  const engines: ArbEngine[] = [];
  for (const asset of assets) {
    const feed = feedMap.get(asset)!;
    for (const duration of durations) {
      const dc = DURATION_CONFIGS[duration];
      const mc = buildMarketConfig(asset, dc);
      for (const strategy of strategies) {
        log.info(`Starting engine: ${mc.type}-${strategy}`, {
          duration: `${mc.candleDurationMs / 1000}s`,
          entryWindow: `${mc.entryStartMs / 1000}s-${mc.entryEndMs / 1000}s`,
          strategy,
        });
        engines.push(new ArbEngine(mc, feed, config.ARB_IS_PAPER, strategy));
      }
    }
  }

  log.info(`Arb worker started`, {
    mode: config.ARB_IS_PAPER ? 'PAPER' : 'LIVE',
    assets: assets.join(','),
    durations: durations.join(','),
    strategies: strategies.join(','),
    engines: engines.length,
    positionSize: `$${config.ARB_POSITION_SIZE_USD}`,
    maxEntryPrice: config.ARB_MAX_ENTRY_PRICE,
  });

  // Main loop: tick all engines every second
  let lastSettlementSweep = 0;
  while (!shuttingDown && !isShuttingDown()) {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      for (const engine of engines) {
        if (shuttingDown || isShuttingDown()) break;
        await engine.runCycle();
        processedCount++;
      }
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Arb cycle failed: ${err.message}`, { stack: err.stack });
    }

    // Non-blocking settlement sweep (periodic)
    if (Date.now() - lastSettlementSweep >= config.ARB_SETTLEMENT_SWEEP_INTERVAL_MS) {
      try {
        await sweepArbSettlements();
        lastSettlementSweep = Date.now();
      } catch (err: any) {
        log.warn(`Arb settlement sweep failed: ${err.message}`);
      }
    }

    // Update system health
    const duration = Date.now() - start;
    await updateHealth(duration, result, processedCount, errorMessage);

    // Sleep remainder of tick interval
    const elapsed = Date.now() - start;
    if (!shuttingDown && !isShuttingDown() && elapsed < TICK_INTERVAL_MS) {
      await new Promise((r) => setTimeout(r, TICK_INTERVAL_MS - elapsed));
    }
  }
}

async function updateHealth(
  duration: number,
  result: string,
  processedCount: number,
  errorMessage?: string,
) {
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
}

main();
