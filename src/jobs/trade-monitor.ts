import 'dotenv/config';
import { isShuttingDown } from '../lib/shutdown';
import { createJobLogger } from '../lib/logger';
import { prisma } from '../lib/prisma';
import { config } from '../config/env';
import { detectNewTrades, detectLiveTrades, detectLiveTradeForWallet, handleRealtimeTrade, startCacheRefresh, stopCacheRefresh, getLiveAllocationWallets } from '../services/trade-detector';
import { RtdsTradeStream } from '../services/ws-trade-stream';
import { ChainTradeWatcher } from '../services/chain-trade-watcher';

const JOB_NAME = 'trade-monitor';
const log = createJobLogger(JOB_NAME);

let wsStream: RtdsTradeStream | null = null;
let wsDetectedCount = 0;
let chainWatcher: ChainTradeWatcher | null = null;
let chainDetectedCount = 0;
// Dedup: prevent concurrent REST calls for the same wallet from rapid-fire chain events
const pendingWalletChecks = new Set<string>();

async function runPollingCycle(): Promise<number> {
  return await detectNewTrades();
}

async function startLivePoll(): Promise<void> {
  log.info('Starting live-trader fast-poll', { intervalMs: config.LIVE_TRADERS_POLL_MS });
  while (!isShuttingDown()) {
    try {
      const detected = await detectLiveTrades();
      if (detected > 0) log.info(`Live poll: ${detected} new trades detected`);
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
    if (wsStream) wsStream.close();
    if (chainWatcher) chainWatcher.close();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => cleanup('SIGTERM'));
  process.on('SIGINT', () => cleanup('SIGINT'));

  // Always populate wallet caches before starting chain watcher or WS/polling.
  // startCacheRefresh has a guard so the call from startWithWebSocket() below is a no-op.
  await startCacheRefresh(60000);

  // Layer 1: Blockchain event-driven detection for live-allocation wallets
  if (config.CHAIN_WATCHER_ENABLED) {
    chainWatcher = new ChainTradeWatcher(
      async (wallet) => {
        // Dedup: skip if a check for this wallet is already in flight
        if (pendingWalletChecks.has(wallet)) return;
        pendingWalletChecks.add(wallet);
        try {
          // Retry schedule: REST API has 2-4min indexing lag after on-chain events.
          // Try immediately, then retry at 3s, 8s, 20s, 45s to cover the lag window.
          const retryDelays = [0, 3000, 5000, 12000, 25000];
          for (let i = 0; i < retryDelays.length; i++) {
            if (retryDelays[i] > 0) {
              await new Promise(r => setTimeout(r, retryDelays[i]));
            }
            const detected = await detectLiveTradeForWallet(wallet);
            if (detected > 0) {
              chainDetectedCount += detected;
              log.info('Chain watcher detected trade', {
                wallet: wallet.slice(0, 10),
                detected,
                attempt: i + 1,
                totalDelayMs: retryDelays.slice(0, i + 1).reduce((a, b) => a + b, 0),
              });
              break;
            }
            // Last attempt — log that REST API didn't have the trade yet
            if (i === retryDelays.length - 1) {
              log.warn('Chain watcher: REST API did not index trade after retries', {
                wallet: wallet.slice(0, 10),
                attempts: retryDelays.length,
                totalDelayMs: retryDelays.reduce((a, b) => a + b, 0),
              });
            }
          }
        } catch (err: any) {
          log.error(`Chain watcher handler error: ${err.message}`, { stack: err.stack });
        } finally {
          pendingWalletChecks.delete(wallet);
        }
      },
      getLiveAllocationWallets,
    );
    chainWatcher.connect();
  }

  // Layer 2: 10s polling backup for live-allocation wallets (always runs)
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

    if (config.CHAIN_WATCHER_ENABLED && chainWatcher) {
      log.debug('Chain watcher status', {
        state: chainWatcher.state,
        eventsReceived: chainWatcher.eventsReceived,
        triggeredDetections: chainWatcher.triggeredDetections,
        lastEventAt: chainWatcher.lastEventAt?.toISOString(),
      });
    }

    if (!isShuttingDown()) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
}

main();
