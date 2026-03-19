#!/usr/bin/env tsx
/**
 * Single-Trader Backtest — Backtests a specific trader over a time window
 *
 * Uses the shared simulation engine (lib/backtest-engine.ts) with:
 *   - Time window filtering (--hours / --days)
 *   - DB allocation config resolution (or CLI overrides)
 *   - Open market mark-to-market for recent windows
 *   - Per-prediction breakdown
 *   - Prior trade warm-up for majority gate
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 aws_ireland_dockerapps
 *   npx tsx src/scripts/backtest-single-trader.ts --trader 0x8dxd --hours 24
 *   npx tsx src/scripts/backtest-single-trader.ts --trader LampStore --days 7 --exclude-slugs ""
 */

import { parseArgs } from 'util';
import { writeFileSync } from 'fs';
import type { TradeRow } from './lib/backtest-engine';
import { simulateCopy } from './lib/backtest-engine';
import { connectBacktestDb, calibrateFromProduction } from './lib/backtest-db';
import { COMMON_FLAGS, buildSimConfig, pad, rpad, getTimeWindow, type AllocRow } from './lib/backtest-cli';

const { values: args } = parseArgs({
  options: {
    ...COMMON_FLAGS,
    trader: { type: 'string', default: '0x8dxd' },
  },
});

// Default to 24h if no time window specified
if (!args.hours && !args.days) args.hours = '24';

const TRADER_INPUT = args.trader ?? '0x8dxd';
const VERBOSE = args.verbose ?? false;
const OUTPUT_FILE = args.output ?? '';

