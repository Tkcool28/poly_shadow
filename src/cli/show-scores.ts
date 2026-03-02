import { prisma } from '../lib/prisma';

export async function showScores(options: { top: number; filter: boolean }) {
  const scores = await prisma.traderScore.findMany({
    where: options.filter
      ? {
          recentPnl30d: { gte: 100 },
          winRate: { gte: 0.70 },
          totalMarkets: { gte: 100 },
        }
      : undefined,
    orderBy: { compositeScore: 'desc' },
    // Fetch extra to allow post-filter trimming
    take: options.filter ? options.top * 3 : options.top,
    include: {
      trader: { select: { userName: true, isMonitored: true, backfillStatus: true } },
    },
  });

  if (scores.length === 0) {
    console.log('No scores calculated yet. Run the score calculator first.');
    return;
  }

  // Compute 7d PnL from closed positions for filtered traders
  let pnl7dMap = new Map<string, number>();
  if (options.filter) {
    const sevenDaysAgo = Math.floor(Date.now() / 1000) - 7 * 86400;
    const wallets = scores.map(s => s.proxyWallet);

    const results = await prisma.closedPosition.groupBy({
      by: ['proxyWallet'],
      where: {
        proxyWallet: { in: wallets },
        timestamp: { gte: sevenDaysAgo },
        avgPrice: { lt: 0.98 },
      },
      _sum: { realizedPnl: true },
    });

    for (const r of results) {
      pnl7dMap.set(r.proxyWallet, r._sum.realizedPnl ?? 0);
    }
  }

  // Post-filter: exclude traders with negative 7d PnL when filtering
  const filtered = options.filter
    ? scores.filter(s => (pnl7dMap.get(s.proxyWallet) ?? 0) > 0).slice(0, options.top)
    : scores;

  if (filtered.length === 0) {
    console.log('No traders match the current filter criteria.');
    return;
  }

  console.log(`\nTop ${options.top} Traders by Composite Score:\n`);
  console.log(
    '#'.padEnd(4) +
    'Wallet'.padEnd(14) +
    'Name'.padEnd(18) +
    'Score'.padEnd(8) +
    'PnL'.padEnd(14) +
    'ROI'.padEnd(9) +
    'WinRate'.padEnd(9) +
    'Trades'.padEnd(8) +
    'MaxDD'.padEnd(8) +
    '7d PnL'.padEnd(12) +
    '30d PnL'.padEnd(14) +
    'Mon',
  );
  console.log('-'.repeat(126));

  for (const s of filtered) {
    const pnl7d = pnl7dMap.get(s.proxyWallet) ?? 0;
    console.log(
      (s.rank?.toString() ?? '-').padEnd(4) +
      s.proxyWallet.slice(0, 12).padEnd(14) +
      (s.trader.userName ?? '-').slice(0, 16).padEnd(18) +
      s.compositeScore.toFixed(3).padEnd(8) +
      `$${s.totalPnl.toFixed(0)}`.padEnd(14) +
      `${(s.roi * 100).toFixed(1)}%`.padEnd(9) +
      `${(s.winRate * 100).toFixed(1)}%`.padEnd(9) +
      s.totalTrades.toString().padEnd(8) +
      `${(s.maxDrawdown * 100).toFixed(1)}%`.padEnd(8) +
      `$${pnl7d.toFixed(0)}`.padEnd(12) +
      `$${s.recentPnl30d.toFixed(0)}`.padEnd(14) +
      (s.trader.isMonitored ? 'YES' : ''),
    );
  }

  // Category breakdown for top trader
  if (filtered.length > 0) {
    const topWallet = filtered[0].proxyWallet;
    const catScores = await prisma.categoryScore.findMany({
      where: { proxyWallet: topWallet },
      orderBy: { totalTrades: 'desc' },
    });

    if (catScores.length > 0) {
      console.log(`\nCategory Breakdown for #1 (${topWallet.slice(0, 12)}):`);
      for (const cs of catScores) {
        console.log(
          `  ${cs.category.padEnd(12)} | ` +
          `PnL: $${cs.pnl.toFixed(0).padStart(10)} | ` +
          `WR: ${(cs.winRate * 100).toFixed(0)}% | ` +
          `Trades: ${cs.totalTrades} | ` +
          `Spec: ${(cs.specializationScore * 100).toFixed(0)}%`,
        );
      }
    }
  }
}
