import 'dotenv/config';
import { isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { detectNewTrades, detectRapidPollTrades, handleRealtimeTrade, startCacheRefresh, stopCacheRefresh, getChainWatcherWallets, createDetectedTradeFromChain } from '../services/trade-detector';
import { stopSweep as stopRaceTrackerSweep } from '../services/detection-race-tracker';
import { RtdsTradeStream } from '../services/ws-trade-stream';
import { ChainTradeWatcher } from '../services/chain-trade-watcher';

const JOB_NAME = 'trade-monitor';
const log = createJobLogger(JOB_NAME);

let wsStream: RtdsTradeStream | null = null;
let wsDetectedCount = 0;
let chainWatchers: ChainTradeWatcher[] = [];
let chainDetectedCount = 0;

async function runPollingCycle(): Promise<number> {
  return await detectNewTrades();
}

async function startLivePoll(): Promise<void> {
  log.info('Starting rapid-poll signal detection', { intervalMs: config.LIVE_TRADERS_POLL_MS });
  while (!isShuttingDown()) {
    try {
      const detected = await detectRapidPollTrades();
      if (detected > 0) log.info(`Rapid-poll: ${detected} new trades detected`);
    } catch (err: any) {
      log.error(`Live poll error: ${err.message}`, { stack: err.stack });
    }
    if (!isShuttingDown()) {
      await new Promise(resolve => setTimeout(resolve, config.LIVE_TRADERS_POLL_MS));
    }
  }
}

async function main() {
  // Custom shutdown handler (replaces setupGracefulShutdown to also clean up WS + cache)
  let cleanedUp = false;
  const cleanup = async (signal: string) => {
    if (cleanedUp) return;
    cleanedUp = true;
    log.info(`Received ${signal}, cleaning up...`);
    stopCacheRefresh();
    stopRaceTrackerSweep();
    if (wsStream) wsStream.close();
    for (const w of chainWatchers) w.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  // Always populate wallet caches before starting chain watcher or WS/polling.
  // startCacheRefresh has a guard so the call from startWithWebSocket() below is a no-op.
  await startCacheRefresh(60000);

  // Layer 1: Blockchain event-driven detection for live-allocation wallets
  // Decodes OrderFilled events on-chain and creates DetectedTrade records directly (~2s latency)
  if (config.CHAIN_WATCHER_ENABLED) {
    const chainCallback = async (data: Parameters<typeof createDetectedTradeFromChain>[0]) => {
      try {
        const inserted = await createDetectedTradeFromChain(data);
        if (inserted) {
          chainDetectedCount++;
          log.info('Chain trade recorded', {
            wallet: data.proxyWallet.slice(0, 10),
            side: data.side,
            tokenId: data.tokenId.slice(0, 16),
            price: data.price.toFixed(4),
            txHash: data.transactionHash.slice(0, 18),
          });
        }
      } catch (err: any) {
        log.error(`Chain trade handler error: ${err.message}`, { stack: err.stack });
      }
    };

    // Primary WSS connection (always)
    const primary = new ChainTradeWatcher(chainCallback, getChainWatcherWallets, 'A');
    primary.connect();
    chainWatchers.push(primary);

    // Backup WSS connection (dual-WSS for zero-gap coverage, separate provider)
    if (config.CHAIN_DUAL_WSS) {
      const backup = new ChainTradeWatcher(
        chainCallback,
        getChainWatcherWallets,
        'B',
        config.POLYGON_WS_RPC_URL_B,
        config.POLYGON_HTTP_RPC_URL_B,
      );
      backup.connect();
      chainWatchers.push(backup);
      log.info('Multi-WSS: instance B enabled');
    }

    // Third WSS connection (triple-WSS for provider diversity)
    if (config.CHAIN_DUAL_WSS && config.POLYGON_WS_RPC_URL_C !== config.POLYGON_WS_RPC_URL) {
      const tertiary = new ChainTradeWatcher(
        chainCallback,
        getChainWatcherWallets,
        'C',
        config.POLYGON_WS_RPC_URL_C,
        config.POLYGON_HTTP_RPC_URL_C,
      );
      tertiary.connect();
      chainWatchers.push(tertiary);
      log.info('Multi-WSS: instance C enabled');
    }
  }

  // Rapid-poll primary signal source (RAPID_POLL, included in copy signals)
  void startLivePoll();

  // Bulk detection for all monitored traders
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
    const totalDetected = detectedCount + wsDetectedCount + chainDetectedCount;
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

    if (wsDetectedCount > 0) {
      log.info(`WS real-time: ${wsDetectedCount} trades detected since last poll`);
    }

    if (chainDetectedCount > 0) {
      log.info(`Chain watcher: ${chainDetectedCount} trades detected since last poll`);
    }

    // Reset counters after reporting
    wsDetectedCount = 0;
    chainDetectedCount = 0;

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

    for (const w of chainWatchers) {
      log.debug(`Chain watcher [${w.label}] status`, {
        state: w.state,
        eventsReceived: w.eventsReceived,
        triggeredDetections: w.triggeredDetections,
        lastEventAt: w.lastEventAt?.toISOString(),
      });
    }

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

main();
