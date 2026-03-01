export const LEADERBOARD_CATEGORIES = [
  'OVERALL',
  'POLITICS',
  'SPORTS',
  'CRYPTO',
  'CULTURE',
  'MENTIONS',
  'WEATHER',
  'ECONOMICS',
  'TECH',
  'FINANCE',
] as const;

export const LEADERBOARD_TIME_PERIODS = ['DAY', 'WEEK', 'MONTH', 'ALL'] as const;

export const LEADERBOARD_ORDER_BY = ['PNL', 'VOL'] as const;

export const TRADE_SIDES = ['BUY', 'SELL'] as const;

export const ACTIVITY_TYPES = [
  'TRADE',
  'SPLIT',
  'MERGE',
  'REDEEM',
  'REWARD',
  'CONVERSION',
  'MAKER_REBATE',
] as const;

// Category normalization mapping from Gamma API categories to standard categories
export const CATEGORY_MAP: Record<string, string> = {
  'us-current-affairs': 'POLITICS',
  politics: 'POLITICS',
  'us-politics': 'POLITICS',
  'world-politics': 'POLITICS',
  sports: 'SPORTS',
  nba: 'SPORTS',
  nfl: 'SPORTS',
  mlb: 'SPORTS',
  soccer: 'SPORTS',
  crypto: 'CRYPTO',
  bitcoin: 'CRYPTO',
  ethereum: 'CRYPTO',
  culture: 'CULTURE',
  'pop-culture': 'CULTURE',
  entertainment: 'CULTURE',
  science: 'SCIENCE',
  weather: 'WEATHER',
  economics: 'ECONOMICS',
  finance: 'FINANCE',
  tech: 'TECH',
  technology: 'TECH',
};

export function normalizeCategory(raw: string | null | undefined): string {
  if (!raw) return 'OTHER';
  const lower = raw.toLowerCase();
  return CATEGORY_MAP[lower] ?? 'OTHER';
}

// Scoring weights
export const SCORING_WEIGHTS = {
  // Profitability (35%)
  roi: 0.15,
  totalPnl: 0.1,
  avgProfitPerTrade: 0.1,

  // Consistency (25%)
  winRate: 0.12,
  returnStdDev: 0.05, // inverted
  maxDrawdown: 0.08, // inverted

  // Activity (15%)
  totalTrades: 0.05,
  totalMarkets: 0.05,
  tradeFrequency: 0.05,

  // Risk (10%)
  concentrationScore: 0.05, // inverted
  avgRelativePositionSize: 0.05, // inverted

  // Recency (15%)
  recentPnl30d: 0.05,
  recentWinRate30d: 0.05,
  trendDirection: 0.05,
} as const;

// Metrics where lower = better (will be inverted in percentile ranking)
export const INVERTED_METRICS = [
  'returnStdDev',
  'maxDrawdown',
  'concentrationScore',
  'avgRelativePositionSize',
] as const;

// Minimum trades for full scoring (below this, 0.5x penalty)
export const MIN_TRADES_THRESHOLD = 10;

// Pre-screening
export const PRESCREEN_POSITIONS_LIMIT = 200;

// Backfill
export const MAX_BACKFILL_RETRIES = 3;
export const BACKFILL_LOCK_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
export const TRADES_PAGE_SIZE = 10000;
export const CLOSED_POSITIONS_PAGE_SIZE = 50;
export const POSITIONS_PAGE_SIZE = 500;

// Proxy
export const PROXY_MAX_CONSECUTIVE_ERRORS = 3;
export const PROXY_COOLDOWN_MS = 60 * 1000; // 60 seconds

// Job timeouts
export const JOB_MAX_RUNTIME_MS = 15 * 60 * 1000; // 15 minutes

// Wallet validation
export const WALLET_ADDRESS_REGEX = /^0x[a-fA-F0-9]{40}$/;
