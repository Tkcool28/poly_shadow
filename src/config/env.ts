import 'dotenv/config';
import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must not be empty'),
  LEADERBOARD_SCAN_INTERVAL_MS: z.coerce.number().default(43200000),
  BACKFILL_POLL_INTERVAL_MS: z.coerce.number().default(60000),
  SCORE_RECALC_INTERVAL_MS: z.coerce.number().default(21600000),
  TRADE_MONITOR_INTERVAL_MS: z.coerce.number().default(120000),
  TOP_N_THRESHOLD: z.coerce.number().default(20),
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
  MAX_POSITION_USD: z.coerce.number().default(50),
  MAX_DAILY_LOSS_USD: z.coerce.number().default(200),
  MAX_OPEN_POSITIONS: z.coerce.number().default(20),
  MAX_TRADE_PERCENT: z.coerce.number().default(0.50), // Max 50% of allocation per trade
  PORTFOLIO_VALUE_REFRESH_MS: z.coerce.number().default(300000), // 5 min
  SLIPPAGE_BPS: z.coerce.number().default(200), // 2% default

  // Paper trade fee simulation (Polymarket formula: C × feeRate × (p × (1-p))^exponent)
  PAPER_TRADE_FEE_RATE: z.coerce.number().default(0), // 0 = no fees (most markets)
  PAPER_TRADE_FEE_EXPONENT: z.coerce.number().default(1), // 1 = sports, 2 = crypto
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
