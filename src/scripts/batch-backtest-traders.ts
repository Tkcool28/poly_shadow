#!/usr/bin/env tsx
/**
 * Batch Backtest Pipeline — Backtests ALL completed traders from DB
 *
 * Uses the shared simulation engine (lib/backtest-engine.ts) with full fidelity:
 *   - Capital lockup, slug exclusion, empirical slippage/FAK, net position tracking
 *   - Sharpe on returns, per-prediction breakdown (--verbose)
 *   - Independent flags: --both-sides, --follow-sells, --no-majority (or --follow-all for all 3)
 *
 * Usage:
 *   ssh -f -N -L 15438:localhost:5438 $PROD_SSH_HOST
 *   npx tsx src/scripts/batch-backtest-traders.ts [--limit N] [--min-positions 20] [--gate 175]
 *   npx tsx src/scripts/batch-backtest-traders.ts --exclude-slugs "" --min-buy-price 0.40 --no-capital-lockup
 *   npx tsx src/scripts/batch-backtest-traders.ts --trader LampStore --hours 24 --verbose
 *   npx tsx src/scripts/batch-backtest-traders.ts --follow-all --min-days 30
 *   npx tsx src/scripts/batch-backtest-traders.ts --both-sides --follow-sells   # independent flags
 */

import { parseArgs } from 'util';
import { writeFileSync } from 'fs';
import type { TradeRow, SimResult } from './lib/backtest-engine';
import { simulateCopy, categorize } from './lib/backtest-engine';
import { connectBacktestDb, calibrateFromProduction } from './lib/backtest-db';
import { COMMON_FLAGS, buildSimConfig, pad, rpad, getTimeWindow } from './lib/backtest-cli';

const { values: args } = parseArgs({
  options: {
    ...COMMON_FLAGS,
    trader: { type: 'string', default: '' },
    limit: { type: 'string', default: '1000' },
    'min-positions': { type: 'string', default: '20' },
    'min-trader-roi': { type: 'string', default: '0' },
    'min-copy-buys': { type: 'string', default: '10' },
    'min-days': { type: 'string', default: '0' },
  },
});

const TRADER_FILTER = args.trader ?? '';
const LIMIT = parseInt(args.limit ?? '1000', 10);
const MIN_POSITIONS = parseInt(args['min-positions'] ?? '20', 10);
const MIN_TRADER_ROI = parseFloat(args['min-trader-roi'] ?? '0');
const MIN_COPY_BUYS = parseInt(args['min-copy-buys'] ?? '10', 10);
const MIN_DAYS = parseInt(args['min-days'] ?? '0', 10);
const OUTPUT_FILE = args.output ?? '';
const VERBOSE = args.verbose ?? false;

interface TraderResult {
  wallet: string;
  name: string;
  trades: number;
  traderPnl: number;
  traderBought: number;
  traderRoi: number;
  traderWr: number;
  sim: SimResult;
}

