use dashmap::DashMap;
use tokio::time::Instant;

/// Market metadata cached per conditionId.
/// Populated from Gamma API / CLOB API, refreshed via IPC from Node.js.
#[derive(Debug, Clone)]
pub struct MarketMeta {
    pub closed: bool,
    pub end_date: Option<i64>,          // Unix timestamp (seconds)
    pub event_slug: Option<String>,
    pub question: Option<String>,       // Market title/question
    pub tokens: Vec<String>,            // All token IDs in this condition (usually 2)
    pub tick_size: String,              // "0.01", "0.001", "0.0001", "0.1"
    pub taker_base_fee: u32,            // Fee in basis points (0, 700, 1000, etc.)
    pub fetched_at: Instant,
}

/// Thread-safe market metadata cache with token→condition reverse lookup.
pub struct MarketCache {
    /// conditionId → MarketMeta
    by_condition: DashMap<String, MarketMeta>,
    /// tokenId → conditionId (reverse index for fast lookups)
    token_to_condition: DashMap<String, String>,
}

impl MarketCache {
    pub fn new() -> Self {
        Self {
            by_condition: DashMap::new(),
            token_to_condition: DashMap::new(),
        }
    }

    /// Insert or update market metadata. Also updates reverse token→condition index.
    pub fn upsert(&self, condition_id: &str, meta: MarketMeta) {
        // Update reverse index
        for token_id in &meta.tokens {
            self.token_to_condition
                .insert(token_id.clone(), condition_id.to_string());
        }
        self.by_condition.insert(condition_id.to_string(), meta);
    }

    /// Get market metadata by conditionId.
    pub fn get(&self, condition_id: &str) -> Option<MarketMeta> {
        self.by_condition.get(condition_id).map(|e| e.clone())
    }

    /// Get conditionId for a tokenId.
    pub fn condition_for_token(&self, token_id: &str) -> Option<String> {
        self.token_to_condition.get(token_id).map(|e| e.clone())
    }

    /// Check if a market is closed.
    pub fn is_closed(&self, condition_id: &str) -> Option<bool> {
        self.by_condition.get(condition_id).map(|e| e.closed)
    }

    /// Get end date for a market.
    pub fn end_date(&self, condition_id: &str) -> Option<i64> {
        self.by_condition
            .get(condition_id)
            .and_then(|e| e.end_date)
    }

    /// Get event slug for a market.
    pub fn event_slug(&self, condition_id: &str) -> Option<String> {
        self.by_condition
            .get(condition_id)
            .and_then(|e| e.event_slug.clone())
    }

    /// Get market title/question.
    pub fn question(&self, condition_id: &str) -> Option<String> {
        self.by_condition
            .get(condition_id)
            .and_then(|e| e.question.clone())
    }

    /// Find the opposite token ID in a binary market.
    /// Given a tokenId, returns the other tokenId in the same condition.
    pub fn opposite_token(&self, token_id: &str) -> Option<String> {
        let condition_id = self.token_to_condition.get(token_id)?;
        let meta = self.by_condition.get(condition_id.value())?;
        meta.tokens
            .iter()
            .find(|t| t.as_str() != token_id)
            .cloned()
    }

    /// Mark a market as closed.
    pub fn mark_closed(&self, condition_id: &str) {
        if let Some(mut entry) = self.by_condition.get_mut(condition_id) {
            entry.closed = true;
        }
    }

    /// Register a token→condition mapping (from incoming WSS events).
    /// Over time, this builds the full mapping naturally.
    pub fn register_token(&self, token_id: &str, condition_id: &str) {
        self.token_to_condition
            .insert(token_id.to_string(), condition_id.to_string());
        // Also add to the condition's token list if not already present
        if let Some(mut entry) = self.by_condition.get_mut(condition_id)
            && !entry.tokens.contains(&token_id.to_string())
        {
            entry.tokens.push(token_id.to_string());
        }
    }

