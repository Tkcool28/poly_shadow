use dashmap::DashMap;
use parking_lot::Mutex;

/// Per-allocation capital state.
#[derive(Debug, Clone)]
pub struct Capital {
    pub current: f64,   // Available budget (adjusted by realized P&L)
    pub deployed: f64,  // Currently in open positions
    pub pending_buy: f64, // Sum of PENDING BUY amounts (reserved but not yet filled)
}

impl Capital {
    pub fn new(initial: f64) -> Self {
        Self {
            current: initial,
            deployed: 0.0,
            pending_buy: 0.0,
        }
    }

    /// Available capital = current - pending (what can be committed to new trades).
    pub fn available(&self) -> f64 {
        (self.current - self.pending_buy).max(0.0)
    }
}

/// Daily spend counter with auto-reset at midnight UTC.
struct DailySpend {
    amount: f64,
    date: chrono::NaiveDate,
}

impl DailySpend {
    fn new() -> Self {
        Self {
            amount: 0.0,
            date: chrono::Utc::now().date_naive(),
        }
    }

    /// Get today's spend, auto-resetting if date rolled over.
    fn get(&mut self) -> f64 {
        self.maybe_reset();
        self.amount
    }

    /// Add to today's spend. Returns new total.
    fn add(&mut self, usd: f64) -> f64 {
        self.maybe_reset();
        self.amount += usd;
        self.amount
    }

    fn maybe_reset(&mut self) {
        let today = chrono::Utc::now().date_naive();
        if today != self.date {
            self.amount = 0.0;
            self.date = today;
        }
    }
}

/// Thread-safe capital tracker.
/// Per-allocation capital behind Mutex (serialized per-allocation for atomic read-modify-write).
/// Global daily spend counters (paper/live) behind separate Mutexes.
pub struct CapitalTracker {
    allocations: DashMap<String, Mutex<Capital>>,
    daily_live_spend: Mutex<DailySpend>,
    daily_paper_spend: Mutex<DailySpend>,
}

impl CapitalTracker {
    pub fn new() -> Self {
        Self {
            allocations: DashMap::new(),
            daily_live_spend: Mutex::new(DailySpend::new()),
            daily_paper_spend: Mutex::new(DailySpend::new()),
        }
    }

    /// Initialize capital for an allocation.
    pub fn init_allocation(&self, alloc_id: &str, initial_capital: f64) {
        self.allocations
            .insert(alloc_id.to_string(), Mutex::new(Capital::new(initial_capital)));
    }

    /// Get a snapshot of an allocation's capital.
    pub fn get(&self, alloc_id: &str) -> Option<Capital> {
        self.allocations
            .get(alloc_id)
            .map(|entry| entry.lock().clone())
    }

    /// Available capital for an allocation (current - pending).
    pub fn available(&self, alloc_id: &str) -> f64 {
        self.allocations
            .get(alloc_id)
            .map(|entry| entry.lock().available())
            .unwrap_or(0.0)
    }

