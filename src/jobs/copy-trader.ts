import 'dotenv/config';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { isShuttingDown } from '../lib/shutdown';
import { initialize as initExecutor, isLiveReady, getWalletBalance, resetBalancePause } from '../services/trade-executor';
import { processCopyTrade } from '../services/copy-trade-worker';
import { startPortfolioRefresh, stopPortfolioRefresh } from '../services/portfolio-cache';
import { rehydratePool, sweepPool } from '../services/order-pool';
import { sweepPositionSettlements } from '../services/position-settlement';
import { reconcileStalePending } from '../services/clob-reconciler';
import { sweepPreResolutionSells } from '../services/pre-resolution-seller';
import { auditAllAllocations } from '../lib/capital-audit';

const JOB_NAME = 'copy-trader';
const log = createJobLogger(JOB_NAME);
const POLL_INTERVAL_MS = 2000; // 2s drain interval
const CAPITAL_AUDIT_INTERVAL_MS = 3_600_000; // 1 hour

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

  // Recover stale PENDING records via CLOB reconciliation
  try {
    await reconcileStalePending();
  } catch (err: any) {
    log.warn(`PENDING record reconciliation failed: ${err.message}`);
  }

  // Sweep throttles
  let lastSettlementSweep = 0;
  let lastBalanceCheck = 0;
  let lastPreResolutionSweep = 0;
  let lastCapitalAudit = 0;

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
      // SELLs are processed first — exits are time-sensitive and must not wait behind a BUY backlog
      const staleCutoff = new Date(Date.now() - config.STALE_TRADE_CUTOFF_MS);
      const baseWhere = {
        copyTrade: null,
        detectedAt: { gte: staleCutoff },
        timestamp: { gte: Math.floor(staleCutoff.getTime() / 1000) },
        proxyWallet: { in: activeWallets },
      };
      const pendingSells = await prisma.detectedTrade.findMany({
        where: { ...baseWhere, side: 'SELL' },
        orderBy: { detectedAt: 'asc' },
      });
      const pendingBuys = await prisma.detectedTrade.findMany({
        where: { ...baseWhere, side: 'BUY' },
        orderBy: { detectedAt: 'asc' },
        take: 10,
      });
      const pending = [...pendingSells, ...pendingBuys];

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

      // Balance check: warn if CLOB wallet balance diverges from DB capital
      if (isLiveReady() && Date.now() - lastBalanceCheck >= config.BALANCE_CHECK_INTERVAL_MS) {
        try {
          const walletBal = await getWalletBalance();
          if (walletBal) {
            const dbCapital = (await prisma.followAllocation.aggregate({
              where: { isActive: true, isPaper: false },
              _sum: { currentCapital: true },
            }))._sum.currentCapital ?? 0;

            const diff = Math.abs(walletBal.balance - dbCapital);
            if (diff > config.BALANCE_MISMATCH_THRESHOLD) {
              log.warn('Balance mismatch: CLOB wallet vs DB capital', {
                clobBalance: walletBal.balance.toFixed(2),
                dbCurrentCapital: dbCapital.toFixed(2),
                diff: diff.toFixed(2),
              });
            } else {
              log.debug('Balance check OK', {
                clobBalance: walletBal.balance.toFixed(2),
                dbCurrentCapital: dbCapital.toFixed(2),
              });
            }
            // Any successful wallet fetch clears the balance pause.
            // The circuit breaker re-engages immediately if the next live trade still fails.
            resetBalancePause();
          }
          lastBalanceCheck = Date.now();
        } catch (err: any) {
          log.warn(`Balance check failed: ${err.message}`);
        }
      }

      // Capital audit: periodic reconciliation check (warn-only, no auto-fix)
      if (Date.now() - lastCapitalAudit >= CAPITAL_AUDIT_INTERVAL_MS) {
        try {
          await auditAllAllocations({ isPaper: false, threshold: 1.0 });
          lastCapitalAudit = Date.now();
        } catch (err: any) {
          log.warn(`Capital audit failed: ${err.message}`);
        }
      }

      // Pre-resolution sweep: auto-sell positions before market closes
      if (Date.now() - lastPreResolutionSweep >= config.SETTLEMENT_SWEEP_INTERVAL_MS) {
        try {
          await sweepPreResolutionSells();
          lastPreResolutionSweep = Date.now();
        } catch (err: any) {
          log.warn(`Pre-resolution sweep failed: ${err.message}`);
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
