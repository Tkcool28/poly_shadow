import { prisma } from '../lib/prisma';

type SortField = 'score' | 'pnl' | 'winRate' | 'trades';

export async function listTraders(options: { sort: SortField; limit: number }) {
  const orderBy: Record<string, any> = {
    score: { scores: { _count: 'desc' } },
    pnl: { leaderboardPnl: 'desc' },
    trades: { leaderboardVol: 'desc' },
  };

  const traders = await prisma.trader.findMany({
    take: options.limit,
    include: {
      scores: { select: { compositeScore: true, totalPnl: true, winRate: true, totalTrades: true, rank: true } },
    },
    orderBy: options.sort === 'score'
      ? { scores: { _count: 'desc' } }
      : options.sort === 'pnl'
        ? { leaderboardPnl: { sort: 'desc', nulls: 'last' } }
        : { leaderboardVol: { sort: 'desc', nulls: 'last' } },
  });

  // If sorting by score/winRate/trades, sort in-memory based on TraderScore
  let sorted = traders;
  if (options.sort === 'score' || options.sort === 'winRate' || options.sort === 'trades') {
    sorted = [...traders].sort((a, b) => {
      const aScore = a.scores[0];
      const bScore = b.scores[0];
      if (!aScore && !bScore) return 0;
      if (!aScore) return 1;
      if (!bScore) return -1;

      switch (options.sort) {
        case 'score': return bScore.compositeScore - aScore.compositeScore;
        case 'winRate': return bScore.winRate - aScore.winRate;
        case 'trades': return bScore.totalTrades - aScore.totalTrades;
        default: return 0;
      }
    });
  }

  console.log(`\nTracked Traders (${sorted.length} shown, sorted by ${options.sort}):\n`);
  console.log(
    'Wallet'.padEnd(14) +
    'Name'.padEnd(18) +
    'Status'.padEnd(12) +
    'Mon'.padEnd(5) +
    'Score'.padEnd(8) +
    'Rank'.padEnd(6) +
    'PnL'.padEnd(14) +
    'WinRate'.padEnd(9) +
    'Trades',
  );
  console.log('-'.repeat(100));

  for (const t of sorted) {
    const s = t.scores[0];
    console.log(
      t.proxyWallet.slice(0, 12).padEnd(14) +
      (t.userName ?? '-').slice(0, 16).padEnd(18) +
      t.backfillStatus.slice(0, 10).padEnd(12) +
      (t.isMonitored ? 'YES' : '').padEnd(5) +
      (s ? s.compositeScore.toFixed(3) : '-').toString().padEnd(8) +
      (s?.rank?.toString() ?? '-').padEnd(6) +
      (s ? `$${s.totalPnl.toFixed(0)}` : '-').padEnd(14) +
      (s ? `${(s.winRate * 100).toFixed(1)}%` : '-').padEnd(9) +
      (s?.totalTrades?.toString() ?? '-'),
    );
  }
}
