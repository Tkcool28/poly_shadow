use std::collections::HashMap;

use parking_lot::RwLock;

/// Per-allocation configuration (mirrors FollowAllocation from Prisma schema).
/// Capital tracking is separate (CapitalTracker) — this holds config + filter settings.
#[derive(Debug, Clone)]
pub struct Allocation {
    pub id: String,
    pub proxy_wallet: String,
    pub is_paper: bool,
    pub is_active: bool,
    pub initial_capital: f64,

    // Sizing overrides (None = use global default from FilterConfig)
    pub copy_trade_percent: Option<f64>,
    pub max_position_usd: Option<f64>,
    pub max_prediction_position_usd: Option<f64>,

    // Filters
    pub min_buy_price: Option<f64>,
    pub exclude_event_slug_patterns: Vec<String>,
    pub exclude_title_patterns: Vec<String>,
    pub majority_only_mode: bool,
    pub copy_maker_fills: bool,
}

/// Thread-safe allocation store. Reads are frequent (every trade), writes are rare (config updates).
/// Keyed by proxy_wallet (unique per allocation).
pub struct AllocationStore {
    inner: RwLock<AllocationData>,
}

struct AllocationData {
    by_wallet: HashMap<String, Allocation>,
}

impl AllocationStore {
    pub fn new() -> Self {
        Self {
            inner: RwLock::new(AllocationData {
                by_wallet: HashMap::new(),
            }),
        }
    }

    /// Get allocation by trader wallet address.
    pub fn get_by_wallet(&self, wallet: &str) -> Option<Allocation> {
        self.inner.read().by_wallet.get(wallet).cloned()
    }

    /// Get all active allocations for a wallet.
    pub fn get_active_by_wallet(&self, wallet: &str) -> Option<Allocation> {
        self.inner
            .read()
            .by_wallet
            .get(wallet)
            .filter(|a| a.is_active)
            .cloned()
    }

    /// Get all active allocations (for seeding/reconciliation).
    pub fn get_all_active(&self) -> Vec<Allocation> {
        self.inner
            .read()
            .by_wallet
            .values()
            .filter(|a| a.is_active)
            .cloned()
            .collect()
    }

    /// Insert or update an allocation. Returns previous value if exists.
    pub fn upsert(&self, alloc: Allocation) -> Option<Allocation> {
        self.inner
            .write()
            .by_wallet
            .insert(alloc.proxy_wallet.clone(), alloc)
    }

    /// Deactivate an allocation by ID.
    pub fn deactivate(&self, alloc_id: &str) -> bool {
        let mut data = self.inner.write();
        for alloc in data.by_wallet.values_mut() {
            if alloc.id == alloc_id {
                alloc.is_active = false;
                return true;
            }
        }
        false
    }

    /// Seed from a batch of allocations (startup).
    pub fn seed(&self, allocations: Vec<Allocation>) {
        let mut data = self.inner.write();
        data.by_wallet.clear();
        for alloc in allocations {
            data.by_wallet.insert(alloc.proxy_wallet.clone(), alloc);
        }
    }

    pub fn count(&self) -> usize {
        self.inner.read().by_wallet.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_alloc(id: &str, wallet: &str, is_paper: bool) -> Allocation {
        Allocation {
            id: id.to_string(),
            proxy_wallet: wallet.to_string(),
            is_paper,
            is_active: true,
            initial_capital: 100.0,
            copy_trade_percent: None,
            max_position_usd: None,
            max_prediction_position_usd: None,
            min_buy_price: None,
            exclude_event_slug_patterns: vec![],
            exclude_title_patterns: vec![],
            majority_only_mode: false,
            copy_maker_fills: false,
        }
    }

    #[test]
    fn test_upsert_and_get() {
        let store = AllocationStore::new();
        let alloc = make_alloc("alloc1", "0xwallet1", false);
        store.upsert(alloc);

        let got = store.get_by_wallet("0xwallet1").unwrap();
        assert_eq!(got.id, "alloc1");
        assert!(!got.is_paper);
    }

    #[test]
    fn test_deactivate() {
        let store = AllocationStore::new();
        store.upsert(make_alloc("alloc1", "0xwallet1", false));

        assert!(store.get_active_by_wallet("0xwallet1").is_some());
        assert!(store.deactivate("alloc1"));
        assert!(store.get_active_by_wallet("0xwallet1").is_none());
        // Still accessible via get_by_wallet
        assert!(store.get_by_wallet("0xwallet1").is_some());
    }

    #[test]
    fn test_seed() {
        let store = AllocationStore::new();
        store.upsert(make_alloc("old", "0xold", false));

        store.seed(vec![
            make_alloc("a1", "0xw1", false),
            make_alloc("a2", "0xw2", true),
        ]);

        assert_eq!(store.count(), 2);
        assert!(store.get_by_wallet("0xold").is_none());
        assert!(store.get_by_wallet("0xw1").is_some());
    }
}
