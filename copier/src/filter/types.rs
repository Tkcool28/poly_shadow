use crate::wss::TradeSide;

/// Input to the filter chain — a decoded trade with resolved context.
#[derive(Debug, Clone)]
pub struct TradeSignal {
    pub proxy_wallet: String,
    pub token_id: String,
    pub condition_id: Option<String>, // Resolved from MarketCache (None if new token)
    pub side: TradeSide,
    pub size: f64,       // shares
    pub price: f64,      // price per share
    pub usd: f64,        // size * price (trader's trade value)
    pub is_neg_risk: bool,
    pub is_maker: bool,
    pub detected_at_ms: u64, // When WSS event was received (Unix ms)
}

/// Output of the filter chain.
#[derive(Debug)]
pub enum FilterResult {
    /// Trade should be executed with these parameters.
    Execute(ExecuteParams),
    /// Trade was skipped (with reason for logging).
    Skip(String),
}

/// Parameters for a trade that passed all filters.
#[derive(Debug, Clone)]
pub struct ExecuteParams {
    pub copy_amount_usd: f64,
    pub side: TradeSide,
    pub token_id: String,
    pub sell_shares: Option<f64>, // Set for SELL trades
    pub is_neg_risk: bool,
    pub price: f64, // Signal price (for order construction)
}

/// Global filter configuration loaded from environment variables.
/// Per-allocation overrides (in Allocation struct) take precedence where applicable.
#[derive(Debug, Clone)]
pub struct FilterConfig {
    // Sizing defaults (overridden by per-allocation DB fields)
    pub copy_trade_percent: f64,
    pub max_position_usd: f64,
    pub max_prediction_position_usd: f64,

    // Daily limit
    pub max_daily_loss_usd: f64,

    // Signal freshness
    pub max_signal_age_ms: u64,

    // Majority gate thresholds
    pub majority_min_usd: f64,
    pub majority_min_ratio: f64,

    // Market structure guards
    pub committed_side_lock: bool,
    pub market_end_gatekeep_enabled: bool,

    // Quality gates (0 = disabled)
    pub min_composite_score: f64,
    pub min_signal_trade_usd: f64,

    // CLOB order constraints
    pub clob_min_order_usd: f64,

    // Hedge guard
    pub hedge_price_ratio: f64,
    pub hedge_naked_max_price: f64,
    pub hedge_min_opposite_usd: f64,
    pub hedge_max_ratio: f64,

    // Pool thresholds (V2: sub-threshold → skip, no pooling)
    pub pool_min_amount_usd: f64,
    pub live_pool_min_amount_usd: f64,
}

impl FilterConfig {
    pub fn from_env() -> Self {
        Self {
            copy_trade_percent: parse_env("COPY_TRADE_PERCENT", 0.10),
            max_position_usd: parse_env("MAX_POSITION_USD", 5.0),
            max_prediction_position_usd: parse_env("MAX_PREDICTION_POSITION_USD", 5.0),
            max_daily_loss_usd: parse_env("MAX_DAILY_LOSS_USD", 200.0),
            max_signal_age_ms: parse_env("MAX_SIGNAL_AGE_MS", 300_000),
            majority_min_usd: parse_env("MAJORITY_MIN_USD", 175.0),
            majority_min_ratio: parse_env("MAJORITY_MIN_RATIO", 0.50),
            committed_side_lock: parse_env_bool("COMMITTED_SIDE_LOCK", true),
            market_end_gatekeep_enabled: parse_env_bool("MARKET_END_GATEKEEP_ENABLED", true),
            min_composite_score: parse_env("MIN_COMPOSITE_SCORE", 0.0),
            min_signal_trade_usd: parse_env("MIN_SIGNAL_TRADE_USD", 0.0),
            clob_min_order_usd: parse_env("CLOB_MIN_ORDER_USD", 1.0),
            hedge_price_ratio: parse_env("HEDGE_PRICE_RATIO", 0.25),
            hedge_naked_max_price: parse_env("HEDGE_NAKED_MAX_PRICE", 0.10),
            hedge_min_opposite_usd: parse_env("HEDGE_MIN_OPPOSITE_USD", 5.0),
            hedge_max_ratio: parse_env("HEDGE_MAX_RATIO", 0.20),
            pool_min_amount_usd: parse_env("POOL_MIN_AMOUNT_USD", 0.50),
            live_pool_min_amount_usd: parse_env("LIVE_POOL_MIN_AMOUNT_USD", 1.0),
        }
    }
}

impl TradeSignal {
    /// Construct a TradeSignal from a decoded WSS trade + resolved conditionId.
    pub fn from_decoded(
        trade: &crate::wss::DecodedTrade,
        condition_id: Option<String>,
    ) -> Self {
        Self {
            proxy_wallet: trade.proxy_wallet.clone(),
            token_id: trade.token_id.clone(),
            condition_id,
            side: trade.side,
            size: trade.size,
            price: trade.price,
            usd: trade.size * trade.price,
            is_neg_risk: trade.is_neg_risk,
            is_maker: trade.is_maker,
            detected_at_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }
}

fn parse_env<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn parse_env_bool(key: &str, default: bool) -> bool {
    std::env::var(key)
        .ok()
        .map(|v| v == "true" || v == "1")
        .unwrap_or(default)
}