    /// Reserve capital for a pending BUY. Returns false if insufficient.
    pub fn reserve_buy(&self, alloc_id: &str, usd: f64) -> bool {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            if cap.available() >= usd {
                cap.pending_buy += usd;
                return true;
            }
        }
        false
    }

    /// Commit a BUY fill: move from pending → deployed, deduct from current.
    /// Only tracks daily spend if the allocation exists (prevents drift on bad alloc_id).
    pub fn commit_buy(&self, alloc_id: &str, usd: f64, is_paper: bool) {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            cap.pending_buy = (cap.pending_buy - usd).max(0.0);
            cap.current = (cap.current - usd).max(0.0);
            cap.deployed += usd;
        } else {
            return; // Unknown allocation — skip daily spend to prevent accounting drift
        }
        let spend = if is_paper {
            &self.daily_paper_spend
        } else {
            &self.daily_live_spend
        };
        spend.lock().add(usd);
    }

    /// Release pending capital (order cancelled or failed).
    pub fn release_pending(&self, alloc_id: &str, usd: f64) {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            cap.pending_buy = (cap.pending_buy - usd).max(0.0);
        }
    }

    /// Record a SELL fill: return proceeds to current, reduce deployed.
    pub fn record_sell(&self, alloc_id: &str, proceeds: f64, cost_basis: f64) {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            cap.current += proceeds;
            cap.deployed = (cap.deployed - cost_basis).max(0.0);
        }
    }

    /// Release capital from a settled market (market resolved → positions closed).
    pub fn release_settlement(&self, alloc_id: &str, settlement_value: f64, cost_basis: f64) {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            cap.current += settlement_value;
            cap.deployed = (cap.deployed - cost_basis).max(0.0);
        }
    }

    /// Set capital to specific values (reconciliation correction from Node.js).
    pub fn reconcile(&self, alloc_id: &str, current: f64, deployed: f64) {
        if let Some(entry) = self.allocations.get(alloc_id) {
            let mut cap = entry.lock();
            cap.current = current;
            cap.deployed = deployed;
        }
    }

    /// Get today's daily spend (auto-resets at midnight UTC).
    pub fn daily_spend(&self, is_paper: bool) -> f64 {
        if is_paper {
            self.daily_paper_spend.lock().get()
        } else {
            self.daily_live_spend.lock().get()
        }
    }

    /// Seed daily spend (startup: sum of today's BUY trades from DB).
    pub fn seed_daily_spend(&self, is_paper: bool, amount: f64) {
        let spend = if is_paper {
            &self.daily_paper_spend
        } else {
            &self.daily_live_spend
        };
        let mut s = spend.lock();
        s.amount = amount;
        s.date = chrono::Utc::now().date_naive();
    }

    /// Seed from a batch of (allocId, capital) pairs.
    pub fn seed(&self, entries: Vec<(String, Capital)>) {
        self.allocations.clear();
        for (alloc_id, capital) in entries {
            self.allocations
                .insert(alloc_id, Mutex::new(capital));
        }
    }

    pub fn count(&self) -> usize {
        self.allocations.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_init_and_available() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 100.0);

        assert_eq!(tracker.available("alloc1"), 100.0);
    }

    #[test]
    fn test_reserve_and_commit() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 100.0);

        assert!(tracker.reserve_buy("alloc1", 30.0));
        assert_eq!(tracker.available("alloc1"), 70.0);

        tracker.commit_buy("alloc1", 30.0, false);
        let cap = tracker.get("alloc1").unwrap();
        assert_eq!(cap.current, 70.0);
        assert_eq!(cap.deployed, 30.0);
        assert_eq!(cap.pending_buy, 0.0);
    }

    #[test]
    fn test_insufficient_capital() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 10.0);

        assert!(!tracker.reserve_buy("alloc1", 20.0));
        assert_eq!(tracker.available("alloc1"), 10.0);
    }

    #[test]
    fn test_sell_returns_capital() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 100.0);

        tracker.commit_buy("alloc1", 30.0, false);
        assert_eq!(tracker.get("alloc1").unwrap().current, 70.0);

        tracker.record_sell("alloc1", 35.0, 30.0); // Profit
        let cap = tracker.get("alloc1").unwrap();
        assert_eq!(cap.current, 105.0);
        assert_eq!(cap.deployed, 0.0);
    }

    #[test]
    fn test_daily_spend_tracked() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 100.0);

        tracker.commit_buy("alloc1", 10.0, false);
        tracker.commit_buy("alloc1", 20.0, false);

        assert_eq!(tracker.daily_spend(false), 30.0);
        assert_eq!(tracker.daily_spend(true), 0.0); // Paper unaffected
    }

    #[test]
    fn test_release_pending() {
        let tracker = CapitalTracker::new();
        tracker.init_allocation("alloc1", 100.0);

        tracker.reserve_buy("alloc1", 50.0);
        assert_eq!(tracker.available("alloc1"), 50.0);

        tracker.release_pending("alloc1", 50.0);
        assert_eq!(tracker.available("alloc1"), 100.0);
    }
}
