use dashmap::DashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Per-allocation tokio Mutex for serializing order execution + state updates.
/// Uses tokio::sync::Mutex (not parking_lot) because the critical section spans .await points
/// (CLOB HTTP call within the lock).
pub struct AllocMutexMap {
    mutexes: DashMap<String, Arc<Mutex<()>>>,
}

impl AllocMutexMap {
    pub fn new() -> Self {
        Self {
            mutexes: DashMap::new(),
        }
    }

    /// Get or create a mutex for the given allocation ID.
    /// Returns an Arc clone — caller can hold the lock across .await.
    pub fn get(&self, alloc_id: &str) -> Arc<Mutex<()>> {
        self.mutexes
            .entry(alloc_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_get_returns_same_mutex() {
        let map = AllocMutexMap::new();
        let m1 = map.get("alloc1");
        let m2 = map.get("alloc1");
        // Same Arc — both point to the same mutex
        assert!(Arc::ptr_eq(&m1, &m2));
    }

    #[tokio::test]
    async fn test_different_allocs_different_mutexes() {
        let map = AllocMutexMap::new();
        let m1 = map.get("alloc1");
        let m2 = map.get("alloc2");
        assert!(!Arc::ptr_eq(&m1, &m2));
    }

    #[tokio::test]
    async fn test_mutex_is_lockable() {
        let map = AllocMutexMap::new();
        let m = map.get("alloc1");
        let _guard = m.lock().await;
        // Lock acquired successfully
    }
}
