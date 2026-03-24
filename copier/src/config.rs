use std::collections::HashSet;

/// Configuration loaded from environment variables.
#[derive(Clone, Debug)]
pub struct Config {
    // WSS RPC endpoints (Polygon)
    pub polygon_ws_rpc_url: String,
    pub polygon_http_rpc_url: String,
    pub polygon_ws_rpc_url_b: Option<String>,
    pub polygon_http_rpc_url_b: Option<String>,
    pub polygon_ws_rpc_url_c: Option<String>,
    pub polygon_http_rpc_url_c: Option<String>,

    // Chain watcher config
    pub chain_heartbeat_ms: u64,
    pub chain_stale_ms: u64,
    #[allow(dead_code)] // Used in Phase 4+ filter chain (signal age guard)
    pub chain_event_stale_ms: u64,

    // Wallets to watch (lowercase, 0x-prefixed)
    pub watched_wallets: HashSet<String>,

    // CLOB API
    pub clob_base_url: String,
    pub private_key: Option<String>,       // hex 0x-prefixed
    pub funder_address: Option<String>,    // 0x-prefixed, may differ from signer for POLY_PROXY
    pub clob_api_key: Option<String>,
    pub clob_api_secret: Option<String>,   // base64-encoded
    pub clob_passphrase: Option<String>,
    pub signature_type: u8,                // 0=EOA, 1=POLY_PROXY

    // Safety guard — force all allocations to paper mode (no real CLOB orders)
    pub paper_only: bool,

    // Order execution
    pub gtc_fallback_enabled: bool,
    pub gtc_fallback_rest_ms: u64,
    pub slippage_upside_fraction: f64,
    pub slippage_min_absolute: f64,

    // Market scanner (permanent updown market subscriptions for CLOB WS)
    pub market_scanner_enabled: bool,

    // GTC paper mode (replaces instant simulate_paper_fill)
    pub gtc_paper_enabled: bool,
    pub gtc_paper_timeout_ms: u64,
    pub clob_ws_url: String,
    pub parquet_data_dir: String,
    pub parquet_flush_rows: usize,
    pub parquet_flush_interval_ms: u64,
}

impl Config {
    pub fn from_env() -> anyhow::Result<Self> {
        let polygon_ws_rpc_url = std::env::var("POLYGON_WS_RPC_URL")
            .unwrap_or_else(|_| "wss://polygon-bor-rpc.publicnode.com".to_string());
        let polygon_http_rpc_url = std::env::var("POLYGON_HTTP_RPC_URL")
            .unwrap_or_else(|_| "https://polygon-bor-rpc.publicnode.com".to_string());

        let polygon_ws_rpc_url_b = std::env::var("POLYGON_WS_RPC_URL_B").ok();
        let polygon_http_rpc_url_b = std::env::var("POLYGON_HTTP_RPC_URL_B").ok();
        let polygon_ws_rpc_url_c = std::env::var("POLYGON_WS_RPC_URL_C").ok();
        let polygon_http_rpc_url_c = std::env::var("POLYGON_HTTP_RPC_URL_C").ok();

        let chain_heartbeat_ms = std::env::var("CHAIN_HEARTBEAT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000);
        let chain_stale_ms = std::env::var("CHAIN_STALE_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(25_000);
        let chain_event_stale_ms = std::env::var("CHAIN_EVENT_STALE_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000);

        // Parse watched wallets from comma-separated env var
        let wallets_str = std::env::var("WATCHED_WALLETS").unwrap_or_default();
        let watched_wallets: HashSet<String> = wallets_str
            .split(',')
            .map(|s| s.trim().to_lowercase())
            .filter(|s| s.starts_with("0x") && s.len() == 42)
            .collect();

        if watched_wallets.is_empty() {
            tracing::warn!("WATCHED_WALLETS is empty — no wallets will be monitored");
        }

        // CLOB API config
        let clob_base_url = std::env::var("CLOB_BASE_URL")
            .unwrap_or_else(|_| "https://clob.polymarket.com".to_string());
        let private_key = std::env::var("PRIVATE_KEY").ok();
        let funder_address = std::env::var("FUNDER_ADDRESS").ok();
        let clob_api_key = std::env::var("CLOB_API_KEY").ok();
        let clob_api_secret = std::env::var("CLOB_API_SECRET").ok();
        let clob_passphrase = std::env::var("CLOB_PASSPHRASE").ok();
        let signature_type: u8 = std::env::var("SIGNATURE_TYPE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(1); // POLY_PROXY

        let paper_only = std::env::var("PAPER_ONLY")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(true); // DEFAULT TRUE — must explicitly set PAPER_ONLY=false for live trading

        let gtc_fallback_enabled = std::env::var("GTC_FALLBACK_ENABLED")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(false); // SAFETY: disabled by default — GTC orders can fill silently if status check fails
        let gtc_fallback_rest_ms = std::env::var("GTC_FALLBACK_REST_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5000);
        let slippage_upside_fraction = std::env::var("SLIPPAGE_UPSIDE_FRACTION")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.05);
        let slippage_min_absolute = std::env::var("SLIPPAGE_MIN_ABSOLUTE")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.01);

        let market_scanner_enabled = std::env::var("MARKET_SCANNER_ENABLED")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);

        let gtc_paper_enabled = std::env::var("GTC_PAPER_ENABLED")
            .ok()
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let gtc_paper_timeout_ms = std::env::var("GTC_PAPER_TIMEOUT_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000);
        let clob_ws_url = std::env::var("CLOB_WS_URL")
            .unwrap_or_else(|_| "wss://ws-subscriptions-clob.polymarket.com/ws/market".to_string());
        let parquet_data_dir = std::env::var("PARQUET_DATA_DIR")
            .unwrap_or_else(|_| "data/prices".to_string());
        let parquet_flush_rows: usize = std::env::var("PARQUET_FLUSH_ROWS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(5000);
        let parquet_flush_interval_ms = std::env::var("PARQUET_FLUSH_INTERVAL_MS")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(10_000);

        Ok(Config {
            polygon_ws_rpc_url,
            polygon_http_rpc_url,
            polygon_ws_rpc_url_b,
            polygon_http_rpc_url_b,
            polygon_ws_rpc_url_c,
            polygon_http_rpc_url_c,
            chain_heartbeat_ms,
            chain_stale_ms,
            chain_event_stale_ms,
            watched_wallets,
            clob_base_url,
            private_key,
            funder_address,
            clob_api_key,
            clob_api_secret,
            clob_passphrase,
            signature_type,
            paper_only,
            gtc_fallback_enabled,
            gtc_fallback_rest_ms,
            slippage_upside_fraction,
            slippage_min_absolute,
            market_scanner_enabled,
            gtc_paper_enabled,
            gtc_paper_timeout_ms,
            clob_ws_url,
            parquet_data_dir,
            parquet_flush_rows,
            parquet_flush_interval_ms,
        })
    }

    pub fn wss_provider_count(&self) -> usize {
        let mut count = 1; // A is always present
        if self.polygon_ws_rpc_url_b.is_some() {
            count += 1;
        }
        if self.polygon_ws_rpc_url_c.as_ref().is_some_and(|c| c != &self.polygon_ws_rpc_url) {
            count += 1;
        }
        count
    }
}
