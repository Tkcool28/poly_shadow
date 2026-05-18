#!/usr/bin/env tsx
/**
 * Post-Deploy Health Monitor
 *
 * Checks 11 production health metrics for a copy-trade allocation after deploy.
 *
 * Runs a SINGLE SSH session to production to avoid rate limiting, pipes all
 * SQL queries in one psql invocation, then parses results in Node.
 *
 * Required env:
 *   ALLOCATION_ID    Follow-allocation row id (e.g. fa_<wallet>_live_<ts>)
 *   WATCHED_WALLET   Trader proxy wallet address being copied
 *   DEPLOY_SSH_HOST  SSH host alias of the production box
 *   DEPLOY_PG_USER   Postgres role
 *   DEPLOY_PG_DB     Postgres database name
 *   DEPLOY_PG_CONTAINER  docker container name running postgres
 *
 * Usage:
 *   ALLOCATION_ID=... WATCHED_WALLET=0x... \
 *   DEPLOY_SSH_HOST=... DEPLOY_PG_USER=... DEPLOY_PG_DB=... DEPLOY_PG_CONTAINER=... \
 *   npx tsx src/scripts/post-deploy-monitor.ts
 *
 * Exit codes: 0 = PASS, 1 = WARN, 2 = ALERT
 */

import { execSync } from 'child_process';

const ALLOCATION_ID = process.env.ALLOCATION_ID ?? '';
const WATCHED_WALLET = process.env.WATCHED_WALLET ?? '';
const DEPLOY_SSH_HOST = process.env.DEPLOY_SSH_HOST ?? '';
const DEPLOY_PG_USER = process.env.DEPLOY_PG_USER ?? '';
const DEPLOY_PG_DB = process.env.DEPLOY_PG_DB ?? '';
const DEPLOY_PG_CONTAINER = process.env.DEPLOY_PG_CONTAINER ?? '';

const required = { ALLOCATION_ID, WATCHED_WALLET, DEPLOY_SSH_HOST, DEPLOY_PG_USER, DEPLOY_PG_DB, DEPLOY_PG_CONTAINER };
for (const [k, v] of Object.entries(required)) {
  if (!v) { console.error(`Missing required env: ${k}`); process.exit(2); }
}

// Validate wallet format — value is interpolated into a SQL string below
if (!/^0x[a-fA-F0-9]{40}$/.test(WATCHED_WALLET)) {
  console.error('WATCHED_WALLET must be a 0x-prefixed 40-hex-char EVM address');
  process.exit(2);
}

// ─── Run all queries in a single SSH + psql session ───

