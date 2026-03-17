use dashmap::DashMap;
use tokio::time::Instant;

/// Cooldown durations (matching Node.js copy-trade-worker.ts).
const BUY_FAILURE_COOLDOWN_MS: u64 = 15_000;
const SELL_COOLDOWN_MS: u64 = 60_000;
const SELL_FAILURE_COOLDOWN_MS: u64 = 60_000;

/// Three independent cooldown maps tracking per-(allocationId, tokenId) timestamps.
/// - buy_failure: prevents rapid FAK retries on illiquid markets (15s)
/// - sell: prevents BUY re-entry after SELL fill (60s)
/// - sell_failure: prevents repeated SELL attempts on dead/closed markets (60s)
pub struct CooldownMaps {
    buy_failure: DashMap<String, Instant>,
    sell: DashMap<String, Instant>,
    sell_failure: DashMap<String, Instant>,
}

fn cooldown_key(alloc_id: &str, token_id: &str) -> String {
    format!("{}:{}", alloc_id, token_id)
}

impl CooldownMaps {
    pub fn new() -> Self {
        Self {
            buy_failure: DashMap::new(),
            sell: DashMap::new(),
            sell_failure: DashMap::new(),
        }
    }

    // ─── Buy failure cooldown (15s) ───

    pub fn is_buy_failure_cooldown(&self, alloc_id: &str, token_id: &str) -> bool {
        is_in_cooldown(&self.buy_failure, alloc_id, token_id, BUY_FAILURE_COOLDOWN_MS)
    }

    pub fn record_buy_failure(&self, alloc_id: &str, token_id: &str) {
        let key = cooldown_key(alloc_id, token_id);
        self.buy_failure.insert(key, Instant::now());
    }

    // ─── Sell cooldown (60s) ───

    pub fn is_sell_cooldown(&self, alloc_id: &str, token_id: &str) -> bool {
        is_in_cooldown(&self.sell, alloc_id, token_id, SELL_COOLDOWN_MS)
    }

    pub fn record_sell_fill(&self, alloc_id: &str, token_id: &str) {
        let key = cooldown_key(alloc_id, token_id);
        self.sell.insert(key, Instant::now());
    }

    // ─── Sell failure cooldown (60s) ───

    pub fn is_sell_failure_cooldown(&self, alloc_id: &str, token_id: &str) -> bool {
        is_in_cooldown(&self.sell_failure, alloc_id, token_id, SELL_FAILURE_COOLDOWN_MS)
    }

    pub fn record_sell_failure(&self, alloc_id: &str, token_id: &str) {
        let key = cooldown_key(alloc_id, token_id);
        self.sell_failure.insert(key, Instant::now());
    }

    /// Prune expired entries from all maps (reduces memory).
    pub fn prune(&self) {
        prune_map(&self.buy_failure, BUY_FAILURE_COOLDOWN_MS);
        prune_map(&self.sell, SELL_COOLDOWN_MS);
        prune_map(&self.sell_failure, SELL_FAILURE_COOLDOWN_MS);
    }
}

fn is_in_cooldown(map: &DashMap<String, Instant>, alloc_id: &str, token_id: &str, duration_ms: u64) -> bool {
    let key = cooldown_key(alloc_id, token_id);
    map.get(&key)
        .is_some_and(|t| t.elapsed().as_millis() < duration_ms as u128)
}

fn prune_map(map: &DashMap<String, Instant>, max_age_ms: u64) {
    map.retain(|_, t| t.elapsed().as_millis() < max_age_ms as u128);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_failure_cooldown() {
        let maps = CooldownMaps::new();

        assert!(!maps.is_buy_failure_cooldown("alloc1", "token1"));
        maps.record_buy_failure("alloc1", "token1");
        assert!(maps.is_buy_failure_cooldown("alloc1", "token1"));
        // Different token not in cooldown
        assert!(!maps.is_buy_failure_cooldown("alloc1", "token2"));
    }

    #[test]
    fn test_sell_cooldown() {
        let maps = CooldownMaps::new();

        maps.record_sell_fill("alloc1", "token1");
        assert!(maps.is_sell_cooldown("alloc1", "token1"));
        assert!(!maps.is_sell_cooldown("alloc2", "token1")); // Different alloc
    }

    #[test]
    fn test_prune_removes_expired() {
        let maps = CooldownMaps::new();
        maps.record_buy_failure("alloc1", "token1");
        assert_eq!(maps.buy_failure.len(), 1);

        // Won't prune fresh entries
        maps.prune();
        assert_eq!(maps.buy_failure.len(), 1);
    }
}
