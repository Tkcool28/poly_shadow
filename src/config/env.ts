import 'dotenv/config';
import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must not be empty'),
  LEADERBOARD_SCAN_INTERVAL_MS: z.coerce.number().default(43200000),
  BACKFILL_POLL_INTERVAL_MS: z.coerce.number().default(60000),
  SCORE_RECALC_INTERVAL_MS: z.coerce.number().default(21600000),
  TRADE_MONITOR_INTERVAL_MS: z.coerce.number().default(120000),
  PROXY_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  PROXY_LIST: z.string().default(''),
  DATA_API_BASE_URL: z.string().default('https://data-api.polymarket.com'),
  GAMMA_API_BASE_URL: z.string().default('https://gamma-api.polymarket.com'),
  LEADERBOARD_CATEGORIES: z.string().default('OVERALL,POLITICS,SPORTS,CRYPTO,CULTURE'),
  LEADERBOARD_TIME_PERIODS: z.string().default('WEEK,MONTH,ALL'),
  LEADERBOARD_LIMIT: z.coerce.number().default(50),
  DATA_RETENTION_DAYS: z.coerce.number().default(90),
  LOG_LEVEL: z.string().default('info'),

  // Arb filtering: exclude trades/positions entered at >= this price from scoring
  ARB_FILTER_PRICE: z.coerce.number().min(0.90).max(1.0).default(0.98),

  // Pre-screening thresholds
  PRESCREEN_MIN_PNL: z.coerce.number().default(0),
  PRESCREEN_MIN_VOLUME: z.coerce.number().default(1000),
  PRESCREEN_MIN_POSITIONS: z.coerce.number().default(10),
  PRESCREEN_MIN_WIN_RATE: z.coerce.number().default(0.45),
  PRESCREEN_CONCURRENCY: z.coerce.number().default(10),

  // WebSocket
  WS_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  WS_RECONNECT_MAX_MS: z.coerce.number().default(30000),
  WS_FALLBACK_POLL_MS: z.coerce.number().default(300000), // 5 min

  // Copy-trade wallet credentials (required when COPY_TRADE_ENABLED=true)
  PRIVATE_KEY: z.string().optional(),
  CLOB_API_KEY: z.string().optional(),
  CLOB_API_SECRET: z.string().optional(),
  CLOB_API_PASSPHRASE: z.string().optional(),
  FUNDER_ADDRESS: z.string().optional(),
  SIGNATURE_TYPE: z.coerce.number().default(2), // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE

  // Copy-trade risk controls
  COPY_TRADE_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  MAX_POSITION_USD: z.coerce.number().min(1).max(10000).default(50),
  MAX_DAILY_LOSS_USD: z.coerce.number().min(1).max(100000).default(200),
  MAX_TRADE_PERCENT: z.coerce.number().min(0.01).max(1.0).default(0.50), // Max 50% of allocation per trade
  PORTFOLIO_VALUE_REFRESH_MS: z.coerce.number().default(300000), // 5 min
  SLIPPAGE_BPS: z.coerce.number().min(10).max(1000).default(200), // 2% default

  // Order aggregation pool
  POOL_MIN_AMOUNT_USD: z.coerce.number().min(0.01).max(100).default(0.10), // min to execute (matches current threshold)
  POOL_BURN_TIMEOUT_MS: z.coerce.number().default(180000), // 3 min per-entry FIFO burn window

  // Position settlement
  SETTLEMENT_SWEEP_INTERVAL_MS: z.coerce.number().default(300000), // 5 minutes
  STALE_TRADE_CUTOFF_MS: z.coerce.number().default(600000), // 10 min (was hardcoded 5 min)
  MIN_SELL_USD: z.coerce.number().min(0).default(0.01), // Skip dust sells below this

  // Paper trade fee simulation (Polymarket formula: C × feeRate × (p × (1-p))^exponent)
  PAPER_TRADE_FEE_RATE: z.coerce.number().default(0), // 0 = no fees (most markets)
  PAPER_TRADE_FEE_EXPONENT: z.coerce.number().default(1), // 1 = sports, 2 = crypto

  // ─── Arb Worker (BTC Up/Down last-minute strategy) ───
  ARB_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ARB_IS_PAPER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  ARB_ASSETS: z.string().default('btc'),      // comma-sep: btc,eth,sol,xrp
  ARB_MARKET_TYPES: z.string().default('5m'), // comma-sep: 5m,15m,1h,4h

  // Capital (separate from copy-trade)
  ARB_INITIAL_CAPITAL_USD: z.coerce.number().min(1).default(1000),
  ARB_POSITION_SIZE_USD: z.coerce.number().min(1).max(50000).default(500),
  ARB_MAX_DAILY_LOSS_USD: z.coerce.number().min(1).default(50),

  // Strategy
  ARB_MAX_ENTRY_PRICE: z.coerce.number().min(0.90).max(0.999).default(0.99),
  ARB_MIN_PRICE_CHANGE: z.coerce.number().default(0.0001), // 0.01% min BTC move
  ARB_MAX_CONSECUTIVE_LOSSES: z.coerce.number().min(1).default(5),

  // Settlement sweep (background, non-blocking)
  ARB_SETTLEMENT_SWEEP_INTERVAL_MS: z.coerce.number().default(10000),  // 10s sweep cadence
  ARB_SETTLEMENT_TIMEOUT_MS: z.coerce.number().default(600000),        // 10-min resolution timeout

  // Fees (crypto 5/15-min markets)
  ARB_FEE_RATE: z.coerce.number().default(0.25),
  ARB_FEE_EXPONENT: z.coerce.number().default(2),

  // Optional separate wallet (if unset, shares copy-trade wallet)
  ARB_PRIVATE_KEY: z.string().optional(),
  ARB_CLOB_API_KEY: z.string().optional(),
  ARB_CLOB_API_SECRET: z.string().optional(),
  ARB_CLOB_API_PASSPHRASE: z.string().optional(),
  ARB_FUNDER_ADDRESS: z.string().optional(),
  ARB_SIGNATURE_TYPE: z.coerce.number().default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
