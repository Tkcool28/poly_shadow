import { prisma } from '../lib/prisma';

export async function showScores(options: { top: number }) {
  const scores = await prisma.traderScore.findMany({
    orderBy: { compositeScore: 'desc' },
    take: options.top,
    include: {
      trader: { select: { userName: true, isMonitored: true, backfillStatus: true } },
    },
  });

  if (scores.length === 0) {
    console.log('No scores calculated yet. Run the score calculator first.');
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
    '30d PnL'.padEnd(14) +
    'Mon',
  );
  console.log('-'.repeat(114));

  for (const s of scores) {
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
      `$${s.recentPnl30d.toFixed(0)}`.padEnd(14) +
      (s.trader.isMonitored ? 'YES' : ''),
    );
  }

  // Category breakdown for top trader
  if (scores.length > 0) {
    const topWallet = scores[0].proxyWallet;
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