function runQueries(): string {
  const sql = `
-- Q1: FAK cooldown blocks (20min)
SELECT 'Q1', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status = 'SKIPPED' AND "failReason" = 'buy failure cooldown active';

-- Q2: CLOB rate limiting (20min)
SELECT 'Q2', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND "failReason" LIKE '%HTTP 429%';

-- Q3: WR trending (2h settled BUYs)
SELECT 'Q3',
       COUNT(*) FILTER (WHERE "settlementPnl" > 0),
       COUNT(*)
FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND status = 'SETTLED' AND side = 'BUY'
  AND "settledAt" > NOW() - INTERVAL '2 hours';

-- Q4: Capital check
SELECT 'Q4', "currentCapital"::numeric(10,2) FROM "FollowAllocation"
WHERE id = '${ALLOCATION_ID}';

-- Q5: FAK reject spike (20min)
SELECT 'Q5', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status = 'SKIPPED' AND "failReason" LIKE 'CLOB rejected%FAK%';

-- Q6: Signal age blocks (20min)
SELECT 'Q6', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status = 'SKIPPED' AND "failReason" LIKE 'signal too old%';

-- Q7: Position sizing config
SELECT 'Q7', "maxPositionUsd"::numeric(10,2), "maxPredictionPositionUsd"::numeric(10,2)
FROM "FollowAllocation" WHERE id = '${ALLOCATION_ID}';

-- Q8: Majority gate health (20min)
SELECT 'Q8', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status = 'SKIPPED' AND "failReason" LIKE 'majority accumulating%';

-- Q9: Filled trades count (20min)
SELECT 'Q9', COUNT(*) FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status IN ('FILLED', 'SETTLED') AND side = 'BUY';

-- Q10: SELL drain waste — any SELLs leaking past pre-filter?
SELECT 'Q10',
  COUNT(*) FILTER (WHERE side = 'SELL' AND "failReason" NOT LIKE 'pre-filtered%' AND "failReason" NOT LIKE 'CHAIN_MAKER pre-filtered%') as leaked,
  COUNT(*) FILTER (WHERE side = 'SELL' AND ("failReason" LIKE 'pre-filtered%' OR "failReason" LIKE 'CHAIN_MAKER pre-filtered%')) as batch_skipped
FROM "CopyTrade"
WHERE "followAllocationId" = '${ALLOCATION_ID}'
  AND "isPaper" = false AND "createdAt" > NOW() - INTERVAL '20 minutes'
  AND status = 'SKIPPED';

-- Q11: RAPID_POLL disabled? (should be zero for copyMakerFills wallets)
SELECT 'Q11', COUNT(*) FROM "DetectedTrade"
WHERE "proxyWallet" = '${WATCHED_WALLET}'
  AND "detectionSource" = 'RAPID_POLL'
  AND "detectedAt" > NOW() - INTERVAL '20 minutes';
`;

  const result = execSync(`ssh ${DEPLOY_SSH_HOST} bash -s <<'OUTER'
docker exec -i ${DEPLOY_PG_CONTAINER} psql -U ${DEPLOY_PG_USER} -d ${DEPLOY_PG_DB} -t -A -F'|' <<'EOSQL'
${sql}
EOSQL
OUTER`, { encoding: 'utf-8', timeout: 30000 });

  return result;
}

// ─── Parse results ───

interface CheckResult {
  label: string;
  status: 'PASS' | 'WARN' | 'ALERT' | 'INFO';
  message: string;
}

