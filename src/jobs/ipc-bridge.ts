import 'dotenv/config';
import { createJobLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { startBridge, closeBridge, reconcileAllAllocations } from '../services/unix-socket-bridge.js';
import {
  sweepPositionSettlements,
  sweepUnclaimedSettledPositions,
  sweepStaleMarkets,
} from '../services/position-settlement.js';
import { reconcileStalePending, reconcileSkippedGhostFills } from '../services/clob-reconciler.js';
import { initialize as initExecutor, getWalletBalance } from '../services/trade-executor.js';
import { auditAllAllocations, cleanupPhantomPositions, checkCircuitBreakers } from '../lib/capital-audit.js';
import { sweepPreResolutionSells } from '../services/pre-resolution-seller.js';
import { config } from '../config/env.js';

const log = createJobLogger('ipc-bridge');
const SETTLEMENT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MARKET_REFRESH_MS = 15 * 60 * 1000; // 15 min
const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const CAPITAL_RECONCILE_MS = 60 * 1000; // 60s — sync Rust copier capital with DB
const CAPITAL_AUDIT_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const BALANCE_CHECK_INTERVAL_MS = 10 * 60 * 1000; // 10 min
const PRE_RESOLUTION_INTERVAL_MS = 15 * 60 * 1000; // 15 min

async function main() {
  let shuttingDown = false;

  // Initialize CLOB client for reconciliation (order status queries + stale order cancellation)
  await initExecutor();

  // Declare timers before cleanup so they're in scope
  let settlementTimer: ReturnType<typeof setInterval>;
  let marketRefreshTimer: ReturnType<typeof setInterval>;
  let reconcileTimer: ReturnType<typeof setInterval>;
  let capitalAuditTimer: ReturnType<typeof setInterval>;
  let balanceCheckTimer: ReturnType<typeof setInterval>;
  let preResolutionTimer: ReturnType<typeof setInterval>;
  let capitalReconcileTimer: ReturnType<typeof setInterval>;

  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(settlementTimer);
    clearInterval(marketRefreshTimer);
    clearInterval(reconcileTimer);
    clearInterval(capitalAuditTimer);
    clearInterval(balanceCheckTimer);
    clearInterval(preResolutionTimer);
    clearInterval(capitalReconcileTimer);
    closeBridge();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  startBridge();
  log.info('IPC bridge started');

  // Settlement sweep (5min) — sends market_settled to Rust for capital release
  settlementTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await sweepPositionSettlements();
      await sweepUnclaimedSettledPositions();
    } catch (err: any) {
      log.warn(`Settlement sweep failed: ${err.message}`);
    }
  }, SETTLEMENT_INTERVAL_MS);

  // Market refresh (15min) — detects resolved markets for settlement
  marketRefreshTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await sweepStaleMarkets();
    } catch (err: any) {
      log.warn(`Market refresh failed: ${err.message}`);
    }
  }, MARKET_REFRESH_MS);

  // Reconciliation sweep (5min) — recovers stale PENDING and ghost fills
  reconcileTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await reconcileStalePending();
      await reconcileSkippedGhostFills();
    } catch (err: any) {
      log.warn(`Reconciliation sweep failed: ${err.message}`);
    }
  }, RECONCILE_INTERVAL_MS);

  // Capital audit (1h) — drift detection + phantom cleanup + circuit breakers
  capitalAuditTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await auditAllAllocations({ isPaper: false, threshold: 1.0 });
      if (config.PHANTOM_AUTO_CLEANUP_ENABLED && config.FUNDER_ADDRESS) {
        await cleanupPhantomPositions(config.FUNDER_ADDRESS);
      }
      if (config.ALLOCATION_CIRCUIT_BREAKER_ENABLED) {
        await checkCircuitBreakers(config.ALLOCATION_CIRCUIT_BREAKER_THRESHOLD);
      }
    } catch (err: any) {
      log.warn(`Capital audit failed: ${err.message}`);
    }
  }, CAPITAL_AUDIT_INTERVAL_MS);

  // Balance monitor (10min) — wallet USDC check for live allocations
  balanceCheckTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      // Query ALL non-paper allocations (wallet holds capital for active + inactive)
      const dbCapital = (await prisma.followAllocation.aggregate({
        where: { isPaper: false },
        _sum: { currentCapital: true },
      }))._sum.currentCapital ?? 0;
      if (dbCapital === 0) return; // no live allocations

      const walletBal = await getWalletBalance();
      if (walletBal) {
        const deficit = dbCapital - walletBal.balance;
        if (deficit > config.BALANCE_MISMATCH_THRESHOLD) {
          log.warn('Balance deficit: wallet USDC below total DB currentCapital', {
            clobBalance: walletBal.balance.toFixed(2),
            dbTotalCC: dbCapital.toFixed(2),
            deficit: deficit.toFixed(2),
          });
        }
      }
    } catch (err: any) {
      log.warn(`Balance check failed: ${err.message}`);
    }
  }, BALANCE_CHECK_INTERVAL_MS);

  // Pre-resolution sells (15min) — auto-exit before market deadline
  preResolutionTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await sweepPreResolutionSells();
    } catch (err: any) {
      log.warn(`Pre-resolution sweep failed: ${err.message}`);
    }
  }, PRE_RESOLUTION_INTERVAL_MS);

  // Capital reconciliation (60s) — sync Rust copier capital with DB state
  capitalReconcileTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await reconcileAllAllocations();
    } catch (err: any) {
      log.warn(`Capital reconciliation failed: ${err.message}`);
    }
  }, CAPITAL_RECONCILE_MS);

  // Startup sweeps
  sweepPositionSettlements()
    .then(() => sweepUnclaimedSettledPositions())
    .catch((err: any) => log.warn(`Startup settlement failed: ${err.message}`));
  sweepStaleMarkets().catch((err: any) =>
    log.warn(`Startup market refresh failed: ${err.message}`),
  );
  reconcileStalePending()
    .then(() => reconcileSkippedGhostFills())
    .catch((err: any) => log.warn(`Startup reconciliation failed: ${err.message}`));
  auditAllAllocations({ isPaper: false, threshold: 1.0 })
    .catch((err: any) => log.warn(`Startup capital audit failed: ${err.message}`));
  sweepPreResolutionSells()
    .catch((err: any) => log.warn(`Startup pre-resolution sweep failed: ${err.message}`));

  log.info('IPC bridge process ready');
  await new Promise(() => {}); // keep alive forever
}

main().catch((err) => {
  console.error('ipc-bridge fatal:', err);
  process.exit(1);
});
