use std::collections::HashMap;

use dashmap::DashMap;

/// Stats for a single outcome within a (wallet, conditionId) pair.
#[derive(Debug, Clone, Default)]
pub struct OutcomeStats {
    pub count: u32,
    pub total_usd: f64,
    pub last_seen_ms: u64, // Unix ms timestamp
}

/// Result of a majority gate check.
#[derive(Debug, Clone)]
pub struct MajorityResult {
    pub outcome: String,
    pub ratio: f64,
    pub total_trades: u32,
    pub total_usd: f64,
    pub num_outcomes: usize,
}

/// Thread-safe majority accumulator.
///
/// Tracks trader BUY volume per (wallet, conditionId, outcome).
/// Used by the majority gate filter: only copy trades when the trader has
/// demonstrated a clear majority on one side of a binary market.
///
/// Key: "wallet:conditionId" → HashMap<outcome, OutcomeStats>
pub struct MajorityAccumulator {
    data: DashMap<String, HashMap<String, OutcomeStats>>,
}

fn acc_key(wallet: &str, condition_id: &str) -> String {
    format!("{}:{}", wallet, condition_id)
}

impl MajorityAccumulator {
    pub fn new() -> Self {
        Self {
            data: DashMap::new(),
        }
    }

    /// Record a trader BUY signal.
    /// Must be called for ALL BUYs (before any per-allocation skip filters).
    pub fn record_buy(
        &self,
        wallet: &str,
        condition_id: &str,
        outcome: &str,
        usd: f64,
        now_ms: u64,
    ) {
        let key = acc_key(wallet, condition_id);
        let mut entry = self.data.entry(key).or_default();
        let stats = entry.entry(outcome.to_string()).or_default();
        stats.count += 1;
        stats.total_usd += usd;
        stats.last_seen_ms = now_ms;
    }

    /// Check majority gate.
    ///
    /// Returns the majority outcome if:
    /// 1. Total USD (after self-exclusion) >= min_usd
    /// 2. Majority ratio >= min_ratio
    /// 3. At least 2 outcomes with > $0 (both-sides requirement)
    ///
    /// `exclude_usd`: the current signal's contribution to exclude from its own
    /// outcome (self-exclusion to prevent a single signal from flipping the majority).
    pub fn get_majority(
        &self,
        wallet: &str,
        condition_id: &str,
        min_usd: f64,
        min_ratio: f64,
        exclude_outcome: Option<&str>,
        exclude_usd: f64,
    ) -> Option<MajorityResult> {
        let key = acc_key(wallet, condition_id);
        let entry = self.data.get(&key)?;
        let outcomes = entry.value();

        if outcomes.is_empty() {
            return None;
        }

        // Build adjusted totals (self-exclusion)
        let mut adjusted: Vec<(String, f64, u32)> = outcomes
            .iter()
            .map(|(outcome, stats)| {
                let adj_usd = if exclude_outcome == Some(outcome.as_str()) {
                    (stats.total_usd - exclude_usd).max(0.0)
                } else {
                    stats.total_usd
                };
                (outcome.clone(), adj_usd, stats.count)
            })
            .collect();

        // Total USD across all outcomes (after exclusion)
        let total_usd: f64 = adjusted.iter().map(|(_, usd, _)| *usd).sum();
        let total_trades: u32 = adjusted.iter().map(|(_, _, count)| *count).sum();

        if total_usd < min_usd {
            return None;
        }

        // Count outcomes with > $0 after exclusion
        let num_outcomes = adjusted.iter().filter(|(_, usd, _)| *usd > 0.0).count();

        // Both-sides requirement: need at least 2 outcomes with volume
        if num_outcomes < 2 {
            return None;
        }

        // Find majority (highest USD)
        adjusted.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        let (majority_outcome, majority_usd, _) = &adjusted[0];

        let ratio = if total_usd > 0.0 {
            majority_usd / total_usd
        } else {
            0.0
        };

        if ratio < min_ratio {
            return None;
        }

        Some(MajorityResult {
            outcome: majority_outcome.clone(),
            ratio,
            total_trades,
            total_usd,
            num_outcomes,
        })
    }

    /// Prune entries older than max_age_ms. Deletes entire (wallet, conditionId) entry
    /// if the most recent trade across all outcomes is older than the cutoff.
    pub fn prune(&self, max_age_ms: u64, now_ms: u64) {
        let cutoff = now_ms.saturating_sub(max_age_ms);
        self.data.retain(|_, outcomes| {
            outcomes
                .values()
                .any(|stats| stats.last_seen_ms >= cutoff)
        });
    }

