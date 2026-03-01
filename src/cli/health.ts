import { prisma } from '../lib/prisma';
import { formatDistanceToNow } from 'date-fns';

const EXPECTED_INTERVALS: Record<string, number> = {
  'leaderboard-scanner': 12 * 60 * 60 * 1000, // 12h
  'history-backfiller': 2 * 60 * 1000, // 2 min (daemon)
  'score-calculator': 6 * 60 * 60 * 1000, // 6h
  'trade-monitor': 3 * 60 * 1000, // 3 min (daemon, slight buffer)
};

export async function showHealth() {
  const healthRecords = await prisma.systemHealth.findMany({
    orderBy: { jobName: 'asc' },
  });

  const traderStats = await prisma.trader.groupBy({
    by: ['backfillStatus'],
    _count: true,
  });

  const monitoredCount = await prisma.trader.count({ where: { isMonitored: true } });
  const totalTraders = await prisma.trader.count();
  const totalTrades = await prisma.trade.count();
  const totalMarkets = await prisma.market.count();
  const detectedTrades = await prisma.detectedTrade.count();

  console.log('\n=== System Health ===\n');

  // Job status
  console.log('Jobs:');
  console.log(
    'Job'.padEnd(22) +
    'Last Run'.padEnd(22) +
    'Duration'.padEnd(12) +
    'Result'.padEnd(10) +
    'Count'.padEnd(8) +
    'Status',
  );
  console.log('-'.repeat(85));

  const now = Date.now();

  for (const h of healthRecords) {
    const lastRunAgo = formatDistanceToNow(h.lastRunAt, { addSuffix: true });
    const durationStr = h.lastRunDuration < 1000
      ? `${h.lastRunDuration}ms`
      : `${(h.lastRunDuration / 1000).toFixed(1)}s`;

    const expectedInterval = EXPECTED_INTERVALS[h.jobName];
    const timeSinceRun = now - h.lastRunAt.getTime();
    let status = 'OK';
    if (expectedInterval && timeSinceRun > expectedInterval * 2) {
      status = 'STALE!';
    }
    if (h.lastRunResult === 'error') {
      status = 'ERROR!';
    }

    console.log(
      h.jobName.padEnd(22) +
      lastRunAgo.padEnd(22) +
      durationStr.padEnd(12) +
      h.lastRunResult.padEnd(10) +
      h.processedCount.toString().padEnd(8) +
      status,
    );

    if (h.errorMessage) {
      console.log(`  Error: ${h.errorMessage.slice(0, 100)}`);
    }
  }

  // Check for missing jobs
  const expectedJobs = Object.keys(EXPECTED_INTERVALS);
  const existingJobs = new Set(healthRecords.map(h => h.jobName));
  for (const job of expectedJobs) {
    if (!existingJobs.has(job)) {
      console.log(`${job.padEnd(22)}${'never'.padEnd(22)}${'-'.padEnd(12)}${'-'.padEnd(10)}${'-'.padEnd(8)}NEVER RUN`);
    }
  }

  // Trader stats
  console.log('\nTraders:');
  console.log(`  Total: ${totalTraders}`);
  console.log(`  Monitored: ${monitoredCount}`);
  for (const stat of traderStats) {
    console.log(`  ${stat.backfillStatus}: ${stat._count}`);
  }

  // Failed backfills
  const failedTraders = await prisma.trader.findMany({
    where: { backfillStatus: { in: ['FAILED', 'PERMANENTLY_FAILED'] } },
    select: { proxyWallet: true, backfillStatus: true, backfillError: true, backfillRetries: true },
    take: 5,
  });

  if (failedTraders.length > 0) {
    console.log('\nFailed Backfills:');
    for (const t of failedTraders) {
      console.log(
        `  ${t.proxyWallet.slice(0, 12)} | ${t.backfillStatus} | ` +
        `Retries: ${t.backfillRetries} | ${t.backfillError?.slice(0, 60) ?? 'no error'}`,
      );
    }
  }

  // Data stats
  console.log('\nData:');
  console.log(`  Trades stored: ${totalTrades.toLocaleString()}`);
  console.log(`  Markets cached: ${totalMarkets}`);
  console.log(`  Detected trades: ${detectedTrades}`);
}
