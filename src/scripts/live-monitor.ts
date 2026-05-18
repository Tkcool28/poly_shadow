#!/usr/bin/env tsx
/**
 * Live Copy-Trade Monitor
 *
 * Checks production health metrics for all active live allocations every 5 minutes.
 * Auto-stops allocations that breach the stop-loss threshold (-$50 capital P&L).
 *
 * Uses SSH+psql pattern (same as post-deploy-monitor.ts) — runs locally,
 * queries production via a single SSH session to avoid rate limiting.
 *
 * Usage:
 *   npx tsx src/scripts/live-monitor.ts
 *   # or with PM2 cron_restart every 5 minutes
 *
 * Exit codes: 0 = PASS, 1 = WARN, 2 = STOPPED (allocation auto-disabled)
 */

import { execSync } from 'child_process';

// ─── Thresholds ───

const STOP_LOSS_USD = 50;        // Auto-stop if capital P&L < -$50
const WARN_SKIP_RATE = 0.50;     // Warn if >50% skipped in last hour
const WARN_STALE_HOURS = 2;      // Warn if no activity for 2h
const WARN_SLIPPAGE_BPS = 500;   // Warn if avg slippage > 500bps

const SSH_HOST = process.env.PROD_SSH_HOST ?? '';
const PSQL_CMD = 'docker exec -i polymarket_postgres psql -U polymarket -d polymarket_copytrade -t -A -F\'|\'';

if (!SSH_HOST) {
  console.error('Missing required env: PROD_SSH_HOST');
  process.exit(2);
}

// ─── SQL Queries (single session) ───

const SQL = `
-- Q1: All active live allocations + capital
SELECT 'Q1', id, "proxyWallet",
       "initialCapital"::numeric(10,2),
       "currentCapital"::numeric(10,2),
       "deployedCapital"::numeric(10,2),
       "copySells", "committedSideLock", "majorityOnlyMode",
       "copyTradePercent"::numeric(10,2), "maxPositionUsd"::numeric(10,2),
       "maxPredictionPositionUsd"::numeric(10,2),
       COALESCE("minBuyPrice", 0)::numeric(10,2)
FROM "FollowAllocation"
WHERE "isActive" = true AND "isPaper" = false;

-- Q2: Recent fills + skips per allocation (1h window)
SELECT 'Q2', "followAllocationId",
  COUNT(*) FILTER (WHERE status IN ('FILLED', 'SETTLED')),
  COUNT(*) FILTER (WHERE status = 'SKIPPED')
FROM "CopyTrade"
WHERE "isPaper" = false
  AND "createdAt" > NOW() - INTERVAL '1 hour'
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId";

-- Q3: Skip reason breakdown per allocation (1h, top 5)
SELECT 'Q3', "followAllocationId", "failReason", COUNT(*)
FROM "CopyTrade"
WHERE "isPaper" = false AND status = 'SKIPPED'
  AND "createdAt" > NOW() - INTERVAL '1 hour'
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId", "failReason"
ORDER BY "followAllocationId", COUNT(*) DESC;

-- Q4: SELL skip check — copySells bug detector
SELECT 'Q4', "followAllocationId", COUNT(*)
FROM "CopyTrade"
WHERE "isPaper" = false AND status = 'SKIPPED' AND side = 'SELL'
  AND "failReason" LIKE '%hold-to-settlement%'
  AND "createdAt" > NOW() - INTERVAL '1 hour'
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId";

-- Q5: Avg slippage per allocation (1h filled trades)
SELECT 'Q5', "followAllocationId", AVG("slippageBps")::numeric(10,1), COUNT(*)
FROM "CopyTrade"
WHERE "isPaper" = false AND status IN ('FILLED', 'SETTLED')
  AND "slippageBps" IS NOT NULL
  AND "createdAt" > NOW() - INTERVAL '1 hour'
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId";

-- Q6: Last trade per allocation (stale check)
SELECT 'Q6', "followAllocationId", MAX("createdAt")
FROM "CopyTrade"
WHERE "isPaper" = false
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId";

-- Q7: Filled SELL count per allocation (1h — verifies SELLs ARE being copied)
SELECT 'Q7', "followAllocationId", COUNT(*)
FROM "CopyTrade"
WHERE "isPaper" = false AND status IN ('FILLED', 'SETTLED') AND side = 'SELL'
  AND "createdAt" > NOW() - INTERVAL '1 hour'
  AND "followAllocationId" IS NOT NULL
GROUP BY "followAllocationId";
`;

// ─── Types ───

interface Allocation {
  id: string;
  proxyWallet: string;
  initialCapital: number;
  currentCapital: number;
  deployedCapital: number;
  copySells: boolean;
  committedSideLock: boolean;
  majorityOnlyMode: boolean;
  copyTradePercent: number;
  maxPositionUsd: number;
  maxPredictionPositionUsd: number;
  minBuyPrice: number;
}

