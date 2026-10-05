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
import { RacingStore, Reconciler, chainGroupKey } from './racing.js';
import { RestPoller } from './rest-poller.js';

function main(): void {
  const cfg = loadConfig(); // fail-closed: throws on any credential material
  const store = new ShadowStore(cfg.dataDir);
  const racing = new RacingStore(cfg.dataDir);
  const reconciler = new Reconciler(racing);

  // CHAIN source: each committed observation also enters the racer with its
  // own arrival timestamp. Chain timing evidence is never overwritten.
  const watcher = new ChainWatcher(cfg, store, undefined, undefined, (obs) => {
    reconciler.record('CHAIN', `${obs.eventId}:${obs.evidence.blockHash.toLowerCase()}`,
      chainGroupKey(obs), obs.sourceFirstSeenUtc);
    // Chain observations are ALSO normalized into the shared per-source
    // observation stream so Phase 4 reads one file per source uniformly.
    racing.appendSourceObservation({
      source: 'CHAIN',
      identity: `${obs.eventId}:${obs.evidence.blockHash.toLowerCase()}`,
      wallet: obs.wallet, side: obs.side, asset: obs.tokenId,
      size: obs.shares, price: obs.price10, sourceTs: obs.blockTimestamp,
      blockTimestamp: obs.blockTimestamp,
      sourceFirstSeenUtc: obs.sourceFirstSeenUtc, completedUtc: obs.firstSeenUtc,
      role: obs.role, groupKey: chainGroupKey(obs), hydration: 'FULL',
    });
  });

  const trades = new RestPoller({
    source: 'REST_TRADES', endpoint: 'trades',
    baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
    intervalMs: cfg.tradesPollMs,
  }, racing, reconciler);

  const activity = new RestPoller({
    source: 'REST_ACTIVITY', endpoint: 'activity',
    baseUrl: cfg.dataApiBaseUrl, wallets: cfg.watchedWallets,
    intervalMs: cfg.activityPollMs,
  }, racing, reconciler);

  console.log('[poly-shadow] starting multi-source observation-only shadow', {
    wallets: [...cfg.watchedWallets].map((w) => w.slice(0, 10) + '…'),
    sources: ['CHAIN', 'REST_TRADES', 'REST_ACTIVITY'],
    tradesPollMs: cfg.tradesPollMs, activityPollMs: cfg.activityPollMs,
    dataDir: cfg.dataDir,
  });

  watcher.start();
  trades.start();
  activity.start();

  const shutdown = () => {
    watcher.stop();
    trades.stop();
    activity.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
