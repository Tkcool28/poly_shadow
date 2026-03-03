import 'dotenv/config';
import { isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { detectNewTrades, handleRealtimeTrade, startCacheRefresh, stopCacheRefresh } from '../services/trade-detector';
import { RtdsTradeStream } from '../services/ws-trade-stream';

const JOB_NAME = 'trade-monitor';
const log = createJobLogger(JOB_NAME);

let wsStream: RtdsTradeStream | null = null;
let wsDetectedCount = 0;

async function runPollingCycle(): Promise<number> {
  return await detectNewTrades();
}

async function main() {
  // Custom shutdown handler (replaces setupGracefulShutdown to also clean up WS + cache)
  let cleanedUp = false;
  const cleanup = async (signal: string) => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info(`Received ${signal}, cleaning up...`);
    stopCacheRefresh();
    if (wsStream) wsStream.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  if (config.WS_ENABLED) {
    await startWithWebSocket();
  } else {
    await startWithPolling(config.TRADE_MONITOR_INTERVAL_MS);
  }
}

async function startWithWebSocket(): Promise<void> {
  log.info('Trade monitor starting with WebSocket (RTDS) + polling fallback', {
    fallbackPollInterval: config.WS_FALLBACK_POLL_MS,
  });

  // Initialize monitored wallets cache (used by WS handler)
  // Await so trackedWallets is populated before WS messages can arrive
  await startCacheRefresh(60000);

  // Start WebSocket stream
  wsStream = new RtdsTradeStream(async (payload) => {
    try {
      const inserted = await handleRealtimeTrade(payload);
      if (inserted) wsDetectedCount++;
    } catch (err: any) {
      log.error(`WS trade handler error: ${err.message}`, { stack: err.stack });
    }
  });
  wsStream.connect();

  // Run reduced-frequency polling as safety net
  await startWithPolling(config.WS_FALLBACK_POLL_MS);
}

async function startWithPolling(intervalMs: number): Promise<void> {
  if (!config.WS_ENABLED) {
    log.info('Trade monitor started (polling only)', {
      pollInterval: intervalMs,
    });
  }

  while (!isShuttingDown()) {
    const start = Date.now();
    let detectedCount = 0;
    let result = config.WS_ENABLED ? `ws-${wsStream?.state ?? 'unknown'}` : 'success';
    let errorMessage: string | undefined;

    try {
      detectedCount = await runPollingCycle();
    } catch (err: any) {
      result = 'error';
      errorMessage = err.message?.slice(0, 500);
      log.error(`Monitor cycle failed: ${err.message}`, { stack: err.stack });
    }

    // Update system health
    const duration = Date.now() - start;
    const totalDetected = detectedCount + wsDetectedCount;
    try {
      await prisma.systemHealth.upsert({
        where: { jobName: JOB_NAME },
        create: {
          jobName: JOB_NAME,
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount: totalDetected,
          errorMessage: errorMessage ?? null,
        },
        update: {
          lastRunAt: new Date(),
          lastRunDuration: duration,
          lastRunResult: result,
          processedCount: totalDetected,
          errorMessage: errorMessage ?? null,
        },
      });
    } catch {}

    // Reset WS counter after reporting
    wsDetectedCount = 0;

    if (detectedCount > 0) {
      log.info(`Polling cycle: detected ${detectedCount} new trades`, { durationMs: duration });
    } else {
      log.debug(`Polling cycle: no new trades`, { durationMs: duration });
    }

    if (config.WS_ENABLED && wsStream) {
      log.debug('WebSocket status', {
        state: wsStream.state,
        messagesReceived: wsStream.messagesReceived,
        lastMessageAt: wsStream.lastMessageAt?.toISOString(),
      });
    }

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

main();