interface CheckResult {
  label: string;
  status: 'PASS' | 'WARN' | 'ALERT' | 'STOP' | 'INFO';
  message: string;
}

// ─── Query helpers ───

function runQueries(): string {
  const result = execSync(`ssh ${SSH_HOST} bash -s <<'OUTER'
${PSQL_CMD} <<'EOSQL' 2>&1
${SQL}
EOSQL
OUTER`, { encoding: 'utf-8', timeout: 30000 });
  return result;
}

function stopAllocation(allocId: string): void {
  // Sanitize allocId to prevent SQL injection (only allow alphanumeric + underscore)
  const safeId = allocId.replace(/[^a-zA-Z0-9_]/g, '');
  if (safeId !== allocId) {
    throw new Error(`Refusing to stop allocation with suspicious id: ${allocId}`);
  }
  execSync(`ssh ${SSH_HOST} bash -s <<'OUTER'
docker exec polymarket_postgres psql -U polymarket -d polymarket_copytrade -c "
UPDATE \\"FollowAllocation\\" SET \\"isActive\\" = false WHERE id = '${safeId}';
"
OUTER`, { encoding: 'utf-8', timeout: 15000 });
}

function getRows(lines: string[], tag: string): string[][] {
  return lines
    .filter(l => l.startsWith(tag + '|'))
    .map(l => l.split('|').slice(1));
}

function parseBool(val: string): boolean {
  return val === 't' || val === 'true';
}

// ─── Parse & evaluate ───

