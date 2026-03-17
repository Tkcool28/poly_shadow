#!/usr/bin/env tsx
/**
 * Scalp Pipeline Dashboard
 *
 * Lightweight status overview for the scalp observer + worker pipeline.
 * Designed for `/loop 2h` monitoring — prints a compact summary and exits.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-dashboard.ts
 */

import 'dotenv/config';
import { prisma } from '../lib/prisma';

async function main() {
  const twoHoursAgo = new Date(Date.now() - 2 * 3600_000);

  // Job health
  const health = await prisma.systemHealth.findMany({
    where: { jobName: { in: ['scalp-observer', 'scalp-worker'] } },
  });
  const observerHealth = health.find(h => h.jobName === 'scalp-observer');
  const workerHealth = health.find(h => h.jobName === 'scalp-worker');

  const formatHealth = (h: typeof observerHealth) => {
    if (!h) return 'NOT RUNNING';
    const agoMs = Date.now() - h.lastRunAt.getTime();
    if (agoMs > 120_000) return `STALE (${Math.round(agoMs/60000)}min ago)`;
    return `alive (${Math.round(agoMs/1000)}s ago)`;
  };

  // Trade log stats
  const tradeCount = await prisma.scalpTradeLog.count({
    where: { receivedAt: { gte: twoHoursAgo } },
  });
  const totalTrades = await prisma.scalpTradeLog.count();

  // Signal stats
  const signals = await prisma.scalpSignalLog.findMany({
    where: { signalAt: { gte: twoHoursAgo } },
  });
  const signalsWithWin = signals.filter(s => s.wouldHaveWon === true).length;
  const signalsComplete = signals.filter(s => s.priceAt30s !== null).length;

  // Capital
  const capital = await prisma.scalpCapital.findFirst({ where: { isPaper: true } });

  // Recent cycles
  const cycles = await prisma.scalpCycle.findMany({
    where: { isPaper: true, status: { notIn: ['SKIPPED'] }, createdAt: { gte: twoHoursAgo } },
  });
  const wins = cycles.filter(c => (c.pnl ?? 0) > 0).length;
  const active = await prisma.scalpCycle.count({
    where: { status: 'ENTERED', isPaper: true },
  });

  // Output
  console.log('=== SCALP PIPELINE DASHBOARD ===');
  console.log(`Observer: ${formatHealth(observerHealth)} | Worker: ${formatHealth(workerHealth)}`);
  console.log(`Trades logged (2h): ${tradeCount} | total: ${totalTrades}`);
  console.log(`Signals (2h): ${signals.length} | complete: ${signalsComplete} | would-win: ${signalsWithWin}`);

  if (capital) {
    console.log(`Paper PnL: $${capital.totalPnl.toFixed(2)} | ${capital.totalWins}W/${capital.totalCycles}T | Capital: $${capital.currentCapital.toFixed(2)}/$${capital.initialCapital.toFixed(2)}`);
  } else {
    console.log('Paper trader: no capital record');
  }

  console.log(`Active positions: ${active} | Trades (2h): ${cycles.length} (${wins}W/${cycles.length - wins}L)`);

  // Top recent signal
  if (signals.length > 0) {
    const best = signals.reduce((b, s) => (s.confidenceScore ?? 0) > (b.confidenceScore ?? 0) ? s : b, signals[0]);
    const priceMove = best.maxPriceAfter ? ((best.maxPriceAfter - best.priceAtSignal) * 100).toFixed(1) : '?';
    console.log(`Top signal: ${best.slug ?? best.tokenId.slice(0,16)} (conf: ${(best.confidenceScore??0).toFixed(2)}, imb: ${best.netImbalance.toFixed(2)}, maxMove: ${priceMove}c)`);
  }

  await prisma.$disconnect();
}

main().catch(err => {
  console.error('Dashboard error:', err.message);
  process.exit(1);
});
