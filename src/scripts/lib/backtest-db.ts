/**
 * Shared DB connection and calibration for backtest scripts.
 *
 * All scripts connect to the production DB via SSH tunnel:
 *   ssh -f -N -L 15438:localhost:5438 aws_ireland_dockerapps
 */

import { Client } from 'pg';
import type { SlippageModel } from './backtest-engine';
import { FALLBACK_FAK_FAILURE_RATE } from './backtest-engine';

export interface CalibrationData {
  slippage: SlippageModel | null;
  fakFailureRate: number;
}

export async function connectBacktestDb(): Promise<Client> {
  const db = new Client({
    host: 'localhost',
    port: parseInt(process.env.BACKTEST_DB_PORT ?? '15438', 10),
    user: 'polymarket',
    password: process.env.HETZNER_PG_PASSWORD ?? '',
    database: 'polymarket_copytrade',
  });
  await db.connect();
  return db;
}

export async function calibrateFromProduction(
  db: Client,
  loadSlippage: boolean = true,
): Promise<CalibrationData> {
  let slippage: SlippageModel | null = null;
  let fakFailureRate = FALLBACK_FAK_FAILURE_RATE;

  // Empirical slippage distribution
  if (loadSlippage) {
    try {
      const res = await db.query(`
        SELECT COUNT(*) as n,
          PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY "slippageBps") as p50,
          PERCENTILE_CONT(0.75) WITHIN GROUP (ORDER BY "slippageBps") as p75,
          PERCENTILE_CONT(0.90) WITHIN GROUP (ORDER BY "slippageBps") as p90
        FROM "CopyTrade"
        WHERE status = 'FILLED' AND "slippageBps" IS NOT NULL AND "slippageBps" >= 0 AND side = 'BUY'
      `);
      const row = res.rows[0];
      if (row && parseInt(row.n) >= 50) {
        slippage = {
          p50: parseFloat(row.p50),
          p75: parseFloat(row.p75),
          p90: parseFloat(row.p90),
        };
        console.log(`Empirical slippage: p50=${slippage.p50.toFixed(0)}bps p75=${slippage.p75.toFixed(0)}bps p90=${slippage.p90.toFixed(0)}bps (n=${row.n})`);
      } else {
        console.log(`Empirical slippage: insufficient data (n=${row?.n ?? 0}), using category-based fallback`);
      }
    } catch {
      console.log(`Empirical slippage: query failed, using category-based fallback`);
    }
  }

  // Empirical FAK failure rate
  try {
    const res = await db.query(`
      SELECT COUNT(CASE WHEN status='FILLED' THEN 1 END)::float / NULLIF(COUNT(*), 0) as fill_rate,
             COUNT(*) as total
      FROM "CopyTrade" WHERE "executionMethod" = 'FAK'
    `);
    const row = res.rows[0];
    if (row && parseInt(row.total) >= 50 && row.fill_rate != null) {
      fakFailureRate = 1 - parseFloat(row.fill_rate);
      console.log(`FAK failure rate: ${(fakFailureRate * 100).toFixed(1)}% (empirical from ${row.total} attempts)`);
    } else {
      console.log(`FAK failure rate: insufficient data (n=${row?.total ?? 0}), using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
    }
  } catch {
    console.log(`FAK failure rate: query failed, using ${(FALLBACK_FAK_FAILURE_RATE * 100)}% fallback`);
  }

  return { slippage, fakFailureRate };
}
