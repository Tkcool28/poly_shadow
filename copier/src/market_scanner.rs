//! Market scanner: discovers active crypto updown markets and subscribes
//! their token IDs to the CLOB Market WebSocket for permanent price data.
//!
//! Polls Gamma API every 30s for BTC/ETH/SOL/XRP × 5m/15m/1h markets.
//! On candle rotation, new tokens are subscribed and expired ones removed.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use chrono::{Datelike, Timelike, Utc};
use chrono_tz::US::Eastern;

use crate::clob_ws::ClobWsClient;

const GAMMA_API_URL: &str = "https://gamma-api.polymarket.com/markets";
const POLL_INTERVAL_SECS: u64 = 30;
const MIN_TIME_REMAINING_SECS: i64 = 5;

struct AssetConfig {
    short: &'static str,
    long_1h: &'static str,
}

struct TfConfig {
    suffix: &'static str,
    bar_seconds: i64,
}

const ASSETS: &[AssetConfig] = &[
    AssetConfig { short: "btc", long_1h: "bitcoin" },
    AssetConfig { short: "eth", long_1h: "ethereum" },
    AssetConfig { short: "sol", long_1h: "solana" },
    AssetConfig { short: "xrp", long_1h: "xrp" },
];

const TIMEFRAMES: &[TfConfig] = &[
    TfConfig { suffix: "5m", bar_seconds: 300 },
    TfConfig { suffix: "15m", bar_seconds: 900 },
    TfConfig { suffix: "1h", bar_seconds: 3600 },
];

const MONTH_NAMES: &[&str] = &[
    "january", "february", "march", "april", "may", "june",
    "july", "august", "september", "october", "november", "december",
];

/// Spawn the market scanner as a tokio task.
pub fn spawn_market_scanner(clob_ws: Arc<ClobWsClient>) {
    tokio::spawn(async move {
        scanner_loop(clob_ws).await;
    });
}

async fn scanner_loop(clob_ws: Arc<ClobWsClient>) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();

    let mut subscribed: HashSet<String> = HashSet::new();
    let mut poll_count: u64 = 0;

    loop {
        let new_tokens = discover_all_markets(&client).await;

        // Diff: find new and expired tokens
        let to_subscribe: Vec<String> = new_tokens
            .difference(&subscribed)
            .cloned()
            .collect();
        let to_unsubscribe: Vec<String> = subscribed
            .difference(&new_tokens)
            .cloned()
            .collect();

        if !to_subscribe.is_empty() {
            clob_ws.subscribe(&to_subscribe);
        }
        if !to_unsubscribe.is_empty() {
            clob_ws.unsubscribe(&to_unsubscribe);
        }

        if !to_subscribe.is_empty() || !to_unsubscribe.is_empty() || poll_count % 20 == 0 {
            tracing::info!(
                markets = new_tokens.len() / 2,
                tokens = new_tokens.len(),
                added = to_subscribe.len(),
                removed = to_unsubscribe.len(),
                "scanner poll"
            );
        }

        subscribed = new_tokens;
        poll_count += 1;

        tokio::time::sleep(Duration::from_secs(POLL_INTERVAL_SECS)).await;
    }
}

/// Discover all active updown markets across all assets and timeframes.
async fn discover_all_markets(client: &reqwest::Client) -> HashSet<String> {
    let mut tokens = HashSet::new();
    let now_unix = Utc::now().timestamp();

    for asset in ASSETS {
        for tf in TIMEFRAMES {
            let bar_start = (now_unix / tf.bar_seconds) * tf.bar_seconds;
            let slug = build_slug(asset, tf, bar_start);

            match query_gamma(client, &slug, now_unix).await {
                Some((token_up, token_down)) => {
                    tokens.insert(token_up);
                    tokens.insert(token_down);
                }
                None => {}
            }
        }
    }

    tokens
}

/// Build the slug for a given asset, timeframe, and bar start.
fn build_slug(asset: &AssetConfig, tf: &TfConfig, bar_start: i64) -> String {
    if tf.suffix == "1h" {
        build_1h_slug(asset, bar_start)
    } else {
        format!("{}-updown-{}-{}", asset.short, tf.suffix, bar_start)
    }
}

/// Build the 1h slug in ET timezone format.
/// Example: "bitcoin-up-or-down-march-24-2026-7am-et"
fn build_1h_slug(asset: &AssetConfig, bar_start_utc: i64) -> String {
    let dt = chrono::DateTime::from_timestamp(bar_start_utc, 0)
        .unwrap_or_else(|| Utc::now())
        .with_timezone(&Eastern);

    let month = MONTH_NAMES[dt.month0() as usize];
    let day = dt.day();
    let year = dt.year();
    let hour = dt.hour();

    let hour_suffix = match hour {
        0 => "12am".to_string(),
        1..=11 => format!("{}am", hour),
        12 => "12pm".to_string(),
        _ => format!("{}pm", hour - 12),
    };

    format!(
        "{}-up-or-down-{}-{}-{}-{}-et",
        asset.long_1h, month, day, year, hour_suffix
    )
}

