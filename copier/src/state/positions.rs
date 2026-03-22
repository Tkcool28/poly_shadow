use dashmap::DashMap;

use crate::wss::TradeSide;

/// Cached position for (tokenId, allocationId, isPaper).
/// Mirrors Node.js CachedPosition from DrainCache.
#[derive(Debug, Clone, Default)]
pub struct CachedPosition {
    pub net_shares: f64,  // BUY fills - SELL fills (clamped ≥ 0)
    pub net_usd: f64,     // BUY USD - SELL USD (clamped ≥ 0)
    pub buy_cost: f64,    // Total USD spent on BUYs (never decremented)
    pub buy_shares: f64,  // Total shares bought (never decremented)
}

/// Thread-safe position tracker using DashMap for per-key concurrent access.
/// Key: "tokenId:allocId:isPaper" composite string.
pub struct PositionTracker {
    positions: DashMap<String, CachedPosition>,
}

fn position_key(token_id: &str, alloc_id: &str, is_paper: bool) -> String {
    format!("{}:{}:{}", token_id, alloc_id, is_paper)
}

impl PositionTracker {
    pub fn new() -> Self {
        Self {
            positions: DashMap::new(),
        }
    }

    /// Get position for a token within an allocation.
    /// Returns default (zero) if no position exists.
    pub fn get(&self, token_id: &str, alloc_id: &str, is_paper: bool) -> CachedPosition {
        let key = position_key(token_id, alloc_id, is_paper);
        self.positions
            .get(&key)
            .map(|p| p.clone())
            .unwrap_or_default()
    }

    /// Record a fill (BUY or SELL). Updates net_shares, net_usd, and BUY accumulators.
    pub fn add_fill(
        &self,
        token_id: &str,
        alloc_id: &str,
        is_paper: bool,
        side: TradeSide,
        shares: f64,
        usd: f64,
    ) {
        let key = position_key(token_id, alloc_id, is_paper);
        let mut entry = self.positions.entry(key).or_default();
        let pos = entry.value_mut();

        match side {
            TradeSide::Buy => {
                pos.net_shares += shares;
                pos.net_usd += usd;
                pos.buy_cost += usd;
                pos.buy_shares += shares;
            }
            TradeSide::Sell => {
                pos.net_shares -= shares;
                pos.net_usd -= usd;
            }
        }

        // Clamp to zero (dust guard: < 0.01 treated as zero)
        if pos.net_shares < 0.01 {
            pos.net_shares = 0.0;
        }
        if pos.net_usd < 0.01 {
            pos.net_usd = 0.0;
        }
    }

    /// Add pending trade impact (in-flight orders).
    /// Same as add_fill but tracks uncommitted changes.
    pub fn add_pending(
        &self,
        token_id: &str,
        alloc_id: &str,
        is_paper: bool,
        side: TradeSide,
        shares: f64,
        usd: f64,
    ) {
        // Pending trades affect position the same way as fills
        self.add_fill(token_id, alloc_id, is_paper, side, shares, usd);
    }

    /// Set position to a specific value (reconciliation correction from Node.js).
    pub fn set(
        &self,
        token_id: &str,
        alloc_id: &str,
        is_paper: bool,
        position: CachedPosition,
    ) {
        let key = position_key(token_id, alloc_id, is_paper);
        self.positions.insert(key, position);
    }

    /// Clear all positions for a condition (market settlement).
    /// Requires the list of token IDs belonging to this condition.
    pub fn clear_for_condition(
        &self,
        token_ids: &[String],
        alloc_id: &str,
        is_paper: bool,
    ) {
        for token_id in token_ids {
            let key = position_key(token_id, alloc_id, is_paper);
            self.positions.remove(&key);
        }
    }

    /// Seed from a batch of positions (startup).
    pub fn seed(&self, entries: Vec<(String, String, bool, CachedPosition)>) {
        self.positions.clear();
        for (token_id, alloc_id, is_paper, pos) in entries {
            let key = position_key(&token_id, &alloc_id, is_paper);
            self.positions.insert(key, pos);
        }
    }

    /// Sum net_usd across ALL allocations for a given tokenId + isPaper.
    /// Used for wallet-level position cap (cross-allocation guard).
    pub fn get_total_for_token(&self, token_id: &str, is_paper: bool) -> f64 {
        let prefix = format!("{}:", token_id);
        let suffix = format!(":{}", is_paper);
        let mut total = 0.0;
        for entry in self.positions.iter() {
            let key = entry.key();
            if key.starts_with(&prefix) && key.ends_with(&suffix) {
                total += entry.value().net_usd;
            }
        }
        total
    }

    pub fn count(&self) -> usize {
        self.positions.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_buy_increases_position() {
        let tracker = PositionTracker::new();
        tracker.add_fill("token1", "alloc1", false, TradeSide::Buy, 10.0, 5.0);

        let pos = tracker.get("token1", "alloc1", false);
        assert_eq!(pos.net_shares, 10.0);
        assert_eq!(pos.net_usd, 5.0);
        assert_eq!(pos.buy_cost, 5.0);
        assert_eq!(pos.buy_shares, 10.0);
    }

    #[test]
    fn test_sell_decreases_position() {
        let tracker = PositionTracker::new();
        tracker.add_fill("token1", "alloc1", false, TradeSide::Buy, 10.0, 5.0);
        tracker.add_fill("token1", "alloc1", false, TradeSide::Sell, 6.0, 3.0);

        let pos = tracker.get("token1", "alloc1", false);
        assert_eq!(pos.net_shares, 4.0);
        assert_eq!(pos.net_usd, 2.0);
        // buy_cost and buy_shares are never decremented
        assert_eq!(pos.buy_cost, 5.0);
        assert_eq!(pos.buy_shares, 10.0);
    }

    #[test]
    fn test_dust_clamp() {
        let tracker = PositionTracker::new();
        tracker.add_fill("token1", "alloc1", false, TradeSide::Buy, 10.0, 5.0);
        tracker.add_fill("token1", "alloc1", false, TradeSide::Sell, 9.995, 4.998);

        let pos = tracker.get("token1", "alloc1", false);
        assert_eq!(pos.net_shares, 0.0); // 0.005 < 0.01 → clamped
        assert_eq!(pos.net_usd, 0.0);    // 0.002 < 0.01 → clamped
    }

    #[test]
    fn test_paper_vs_live_isolated() {
        let tracker = PositionTracker::new();
        tracker.add_fill("token1", "alloc1", false, TradeSide::Buy, 10.0, 5.0);
        tracker.add_fill("token1", "alloc1", true, TradeSide::Buy, 20.0, 10.0);

        assert_eq!(tracker.get("token1", "alloc1", false).net_shares, 10.0);
        assert_eq!(tracker.get("token1", "alloc1", true).net_shares, 20.0);
    }

    #[test]
    fn test_default_position() {
        let tracker = PositionTracker::new();
        let pos = tracker.get("nonexistent", "alloc1", false);
        assert_eq!(pos.net_shares, 0.0);
        assert_eq!(pos.net_usd, 0.0);
    }
}
