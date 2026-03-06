import { describe, it, expect } from 'vitest';
import { computeCompositeScores } from './composite';

function makeTrader(wallet: string, overrides: Record<string, number> = {}) {
  return {
    proxyWallet: wallet,
    roi: 0.1, totalPnl: 100, avgProfitPerTrade: 5, winRate: 0.6,
    returnStdDev: 10, maxDrawdown: 0.3, totalTrades: 50, totalMarkets: 10,
    tradeFrequency: 2, concentrationScore: 0.2, avgRelativePositionSize: 0.1,
    recentPnl30d: 50, recentWinRate30d: 0.6, trendDirection: 0.5,
    ...overrides,
  };
}

describe('computeCompositeScores', () => {
  it('no-data trader does not outscore active trader on inverted metrics', () => {
    const active = makeTrader('0xactive');
    const noData = makeTrader('0xnodata', {
      totalTrades: 0, returnStdDev: 0, maxDrawdown: 0,
      concentrationScore: 0, avgRelativePositionSize: 0,
      roi: 0, totalPnl: 0, avgProfitPerTrade: 0, winRate: 0,
      totalMarkets: 0, tradeFrequency: 0, recentPnl30d: 0,
      recentWinRate30d: 0, trendDirection: 0,
    });

    const results = computeCompositeScores([active, noData]);
    const activeScore = results.find(r => r.proxyWallet === '0xactive')!;
    const noDataScore = results.find(r => r.proxyWallet === '0xnodata')!;
    expect(activeScore.compositeScore).toBeGreaterThan(noDataScore.compositeScore);
  });

  it('low drawdown with sufficient trades still beats high drawdown', () => {
    const lowDD = makeTrader('0xlowdd', { maxDrawdown: 0.01, totalTrades: 100 });
    const highDD = makeTrader('0xhighdd', { maxDrawdown: 0.9, totalTrades: 100 });

    const results = computeCompositeScores([lowDD, highDD]);
    const lowResult = results.find(r => r.proxyWallet === '0xlowdd')!;
    const highResult = results.find(r => r.proxyWallet === '0xhighdd')!;
    expect(lowResult.compositeScore).toBeGreaterThan(highResult.compositeScore);
  });
});
