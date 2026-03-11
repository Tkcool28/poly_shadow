import Bottleneck from 'bottleneck';

// Rate limiters matching Polymarket's documented 10-second sliding windows
// Each endpoint group has its own limiter chained to the general API limiter

const dataApiGeneral = new Bottleneck({
  reservoir: 1000,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 1000,
  maxConcurrent: 20, // accommodate parallel rapid-poll + other concurrent requests
});

const dataApiPositions = new Bottleneck({
  reservoir: 150,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 150,
  maxConcurrent: 5,
});
dataApiPositions.chain(dataApiGeneral);

const dataApiTrades = new Bottleneck({
  reservoir: 200,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 200,
  maxConcurrent: 15, // 9 rapid-poll wallets + headroom for bulk POLL
});
dataApiTrades.chain(dataApiGeneral);

const dataApiLeaderboard = new Bottleneck({
  reservoir: 200,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 200,
  maxConcurrent: 5,
});
dataApiLeaderboard.chain(dataApiGeneral);

const gammaApiGeneral = new Bottleneck({
  reservoir: 300,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 300,
  maxConcurrent: 5,
});

const gammaApiMarkets = new Bottleneck({
  reservoir: 300,
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 300,
  maxConcurrent: 5,
});
gammaApiMarkets.chain(gammaApiGeneral);

// Map URL paths to the appropriate limiter
const LIMITER_MAP: Record<string, Bottleneck> = {
  '/positions': dataApiPositions,
  '/closed-positions': dataApiPositions,
  '/trades': dataApiTrades,
  '/v1/leaderboard': dataApiLeaderboard,
  '/activity': dataApiGeneral,
  '/value': dataApiGeneral,
  '/traded': dataApiGeneral,
  '/holders': dataApiGeneral,
  '/markets': gammaApiMarkets,
  '/events': gammaApiGeneral,
};

export function getRateLimiter(path: string): Bottleneck {
  // Match the longest prefix
  for (const [prefix, limiter] of Object.entries(LIMITER_MAP)) {
    if (path.startsWith(prefix)) {
      return limiter;
    }
  }
  // Default to general data API limiter
  return dataApiGeneral;
}
