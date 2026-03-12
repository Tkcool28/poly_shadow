import 'dotenv/config';
import { z } from 'zod/v4';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL must not be empty'),
  LEADERBOARD_SCAN_INTERVAL_MS: z.coerce.number().default(43200000),
  BACKFILL_POLL_INTERVAL_MS: z.coerce.number().default(60000),
  BACKFILL_REFRESH_AFTER_MS: z.coerce.number().default(604800000),  // 7 days
  BACKFILL_REFRESH_BATCH_SIZE: z.coerce.number().default(3),         // stale traders per idle cycle
  SCORE_RECALC_INTERVAL_MS: z.coerce.number().default(21600000),
  TRADE_MONITOR_INTERVAL_MS: z.coerce.number().default(900000),  // 15 min safety-net poll for all monitored traders
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
  LIVE_TRADERS_POLL_MS: z.coerce.number().default(500), // rapid-poll interval for live-allocation traders (primary signal source; 150ms on AWS, 500ms on Finland)
  RAPID_POLL_LIMIT: z.coerce.number().default(20), // API limit per wallet per rapid-poll cycle
  POLYGON_WS_RPC_URL: z.string().default('wss://polygon-bor-rpc.publicnode.com'),
  POLYGON_HTTP_RPC_URL: z.string().default('https://polygon-bor-rpc.publicnode.com'),
  POLYGON_WS_RPC_URL_B: z.string().default('wss://polygon-bor-rpc.publicnode.com'),
  POLYGON_HTTP_RPC_URL_B: z.string().default('https://polygon-bor-rpc.publicnode.com'),
  CHAIN_VERIFY_INTERVAL_MS: z.coerce.number().default(60000), // periodic eth_getLogs verification (was 5 min, now 60s)
  CHAIN_HEARTBEAT_MS: z.coerce.number().default(10000), // WSS keepalive interval (was hardcoded 45s)
  CHAIN_STALE_MS: z.coerce.number().default(25000), // WSS stale threshold — force reconnect (was hardcoded 135s)
  CHAIN_EVENT_STALE_MS: z.coerce.number().default(90000), // 90s: force reconnect if no WSS events despite healthy connection
  CHAIN_DUAL_WSS: z
    .string()
    .default('true') // two independent WSS connections for zero-gap coverage
    .transform((v) => v === 'true'),
  CHAIN_WATCHER_ENABLED: z
    .string()
    .default('false') // default off; enable explicitly after verifying WS works
    .transform((v) => v === 'true'),
  SKIP_CHAIN_MAKER_FILLS: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),

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
  MAX_POSITION_USD: z.coerce.number().min(1).max(10000).default(2),
  MAX_PREDICTION_POSITION_USD: z.coerce.number().min(0).max(10000).default(5), // 0 = disabled; max net USD per prediction per allocation
  MAX_DAILY_LOSS_USD: z.coerce.number().min(1).max(100000).default(200),
  MAX_TRADE_PERCENT: z.coerce.number().min(0.01).max(1.0).default(0.50), // Max 50% of allocation per trade
  PORTFOLIO_VALUE_REFRESH_MS: z.coerce.number().default(300000), // 5 min
  SLIPPAGE_UPSIDE_FRACTION: z.coerce.number().min(0).max(0.5).default(0.05), // BUY: fraction of (1-P) upside sacrificed for execution certainty
  SLIPPAGE_MIN_ABSOLUTE: z.coerce.number().min(0).max(0.10).default(0.01), // 1¢ absolute minimum tolerance regardless of price
  COPY_TRADE_PERCENT: z.coerce.number().min(0.01).max(1.0).default(0.10), // Copy 10% of trader's actual trade size
  MIN_COMPOSITE_SCORE: z.coerce.number().min(0).max(1).default(0), // Skip BUY trades below this score (0 = disabled)
  MIN_SIGNAL_TRADE_USD: z.coerce.number().min(0).default(0), // Skip BUY trades where trader's USD < this (0 = disabled)

  // Hedge guard: block low-probability BUY trades unless opposite outcome has sufficient position
  HEDGE_PRICE_RATIO: z.coerce.number().min(0).max(0.50).default(0.25),  // trade.price < ratio * opposite avgBuyPrice = hedge (0 = disabled)
  HEDGE_MIN_OPPOSITE_USD: z.coerce.number().min(0).max(1000).default(5),     // need ≥$5 on opposite side
  HEDGE_MAX_RATIO: z.coerce.number().min(0).max(1.0).default(0.20),         // max 20% of opposite (5:1)
  HEDGE_NAKED_MAX_PRICE: z.coerce.number().min(0).max(0.50).default(0.10), // block naked BUY (no opposite) if price ≤ this (0 = disabled)

  // Fallback poll interval for copy-trader when pg LISTEN is active
  COPY_TRADE_FALLBACK_POLL_MS: z.coerce.number().min(1000).default(7000), // 7s safety net

  // Anti-cycle: per-token cool-down after a SELL fill to prevent market-making spread loss
  TOKEN_SELL_COOLDOWN_MS: z.coerce.number().min(0).default(60000), // 60s — 0 = disabled

  // Midpoint WS cache (eliminates REST getMidpoint() in stale-signal guard)
  MIDPOINT_CACHE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  MIDPOINT_CACHE_MAX_AGE_MS: z.coerce.number().default(5_000),    // 5s cache TTL
  MIDPOINT_CACHE_PRUNE_MS: z.coerce.number().default(600_000),    // 10min subscription TTL

  // Pipeline optimization feature flags
  POSITION_CACHE_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PARALLEL_DRAIN_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

  // Order aggregation pool
  POOL_MIN_AMOUNT_USD: z.coerce.number().min(0.01).max(100).default(0.50), // min USD to pool paper trades
  LIVE_POOL_MIN_AMOUNT_USD: z.coerce.number().min(0.01).max(1000).default(1.0), // min USD to fire live pool (CLOB $1 minimum)
  POOL_BURN_TIMEOUT_MS: z.coerce.number().default(180000), // 3 min per-entry FIFO burn window

  // Auto-claim: on-chain redemption of won conditional tokens
  POLYGON_RPC_URL: z.string().default('https://polygon-bor-rpc.publicnode.com'),
  AUTO_CLAIM_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  // Min USD value to trigger auto-claim (netShares == USD for price=1.0 wins; skips gas-inefficient dust)
  MIN_CLAIM_USD: z.coerce.number().min(0).default(1.00),

  // Position settlement
  SETTLEMENT_SWEEP_INTERVAL_MS: z.coerce.number().default(300000), // 5 minutes
  STALE_TRADE_CUTOFF_MS: z.coerce.number().default(600000), // 10 min (was hardcoded 5 min)
  MARKET_END_GATEKEEP_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  SETTLEMENT_ONCHAIN_FALLBACK_ENABLED: z.string().default('true').transform((v) => v === 'true'),
  SETTLEMENT_ENDDATE_GRACE_MS: z.coerce.number().default(86400000), // 24h grace (sports endDate = game start, not close)

  // Phantom position auto-cleanup (runs on hourly capital audit timer)
  PHANTOM_AUTO_CLEANUP_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  PHANTOM_AUTO_CLEANUP_MAX_COST_USD: z.coerce.number().min(1).max(100).default(10),

  // Per-allocation circuit breaker: auto-deactivate live allocations on deep drawdown
  ALLOCATION_CIRCUIT_BREAKER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  ALLOCATION_CIRCUIT_BREAKER_THRESHOLD: z.coerce.number().min(0).max(1.0).default(0.30), // trip at (CC+DC)/initial < 30%

  // CLOB reconciliation & balance check
  BALANCE_CHECK_INTERVAL_MS: z.coerce.number().default(600000), // 10 min
  BALANCE_MISMATCH_THRESHOLD: z.coerce.number().default(5), // $5 warn threshold

  // Pre-resolution auto-sell
  PRE_RESOLUTION_SELL_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  PRE_RESOLUTION_SELL_WINDOW_MS: z.coerce.number().default(3600000), // 1 hour before end

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

  // Capital — legacy: used for one-time DB bootstrap only (ArbStrategyConfig is source of truth)
  ARB_INITIAL_CAPITAL_USD: z.coerce.number().min(1).default(1000),
  ARB_STANDARD_INITIAL_CAPITAL_USD: z.coerce.number().min(1).optional(),
  ARB_CONTRARIAN_INITIAL_CAPITAL_USD: z.coerce.number().min(1).default(200),
  ARB_POSITION_SIZE_USD: z.coerce.number().min(1).max(50000).default(500),
  ARB_MAX_DAILY_LOSS_USD: z.coerce.number().min(1).default(500),

  // Strategy — legacy: maxEntryPrice now lives in ArbStrategyConfig
  ARB_MAX_ENTRY_PRICE: z.coerce.number().min(0.90).max(0.999).default(0.99),
  ARB_MIN_PRICE_CHANGE: z.coerce.number().default(0.0001), // 0.01% min BTC move (FLAT floor)
  ARB_MAX_CONSECUTIVE_LOSSES: z.coerce.number().min(1).default(5),

  // Confidence scoring
  ARB_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.60),
  ARB_CONFIDENCE_PRICE_SCALE: z.coerce.number().default(0.002),
  ARB_CONFIDENCE_VOL_SCALE: z.coerce.number().default(0.0003),
  ARB_SNAP_BUFFER_SIZE: z.coerce.number().min(60).max(600).default(300),

  // Stop-loss (early exit when outcome price drops)
  ARB_STOP_LOSS_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  ARB_STOP_LOSS_PRICE: z.coerce.number().min(0.01).max(0.95).default(0.50),

  // Contrarian — legacy: enable/disable + sizing now live in ArbStrategyConfig table
  ARB_CONTRARIAN_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ARB_CONTRARIAN_MAX_PRICE: z.coerce.number().min(0.01).max(0.20).default(0.10),
  ARB_CONTRARIAN_POSITION_SIZE_USD: z.coerce.number().min(1).max(1000).default(10),

  // Contrarian strategy variants — legacy: used for one-time DB bootstrap only
  ARB_CONTRARIAN_EVERY3_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ARB_CONTRARIAN_ANTIMART_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  ARB_CONTRARIAN_COOLDOWN_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),

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

  // ─── Scalp Worker (in-play esports/tennis trading) ───
  SCALP_ENABLED: z
    .string()
    .default('false')
    .transform((v) => v === 'true'),
  SCALP_IS_PAPER: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  SCALP_INITIAL_CAPITAL_USD: z.coerce.number().min(5).default(100),
  SCALP_POSITION_SIZE_USD: z.coerce.number().min(5).max(50000).default(5),
  SCALP_MAX_DAILY_LOSS_USD: z.coerce.number().min(1).default(30),
  SCALP_MIN_EDGE_CENTS: z.coerce.number().min(1).default(5),
  SCALP_STOP_LOSS_CENTS: z.coerce.number().min(1).default(15),
  SCALP_MIN_MEANINGFUL_BID: z.coerce.number().default(0.05),        // below this = no liquid bids
  SCALP_MAX_ENTRY_SPREAD: z.coerce.number().default(0.30),          // skip entry if spread > 30¢

  // Scalp exit
  SCALP_CONVERGENCE_SELL_TIMEOUT_MS: z.coerce.number().default(120000),       // 2 min
  SCALP_CONVERGENCE_SELL_DISCOUNT_CENTS: z.coerce.number().default(3),
  SCALP_SETTLEMENT_SWEEP_INTERVAL_MS: z.coerce.number().default(30000),       // 30s
  SCALP_ORDER_POLL_INTERVAL_MS: z.coerce.number().default(5000),              // 5s
  SCALP_STOP_LOSS_COOLDOWN_MS: z.coerce.number().default(60000),              // 60s
  SCALP_SETTLEMENT_TIMEOUT_MS: z.coerce.number().default(86400000),           // 24hr fail-safe

  // Scalp market discovery
  SCALP_MARKET_DISCOVERY_INTERVAL_MS: z.coerce.number().default(300000),      // 5 min
  SCALP_GAMES: z.string().default('cs2,dota2'),

  // Scalp data feeds
  SCALP_STEAM_API_KEY: z.string().default(''),
  SCALP_DOTA2_POLL_INTERVAL_MS: z.coerce.number().default(5000),
  SCALP_CS2_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  SCALP_HLTV_RECONNECT_MAX_MS: z.coerce.number().default(30000),

  // Scalp paper trading (separate from copy-trade paper config)
  SCALP_PAPER_FEE_RATE: z.coerce.number().default(0.0175),      // Sports market fee rate
  SCALP_PAPER_FEE_EXPONENT: z.coerce.number().default(1),        // Linear fee scaling
  SCALP_PAPER_SLIPPAGE_FRACTION: z.coerce.number().default(0.05),

  // Scalp CLOB credentials (falls back to ARB_* if not set)
  SCALP_PRIVATE_KEY: z.string().optional(),
  SCALP_CLOB_API_KEY: z.string().optional(),
  SCALP_CLOB_API_SECRET: z.string().optional(),
  SCALP_CLOB_API_PASSPHRASE: z.string().optional(),
  SCALP_FUNDER_ADDRESS: z.string().optional(),
  SCALP_SIGNATURE_TYPE: z.coerce.number().default(2),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('Invalid environment variables:');
  console.error(parsed.error.format());
  process.exit(1);
}

export const config = parsed.data;
