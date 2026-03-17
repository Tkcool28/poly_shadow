#!/usr/bin/env tsx
/**
 * Scalp Strategy Analyzer
 *
 * Reads observation data from ScalpSignalLog / ScalpTradeLog and recommends
 * strategy parameters based on historical signal quality, stop-loss sweeps,
 * imbalance correlation, and volume correlation.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-analyze.ts [--since 2h] [--format json|text]
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';

// ─── CLI Args ───

const args = process.argv.slice(2);
const sinceArg = args.find(a => a.startsWith('--since'))?.split('=')[1] || args[args.indexOf('--since') + 1] || '24h';
const formatArg = args.find(a => a.startsWith('--format'))?.split('=')[1] || args[args.indexOf('--format') + 1] || 'text';

function parseDuration(s: string): number {
  const num = parseFloat(s);
  if (s.endsWith('h')) return num * 3600_000;
  if (s.endsWith('m')) return num * 60_000;
  if (s.endsWith('d')) return num * 86400_000;
  return num * 3600_000; // default hours
}

async function main() {
  const sinceMs = parseDuration(sinceArg);
  const since = new Date(Date.now() - sinceMs);

  // 1. Load signals
  const signals = await prisma.scalpSignalLog.findMany({
    where: { signalAt: { gte: since } },
    orderBy: { signalAt: 'desc' },
  });

  // 2. Load trade log stats
  const tradeCount = await prisma.scalpTradeLog.count({
    where: { receivedAt: { gte: since } },
  });

  // 3. Signal quality analysis
  // For signals that have at least priceAt30s filled in:
  const completedSignals = signals.filter(s => s.priceAt30s !== null);

  // Confidence bands
  const bands = [
    { name: '0.0-0.3 (LOW)', min: 0, max: 0.3 },
    { name: '0.3-0.6 (MED)', min: 0.3, max: 0.6 },
    { name: '0.6-1.0 (HIGH)', min: 0.6, max: 1.0 },
  ];

  const bandStats = bands.map(band => {
    const inBand = completedSignals.filter(s =>
      (s.confidenceScore ?? 0) >= band.min && (s.confidenceScore ?? 0) < band.max
    );
    if (inBand.length === 0) return { ...band, count: 0, winAt30s: 0, winAt1m: 0, winAt5m: 0, winAt10m: 0, avgMaxMove: 0, avgMinMove: 0 };

    const winAt30s = inBand.filter(s => s.priceAt30s !== null && s.priceAt30s > s.priceAtSignal).length / inBand.length;
    const with1m = inBand.filter(s => s.priceAt1m !== null);
    const winAt1m = with1m.length > 0 ? with1m.filter(s => s.priceAt1m! > s.priceAtSignal).length / with1m.length : 0;
    const with5m = inBand.filter(s => s.priceAt5m !== null);
    const winAt5m = with5m.length > 0 ? with5m.filter(s => s.priceAt5m! > s.priceAtSignal).length / with5m.length : 0;
    const with10m = inBand.filter(s => s.priceAt10m !== null);
    const winAt10m = with10m.length > 0 ? with10m.filter(s => s.priceAt10m! > s.priceAtSignal).length / with10m.length : 0;

    const withMax = inBand.filter(s => s.maxPriceAfter !== null);
    const avgMaxMove = withMax.length > 0
      ? withMax.reduce((sum, s) => sum + (s.maxPriceAfter! - s.priceAtSignal) * 100, 0) / withMax.length
      : 0;
    const withMin = inBand.filter(s => s.minPriceAfter !== null);
    const avgMinMove = withMin.length > 0
      ? withMin.reduce((sum, s) => sum + (s.priceAtSignal - s.minPriceAfter!) * 100, 0) / withMin.length
      : 0;

    return { ...band, count: inBand.length, winAt30s, winAt1m, winAt5m, winAt10m, avgMaxMove, avgMinMove };
  });

  // 4. Optimal stop-loss sweep
  // For each signal with minPriceAfter and maxPriceAfter, simulate entry at priceAtSignal
  const tradeable = completedSignals.filter(s => s.maxPriceAfter !== null && s.minPriceAfter !== null);
  const stopLossResults: { cents: number; netPnlCents: number; trades: number; wins: number }[] = [];

  for (let stopCents = 1; stopCents <= 20; stopCents++) {
    let totalPnl = 0;
    let wins = 0;
    for (const s of tradeable) {
      const mae = (s.priceAtSignal - s.minPriceAfter!) * 100; // max adverse excursion in cents
      const mfe = (s.maxPriceAfter! - s.priceAtSignal) * 100; // max favorable excursion in cents

      if (mae >= stopCents) {
        // Stop loss triggered
        totalPnl -= stopCents;
      } else if (mfe > 0) {
        // Would have won - assume capture half the MFE
        totalPnl += mfe * 0.5;
        wins++;
      }
      // else: neither triggered, assume flat
    }
    stopLossResults.push({ cents: stopCents, netPnlCents: totalPnl, trades: tradeable.length, wins });
  }

  // Floor at 5c — sub-5c stop-losses trigger on natural bid fluctuation and stop out every trade
  const viableResults = stopLossResults.filter(r => r.cents >= 5);
  const bestStopLoss = viableResults.reduce((best, r) => r.netPnlCents > best.netPnlCents ? r : best, viableResults[0]);

  // 5. Order flow imbalance correlation
  const imbalanceBuckets = [
    { name: '0.3-0.5', min: 0.3, max: 0.5 },
    { name: '0.5-0.7', min: 0.5, max: 0.7 },
    { name: '0.7+', min: 0.7, max: 2.0 },
  ];

  const imbalanceStats = imbalanceBuckets.map(bucket => {
    const inBucket = completedSignals.filter(s => s.netImbalance >= bucket.min && s.netImbalance < bucket.max);
    const wonCount = inBucket.filter(s => s.wouldHaveWon === true).length;
    return { ...bucket, count: inBucket.length, winRate: inBucket.length > 0 ? wonCount / inBucket.length : 0 };
  });

  // 6. Volume analysis
  const volumeBuckets = [
    { name: '$50-100', min: 50, max: 100 },
    { name: '$100-500', min: 100, max: 500 },
    { name: '$500+', min: 500, max: 999999 },
  ];

  const volumeStats = volumeBuckets.map(bucket => {
    const inBucket = completedSignals.filter(s => s.buyVolumeUsd >= bucket.min && s.buyVolumeUsd < bucket.max);
    const wonCount = inBucket.filter(s => s.wouldHaveWon === true).length;
    return { ...bucket, count: inBucket.length, winRate: inBucket.length > 0 ? wonCount / inBucket.length : 0 };
  });

  // 7. Paper trader report
  const capital = await prisma.scalpCapital.findFirst({ where: { isPaper: true } });
  const recentCycles = await prisma.scalpCycle.findMany({
    where: { isPaper: true, status: { notIn: ['SKIPPED'] }, createdAt: { gte: since } },
  });
  const exitMethodBreakdown = recentCycles.reduce((acc, c) => {
    const method = c.exitMethod ?? c.status;
    acc[method] = (acc[method] ?? 0) + 1;
    return acc;
  }, {} as Record<string, number>);

  // 8. Recommended parameters
  const recommended = {
    SCALP_MIN_NET_IMBALANCE: 0.30, // default unless data shows otherwise
    SCALP_STOP_LOSS_CENTS: bestStopLoss?.cents ?? 15,
    SCALP_TRAILING_STOP_CENTS: 5,
    SCALP_CONVERGENCE_SELL_TIMEOUT_MS: 180000,
    SCALP_MIN_EDGE_CENTS: 3,
  };

  // If we have enough data, refine
  if (completedSignals.length >= 10) {
    // Find imbalance threshold with best win rate
    const bestImbalance = imbalanceStats.reduce((best, b) => b.winRate > best.winRate ? b : best, imbalanceStats[0]);
    if (bestImbalance.winRate > 0.5) {
      recommended.SCALP_MIN_NET_IMBALANCE = bestImbalance.min;
    }
  }

  // ─── Output ───

  if (formatArg === 'json') {
    const output = {
      period: { since: since.toISOString(), sinceArg },
      trades: { total: tradeCount },
      signals: { total: signals.length, completed: completedSignals.length },
      bandStats,
      stopLossAnalysis: { best: bestStopLoss, sweep: stopLossResults },
      imbalanceStats,
      volumeStats,
      paperTrader: capital ? {
        currentCapital: capital.currentCapital,
        totalPnl: capital.totalPnl,
        totalCycles: capital.totalCycles,
        totalWins: capital.totalWins,
        winRate: capital.totalCycles > 0 ? capital.totalWins / capital.totalCycles : 0,
        exitMethods: exitMethodBreakdown,
      } : null,
      recommended,
    };
    console.log(JSON.stringify(output, null, 2));
  } else {
    // Text output
    console.log(`\n=== SCALP ANALYSIS (since ${sinceArg} ago) ===\n`);
    console.log(`Trades logged: ${tradeCount}`);
    console.log(`Signals detected: ${signals.length} (${completedSignals.length} with price data)\n`);

    if (completedSignals.length === 0) {
      console.log('Insufficient data — no signals with price snapshots yet.');
      console.log('  Observer needs more time to collect signals + price outcomes.\n');
    } else {
      console.log('Signal Quality by Confidence Band:');
      console.log('Band          | Count | Win@30s | Win@1m | Win@5m | Win@10m | AvgUp(c) | AvgDown(c)');
      console.log('-'.repeat(90));
      for (const b of bandStats) {
        if (b.count === 0) continue;
        console.log(
          `${b.name.padEnd(14)}| ${String(b.count).padEnd(6)}| ${(b.winAt30s*100).toFixed(0).padStart(5)}%  | ${(b.winAt1m*100).toFixed(0).padStart(4)}%  | ${(b.winAt5m*100).toFixed(0).padStart(4)}%  | ${(b.winAt10m*100).toFixed(0).padStart(5)}%  | ${b.avgMaxMove.toFixed(1).padStart(7)}  | ${b.avgMinMove.toFixed(1).padStart(9)}`
        );
      }

      console.log('\nStop-Loss Sweep (simulated):');
      console.log('Stop(c) | Net PnL(c) | Win/Total');
      console.log('-'.repeat(40));
      for (const r of stopLossResults.filter((_, i) => i % 2 === 0 || i === (bestStopLoss?.cents ?? 0) - 1)) {
        const marker = r.cents === bestStopLoss?.cents ? ' <- BEST' : '';
        console.log(`${String(r.cents).padStart(5)}c  | ${r.netPnlCents.toFixed(1).padStart(9)}  | ${r.wins}/${r.trades}${marker}`);
      }

      console.log('\nImbalance Correlation:');
      for (const b of imbalanceStats) {
        if (b.count === 0) continue;
        console.log(`  ${b.name}: ${b.count} signals, ${(b.winRate*100).toFixed(0)}% win rate`);
      }

      console.log('\nVolume Correlation:');
      for (const b of volumeStats) {
        if (b.count === 0) continue;
        console.log(`  ${b.name}: ${b.count} signals, ${(b.winRate*100).toFixed(0)}% win rate`);
      }
    }

    if (capital) {
      console.log(`\nPaper Trader:`);
      console.log(`  Capital: $${capital.currentCapital.toFixed(2)} / $${capital.initialCapital.toFixed(2)}`);
      console.log(`  PnL: $${capital.totalPnl.toFixed(2)} (${capital.totalWins}W / ${capital.totalCycles}T)`);
      console.log(`  Exit methods: ${JSON.stringify(exitMethodBreakdown)}`);
    }

    console.log(`\nRecommended Parameters:`);
    for (const [key, val] of Object.entries(recommended)) {
      console.log(`  ${key}=${val}`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Analysis failed:', err.message);
  process.exit(1);
});