async function main() {
  const db = await connectBacktestDb();
  console.log('Connected to production DB (Ireland)');

  // Resolve trader wallet + allocation config
  let proxyWallet: string;
  let allocConfig: AllocRow | null = null;

  const allocResult = await db.query(`
    SELECT "proxyWallet", id, "initialCapital", "currentCapital", "deployedCapital",
           "copyTradePercent", "maxPositionUsd", "maxPredictionPositionUsd",
           "minBuyPrice", "excludeEventSlugPatterns", "majorityOnlyMode", "copyMakerFills"
    FROM "FollowAllocation"
    WHERE id LIKE $1 OR "proxyWallet" LIKE $1
    LIMIT 1
  `, [`%${TRADER_INPUT}%`]);

  if (allocResult.rows.length > 0) {
    const row = allocResult.rows[0];
    allocConfig = {
      copyTradePercent: row.copyTradePercent,
      maxPositionUsd: row.maxPositionUsd,
      maxPredictionPositionUsd: row.maxPredictionPositionUsd,
      minBuyPrice: row.minBuyPrice,
      excludeEventSlugPatterns: row.excludeEventSlugPatterns,
      majorityOnlyMode: row.majorityOnlyMode,
      currentCapital: row.currentCapital,
    };
    proxyWallet = row.proxyWallet;
    console.log(`Found allocation: ${row.id}`);
  } else {
    const traderResult = await db.query(`
      SELECT "proxyWallet", "userName" FROM "Trader"
      WHERE "proxyWallet" LIKE $1 OR "userName" ILIKE $1
      LIMIT 1
    `, [`%${TRADER_INPUT}%`]);
    if (traderResult.rows.length === 0) {
      console.error(`Trader not found: ${TRADER_INPUT}`);
      process.exit(1);
    }
    proxyWallet = traderResult.rows[0].proxyWallet;
    console.log(`Found trader: ${traderResult.rows[0].userName} (${proxyWallet})`);
  }

  // Time window
  const timeWindow = getTimeWindow(args as Record<string, string | boolean | undefined>);
  const cutoffTs = timeWindow?.cutoffTs ?? 0;

  // Calibration
  const useEmpirical = !args['no-empirical-slippage'];
  const calibration = await calibrateFromProduction(db, useEmpirical);

  // Build config from CLI + DB allocation
  const simConfig = buildSimConfig(
    args as Record<string, string | boolean | undefined>,
    calibration,
    allocConfig,
    {
      trackPredictions: true,
      includeOpenMarkets: true,
    },
  );

  const windowLabel = timeWindow
    ? `${timeWindow.days > 0 ? `${timeWindow.days} days` : `${timeWindow.hours} hours`} (since ${new Date(cutoffTs * 1000).toISOString()})`
    : 'full history';

  console.log(`\nConfig from prod DB allocation:`);
  console.log(`  copyPercent=${simConfig.copyPercent} maxTrade=$${simConfig.maxTradeUsd} maxPred=$${simConfig.maxPredUsd}`);
  console.log(`  minBuyPrice=$${simConfig.minBuyPrice} majorityGate=$${simConfig.majorityGate} bothSides=${simConfig.bothSides} followSells=${simConfig.followSells}`);
  console.log(`  excludeSlugs=[${simConfig.excludeSlugs.join(',')}] startingCapital=$${simConfig.startingCapital.toFixed(0)}`);
  console.log(`  capitalLockup=${simConfig.useCapitalLockup} seed=${simConfig.seed}`);
  console.log(`  Window: ${windowLabel}`);

  // Fetch trades (include open markets for recent windows)
  console.log(`\nFetching trades...`);
  const tradeQuery = timeWindow
    ? `SELECT t."conditionId", t.outcome, t."outcomeIndex",
             t.price, t.size, t.timestamp, t.side, t."eventSlug",
             m.question, m."outcomePrices", m.outcomes, m."endDate", m.closed
       FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
       WHERE t."proxyWallet" = $1 AND t.timestamp >= $2
       ORDER BY t.timestamp ASC`
    : `SELECT t."conditionId", t.outcome, t."outcomeIndex",
             t.price, t.size, t.timestamp, t.side, t."eventSlug",
             m.question, m."outcomePrices", m.outcomes, m."endDate", m.closed
       FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
       WHERE t."proxyWallet" = $1
       ORDER BY t.timestamp ASC`;
  const tradeParams = timeWindow ? [proxyWallet, cutoffTs] : [proxyWallet];
  const tradeResult = await db.query(tradeQuery, tradeParams);

  console.log(`Fetched ${tradeResult.rows.length} trades in window`);

  const trades: TradeRow[] = tradeResult.rows.map((r: any) => ({
    conditionId: r.conditionId,
    outcome: r.outcome || '',
    outcomeIndex: r.outcomeIndex != null ? parseInt(r.outcomeIndex) : null,
    price: parseFloat(r.price) || 0,
    size: parseFloat(r.size) || 0,
    timestamp: parseInt(r.timestamp) || 0,
    side: r.side || '',
    eventSlug: r.eventSlug || '',
    question: r.question || '',
    outcomePrices: r.outcomePrices || '[]',
    outcomes: r.outcomes || '[]',
    endDate: r.endDate ? Math.floor(new Date(r.endDate).getTime() / 1000) : null,
    closed: r.closed ?? false,
  }));

  // Fetch prior trades for majority gate warm-up
  let priorTrades: TradeRow[] | undefined;
  if (simConfig.majorityGate > 0 && timeWindow) {
    const priorResult = await db.query(`
      SELECT t."conditionId", t.outcome, t.price, t.size, t.side, t."eventSlug"
      FROM "Trade" t
      WHERE t."proxyWallet" = $1
        AND t.timestamp < $2
        AND t."conditionId" IN (
          SELECT DISTINCT "conditionId" FROM "Trade"
          WHERE "proxyWallet" = $1 AND timestamp >= $2
        )
    `, [proxyWallet, cutoffTs]);
    console.log(`Fetched ${priorResult.rows.length} prior trades for majority gate warm-up`);
    priorTrades = priorResult.rows.map((r: any) => ({
      conditionId: r.conditionId,
      outcome: r.outcome || '',
      outcomeIndex: null,
      price: parseFloat(r.price) || 0,
      size: parseFloat(r.size) || 0,
      timestamp: 0,
      side: r.side || '',
      eventSlug: r.eventSlug || '',
      outcomePrices: '[]',
      outcomes: '[]',
      endDate: null,
    }));
  }

  // Run simulation
  const result = simulateCopy(trades, simConfig, priorTrades);

  // Count trader activity
  const sellCount = trades.filter(t => t.side === 'SELL').length;
  const buyCountAfterSlug = result.skips.slug > 0
    ? trades.filter(t => t.side === 'BUY').length - result.skips.slug - sellCount
    : trades.filter(t => t.side === 'BUY').length;

  // ─── Output ───
  console.log(`\n${'='.repeat(100)}`);
  console.log(`SINGLE-TRADER BACKTEST — ${proxyWallet.slice(0, 10)}... | ${timeWindow ? (timeWindow.days > 0 ? `${timeWindow.days}d` : `${timeWindow.hours}h`) : 'full'} window`);
  console.log(`${'='.repeat(100)}`);

  console.log(`\nTrader activity in window:`);
  console.log(`  Total trades: ${trades.length} (${sellCount} sells)`);
  console.log(`  Unique predictions: ${new Set(trades.map(t => t.conditionId)).size}`);

  console.log(`\nCopy simulation results:`);
  console.log(`  Copy buys executed: ${result.copyBuys}`);
  console.log(`  Capital deployed: $${result.copyDeployed.toFixed(2)}`);
  console.log(`  PnL: ${result.copyPnl >= 0 ? '+' : ''}$${result.copyPnl.toFixed(2)} (ROI: ${result.copyRoi.toFixed(1)}%)`);
  console.log(`  Win rate: ${result.copyWr.toFixed(1)}% (${result.wins}W / ${result.losses}L)`);
  console.log(`  Max drawdown: $${result.copyMaxDd.toFixed(2)} (${result.copyMaxDdPct.toFixed(1)}% of capital)`);
  console.log(`  Sharpe: ${result.copySharpe.toFixed(2)} | Day WR: ${result.dayWr.toFixed(0)}% | Category: ${result.mainCategory} | Crypto: ${result.cryptoPct.toFixed(0)}%`);

  console.log(`\nSkip reasons:`);
  console.log(`  Slug excluded: ${result.skips.slug}`);
  console.log(`  Price filter: ${result.skips.price}`);
  console.log(`  Majority gate: ${result.skips.gate}`);
  console.log(`  Pred limit: ${result.skips.pred}`);
  console.log(`  FAK failure: ${result.skips.fak}`);
  console.log(`  Capital: ${result.skips.capital}`);

  // Per-prediction breakdown
  const predResults = result.predictions
    .filter(p => p.copyBuys > 0)
    .sort((a, b) => b.copyPnl - a.copyPnl);

  if (predResults.length > 0) {
    console.log(`\n${'='.repeat(100)}`);
    console.log(`PER-PREDICTION BREAKDOWN (${predResults.length} predictions copied)`);
    console.log(`${'='.repeat(100)}`);

    console.log(`${pad('Question', 55)} ${rpad('TrBuys', 7)} ${rpad('TrBuy$', 8)} ${rpad('CpBuys', 7)} ${rpad('Cp$', 8)} ${rpad('PnL', 9)} ${rpad('ROI%', 7)} ${pad('Won?', 6)} ${pad('Status', 8)}`);
    console.log('-'.repeat(120));

    for (const p of predResults) {
      const roi = p.copyDeployed > 0 ? p.copyPnl / p.copyDeployed * 100 : 0;
      const wonStr = p.outcomeWon === null ? '?' : p.outcomeWon ? 'YES' : 'NO';
      const statusStr = p.marketClosed ? 'CLOSED' : 'OPEN';
      console.log(
        `${pad(p.question || p.conditionId.slice(0, 55), 55)} ${rpad(String(p.traderBuys), 7)} ${rpad('$' + p.traderBuyUsd.toFixed(0), 8)} ` +
        `${rpad(String(p.copyBuys), 7)} ${rpad('$' + p.copyDeployed.toFixed(1), 8)} ` +
        `${rpad((p.copyPnl >= 0 ? '+$' : '-$') + Math.abs(p.copyPnl).toFixed(1), 9)} ` +
        `${rpad(roi.toFixed(0) + '%', 7)} ${pad(wonStr, 6)} ${pad(statusStr, 8)}`
      );
    }

    const closedPreds = predResults.filter(p => p.marketClosed);
    const openPreds = predResults.filter(p => !p.marketClosed);
    const closedPnl = closedPreds.reduce((s, p) => s + p.copyPnl, 0);
    const openPnl = openPreds.reduce((s, p) => s + p.copyPnl, 0);

    console.log(`\nClosed market PnL: ${closedPnl >= 0 ? '+' : ''}$${closedPnl.toFixed(2)} (${closedPreds.length} predictions)`);
    console.log(`Open market PnL (mark-to-market): ${openPnl >= 0 ? '+' : ''}$${openPnl.toFixed(2)} (${openPreds.length} predictions)`);
  }

  if (VERBOSE) {
    const allPreds = result.predictions.sort((a, b) => b.traderBuyUsd - a.traderBuyUsd);
    console.log(`\n${'='.repeat(100)}`);
    console.log(`ALL PREDICTIONS (${allPreds.length} total, including non-copied)`);
    console.log(`${'='.repeat(100)}`);
    for (const p of allPreds.slice(0, 50)) {
      const copiedStr = p.copyBuys > 0 ? `COPIED ${p.copyBuys}x $${p.copyDeployed.toFixed(0)}` : 'NOT COPIED';
      console.log(`  ${(p.question || p.conditionId.slice(0, 60)).slice(0, 60).padEnd(62)} Tr:${p.traderBuys}B/${p.traderSells}S $${p.traderBuyUsd.toFixed(0)} | ${copiedStr}`);
    }
  }

  // CSV output
  if (OUTPUT_FILE) {
    const csvHeaders = ['question', 'conditionId', 'eventSlug', 'traderBuys', 'traderBuyUsd', 'copyBuys', 'copyDeployed', 'copyPnl', 'roi', 'outcomeWon', 'marketClosed'];
    const csvRows = predResults.map(p => [
      `"${(p.question || '').replace(/"/g, '""')}"`,
      p.conditionId, p.eventSlug,
      p.traderBuys, p.traderBuyUsd.toFixed(2),
      p.copyBuys, p.copyDeployed.toFixed(2), p.copyPnl.toFixed(2),
      p.copyDeployed > 0 ? (p.copyPnl / p.copyDeployed * 100).toFixed(1) : '0',
      p.outcomeWon ?? '', p.marketClosed,
    ].join(','));
    writeFileSync(OUTPUT_FILE, [csvHeaders.join(','), ...csvRows].join('\n'));
    console.log(`\nResults saved to ${OUTPUT_FILE}`);
  }

  await db.end();
}

main().catch(e => { console.error(e); process.exit(1); });
