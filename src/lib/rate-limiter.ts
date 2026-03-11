import Bottleneck from 'bottleneck';

// Rate limiters for Polymarket API endpoints
// Bottleneck uses fixed-window reservoir refresh; minTime provides burst protection against Cloudflare's sliding window
// Two processes share the Cloudflare budget (trade-monitor + history-backfiller), so per-process reservoir is halved

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
  reservoir: 100,                    // halved for 2-process split (trade-monitor + backfiller)
  reservoirRefreshInterval: 10000,
  reservoirRefreshAmount: 100,
  maxConcurrent: 15,                 // 7 rapid-poll wallets + headroom for bulk POLL
  minTime: 75,                       // 75ms between request starts = ~13.3 req/s max per process
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
