/**
 * Poly-Shadow entrypoint — read-only MULTI-SOURCE trade-discovery shadow.
 * No orders, no signing, no keys, no Poly2 connection. Observation only.
 *
 * Sources (independent — no source validates another; handoff §4):
 *   CHAIN         Polygon V2 event watcher (Phase 2)
 *   REST_TRADES   Data API /trades poller (takerOnly=false: maker+taker)
 *   REST_ACTIVITY Data API /activity poller (separate population)
 * The reconciliation layer (racing.ts) records economic-trade candidate
 * groups, first-source winners, and later corroboration. Unmatched and
 * ungrouped records stay visible.
 *
 * WebSocket trade source: investigated and REJECTED for watched-wallet
 * discovery — see docs/shadow/WS_FEASIBILITY.md.
 */
import { loadConfig } from './config.js';
import { ShadowStore } from './storage.js';
import { ChainWatcher } from './watcher.js';
import { RacingStore, Reconciler, publishChainObservation } from './racing.js';
import { RestPoller } from './rest-poller.js';
import { startMemoryPublisher } from './runtime-memory.js';
import { selfToken } from './memory.js';

async function main(): Promise<void> {
  const cfg = loadConfig(); // fail-closed: throws on any credential material
  const store = new ShadowStore(cfg.dataDir);
  const racing = new RacingStore(cfg.dataDir);
  const reconciler = new Reconciler(racing);

  // CHAIN source: each committed observation also enters the racer with its
  // own arrival timestamp. Chain timing evidence is never overwritten.
  const watcher = new ChainWatcher(cfg, store, undefined, undefined, (obs) => {
    publishChainObservation(racing, reconciler, obs);
  });

  let trades: RestPoller | undefined;
  let activity: RestPoller | undefined;
  const initializePollers=()=>{
    trades = new RestPoller({
      source: 'REST_TRADES', endpoint: 'trades',
      baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
      intervalMs: cfg.tradesPollMs,
    }, racing, reconciler);
    activity = new RestPoller({
      source: 'REST_ACTIVITY', endpoint: 'activity',
      baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
      intervalMs: cfg.activityPollMs,
    }, racing, reconciler);
  };

  console.log('[poly-shadow] starting multi-source observation-only shadow', {
    wallets: [...cfg.watchedWallets].map((w) => w.slice(0, 10) + '…'),
    sources: ['CHAIN', 'REST_TRADES', 'REST_ACTIVITY'],
    tradesPollMs: cfg.tradesPollMs, activityPollMs: cfg.activityPollMs,
    dataDir: cfg.dataDir,
  });

  // Operational mutable snapshot, separate from arrival/scientific evidence.
  const {publish:publishMemory,stop:stopMemory}=startMemoryPublisher(cfg.dataDir,()=>({
    ...watcher.memoryTelemetry(),...racing.indexTelemetry(),token:selfToken(),
  }));

  const shutdown = () => {
    stopMemory();
    watcher.stop();
    trades?.stop();
    activity?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  try {
    await store.initializeIndex();
    await racing.initializeIndex();
    initializePollers();
    publishMemory();
    watcher.start();
    trades!.start();
    activity!.start();
  } catch (err) {
    stopMemory();
    watcher.stop(); trades?.stop(); activity?.stop();
    process.off('SIGINT', shutdown); process.off('SIGTERM', shutdown);
    store.close(); racing.close();
    throw err;
  }
}

void main().catch(err => { console.error('[poly-shadow] startup failed', err); process.exitCode=1; });
