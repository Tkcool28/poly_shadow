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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
