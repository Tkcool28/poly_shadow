import 'dotenv/config';
import { createJobLogger } from '../lib/logger.js';
import { prisma } from '../lib/prisma.js';
import { startBridge, closeBridge } from '../services/unix-socket-bridge.js';
import {
  sweepPositionSettlements,
  sweepUnclaimedSettledPositions,
  sweepStaleMarkets,
} from '../services/position-settlement.js';

const log = createJobLogger('ipc-bridge');
const SETTLEMENT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const MARKET_REFRESH_MS = 15 * 60 * 1000; // 15 min

async function main() {
  let shuttingDown = false;

  const cleanup = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Received ${signal}, shutting down...`);
    clearInterval(settlementTimer);
    clearInterval(marketRefreshTimer);
    closeBridge();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  startBridge();
  log.info('IPC bridge started');

  // Settlement sweep (5min) — sends market_settled to Rust for capital release
  const settlementTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await sweepPositionSettlements();
      await sweepUnclaimedSettledPositions();
    } catch (err: any) {
      log.warn(`Settlement sweep failed: ${err.message}`);
    }
  }, SETTLEMENT_INTERVAL_MS);

  // Market refresh (15min) — detects resolved markets for settlement
  const marketRefreshTimer = setInterval(async () => {
    if (shuttingDown) return;
    try {
      await sweepStaleMarkets();
    } catch (err: any) {
      log.warn(`Market refresh failed: ${err.message}`);
    }
  }, MARKET_REFRESH_MS);

  // Startup sweeps
  sweepPositionSettlements()
    .then(() => sweepUnclaimedSettledPositions())
    .catch((err: any) => log.warn(`Startup settlement failed: ${err.message}`));
  sweepStaleMarkets().catch((err: any) =>
    log.warn(`Startup market refresh failed: ${err.message}`),
  );

  log.info('IPC bridge process ready');
  await new Promise(() => {}); // keep alive forever
}

main().catch((err) => {
  console.error('ipc-bridge fatal:', err);
  process.exit(1);
});
