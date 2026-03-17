use lru::LruCache;
use parking_lot::Mutex;
use std::num::NonZeroUsize;
use std::time::Instant;

/// Thread-safe LRU dedup cache for txHash:logIndex keys.
/// All WSS providers share one instance — Mutex serializes access (~0.001ms).
/// Capacity-based eviction (not TTL): at ~23 trades/30s, 500 entries ≈ 10min
/// coverage. LRU guarantees oldest entries are evicted first under pressure.
pub struct DedupCache {
    inner: Mutex<LruCache<String, Instant>>,
}

impl DedupCache {
    pub fn new(capacity: usize) -> Self {
        Self {
            inner: Mutex::new(LruCache::new(
                NonZeroUsize::new(capacity).expect("capacity must be > 0"),
            )),
        }
    }

    /// Returns true if key is NEW (not seen before). Inserts it.
    /// Returns false if key already exists (duplicate).
    pub fn check_and_insert(&self, key: &str) -> bool {
        let mut cache = self.inner.lock();
        if cache.contains(key) {
            false
        } else {
            cache.put(key.to_string(), Instant::now());
            true
        }
    }
}
