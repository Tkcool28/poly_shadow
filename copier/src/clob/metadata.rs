use std::sync::Arc;
use std::time::Duration;

use dashmap::DashSet;
use reqwest::Client;
use tokio::time::Instant;

use crate::state::markets::{MarketCache, MarketMeta};

/// Async metadata resolver for conditionId + tick_size.
/// Three-tier: cache → CLOB API → Gamma API.
/// All HTTP calls have 5s timeout. Failures return None/default, never panic.
pub struct MetadataResolver {
    http: Client,
    clob_base_url: String,
    gamma_base_url: String,
    markets: Arc<MarketCache>,
    /// Tracks in-flight resolutions to prevent duplicate HTTP requests
    /// for the same tokenId when multiple trades arrive during ~100ms resolution window.
    in_flight: DashSet<String>,
}

impl MetadataResolver {
    pub fn new(clob_base_url: &str, markets: Arc<MarketCache>) -> Self {
        Self {
            http: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default(),
            clob_base_url: clob_base_url.to_string(),
            gamma_base_url: "https://gamma-api.polymarket.com".to_string(),
            markets,
            in_flight: DashSet::new(),
        }
    }

    /// Check if resolution is already in-flight for this tokenId.
    pub fn is_resolving(&self, token_id: &str) -> bool {
        self.in_flight.contains(token_id)
    }

    /// Resolve conditionId: cache → CLOB /book → None.
    /// Inserts into in_flight set at start, removes at end.
    /// If conditionId is found, also triggers full metadata resolution (Gamma).
    pub async fn resolve_condition_id(&self, token_id: &str) -> Option<String> {
        // Tier 1: cache
        if let Some(cid) = self.markets.condition_for_token(token_id) {
            return Some(cid);
        }

        // Mark as in-flight
        if !self.in_flight.insert(token_id.to_string()) {
            // Already in-flight — another task is resolving
            return None;
        }

        // Tier 2: CLOB /book
        let result = self.fetch_condition_from_clob(token_id).await;

        if let Some(ref cid) = result {
            // Tier 3: Gamma full metadata (fire-and-forget — populates cache)
            self.resolve_and_cache_full(token_id, cid).await;
        }

        // Remove from in-flight
        self.in_flight.remove(token_id);

        result
    }

    /// Resolve tick_size: cache → CLOB /tick-size → default "0.01".
    pub async fn resolve_tick_size(&self, token_id: &str) -> String {
        // Tier 1: cache
        if let Some(ts) = self.markets.tick_size_for_token(token_id) {
            return ts;
        }

        // Tier 2: CLOB /tick-size
        self.fetch_tick_size_from_clob(token_id)
            .await
            .unwrap_or_else(|| "0.01".to_string())
    }

    /// Fetch full metadata from Gamma and cache it.
    /// Registers all token→condition mappings in MarketCache.
    pub async fn resolve_and_cache_full(
        &self,
        token_id: &str,
        condition_id: &str,
    ) -> Option<()> {
        // Try Gamma API for full metadata
        let gamma = self.fetch_gamma_metadata(condition_id).await;

        // Also fetch tick_size from CLOB (Gamma doesn't have it)
        let tick_size = self
            .fetch_tick_size_from_clob(token_id)
            .await
            .unwrap_or_else(|| "0.01".to_string());

        let meta = if let Some((event_slug, question, end_date, tokens)) = gamma {
            MarketMeta {
                closed: false,
                end_date,
                event_slug: Some(event_slug),
                question: Some(question),
                tokens,
                tick_size,
                fetched_at: Instant::now(),
            }
        } else {
            // Gamma failed — cache minimal metadata with just the one token we know
            MarketMeta {
                closed: false,
                end_date: None,
                event_slug: None,
                question: None,
                tokens: vec![token_id.to_string()],
                tick_size,
                fetched_at: Instant::now(),
            }
        };

        self.markets.upsert(condition_id, meta);
        Some(())
    }