function evaluate(raw: string): { results: CheckResult[]; worstLevel: number } {
  const results: CheckResult[] = [];
  let worstLevel = 0; // 0=PASS, 1=WARN, 2=STOP

  // Detect psql errors (e.g. missing columns before migration is applied)
  const errorLines = raw.split('\n').filter(l => l.startsWith('ERROR:'));
  if (errorLines.length > 0) {
    results.push({
      label: 'Database',
      status: 'ALERT',
      message: `psql error: ${errorLines[0].trim()}`,
    });
    worstLevel = 1;
    return { results, worstLevel };
  }

  const lines = raw.trim().split('\n').filter(l => l.startsWith('Q'));

  // Q1: Parse allocations
  const allocRows = getRows(lines, 'Q1');
  if (allocRows.length === 0) {
    results.push({ label: 'Allocations', status: 'INFO', message: 'No active live allocations found' });
    return { results, worstLevel };
  }

  const allocations: Allocation[] = allocRows.map(r => ({
    id: r[0],
    proxyWallet: r[1],
    initialCapital: parseFloat(r[2]),
    currentCapital: parseFloat(r[3]),
    deployedCapital: parseFloat(r[4]),
    copySells: parseBool(r[5]),
    committedSideLock: parseBool(r[6]),
    majorityOnlyMode: parseBool(r[7]),
    copyTradePercent: parseFloat(r[8]),
    maxPositionUsd: parseFloat(r[9]),
    maxPredictionPositionUsd: parseFloat(r[10]),
    minBuyPrice: parseFloat(r[11]),
  }));

  // Per-allocation trade data
  const q2Rows = getRows(lines, 'Q2');
  const q3Rows = getRows(lines, 'Q3');
  const q4Rows = getRows(lines, 'Q4');
  const q5Rows = getRows(lines, 'Q5');
  const q6Rows = getRows(lines, 'Q6');
  const q7Rows = getRows(lines, 'Q7');

  for (const alloc of allocations) {
    const walletShort = alloc.proxyWallet.slice(0, 8);
    const capitalPnl = (alloc.currentCapital + alloc.deployedCapital) - alloc.initialCapital;

    // ── Capital drift (STOP trigger) ──
    if (capitalPnl < -STOP_LOSS_USD) {
      results.push({
        label: `${walletShort} Capital`,
        status: 'STOP',
        message: `P&L $${capitalPnl.toFixed(2)} breached -$${STOP_LOSS_USD} limit → AUTO-STOPPING`,
      });
      try {
        stopAllocation(alloc.id);
        results.push({
          label: `${walletShort} Stop`,
          status: 'STOP',
          message: `Set isActive=false for ${alloc.id}`,
        });
      } catch (err: any) {
        results.push({
          label: `${walletShort} Stop`,
          status: 'ALERT',
          message: `FAILED to stop: ${err.message}`,
        });
      }
      worstLevel = 2;
      continue;
    }

    results.push({
      label: `${walletShort} Capital`,
      status: capitalPnl < -(STOP_LOSS_USD * 0.6) ? 'WARN' : 'PASS',
      message: `cur=$${alloc.currentCapital.toFixed(2)} dep=$${alloc.deployedCapital.toFixed(2)} pnl=$${capitalPnl.toFixed(2)} (stop: -$${STOP_LOSS_USD})`,
    });
    if (capitalPnl < -(STOP_LOSS_USD * 0.6) && worstLevel < 1) worstLevel = 1;

    // ── Fills + skips (1h) ──
    const tradeRow = q2Rows.find(r => r[0] === alloc.id);
    const fills = tradeRow ? parseInt(tradeRow[1], 10) : 0;
    const skips = tradeRow ? parseInt(tradeRow[2], 10) : 0;
    const total = fills + skips;

    if (total > 5 && skips / total > WARN_SKIP_RATE) {
      results.push({
        label: `${walletShort} Skip rate`,
        status: 'WARN',
        message: `${((skips / total) * 100).toFixed(0)}% (${skips}/${total}) in 1h — threshold ${WARN_SKIP_RATE * 100}%`,
      });
      if (worstLevel < 1) worstLevel = 1;

      // Top skip reasons
      const reasons = q3Rows
        .filter(r => r[0] === alloc.id)
        .slice(0, 3)
        .map(r => `${r[1]} (${r[2]})`)
        .join(', ');
      if (reasons) {
        results.push({ label: `${walletShort} Skip reasons`, status: 'INFO', message: reasons });
      }
    } else {
      results.push({
        label: `${walletShort} Trades (1h)`,
        status: 'INFO',
        message: `${fills} fills, ${skips} skips`,
      });
    }

    // ── SELL skip check (copySells bug) ──
    if (alloc.copySells) {
      const sellSkipRow = q4Rows.find(r => r[0] === alloc.id);
      const sellSkips = sellSkipRow ? parseInt(sellSkipRow[1], 10) : 0;
      if (sellSkips > 0) {
        results.push({
          label: `${walletShort} SELL bug`,
          status: 'ALERT',
          message: `${sellSkips} SELLs skipped with hold-to-settlement despite copySells=true!`,
        });
        if (worstLevel < 1) worstLevel = 1;
      }

      // Positive SELL confirmation
      const sellFillRow = q7Rows.find(r => r[0] === alloc.id);
      const sellFills = sellFillRow ? parseInt(sellFillRow[1], 10) : 0;
      results.push({
        label: `${walletShort} SELL fills (1h)`,
        status: 'INFO',
        message: `${sellFills}`,
      });
    }

    // ── Slippage ──
    const slipRow = q5Rows.find(r => r[0] === alloc.id);
    if (slipRow) {
      const avgSlip = parseFloat(slipRow[1]);
      const slipCount = parseInt(slipRow[2], 10);
      if (slipCount >= 3 && avgSlip > WARN_SLIPPAGE_BPS) {
        results.push({
          label: `${walletShort} Slippage`,
          status: 'WARN',
          message: `avg ${avgSlip.toFixed(0)}bps (${slipCount} fills) — threshold ${WARN_SLIPPAGE_BPS}bps`,
        });
        if (worstLevel < 1) worstLevel = 1;
      }
    }

    // ── Stale activity ──
    const lastRow = q6Rows.find(r => r[0] === alloc.id);
    if (lastRow && lastRow[1]) {
      const lastAt = new Date(lastRow[1]);
      const hoursSince = (Date.now() - lastAt.getTime()) / 3600000;
      if (hoursSince > WARN_STALE_HOURS) {
        results.push({
          label: `${walletShort} Stale`,
          status: 'WARN',
          message: `No trades for ${hoursSince.toFixed(1)}h (last: ${lastRow[1]})`,
        });
        if (worstLevel < 1) worstLevel = 1;
      }
    } else if (!lastRow) {
      results.push({
        label: `${walletShort} Activity`,
        status: 'INFO',
        message: 'No trades recorded yet',
      });
    }

    // ── Config summary ──
    results.push({
      label: `${walletShort} Config`,
      status: 'INFO',
      message: `copy=${(alloc.copyTradePercent * 100).toFixed(0)}% maxPos=$${alloc.maxPositionUsd} maxPred=$${alloc.maxPredictionPositionUsd} minBuy=$${alloc.minBuyPrice} copySells=${alloc.copySells} gate=${alloc.majorityOnlyMode}`,
    });
  }

  return { results, worstLevel };
}

// ─── Main ───

function main() {
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  console.log('============================================================');
  console.log(`LIVE MONITOR — ${now} UTC`);
  console.log('============================================================');
  console.log('');

  let raw: string;
  try {
    raw = runQueries();
  } catch (err: any) {
    console.error('[ALERT] Failed to connect to production');
    console.error(err.message || err);
    process.exit(2);
  }

  const { results, worstLevel } = evaluate(raw);

  for (const r of results) {
    const tag = `[${r.status}]`.padEnd(8);
    console.log(`${tag}${r.label}: ${r.message}`);
  }

  const resultLabel = worstLevel === 2 ? 'STOPPED' : worstLevel === 1 ? 'WARN' : 'PASS';
  console.log('');
  console.log(`RESULT: ${resultLabel}`);

  process.exit(worstLevel);
}

main();