    /// Seed from DB records (startup).
    pub fn seed(
        &self,
        trades: Vec<(String, String, String, f64, u64)>, // (wallet, conditionId, outcome, usd, timestampMs)
    ) {
        self.data.clear();
        for (wallet, condition_id, outcome, usd, ts_ms) in trades {
            self.record_buy(&wallet, &condition_id, &outcome, usd, ts_ms);
        }
    }

    pub fn clear(&self) {
        self.data.clear();
    }

    pub fn entry_count(&self) -> usize {
        self.data.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_record_and_get_majority() {
        let acc = MajorityAccumulator::new();
        let now = 1_700_000_000_000u64;

        // Trader buys outcome "Yes" heavily, "No" lightly
        acc.record_buy("0xtrader", "cond1", "Yes", 150.0, now);
        acc.record_buy("0xtrader", "cond1", "No", 50.0, now);

        let result = acc
            .get_majority("0xtrader", "cond1", 100.0, 0.50, None, 0.0)
            .unwrap();
        assert_eq!(result.outcome, "Yes");
        assert!((result.ratio - 0.75).abs() < 0.001); // 150/200
        assert_eq!(result.total_usd, 200.0);
        assert_eq!(result.num_outcomes, 2);
    }

    #[test]
    fn test_below_min_usd_threshold() {
        let acc = MajorityAccumulator::new();
        let now = 1_700_000_000_000u64;

        acc.record_buy("0xtrader", "cond1", "Yes", 50.0, now);
        acc.record_buy("0xtrader", "cond1", "No", 10.0, now);

        // min_usd=100 but total is only 60
        let result = acc.get_majority("0xtrader", "cond1", 100.0, 0.50, None, 0.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_below_min_ratio() {
        let acc = MajorityAccumulator::new();
        let now = 1_700_000_000_000u64;

        acc.record_buy("0xtrader", "cond1", "Yes", 100.0, now);
        acc.record_buy("0xtrader", "cond1", "No", 100.0, now);

        // Ratio is 0.50, below min_ratio=0.55
        let result = acc.get_majority("0xtrader", "cond1", 100.0, 0.55, None, 0.0);
        assert!(result.is_none());
    }

    #[test]
    fn test_self_exclusion() {
        let acc = MajorityAccumulator::new();
        let now = 1_700_000_000_000u64;

        acc.record_buy("0xtrader", "cond1", "Yes", 100.0, now);
        acc.record_buy("0xtrader", "cond1", "No", 50.0, now);

        // Without exclusion: Yes=100, No=50, total=150, ratio=0.667 → passes
        let with = acc.get_majority("0xtrader", "cond1", 100.0, 0.50, None, 0.0);
        assert!(with.is_some());

        // Exclude 60 from Yes: Yes=40, No=50, total=90 → below min_usd=100
        let without = acc.get_majority(
            "0xtrader",
            "cond1",
            100.0,
            0.50,
            Some("Yes"),
            60.0,
        );
        assert!(without.is_none());
    }

    #[test]
    fn test_both_sides_requirement() {
        let acc = MajorityAccumulator::new();
        let now = 1_700_000_000_000u64;

        // Only one outcome has volume
        acc.record_buy("0xtrader", "cond1", "Yes", 200.0, now);

        let result = acc.get_majority("0xtrader", "cond1", 100.0, 0.50, None, 0.0);
        assert!(result.is_none()); // Fails both-sides requirement
    }

    #[test]
    fn test_prune_stale_entries() {
        let acc = MajorityAccumulator::new();
        let old = 1_700_000_000_000u64;
        let now = old + 5 * 60 * 60 * 1000; // 5 hours later

        acc.record_buy("0xtrader", "cond1", "Yes", 100.0, old);
        acc.record_buy("0xtrader", "cond1", "No", 50.0, old);
        acc.record_buy("0xtrader", "cond2", "Yes", 100.0, now); // Fresh

        assert_eq!(acc.entry_count(), 2);
        acc.prune(4 * 60 * 60 * 1000, now); // 4h TTL (matches seed window)
        assert_eq!(acc.entry_count(), 1); // cond1 pruned, cond2 kept
    }
}
