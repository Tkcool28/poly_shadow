/**
 * Shared types and functions for GTC backtest scripts.
 *
 * Used by:
 *   - backtest-gtc.ts (single trader GTC backtest)
 *   - backtest-gtc-sweep.ts (config sweep with GTC fills)
 */

import { existsSync, readdirSync } from 'fs';

// ─── Types ───

export interface DetectedSignal {
  id: string;
  proxyWallet: string;
  side: string;
  conditionId: string;
  tokenId: string;
  size: number;
  price: number;
  outcome: string;
  eventSlug: string;
  title: string;
  timestamp: number; // unix seconds
  detectedAtMs: number; // unix ms
}

export interface PriceTick {
  timestamp_ms: number;
  token_id: string;
  price: number;
  size: number;
  side: string;
}

export interface GtcFillResult {
  filled: boolean;
  fillPrice: number;
  fillLatencyMs: number;
}

// ─── GTC Fill Simulation ───

/**
 * Simulate a GTC fill: check if any price tick within the timeout window
 * crosses the limit price for a BUY order.
 * BUY fills if tick.price <= limitPrice (someone sells at our bid).
 */
export function simulateGtcFill(
  tokenId: string,
  limitPrice: number,
  signalTimestampMs: number,
  timeoutMs: number,
  priceTicks: Map<string, PriceTick[]>,
): GtcFillResult {
  const ticks = priceTicks.get(tokenId);
  if (!ticks) return { filled: false, fillPrice: 0, fillLatencyMs: 0 };

  const endMs = signalTimestampMs + timeoutMs;

  // Binary search for first tick >= signalTimestampMs
  let lo = 0, hi = ticks.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (ticks[mid].timestamp_ms < signalTimestampMs) lo = mid + 1;
    else hi = mid;
  }

  // Scan ticks within timeout window
  for (let i = lo; i < ticks.length && ticks[i].timestamp_ms <= endMs; i++) {
    if (ticks[i].price <= limitPrice) {
      return {
        filled: true,
        fillPrice: ticks[i].price,
        fillLatencyMs: ticks[i].timestamp_ms - signalTimestampMs,
      };
    }
  }

  return { filled: false, fillPrice: 0, fillLatencyMs: 0 };
}

// ─── Parquet Price Data Loader ───

/**
 * Load price ticks from parquet files in the data directory.
 * Returns a Map of tokenId -> sorted PriceTick[].
 */
export async function loadPriceTicks(
  dir: string,
  cutoffMs: number,
): Promise<Map<string, PriceTick[]>> {
  const result = new Map<string, PriceTick[]>();

  if (!existsSync(dir)) {
    console.warn(`Price data directory not found: ${dir}`);
    console.warn('Download from server: scp aws_ireland_dockerapps:/data/prices/*.parquet data/prices/');
    return result;
  }

  const files = readdirSync(dir).filter(f => f.endsWith('.parquet')).sort();
  if (files.length === 0) {
    console.warn(`No parquet files found in ${dir}`);
    return result;
  }

  console.log(`  Found ${files.length} parquet files`);

  // Try DuckDB for parquet reading
  try {
    // @ts-ignore — duckdb is an optional dependency, only needed when running this script
    const duckdbModule = await import('duckdb');
    const duckdb = duckdbModule.default ?? duckdbModule;
    const db = new duckdb.Database(':memory:');
    const conn = db.connect();

    // DuckDB query — dir and cutoffMs are computed internally (not user input),
    // but we sanitize the path to prevent injection via malicious filenames
    const safePath = dir.replace(/['"\\]/g, '');
    const safeCutoff = Number(cutoffMs);
    const query = `
      SELECT timestamp_ms, token_id, price, size, side
      FROM read_parquet('${safePath}/*.parquet')
      WHERE timestamp_ms >= ${safeCutoff}
      ORDER BY token_id, timestamp_ms
    `;

    await new Promise<void>((resolve, reject) => {
      conn.all(query, (err: any, rows: any[]) => {
        if (err) { reject(err); return; }
        for (const row of rows) {
          const tick: PriceTick = {
            timestamp_ms: Number(row.timestamp_ms),
            token_id: String(row.token_id),
            price: Number(row.price),
            size: Number(row.size),
            side: String(row.side),
          };
          const arr = result.get(tick.token_id) ?? [];
          arr.push(tick);
          result.set(tick.token_id, arr);
        }
        resolve();
      });
    });

    conn.close();
    db.close();
  } catch (e: any) {
    console.warn(`DuckDB not available (${e.message}). Install: npm install duckdb`);
    console.warn('Falling back to empty price data — GTC fills will all expire.');
  }

  return result;
}