    /// CLOB API: GET /book?token_id=X → { "market": "conditionId" }
    async fn fetch_condition_from_clob(&self, token_id: &str) -> Option<String> {
        let url = format!("{}/book?token_id={}", self.clob_base_url, token_id);
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            tracing::warn!(
                status = %resp.status(),
                token_id,
                "CLOB /book failed"
            );
            return None;
        }
        let json: serde_json::Value = resp.json().await.ok()?;
        json.get("market")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    /// CLOB API: GET /tick-size?token_id=X → bare string "0.01"
    async fn fetch_tick_size_from_clob(&self, token_id: &str) -> Option<String> {
        let url = format!(
            "{}/tick-size?token_id={}",
            self.clob_base_url, token_id
        );
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let text = resp.text().await.ok()?;
        let ts = text.trim().trim_matches('"').to_string();
        if ["0.1", "0.01", "0.001", "0.0001"].contains(&ts.as_str()) {
            Some(ts)
        } else {
            tracing::warn!(tick_size = %ts, token_id, "unexpected tick_size from CLOB");
            None
        }
    }

    /// Gamma API: GET /markets?condition_ids=X
    /// Returns (event_slug, question, end_date, token_ids).
    async fn fetch_gamma_metadata(
        &self,
        condition_id: &str,
    ) -> Option<(String, String, Option<i64>, Vec<String>)> {
        let url = format!(
            "{}/markets?condition_ids={}",
            self.gamma_base_url, condition_id
        );
        let resp = self.http.get(&url).send().await.ok()?;
        if !resp.status().is_success() {
            tracing::warn!(
                status = %resp.status(),
                condition_id,
                "Gamma /markets failed"
            );
            return None;
        }
        let json: serde_json::Value = resp.json().await.ok()?;
        let market = json.as_array()?.first()?;

        let slug = market
            .get("slug")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let question = market
            .get("question")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        // Parse endDateIso to unix timestamp
        let end_date = market
            .get("endDateIso")
            .and_then(|v| v.as_str())
            .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
            .map(|dt| dt.timestamp());

        // Extract token IDs
        let tokens: Vec<String> = market
            .get("tokens")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| {
                        t.get("token_id")
                            .and_then(|v| v.as_str())
                            .map(|s| s.to_string())
                    })
                    .collect()
            })
            .unwrap_or_default();

        if slug.is_empty() && question.is_empty() {
            return None;
        }

        Some((slug, question, end_date, tokens))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_resolving_initially_false() {
        let markets = Arc::new(MarketCache::new());
        let resolver = MetadataResolver::new("http://localhost", markets);
        assert!(!resolver.is_resolving("token123"));
    }

    #[tokio::test]
    async fn test_resolve_condition_id_cache_hit() {
        let markets = Arc::new(MarketCache::new());
        markets.upsert(
            "cond1",
            MarketMeta {
                closed: false,
                end_date: None,
                event_slug: None,
                question: None,
                tokens: vec!["tokenA".into()],
                tick_size: "0.01".into(),
                fetched_at: Instant::now(),
            },
        );

        let resolver = MetadataResolver::new("http://localhost", markets);
        let result = resolver.resolve_condition_id("tokenA").await;
        assert_eq!(result, Some("cond1".to_string()));
    }

    #[tokio::test]
    async fn test_resolve_tick_size_cache_hit() {
        let markets = Arc::new(MarketCache::new());
        markets.upsert(
            "cond1",
            MarketMeta {
                closed: false,
                end_date: None,
                event_slug: None,
                question: None,
                tokens: vec!["tokenA".into()],
                tick_size: "0.001".into(),
                fetched_at: Instant::now(),
            },
        );

        let resolver = MetadataResolver::new("http://localhost", markets);
        let result = resolver.resolve_tick_size("tokenA").await;
        assert_eq!(result, "0.001");
    }

    #[tokio::test]
    async fn test_resolve_tick_size_default_on_miss() {
        let markets = Arc::new(MarketCache::new());
        let resolver = MetadataResolver::new("http://localhost:99999", markets);
        // Will fail to connect — should return default
        let result = resolver.resolve_tick_size("unknown_token").await;
        assert_eq!(result, "0.01");
    }
}
