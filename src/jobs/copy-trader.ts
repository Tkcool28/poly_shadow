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
import { PgListener } from '../lib/pg-listen';

const JOB_NAME = 'copy-trader';
const log = createJobLogger(JOB_NAME);
const CAPITAL_AUDIT_INTERVAL_MS = 3_600_000; // 1 hour

async function main() {
  let shuttingDown = false;

  // Early signal handler: covers the init window before full resources exist
  const earlyCleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal} during init, shutting down...`);
    stopPortfolioRefresh();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => earlyCleanup('SIGTERM'));
  process.on('SIGINT', () => earlyCleanup('SIGINT'));

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

  // ─── Event-driven trade processing ───
  // pg LISTEN/NOTIFY wakes us instantly on DetectedTrade INSERT.
  // Notification coalescing: multiple rapid notifications collapse into 1-2 drain cycles.
  // CRITICAL: processCopyTrade MUST remain sequential (shared lastSellAt state + capital mutations).
  let drainScheduled = false;
  let drainRunning = false;

  function scheduleDrain(source?: string) {
    if (drainScheduled || drainRunning) return;
    drainScheduled = true;
    log.debug(`Drain scheduled (${source ?? 'unknown'})`);
    setImmediate(runDrain);
  }

  async function runDrain() {
    drainScheduled = false;
    if (drainRunning || shuttingDown || isShuttingDown()) return;
    drainRunning = true;
    try {
      await drainTrades();
    } finally {
      drainRunning = false;
      if (drainScheduled) setImmediate(runDrain);
    }
  }

  async function drainTrades() {
    const start = Date.now();
    let processedCount = 0;
    let result = 'success';
    let errorMessage: string | undefined;

    try {
      // Get active followed wallets — split by buying power
      // SELLs need all wallets (must exit positions even at $0 capital)
      // BUYs only need wallets with buying power (filters out broke allocations)
      const allActiveAllocations = await prisma.followAllocation.findMany({
        where: { isActive: true },
        select: { proxyWallet: true, currentCapital: true },
      });
      const allActiveWallets = allActiveAllocations.map(a => a.proxyWallet);
      const buyEligibleWallets = allActiveAllocations
        .filter(a => a.currentCapital > 0)
        .map(a => a.proxyWallet);

      if (allActiveWallets.length === 0) {
        const duration = Date.now() - start;
        await updateHealth(duration, 'success', 0);
        return;
      }

      // Fetch unprocessed detected trades (no linked CopyTrade, within stale cutoff window)
      // SELLs are processed first — exits are time-sensitive and must not wait behind a BUY backlog
      const staleCutoff = new Date(Date.now() - config.STALE_TRADE_CUTOFF_MS);
      const baseWhere = {
        copyTrade: null,
        detectedAt: { gte: staleCutoff },
        timestamp: { gte: Math.floor(staleCutoff.getTime() / 1000) },
        // LIVE_POLL is a gap-filler for monitoring only — too high latency for copy signals
        detectionSource: { not: 'LIVE_POLL' as const },
      };
      const pendingSells = await prisma.detectedTrade.findMany({
        where: { ...baseWhere, side: 'SELL', proxyWallet: { in: allActiveWallets } },
        orderBy: { detectedAt: 'asc' },
      });
      const pendingBuys = await prisma.detectedTrade.findMany({
        where: { ...baseWhere, side: 'BUY', proxyWallet: { in: buyEligibleWallets } },
        orderBy: { detectedAt: 'asc' },
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

      // Sweep pool: burn expired FIFO entries (fast, trade-related)
      await sweepPool();
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Copy-trader drain failed: ${err.message}`, { stack: err.stack });
    }

    const duration = Date.now() - start;
    await updateHealth(duration, result, processedCount, errorMessage);
  }

  // Connect pg LISTEN for instant wake on DetectedTrade INSERT
  const listener = new PgListener('detected_trade_inserted', () => scheduleDrain('pg-notify'));
  await listener.connect();

  // Fallback poll: safety net if LISTEN connection drops
  const fallbackTimer = setInterval(() => scheduleDrain('fallback-poll'), config.COPY_TRADE_FALLBACK_POLL_MS);

  // Initial drain on startup (recover unprocessed trades from downtime)
  scheduleDrain('startup');

  // ─── Independent housekeeping timers ───
  // These run on their own schedules, never blocking trade processing.

  const settlementTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await sweepPositionSettlements();
    } catch (err: any) {
      log.warn(`Settlement sweep failed: ${err.message}`);
    }
  }, config.SETTLEMENT_SWEEP_INTERVAL_MS);

  const balanceTimer = isLiveReady() ? setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
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
    } catch (err: any) {
      log.warn(`Balance check failed: ${err.message}`);
    }
  }, config.BALANCE_CHECK_INTERVAL_MS) : null;

  const capitalAuditTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await auditAllAllocations({ isPaper: false, threshold: 1.0 });
    } catch (err: any) {
      log.warn(`Capital audit failed: ${err.message}`);
    }
  }, CAPITAL_AUDIT_INTERVAL_MS);

  const preResTimer = setInterval(async () => {
    if (shuttingDown || isShuttingDown()) return;
    try {
      await sweepPreResolutionSells();
    } catch (err: any) {
      log.warn(`Pre-resolution sweep failed: ${err.message}`);
    }
  }, config.SETTLEMENT_SWEEP_INTERVAL_MS);

  // Fire housekeeping once on startup (matches old behavior where lastX=0 triggered first cycle)
  sweepPositionSettlements().catch((err: any) => log.warn(`Settlement sweep failed: ${err.message}`));
  auditAllAllocations({ isPaper: false, threshold: 1.0 }).catch((err: any) => log.warn(`Capital audit failed: ${err.message}`));
  sweepPreResolutionSells().catch((err: any) => log.warn(`Pre-resolution sweep failed: ${err.message}`));

  // ─── Upgrade shutdown handler: now all resources exist ───
  process.removeAllListeners('SIGTERM');
  process.removeAllListeners('SIGINT');
  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(fallbackTimer);
    clearInterval(settlementTimer);
    if (balanceTimer) clearInterval(balanceTimer);
    clearInterval(capitalAuditTimer);
    clearInterval(preResTimer);
    stopPortfolioRefresh();
    await listener.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  log.info('Event-driven copy-trader ready', {
    fallbackPollMs: config.COPY_TRADE_FALLBACK_POLL_MS,
  });
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
