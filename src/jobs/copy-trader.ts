import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initialize as initExecutor, isLiveReady } from '../services/trade-executor';
import { processCopyTrade } from '../services/copy-trade-worker';
import { startPortfolioRefresh, stopPortfolioRefresh } from '../services/portfolio-cache';
import { rehydratePool, sweepPool } from '../services/order-pool';
import { sweepPositionSettlements } from '../services/position-settlement';

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
    stopPortfolioRefresh();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  if (!config.COPY_TRADE_ENABLED) {
    log.info('Copy trading disabled (COPY_TRADE_ENABLED=false), exiting');
    return;
  }

  // Initialize CLOB client (only needed for live allocations)
  if (config.PRIVATE_KEY && config.CLOB_API_KEY && config.CLOB_API_SECRET
      && config.CLOB_API_PASSPHRASE && config.FUNDER_ADDRESS) {
    try {
      await initExecutor();
      log.info('Copy-trader daemon started (live + paper trading available)');
    } catch (err: any) {
      log.error(`CLOB executor init failed — LIVE TRADING UNAVAILABLE: ${err.message}`);
    }
  } else {
    log.info('No CLOB credentials configured — only paper trading available');
  }

  // Check for live allocations without CLOB executor
  const liveAllocations = await prisma.followAllocation.findMany({
    where: { isActive: true, isPaper: false },
  });
  if (liveAllocations.length > 0) {
    const dbTotal = liveAllocations.reduce((s, a) => s + a.currentCapital, 0);
    if (!isLiveReady()) {
      log.error(`${liveAllocations.length} LIVE allocations exist but CLOB executor unavailable — live trades will NOT execute`, {
        dbCurrentCapital: dbTotal.toFixed(2),
      });
    } else {
      log.info('Live capital check', {
        dbCurrentCapital: dbTotal.toFixed(2),
        allocations: liveAllocations.length,
      });
    }
  }

  // Start portfolio value cache
  try {
    await startPortfolioRefresh();
  } catch (err: any) {
    log.warn(`Portfolio cache initial refresh failed: ${err.message}`);
  }

  // Rehydrate order pool from DB (recovers POOLED records across restarts)
  try {
    await rehydratePool();
  } catch (err: any) {
    log.warn(`Pool rehydration failed: ${err.message}`);
  }

  // Recover stale PENDING records from previous crash
  try {
    const stalePending = await prisma.copyTrade.findMany({
      where: { status: 'PENDING', createdAt: { lt: new Date(Date.now() - 60000) } },
    });
    if (stalePending.length > 0) {
      await prisma.copyTrade.updateMany({
        where: { id: { in: stalePending.map(r => r.id) } },
        data: { status: 'FAILED', failReason: 'process restart: order status unknown — check CLOB manually' },
      });
      const liveStale = stalePending.filter(r => !r.isPaper);
      if (liveStale.length > 0) {
        log.error(`${liveStale.length} LIVE PENDING records recovered — MANUAL CLOB RECONCILIATION REQUIRED`, {
          ids: liveStale.map(r => r.id),
          amounts: liveStale.map(r => `${r.side} $${r.requestedAmount.toFixed(2)}`),
        });
      }
      if (stalePending.length > liveStale.length) {
        log.warn(`Recovered ${stalePending.length - liveStale.length} paper PENDING records on startup`);
      }
    }
  } catch (err: any) {
    log.warn(`PENDING record recovery failed: ${err.message}`);
  }

  // Settlement sweep throttle
  let lastSettlementSweep = 0;

  // Main loop: drain DetectedTrade queue
  while (!shuttingDown && !isShuttingDown()) {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      // Get active followed wallets
      const activeWallets = (await prisma.followAllocation.findMany({
        where: { isActive: true },
        select: { proxyWallet: true },
      })).map(a => a.proxyWallet);

      if (activeWallets.length === 0) {
        // No allocations configured — nothing to do this cycle
        const duration = Date.now() - start;
        await updateHealth(duration, 'success', 0);
        if (!shuttingDown && !isShuttingDown()) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        }
        continue;
      }

      // Fetch unprocessed detected trades (no linked CopyTrade, within stale cutoff window)
      const staleCutoff = new Date(Date.now() - config.STALE_TRADE_CUTOFF_MS);
      const pending = await prisma.detectedTrade.findMany({
        where: {
          copyTrade: null,
          detectedAt: { gte: staleCutoff },
          proxyWallet: { in: activeWallets },
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
      // Sweep pool: burn expired FIFO entries
      await sweepPool();

      // Settlement sweep: settle resolved market positions
      if (Date.now() - lastSettlementSweep >= config.SETTLEMENT_SWEEP_INTERVAL_MS) {
        try {
          await sweepPositionSettlements();
          lastSettlementSweep = Date.now();
        } catch (err: any) {
          log.warn(`Settlement sweep failed: ${err.message}`);
        }
      }
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Copy-trader cycle failed: ${err.message}`, { stack: err.stack });
    }

    // Update system health (silent catch)
    const duration = Date.now() - start;
    await updateHealth(duration, result, processedCount, errorMessage);

    if (!shuttingDown && !isShuttingDown()) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
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
