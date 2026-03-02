import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initialize as initSharedExecutor } from '../services/trade-executor';
import { initArbExecutor } from '../services/arb/arb-executor';
import { CryptoPriceFeed } from '../services/arb/crypto-price-feed';
import { ArbEngine } from '../services/arb/arb-engine';
import { DURATION_CONFIGS, SUPPORTED_ASSETS, buildMarketConfig } from '../services/arb/arb-types';
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

  // Ensure ArbCapital record exists
  const existingCapital = await prisma.arbCapital.findUnique({
    where: { isPaper: config.ARB_IS_PAPER },
  });
  if (!existingCapital) {
    await prisma.arbCapital.create({
      data: {
        initialCapital: config.ARB_INITIAL_CAPITAL_USD,
        currentCapital: config.ARB_INITIAL_CAPITAL_USD,
        deployedCapital: 0,
        isPaper: config.ARB_IS_PAPER,
      },
    });
    log.info('Created ArbCapital record', {
      initialCapital: config.ARB_INITIAL_CAPITAL_USD,
      isPaper: config.ARB_IS_PAPER,
    });
  } else {
    log.info('ArbCapital loaded', {
      currentCapital: existingCapital.currentCapital.toFixed(2),
      deployedCapital: existingCapital.deployedCapital.toFixed(2),
      totalPnl: existingCapital.totalPnl.toFixed(2),
      totalCycles: existingCapital.totalCycles,
      totalWins: existingCapital.totalWins,
    });
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
    const feed = new CryptoPriceFeed(asset);
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

  // Create one engine per (asset, duration) combination
  const engines: ArbEngine[] = [];
  for (const asset of assets) {
    const feed = feedMap.get(asset)!;
    for (const duration of durations) {
      const dc = DURATION_CONFIGS[duration];
      const mc = buildMarketConfig(asset, dc);
      log.info(`Starting engine: ${mc.type}`, {
        duration: `${mc.candleDurationMs / 1000}s`,
        entryWindow: `${mc.entryStartMs / 1000}s-${mc.entryEndMs / 1000}s`,
      });
      engines.push(new ArbEngine(mc, feed, config.ARB_IS_PAPER));
    }
  }

  log.info(`Arb worker started`, {
    mode: config.ARB_IS_PAPER ? 'PAPER' : 'LIVE',
    assets: assets.join(','),
    durations: durations.join(','),
    engines: engines.length,
    positionSize: `$${config.ARB_POSITION_SIZE_USD}`,
    maxEntryPrice: config.ARB_MAX_ENTRY_PRICE,
  });

  // Main loop: tick all engines every second
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
