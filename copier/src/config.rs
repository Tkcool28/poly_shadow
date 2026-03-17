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