async function main() {
  const db = await connectBacktestDb();
  console.log('Connected to production DB via SSH tunnel');

  const timeWindow = getTimeWindow(args as Record<string, string | boolean | undefined>);
  const useEmpirical = !args['no-empirical-slippage'];
  const calibration = await calibrateFromProduction(db, useEmpirical);
  const simConfig = buildSimConfig(
    args as Record<string, string | boolean | undefined>,
    calibration,
    null,
    {
      trackPredictions: VERBOSE,
      includeOpenMarkets: !!timeWindow || !!args['include-open'],
    },
  );

  // Log config
  const flags: string[] = [];
  if (simConfig.excludeSlugs.length > 0) flags.push(`slugExclude=[${simConfig.excludeSlugs.join(',')}]`);
  if (simConfig.useCapitalLockup) flags.push('capitalLockup=ON'); else flags.push('capitalLockup=OFF');
  if (useEmpirical) flags.push('empiricalSlippage=ON'); else flags.push('empiricalSlippage=OFF');
  if (simConfig.bothSides) flags.push('bothSides=ON');
  if (simConfig.followSells) flags.push('followSells=ON');
  if (timeWindow) flags.push(`window=${timeWindow.days > 0 ? `${timeWindow.days}d` : `${timeWindow.hours}h`}`);
  console.log(`Config: minBuyPrice=${simConfig.minBuyPrice} gate=$${simConfig.majorityGate === 0 ? 'OFF' : simConfig.majorityGate} ${flags.join(' ')}`);

  // Get traders
  let traderQuery: string;
  let traderParams: any[];

  if (TRADER_FILTER) {
    traderQuery = `
      SELECT t."proxyWallet", tr."userName", COUNT(*) as trade_count
      FROM "Trade" t
      JOIN "Trader" tr ON tr."proxyWallet" = t."proxyWallet"
      WHERE (tr."proxyWallet" LIKE $1 OR tr."userName" ILIKE $1)
      GROUP BY t."proxyWallet", tr."userName"
      ORDER BY COUNT(*) DESC LIMIT 1
    `;
    traderParams = [`%${TRADER_FILTER}%`];
  } else {
    traderQuery = `
      SELECT t."proxyWallet", tr."userName", COUNT(*) as trade_count
      FROM "Trade" t
      JOIN "Trader" tr ON tr."proxyWallet" = t."proxyWallet"
      WHERE tr."backfillStatus" = 'COMPLETED'
      GROUP BY t."proxyWallet", tr."userName"
      HAVING COUNT(*) >= $1
      ORDER BY COUNT(*) DESC LIMIT $2
    `;
    traderParams = [MIN_POSITIONS, LIMIT];
  }

  const traders = await db.query(traderQuery, traderParams);
  console.log(`Found ${traders.rows.length} traders${TRADER_FILTER ? ` matching "${TRADER_FILTER}"` : ` with >= ${MIN_POSITIONS} trades`}`);

  // Batch fetch official Polymarket P&L
  const wallets = traders.rows.map((r: any) => r.proxyWallet);
  console.log('Fetching official Polymarket P&L from ClosedPosition + Position tables...');

  const closedPnlResult = await db.query(`
    SELECT "proxyWallet",
           COALESCE(SUM("realizedPnl"), 0) as realized_pnl,
           COALESCE(SUM("totalBought"), 0) as total_bought,
           COUNT(*) as num_positions,
           COUNT(CASE WHEN "realizedPnl" > 0 THEN 1 END) as wins
    FROM "ClosedPosition"
    WHERE "proxyWallet" = ANY($1::text[])
    GROUP BY "proxyWallet"
  `, [wallets]);

  const openPnlResult = await db.query(`
    SELECT "proxyWallet",
           COALESCE(SUM("cashPnl"), 0) as unrealized_pnl,
           COALESCE(SUM("initialValue"), 0) as open_capital
    FROM "Position"
    WHERE "proxyWallet" = ANY($1::text[])
    GROUP BY "proxyWallet"
  `, [wallets]);

  const closedPnlMap = new Map<string, any>(closedPnlResult.rows.map((r: any) => [r.proxyWallet, r]));
  const openPnlMap = new Map<string, any>(openPnlResult.rows.map((r: any) => [r.proxyWallet, r]));

  const cappedTraders = closedPnlResult.rows.filter((r: any) => parseInt(r.num_positions) >= 10000);
  if (cappedTraders.length > 0) {
    console.log(`WARNING: ${cappedTraders.length} traders hit 10K ClosedPosition cap — realized PnL may be incomplete`);
  }
  console.log(`Loaded P&L for ${closedPnlResult.rows.length} traders (closed) + ${openPnlResult.rows.length} (open positions)`);

  const results: TraderResult[] = [];
  let processed = 0;

  const includeOpen = !!args['include-open'];

  for (const trader of traders.rows) {
    let tradeQuery: string;
    let tradeParams: any[];

    if (timeWindow) {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed, m.question
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND t.timestamp >= $2
         ORDER BY t.timestamp ASC`;
      tradeParams = [trader.proxyWallet, timeWindow.cutoffTs];
    } else if (includeOpen) {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed, m.question
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1
         ORDER BY t.timestamp ASC`;
      tradeParams = [trader.proxyWallet];
    } else {
      tradeQuery = `SELECT t."conditionId", t.outcome, t."outcomeIndex",
               t.price, t.size, t.timestamp, t.side, t."eventSlug",
               m."outcomePrices", m.outcomes, m."endDate", m.closed
         FROM "Trade" t JOIN "Market" m ON t."conditionId" = m."conditionId"
         WHERE t."proxyWallet" = $1 AND m.closed = true
         ORDER BY t.timestamp ASC`;
      tradeParams = [trader.proxyWallet];
    }
    const tradeResult = await db.query(tradeQuery, tradeParams);

    const trades: TradeRow[] = tradeResult.rows.map((r: any) => ({
      conditionId: r.conditionId,
      outcome: r.outcome || '',
      outcomeIndex: r.outcomeIndex != null ? parseInt(r.outcomeIndex) : null,
      price: parseFloat(r.price) || 0,
      size: parseFloat(r.size) || 0,
      timestamp: parseInt(r.timestamp) || 0,
      side: r.side || '',
      eventSlug: r.eventSlug || '',
      outcomePrices: r.outcomePrices || '[]',
      outcomes: r.outcomes || '[]',
      endDate: r.endDate ? Math.floor(new Date(r.endDate).getTime() / 1000) : null,
      closed: r.closed ?? true,
      ...(timeWindow || includeOpen ? { question: r.question || '' } : {}),
    }));

    // Trader stats
    const buyTrades = trades.filter(t => t.side === 'BUY');
    const traderBought = buyTrades.reduce((s, t) => s + t.size * t.price, 0);

    // Official P&L
    const closedData = closedPnlMap.get(trader.proxyWallet);
    const openData = openPnlMap.get(trader.proxyWallet);
    const realizedPnl = parseFloat(closedData?.realized_pnl ?? '0');
    const unrealizedPnl = parseFloat(openData?.unrealized_pnl ?? '0');
    const totalTraderCapital = parseFloat(closedData?.total_bought ?? '0') + parseFloat(openData?.open_capital ?? '0');
    const actualTraderPnl = realizedPnl + unrealizedPnl;
    const actualTraderRoi = totalTraderCapital > 0 ? actualTraderPnl / totalTraderCapital * 100 : 0;
    const numPositions = parseInt(closedData?.num_positions ?? '0');
    const traderWins = parseInt(closedData?.wins ?? '0');
    const traderWr = numPositions > 0 ? traderWins / numPositions * 100 : 0;

    const sim = simulateCopy(trades, simConfig);

    results.push({
      wallet: trader.proxyWallet,
      name: (trader.userName || trader.proxyWallet.slice(0, 10)).slice(0, 20),
      trades: trades.length,
      traderPnl: actualTraderPnl,
      traderBought,
      traderRoi: actualTraderRoi,
      traderWr,
      sim,
    });

    processed++;
    if (processed % 50 === 0) console.log(`  Processed ${processed}/${traders.rows.length}...`);
  }

  await db.end();

  const allCopyPositive = results.filter(r => r.sim.copyPnl > 0);
  const filteredOutByTraderRoi = allCopyPositive.filter(r => r.traderRoi < MIN_TRADER_ROI);
  const filteredOutByMinBuys = allCopyPositive.filter(r => r.traderRoi >= MIN_TRADER_ROI && r.sim.copyBuys < MIN_COPY_BUYS);
  const filteredOutByMinDays = allCopyPositive.filter(r => r.traderRoi >= MIN_TRADER_ROI && r.sim.copyBuys >= MIN_COPY_BUYS && r.sim.daysActive < MIN_DAYS);
  const profitable = allCopyPositive
    .filter(r => r.traderRoi >= MIN_TRADER_ROI)
    .filter(r => r.sim.copyBuys >= MIN_COPY_BUYS)
    .filter(r => r.sim.daysActive >= MIN_DAYS);
  const unprofitable = results.filter(r => r.sim.copyPnl <= 0);
  profitable.sort((a, b) => b.sim.score - a.sim.score);
  unprofitable.sort((a, b) => b.sim.copyPnl - a.sim.copyPnl);

  const lockupLabel = simConfig.useCapitalLockup ? 'lockup ON' : 'lockup OFF';
  const slippageLabel = simConfig.empiricalSlippage ? 'empirical slippage' : 'category slippage';
  console.log(`\n${'='.repeat(200)}`);
  const modeLabel = [
    simConfig.majorityGate === 0 ? 'gate=OFF' : `gate=$${simConfig.majorityGate}`,
    simConfig.bothSides ? 'bothSides' : '',
    simConfig.followSells ? 'followSells' : '',
  ].filter(Boolean).join(' ');
  console.log(`BATCH BACKTEST (Trade-level) — ${results.length} traders | ${lockupLabel} | ${slippageLabel} | FAK=${(simConfig.fakFailureRate*100).toFixed(0)}%+15s cd | Copy: ${(simConfig.copyPercent*100).toFixed(0)}%, $${simConfig.maxTradeUsd}/trade, $${simConfig.maxPredUsd}/pred, $${simConfig.startingCapital} cap, minBuy=$${simConfig.minBuyPrice} ${modeLabel} | minTraderROI=${MIN_TRADER_ROI}% minCpBuys=${MIN_COPY_BUYS} | PnL=ClosedPosition+Position | slugExclude=[${simConfig.excludeSlugs.join(',')}]`);
  console.log(`${'='.repeat(200)}\n`);

  const header =
    `${pad('Rank', 5)}${pad('Trader', 22)}${rpad('Trd', 6)}${rpad('TrROI%', 7)}${rpad('TrWR%', 7)}${rpad('ActPnL$', 11)}` +
    `${rpad('CpPnL$', 9)}${rpad('CpROI%', 8)}${rpad('HldWR%', 7)}${rpad('CpBuys', 7)}` +
    `${rpad('MaxDD%', 8)}${rpad('Sharpe', 8)}${rpad('DayWR%', 8)}` +
    `${rpad('Scalp%', 7)}${rpad('Score', 8)}` +
    `${rpad('$/day', 8)}${rpad('Days', 5)}${rpad('Cry%', 5)}${pad('  Category', 12)}`;

  console.log(`PROFITABLE TRADERS (${profitable.length}):`);
  console.log(header);
  console.log('-'.repeat(200));

  for (let i = 0; i < Math.min(profitable.length, 50); i++) {
    const r = profitable[i];
    const s = r.sim;
    const actPnlStr = (r.traderPnl >= 0 ? '+$' : '-$') + Math.abs(r.traderPnl).toFixed(0);
    console.log(
      `${pad(String(i + 1), 5)}${pad(r.name, 22)}` +
      `${rpad(String(r.trades), 6)}${rpad(r.traderRoi.toFixed(1), 7)}${rpad(r.traderWr.toFixed(1), 7)}${rpad(actPnlStr, 11)}` +
      `${rpad('$' + s.copyPnl.toFixed(0), 9)}${rpad(s.copyRoi.toFixed(1), 8)}${rpad(s.holdWr.toFixed(1), 7)}${rpad(String(s.copyBuys), 7)}` +
      `${rpad(s.copyMaxDdPct.toFixed(1), 8)}${rpad(s.copySharpe.toFixed(2), 8)}${rpad(s.dayWr.toFixed(0), 8)}` +
      `${rpad(s.scalpPct.toFixed(0), 7)}${rpad(s.score.toFixed(2), 8)}` +
      `${rpad('$' + s.pnlPerDay.toFixed(0), 8)}${rpad(String(s.daysActive), 5)}${rpad(s.cryptoPct.toFixed(0), 5)}${pad('  ' + s.mainCategory, 12)}`
    );
  }

  // Verbose: show per-prediction breakdown for top trader
  if (VERBOSE && profitable.length > 0) {
    const top = profitable[0];
    const preds = top.sim.predictions.filter(p => p.copyBuys > 0).sort((a, b) => b.copyPnl - a.copyPnl);
    if (preds.length > 0) {
      console.log(`\nPER-PREDICTION BREAKDOWN for ${top.name} (${preds.length} predictions copied):`);
      console.log(`${pad('Question', 55)} ${rpad('CpBuys', 7)} ${rpad('Cp$', 8)} ${rpad('PnL', 9)} ${rpad('ROI%', 7)} ${pad('Won?', 6)}`);
      console.log('-'.repeat(100));
      for (const p of preds.slice(0, 30)) {
        const roi = p.copyDeployed > 0 ? p.copyPnl / p.copyDeployed * 100 : 0;
        const wonStr = p.outcomeWon === null ? '?' : p.outcomeWon ? 'YES' : 'NO';
        console.log(
          `${pad(p.question || p.conditionId.slice(0, 55), 55)} ${rpad(String(p.copyBuys), 7)} ${rpad('$' + p.copyDeployed.toFixed(1), 8)} ` +
          `${rpad((p.copyPnl >= 0 ? '+$' : '-$') + Math.abs(p.copyPnl).toFixed(1), 9)} ${rpad(roi.toFixed(0) + '%', 7)} ${pad(wonStr, 6)}`
        );
      }
    }
  }

  const cryptoProfitable = profitable.filter(r => r.sim.cryptoPct > 50);

  console.log(`\n${'='.repeat(80)}`);
  console.log(`SUMMARY`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total traders tested: ${results.length}`);
  console.log(`Profitable (copyPnL>0, traderROI>=${MIN_TRADER_ROI}%, copyBuys>=${MIN_COPY_BUYS}, days>=${MIN_DAYS}): ${profitable.length} (${(profitable.length / results.length * 100).toFixed(1)}%)`);
  if (filteredOutByTraderRoi.length > 0) {
    console.log(`Filtered out (copyPnL>0 but traderROI<${MIN_TRADER_ROI}%): ${filteredOutByTraderRoi.length} traders`);
  }
  if (filteredOutByMinBuys.length > 0) {
    console.log(`Filtered out (copyPnL>0 but copyBuys<${MIN_COPY_BUYS}): ${filteredOutByMinBuys.length} traders`);
  }
  if (filteredOutByMinDays.length > 0) {
    console.log(`Filtered out (copyPnL>0 but daysActive<${MIN_DAYS}): ${filteredOutByMinDays.length} traders`);
  }
  console.log(`Unprofitable: ${unprofitable.length}`);
  console.log(`Profitable crypto traders: ${cryptoProfitable.length}`);
  const perfectWr = profitable.filter(r => r.sim.holdWr >= 100.0);
  if (perfectWr.length > 0 && !includeOpen) {
    console.log(`\n  WARNING: ${perfectWr.length} traders show 100% holdWR — likely survivorship bias from closed-only filter.`);
    console.log(`  Re-run with --include-open to include open market positions.`);
  }
  console.log(`\nTop 5 by composite score:`);
  for (const r of profitable.slice(0, 5)) {
    console.log(`  ${r.name}: Score=${r.sim.score.toFixed(2)} | CopyPnL=$${r.sim.copyPnl.toFixed(0)} | ActPnL=$${r.traderPnl.toFixed(0)} | HoldWR=${r.sim.holdWr.toFixed(1)}% | ${r.sim.mainCategory}`);
  }

  // CSV output
  if (OUTPUT_FILE) {
    const csvHeaders = [
      'rank','name','wallet','trades','actualPnl','actualRoi','traderWr',
      'copyPnl','copyRoi','holdWr','copyBuys','maxDdPct','sharpe','dayWr',
      'scalpPct','score','pnlPerDay','daysActive','cryptoPct','category'
    ];
    const allSorted = [...profitable, ...unprofitable];
    const csvRows = allSorted.map((r, i) => [
      i + 1, `"${r.name}"`, r.wallet, r.trades,
      r.traderPnl.toFixed(2), r.traderRoi.toFixed(2), r.traderWr.toFixed(1),
      r.sim.copyPnl.toFixed(2), r.sim.copyRoi.toFixed(1), r.sim.holdWr.toFixed(1),
      r.sim.copyBuys, r.sim.copyMaxDdPct.toFixed(1), r.sim.copySharpe.toFixed(2), r.sim.dayWr.toFixed(0),
      r.sim.scalpPct.toFixed(0), r.sim.score.toFixed(2), r.sim.pnlPerDay.toFixed(2),
      r.sim.daysActive, r.sim.cryptoPct.toFixed(0), r.sim.mainCategory
    ].join(','));
    writeFileSync(OUTPUT_FILE, [csvHeaders.join(','), ...csvRows].join('\n'));
    console.log(`\nResults saved to ${OUTPUT_FILE}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