    /// Seed from a batch of (conditionId, MarketMeta) pairs.
    pub fn seed(&self, entries: Vec<(String, MarketMeta)>) {
        self.by_condition.clear();
        self.token_to_condition.clear();
        for (condition_id, meta) in entries {
            self.upsert(&condition_id, meta);
        }
    }

    /// Prune entries older than TTL.
    pub fn prune(&self, max_age: std::time::Duration) {
        let now = Instant::now();
        self.by_condition.retain(|_, meta| {
            now.duration_since(meta.fetched_at) < max_age
        });
        // Clean up orphaned token→condition entries
        self.token_to_condition
            .retain(|_, cid| self.by_condition.contains_key(cid.as_str()));
    }

    /// Get tick_size for a token (reverse lookup through condition).
    pub fn tick_size_for_token(&self, token_id: &str) -> Option<String> {
        let cid = self.token_to_condition.get(token_id)?;
        self.by_condition
            .get(cid.value())
            .map(|e| e.tick_size.clone())
    }

    pub fn taker_base_fee_for_token(&self, token_id: &str) -> u32 {
        self.token_to_condition
            .get(token_id)
            .and_then(|cid| self.by_condition.get(cid.value()))
            .map(|e| e.taker_base_fee)
            .unwrap_or(0)
    }

    pub fn count(&self) -> usize {
        self.by_condition.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_meta(tokens: Vec<&str>) -> MarketMeta {
        MarketMeta {
            closed: false,
            end_date: None,
            event_slug: Some("test-slug".to_string()),
            question: Some("Will X happen?".to_string()),
            tokens: tokens.into_iter().map(String::from).collect(),
            tick_size: "0.01".to_string(),
            taker_base_fee: 0,
            fetched_at: Instant::now(),
        }
    }

    #[test]
    fn test_tick_size_for_token() {
        let cache = MarketCache::new();
        let mut meta = make_meta(vec!["tokenA", "tokenB"]);
        meta.tick_size = "0.001".to_string();
        cache.upsert("cond1", meta);

        assert_eq!(
            cache.tick_size_for_token("tokenA"),
            Some("0.001".to_string())
        );
        assert_eq!(cache.tick_size_for_token("tokenC"), None);
    }

    #[test]
    fn test_upsert_and_get() {
        let cache = MarketCache::new();
        cache.upsert("cond1", make_meta(vec!["tokenA", "tokenB"]));

        let meta = cache.get("cond1").unwrap();
        assert!(!meta.closed);
        assert_eq!(meta.tokens.len(), 2);
    }

    #[test]
    fn test_opposite_token() {
        let cache = MarketCache::new();
        cache.upsert("cond1", make_meta(vec!["tokenA", "tokenB"]));

        assert_eq!(cache.opposite_token("tokenA"), Some("tokenB".to_string()));
        assert_eq!(cache.opposite_token("tokenB"), Some("tokenA".to_string()));
        assert_eq!(cache.opposite_token("tokenC"), None);
    }

    #[test]
    fn test_condition_for_token() {
        let cache = MarketCache::new();
        cache.upsert("cond1", make_meta(vec!["tokenA", "tokenB"]));

        assert_eq!(
            cache.condition_for_token("tokenA"),
            Some("cond1".to_string())
        );
    }

    #[test]
    fn test_mark_closed() {
        let cache = MarketCache::new();
        cache.upsert("cond1", make_meta(vec!["tokenA"]));

        assert_eq!(cache.is_closed("cond1"), Some(false));
        cache.mark_closed("cond1");
        assert_eq!(cache.is_closed("cond1"), Some(true));
    }

    #[test]
    fn test_register_token_builds_mapping() {
        let cache = MarketCache::new();
        cache.upsert("cond1", make_meta(vec!["tokenA"]));
        cache.register_token("tokenB", "cond1");

        let meta = cache.get("cond1").unwrap();
        assert_eq!(meta.tokens.len(), 2);
        assert!(meta.tokens.contains(&"tokenB".to_string()));
    }
}