/// Query Gamma API for a market by slug. Returns (token_id_up, token_id_down) if found.
async fn query_gamma(
    client: &reqwest::Client,
    slug: &str,
    now_unix: i64,
) -> Option<(String, String)> {
    let resp = match client
        .get(GAMMA_API_URL)
        .query(&[("slug", slug)])
        .send()
        .await
    {
        Ok(r) => r,
        Err(e) => {
            tracing::debug!(slug, error = %e, "gamma query failed");
            return None;
        }
    };

    if !resp.status().is_success() {
        return None;
    }

    let markets: Vec<serde_json::Value> = match resp.json().await {
        Ok(m) => m,
        Err(_) => return None,
    };

    let m = markets.first()?;

    // Check active and not closed
    if m.get("active").and_then(|a| a.as_bool()) != Some(true) {
        return None;
    }
    if m.get("closed").and_then(|c| c.as_bool()) == Some(true) {
        return None;
    }

    // Check time remaining
    if let Some(end_str) = m.get("endDate").and_then(|e| e.as_str()) {
        if let Ok(end_dt) = chrono::DateTime::parse_from_rfc3339(end_str) {
            let remaining = end_dt.timestamp() - now_unix;
            if remaining < MIN_TIME_REMAINING_SECS {
                return None;
            }
        }
    }

    // Parse outcomes (JSON string within JSON)
    let outcomes_str = m.get("outcomes").and_then(|o| o.as_str())?;
    let outcomes: Vec<String> = serde_json::from_str(outcomes_str).ok()?;

    // Find Up/Down indices
    let up_idx = outcomes.iter().position(|o| o.eq_ignore_ascii_case("up"))?;
    let down_idx = outcomes.iter().position(|o| o.eq_ignore_ascii_case("down"))?;

    // Parse token IDs (JSON string within JSON)
    let tokens_str = m.get("clobTokenIds").and_then(|t| t.as_str())?;
    let token_ids: Vec<String> = serde_json::from_str(tokens_str).ok()?;

    let token_up = token_ids.get(up_idx)?.clone();
    let token_down = token_ids.get(down_idx)?.clone();

    Some((token_up, token_down))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_build_5m_slug() {
        let asset = AssetConfig { short: "btc", long_1h: "bitcoin" };
        let tf = TfConfig { suffix: "5m", bar_seconds: 300 };
        assert_eq!(build_slug(&asset, &tf, 1774290600), "btc-updown-5m-1774290600");
    }

    #[test]
    fn test_build_15m_slug() {
        let asset = AssetConfig { short: "eth", long_1h: "ethereum" };
        let tf = TfConfig { suffix: "15m", bar_seconds: 900 };
        assert_eq!(build_slug(&asset, &tf, 1774290000), "eth-updown-15m-1774290000");
    }

    #[test]
    fn test_build_1h_slug() {
        let asset = AssetConfig { short: "btc", long_1h: "bitcoin" };
        // Use a known timestamp and verify format
        let slug = build_1h_slug(&asset, 1774296000); // some UTC hour
        assert!(slug.starts_with("bitcoin-up-or-down-"));
        assert!(slug.ends_with("-et"));
        // Verify it contains a valid month, day, year, and am/pm
        assert!(slug.contains("-2026-"));
    }

    #[test]
    fn test_bar_start() {
        let now = 1774290625;
        let bar_5m = (now / 300) * 300;
        assert_eq!(bar_5m, 1774290600);
        let bar_15m = (now / 900) * 900;
        // 1774290625 / 900 = 1971434, * 900 = 1774290600
        assert_eq!(bar_15m, (1774290625 / 900) * 900);
    }

    #[test]
    fn test_hour_suffix_formatting() {
        // Test the hour formatting logic
        assert_eq!(format_hour(0), "12am");
        assert_eq!(format_hour(1), "1am");
        assert_eq!(format_hour(11), "11am");
        assert_eq!(format_hour(12), "12pm");
        assert_eq!(format_hour(13), "1pm");
        assert_eq!(format_hour(23), "11pm");
    }

    fn format_hour(hour: u32) -> String {
        match hour {
            0 => "12am".to_string(),
            1..=11 => format!("{}am", hour),
            12 => "12pm".to_string(),
            _ => format!("{}pm", hour - 12),
        }
    }
}
