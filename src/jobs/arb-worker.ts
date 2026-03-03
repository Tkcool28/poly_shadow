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

/**
 * One-time seed: populate ArbStrategyConfig from env vars if the table is empty.
 * This preserves backward compat for existing deployments.
 */
async function bootstrapStrategyConfigs(): Promise<void> {
  const existing = await prisma.arbStrategyConfig.count();
  if (existing > 0) return;

  const seeds = [
    {
      strategy: 'standard',
      enabled: true,
      positionSizeUsd: config.ARB_POSITION_SIZE_USD,
      maxEntryPrice: config.ARB_MAX_ENTRY_PRICE,
      initialCapitalUsd: config.ARB_STANDARD_INITIAL_CAPITAL_USD ?? config.ARB_INITIAL_CAPITAL_USD,
    },
    {
      strategy: 'contrarian',
      enabled: config.ARB_CONTRARIAN_ENABLED,
      positionSizeUsd: config.ARB_CONTRARIAN_POSITION_SIZE_USD,
      maxEntryPrice: config.ARB_CONTRARIAN_MAX_PRICE,
      initialCapitalUsd: config.ARB_CONTRARIAN_INITIAL_CAPITAL_USD,
    },
    {
      strategy: 'contrarian-every3',
      enabled: config.ARB_CONTRARIAN_EVERY3_ENABLED,
      positionSizeUsd: config.ARB_CONTRARIAN_POSITION_SIZE_USD,
      maxEntryPrice: config.ARB_CONTRARIAN_MAX_PRICE,
      initialCapitalUsd: config.ARB_CONTRARIAN_INITIAL_CAPITAL_USD,
      everyNth: 3,
    },
    {
      strategy: 'contrarian-antimart',
      enabled: config.ARB_CONTRARIAN_ANTIMART_ENABLED,
      positionSizeUsd: config.ARB_CONTRARIAN_POSITION_SIZE_USD,
      maxEntryPrice: config.ARB_CONTRARIAN_MAX_PRICE,
      initialCapitalUsd: config.ARB_CONTRARIAN_INITIAL_CAPITAL_USD,
      antiMartingale: true,
    },
    {
      strategy: 'contrarian-cooldown',
      enabled: config.ARB_CONTRARIAN_COOLDOWN_ENABLED,
      positionSizeUsd: config.ARB_CONTRARIAN_POSITION_SIZE_USD,
      maxEntryPrice: config.ARB_CONTRARIAN_MAX_PRICE,
      initialCapitalUsd: config.ARB_CONTRARIAN_INITIAL_CAPITAL_USD,
      cooldownLosses: 3,
      cooldownSkip: 2,
    },
  ];

  const { count } = await prisma.arbStrategyConfig.createMany({
    data: seeds,
    skipDuplicates: true,
  });
  if (count > 0) {
    log.info(`Bootstrapped ${count} strategy configs from env vars`);
  }
}

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

  // Bootstrap strategy configs from env vars on first run (backward compat)
  await bootstrapStrategyConfigs();

  // Load enabled strategies from DB
  const strategyConfigs = await prisma.arbStrategyConfig.findMany({
    where: { enabled: true },
  });

  if (strategyConfigs.length === 0) {
    log.info('No enabled strategies in ArbStrategyConfig, exiting');
    return;
  }

  // Parse global assets/durations (fallback for strategies with null overrides)
  const globalAssets = config.ARB_ASSETS.split(',').map((a) => a.trim().toLowerCase())
    .filter((a): a is SupportedAsset => (SUPPORTED_ASSETS as readonly string[]).includes(a));
  const globalDurations = config.ARB_MARKET_TYPES.split(',').map((t) => t.trim())
    .filter((t) => DURATION_CONFIGS[t]);

  // Resolve per-strategy markets
  const resolvedStrategies = strategyConfigs.map((sc) => {
    const assets = sc.assets
      ? sc.assets.split(',').map((a) => a.trim().toLowerCase())
          .filter((a): a is SupportedAsset => (SUPPORTED_ASSETS as readonly string[]).includes(a))
      : globalAssets;
    const durations = sc.durations
      ? sc.durations.split(',').map((t) => t.trim()).filter((t) => DURATION_CONFIGS[t])
      : globalDurations;
    return { ...sc, resolvedAssets: assets, resolvedDurations: durations };
  }).filter((sc) => {
    if (sc.resolvedAssets.length === 0 || sc.resolvedDurations.length === 0) {
      log.warn(`Strategy ${sc.strategy} has no valid markets, skipping`, {
        assets: sc.assets, durations: sc.durations,
      });
      return false;
    }
    return true;
  });

  if (resolvedStrategies.length === 0) {
    log.error('All strategies resolved to zero valid markets, exiting');
    return;
  }

  // Ensure ArbCapital record exists per strategy
  for (const sc of resolvedStrategies) {
    const capitalKey = { isPaper_strategy: { isPaper: config.ARB_IS_PAPER, strategy: sc.strategy } };
    const existingCapital = await prisma.arbCapital.findUnique({ where: capitalKey });
    if (!existingCapital) {
      await prisma.arbCapital.create({
        data: {
          initialCapital: sc.initialCapitalUsd,
          currentCapital: sc.initialCapitalUsd,
          deployedCapital: 0,
          isPaper: config.ARB_IS_PAPER,
          strategy: sc.strategy,
        },
      });
      log.info(`Created ArbCapital [${sc.strategy}]`, { initialCapital: sc.initialCapitalUsd, isPaper: config.ARB_IS_PAPER });
    } else {
      log.info(`ArbCapital [${sc.strategy}] loaded`, {
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

  // Collect union of all assets across strategies for price feeds
  const allAssets = new Set<SupportedAsset>();
  for (const sc of resolvedStrategies) {
    for (const a of sc.resolvedAssets) allAssets.add(a);
  }

  // Create one price feed per unique asset
  const feedMap = new Map<string, CryptoPriceFeed>();
  for (const asset of allAssets) {
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

  // Create engines per-strategy, per-market
  const engines: ArbEngine[] = [];
  for (const sc of resolvedStrategies) {
    for (const asset of sc.resolvedAssets) {
      const feed = feedMap.get(asset)!;
      for (const duration of sc.resolvedDurations) {
        const dc = DURATION_CONFIGS[duration];
        const mc = buildMarketConfig(asset, dc);
        log.info(`Starting engine: ${mc.type}-${sc.strategy}`, {
          duration: `${mc.candleDurationMs / 1000}s`,
          entryWindow: `${mc.entryStartMs / 1000}s-${mc.entryEndMs / 1000}s`,
          positionSize: `$${sc.positionSizeUsd}`,
          maxEntryPrice: sc.maxEntryPrice,
        });
        engines.push(new ArbEngine(mc, feed, config.ARB_IS_PAPER, sc.strategy, {
          positionSizeUsd: sc.positionSizeUsd,
          maxEntryPrice: sc.maxEntryPrice,
          everyNth: sc.everyNth ?? undefined,
          cooldownLosses: sc.cooldownLosses ?? undefined,
          cooldownSkip: sc.cooldownSkip ?? undefined,
          antiMartingale: sc.antiMartingale,
          minConfidence: sc.minConfidence ?? undefined,
        }));
      }
    }
  }

  log.info('Arb worker started', {
    mode: config.ARB_IS_PAPER ? 'PAPER' : 'LIVE',
    strategies: resolvedStrategies.map((sc) => {
      const count = sc.resolvedAssets.length * sc.resolvedDurations.length;
      return `${sc.strategy}(${sc.resolvedAssets.join(',')}×${sc.resolvedDurations.join(',')} $${sc.positionSizeUsd}@${sc.maxEntryPrice} ×${count})`;
    }).join(' | '),
    engines: engines.length,
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