function parseResults(raw: string): CheckResult[] {
  const lines = raw.trim().split('\n').filter(l => l.startsWith('Q'));
  const results: CheckResult[] = [];

  const getRow = (tag: string): string[] => {
    const line = lines.find(l => l.startsWith(tag + '|'));
    if (!line) return [];
    return line.split('|').slice(1);
  };

  // Q1: FAK cooldown blocks
  {
    const count = parseInt(getRow('Q1')[0] || '0', 10);
    let status: CheckResult['status'] = 'PASS';
    if (count > 5) status = 'ALERT';
    results.push({
      label: 'FAK cooldown blocks',
      status,
      message: `${count} (threshold: ≤5)`,
    });
  }

  // Q2: CLOB rate limiting
  {
    const count = parseInt(getRow('Q2')[0] || '0', 10);
    let status: CheckResult['status'] = 'PASS';
    if (count > 0) status = 'ALERT';
    results.push({
      label: 'CLOB rate limiting',
      status,
      message: `${count} (threshold: 0)`,
    });
  }

  // Q3: WR trending
  {
    const row = getRow('Q3');
    const wins = parseInt(row[0] || '0', 10);
    const total = parseInt(row[1] || '0', 10);
    const losses = total - wins;
    let wr = 0;
    if (total > 0) wr = (wins / total) * 100;
    let status: CheckResult['status'] = 'PASS';
    if (total > 0 && wr < 50) status = 'ALERT';
    else if (total > 0 && wr < 55) status = 'WARN';
    const wrStr = total > 0 ? `${wr.toFixed(1)}% (${wins}W/${losses}L)` : 'no data';
    results.push({
      label: 'WR (2h)',
      status: total === 0 ? 'INFO' : status,
      message: `${wrStr} (WARN <55%, ALERT <50%)`,
    });
  }

  // Q4: Capital check
  {
    const capital = parseFloat(getRow('Q4')[0] || '0');
    let status: CheckResult['status'] = 'PASS';
    if (capital < 10) status = 'WARN';
    results.push({
      label: 'Capital',
      status,
      message: `$${capital.toFixed(2)} (WARN <$10)`,
    });
  }

  // Q5: FAK reject spike
  {
    const count = parseInt(getRow('Q5')[0] || '0', 10);
    let status: CheckResult['status'] = 'INFO';
    if (count > 50) status = 'ALERT';
    results.push({
      label: 'FAK rejects',
      status,
      message: `${count} (ALERT >50)`,
    });
  }

  // Q6: Signal age blocks
  {
    const count = parseInt(getRow('Q6')[0] || '0', 10);
    results.push({
      label: 'Signal age blocks',
      status: 'INFO',
      message: `${count} (was ~30/20min pre-deploy)`,
    });
  }

  // Q7: Position sizing config
  {
    const row = getRow('Q7');
    const maxTrade = parseFloat(row[0] || '0');
    const maxPred = parseFloat(row[1] || '0');
    const expected = maxTrade === 8.0 && maxPred === 30.0;
    results.push({
      label: 'Config',
      status: expected ? 'PASS' : 'WARN',
      message: expected
        ? `maxTrade=$${maxTrade.toFixed(0)}, maxPred=$${maxPred.toFixed(0)} ✓`
        : `maxTrade=$${maxTrade.toFixed(2)}, maxPred=$${maxPred.toFixed(2)} — EXPECTED $8/$30`,
    });
  }

  // Q8: Majority gate health
  {
    const count = parseInt(getRow('Q8')[0] || '0', 10);
    let status: CheckResult['status'] = 'PASS';
    if (count > 100) status = 'WARN';
    results.push({
      label: 'Majority gate',
      status,
      message: `${count} accumulating (WARN >100)`,
    });
  }

  // Q9: Filled trades count
  {
    const count = parseInt(getRow('Q9')[0] || '0', 10);
    results.push({
      label: 'Filled trades',
      status: 'INFO',
      message: `${count}`,
    });
  }

  // Q10: SELL drain waste
  {
    const row = getRow('Q10');
    const leaked = parseInt(row[0] || '0', 10);
    const batchSkipped = parseInt(row[1] || '0', 10);
    results.push({
      label: 'SELL drain leak',
      status: leaked > 0 ? 'WARN' : 'PASS',
      message: leaked > 0
        ? `${leaked} SELLs leaked past pre-filter (${batchSkipped} batch-skipped)`
        : `0 leaked, ${batchSkipped} batch-skipped ✓`,
    });
  }

  // Q11: RAPID_POLL disabled
  {
    const count = parseInt(getRow('Q11')[0] || '0', 10);
    results.push({
      label: 'RAPID_POLL disabled',
      status: count > 0 ? 'ALERT' : 'PASS',
      message: count > 0
        ? `${count} RAPID_POLL signals detected — should be 0`
        : `0 signals ✓`,
    });
  }

  return results;
}

// ─── Main ───

function main() {
  const now = new Date().toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');

  console.log('============================================================');
  console.log(`POST-DEPLOY HEALTH CHECK — ${now} UTC`);
  console.log(`Allocation: ${ALLOCATION_ID} | Window: 20min`);
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

  const results = parseResults(raw);

  let worstLevel = 0; // 0=PASS, 1=WARN, 2=ALERT

  for (const r of results) {
    const tag = `[${r.status}]`.padEnd(8);
    console.log(`${tag}${r.label}: ${r.message}`);

    if (r.status === 'ALERT' && worstLevel < 2) worstLevel = 2;
    if (r.status === 'WARN' && worstLevel < 1) worstLevel = 1;
  }

  const resultLabel = worstLevel === 2 ? 'ALERT' : worstLevel === 1 ? 'WARN' : 'PASS';
  console.log('');
  console.log(`RESULT: ${resultLabel}`);

  process.exit(worstLevel);
}

main();
