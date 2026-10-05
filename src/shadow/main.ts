/**
 * Poly-Shadow entrypoint — read-only trade-discovery shadow.
 * No orders, no signing, no keys, no Poly2 connection. Observation only.
 */
import { loadConfig } from './config.js';
import { ShadowStore } from './storage.js';
import { ChainWatcher } from './watcher.js';

function main(): void {
  const cfg = loadConfig(); // fail-closed: throws on any credential material
  const store = new ShadowStore(cfg.dataDir);
  const watcher = new ChainWatcher(cfg, store);

  console.log('[poly-shadow] starting observation-only shadow', {
    wallets: [...cfg.watchedWallets].map((w) => w.slice(0, 10) + '…'),
    dataDir: cfg.dataDir,
  });

  watcher.start();

  const shutdown = () => {
    watcher.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main();
