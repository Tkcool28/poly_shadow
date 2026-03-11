import { createJobLogger } from '../lib/logger';

const log = createJobLogger('detection-race');

// ─── In-memory race tracker: CHAIN vs RAPID_POLL detection comparison ───

interface DetectionEntry {
  source: string;    // normalized: "CHAIN" or "RAPID_POLL"
  detectedAt: number; // Date.now() ms
}

const EXPIRY_MS = 5 * 60 * 1000; // 5 min: if no second source arrives, count as solo
const SWEEP_INTERVAL_MS = 60_000;
const MAX_ENTRIES = 200;

const pending = new Map<string, DetectionEntry>();

// Rolling stats (reset each heartbeat window)
let chainFirst = 0;
let rapidPollFirst = 0;
let chainOnly = 0;
let rapidPollOnly = 0;
let totalRaces = 0;

function normalizeSource(source: string): string {
  return source === 'CHAIN' || source === 'CHAIN_MAKER' ? 'CHAIN' : source;
}

function makeKey(txHash: string, wallet: string, asset: string): string {
  return `${txHash}:${wallet}:${asset}`;
}

export function recordDetection(
  txHash: string,
  wallet: string,
  asset: string,
  source: string,
): void {
  const key = makeKey(txHash, wallet, asset);
  const normalized = normalizeSource(source);
  const now = Date.now();

  const existing = pending.get(key);
  if (!existing) {
    // First detection — store and wait for the other source
    pending.set(key, { source: normalized, detectedAt: now });

    // Cap size: evict oldest if over limit
    if (pending.size > MAX_ENTRIES) {
      const oldestKey = pending.keys().next().value!;
      pending.delete(oldestKey);
    }
    return;
  }

  // Second detection — we have a race result
  pending.delete(key);

  if (existing.source === normalized) {
    // Same source detected twice (e.g., backfill + live), not a race
    return;
  }

  const deltaMs = now - existing.detectedAt;
  totalRaces++;

  if (existing.source === 'CHAIN') {
    chainFirst++;
  } else {
    rapidPollFirst++;
  }

  log.info('DETECTION_RACE', {
    winner: existing.source,
    loser: normalized,
    deltaMs,
    txHash: txHash.slice(0, 18),
    wallet: wallet.slice(0, 10),
  });
}

// Periodic sweep: entries that expired without a second detection = one source missed
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now - entry.detectedAt > EXPIRY_MS) {
      pending.delete(key);

      if (entry.source === 'CHAIN') {
        chainOnly++;
      } else {
        rapidPollOnly++;
      }

      const [txHash, wallet] = key.split(':');
      log.info('DETECTION_MISS', {
        onlySource: entry.source,
        txHash: txHash.slice(0, 18),
        wallet: wallet.slice(0, 10),
        ageMs: now - entry.detectedAt,
      });
    }
  }
}, SWEEP_INTERVAL_MS);
sweepTimer.unref(); // don't block process shutdown

export function getStats() {
  return { chainFirst, rapidPollFirst, chainOnly, rapidPollOnly, totalRaces };
}

export function resetStats(): void {
  chainFirst = 0;
  rapidPollFirst = 0;
  chainOnly = 0;
  rapidPollOnly = 0;
  totalRaces = 0;
}

export function stopSweep(): void {
  clearInterval(sweepTimer);
}
