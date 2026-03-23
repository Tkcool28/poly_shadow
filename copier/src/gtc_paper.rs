use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use dashmap::DashMap;
use tokio::sync::{broadcast, mpsc};
use tokio::time::interval;

use crate::clob::types::ExecutionMethod;
use crate::clob_ws::{ClobWsClient, PriceTick};
use crate::ipc::messages::OutboundMessage;
use crate::state::capital::CapitalTracker;
use crate::wss::TradeSide;

static ORDER_SEQUENCE: AtomicU64 = AtomicU64::new(0);

/// A pending GTC paper order awaiting fill from CLOB Market WS price data.
#[derive(Debug, Clone)]
pub struct PendingGtcPaper {
    pub alloc_id: String,
    pub token_id: String,
    pub side: TradeSide,
    pub price: f64,
    pub amount_usd: f64,
    pub is_neg_risk: bool,
    pub created_at: Instant,
    pub timeout: Duration,
    // IPC context
    pub proxy_wallet: String,
    pub condition_id: Option<String>,
    pub transaction_hash: String,
}

/// Tracks pending GTC paper orders and manages token subscription reference counts.
pub struct GtcPaperTracker {
    pub pending: DashMap<String, PendingGtcPaper>,
    pub timeout: Duration,
    pub token_refcount: DashMap<String, usize>,
}

impl GtcPaperTracker {
    pub fn new(timeout: Duration) -> Self {
        Self {
            pending: DashMap::new(),
            timeout,
            token_refcount: DashMap::new(),
        }
    }

    /// Submit a new pending GTC paper order.
    pub fn submit(&self, order: PendingGtcPaper) {
        let seq = ORDER_SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let key = format!("{}:{}:{}", order.alloc_id, order.token_id, seq);
        self.pending.insert(key, order);
    }

    /// Increment reference count for a token ID (for subscription management).
    pub fn increment_ref(&self, token_id: &str) {
        self.token_refcount
            .entry(token_id.to_string())
            .and_modify(|c| *c += 1)
            .or_insert(1);
    }

    /// Decrement reference count. Returns true if count reached zero (should unsubscribe).
    fn decrement_ref(&self, token_id: &str) -> bool {
        if let Some(mut entry) = self.token_refcount.get_mut(token_id) {
            *entry = entry.saturating_sub(1);
            if *entry == 0 {
                drop(entry);
                self.token_refcount.remove(token_id);
                return true;
            }
        }
        false
    }

    /// Check if any pending orders are filled by this price tick.
    /// Returns filled orders (already removed from pending map).
    pub fn check_fill(&self, tick: &PriceTick) -> Vec<(String, PendingGtcPaper)> {
        let mut fills = Vec::new();

        // Collect matching keys first, then remove
        let matching_keys: Vec<String> = self
            .pending
            .iter()
            .filter(|entry| {
                let order = entry.value();
                if order.token_id != tick.token_id {
                    return false;
                }
                match order.side {
                    TradeSide::Buy => tick.price <= order.price,
                    TradeSide::Sell => tick.price >= order.price,
                }
            })
            .map(|entry| entry.key().clone())
            .collect();

        for key in matching_keys {
            if let Some((k, order)) = self.pending.remove(&key) {
                fills.push((k, order));
            }
        }

        fills
    }

    /// Remove expired orders. Returns expired orders.
    pub fn sweep_expired(&self) -> Vec<(String, PendingGtcPaper)> {
        let mut expired = Vec::new();

        let expired_keys: Vec<String> = self
            .pending
            .iter()
            .filter(|entry| entry.value().created_at.elapsed() > entry.value().timeout)
            .map(|entry| entry.key().clone())
            .collect();

        for key in expired_keys {
            if let Some((k, order)) = self.pending.remove(&key) {
                expired.push((k, order));
            }
        }

        expired
    }
}

/// Spawn the fill monitor task. Reads price ticks and fills matching GTC paper orders.
pub fn spawn_fill_monitor(
    tracker: Arc<GtcPaperTracker>,
    mut price_rx: broadcast::Receiver<PriceTick>,
    capital: Arc<CapitalTracker>,
    ipc_tx: mpsc::Sender<OutboundMessage>,
    clob_ws: Arc<ClobWsClient>,
) {
    tokio::spawn(async move {
        loop {
            match price_rx.recv().await {
                Ok(tick) => {
                    let fills = tracker.check_fill(&tick);
                    for (_key, order) in fills {
                        let fill_price = tick.price;
                        let fill_size = order.amount_usd / fill_price;

                        // Capital management
                        match order.side {
                            TradeSide::Buy => {
                                capital.commit_buy(
                                    &order.alloc_id,
                                    order.amount_usd,
                                    true, // is_paper
                                );
                            }
                            TradeSide::Sell => {
                                let proceeds = fill_size * fill_price;
                                let cost_basis = order.amount_usd;
                                capital.record_sell(&order.alloc_id, proceeds, cost_basis);
                            }
                        }

                        // Decrement token refcount + unsubscribe if zero
                        if tracker.decrement_ref(&order.token_id) {
                            clob_ws.unsubscribe(&[order.token_id.clone()]);
                        }

                        let latency_ms = order.created_at.elapsed().as_millis() as u64;

                        tracing::info!(
                            alloc = %&order.alloc_id[..order.alloc_id.len().min(12)],
                            side = ?order.side,
                            token = %&order.token_id[..order.token_id.len().min(16)],
                            fill_price = format!("{:.4}", fill_price),
                            fill_size = format!("{:.4}", fill_size),
                            latency_ms,
                            "GTC_PAPER FILLED"
                        );

                        // Send CopyTradeResult IPC
                        let _ = ipc_tx
                            .send(OutboundMessage::CopyTradeResult {
                                detected_trade_id: Some(order.transaction_hash.clone()),
                                allocation_id: order.alloc_id,
                                proxy_wallet: order.proxy_wallet,
                                condition_id: order.condition_id,
                                token_id: order.token_id,
                                side: match order.side {
                                    TradeSide::Buy => "BUY".to_string(),
                                    TradeSide::Sell => "SELL".to_string(),
                                },
                                status: "FILLED".to_string(),
                                filled_price: fill_price,
                                filled_size: fill_size,
                                requested_amount: order.amount_usd,
                                requested_price: order.price,
                                order_id: None,
                                execution_method: ExecutionMethod::GtcPaper.as_str().to_string(),
                                latency_ms,
                                fail_reason: None,
                                is_paper: true,
                            })
                            .await;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(lagged = n, "fill monitor lagged, some ticks dropped");
                }
                Err(_) => break,
            }
        }
        tracing::info!("fill monitor stopped");
    });
}

/// Spawn the timeout sweeper task. Expires stale GTC paper orders and cleans up subscriptions.
pub fn spawn_timeout_sweeper(
    tracker: Arc<GtcPaperTracker>,
    capital: Arc<CapitalTracker>,
    ipc_tx: mpsc::Sender<OutboundMessage>,
    clob_ws: Arc<ClobWsClient>,
) {
    tokio::spawn(async move {
        let mut tick = interval(Duration::from_secs(1));
        loop {
            tick.tick().await;

            let expired = tracker.sweep_expired();
            for (_key, order) in expired {
                // Release reserved capital for BUY orders
                if order.side == TradeSide::Buy {
                    capital.release_pending(&order.alloc_id, order.amount_usd);
                }

                // Subscription cleanup
                if tracker.decrement_ref(&order.token_id) {
                    clob_ws.unsubscribe(&[order.token_id.clone()]);
                }

                tracing::debug!(
                    alloc = %&order.alloc_id[..order.alloc_id.len().min(12)],
                    side = ?order.side,
                    token = %&order.token_id[..order.token_id.len().min(16)],
                    "GTC_PAPER expired"
                );

                // Send SKIPPED IPC result
                let _ = ipc_tx
                    .send(OutboundMessage::CopyTradeResult {
                        detected_trade_id: Some(order.transaction_hash.clone()),
                        allocation_id: order.alloc_id,
                        proxy_wallet: order.proxy_wallet,
                        condition_id: order.condition_id,
                        token_id: order.token_id,
                        side: match order.side {
                            TradeSide::Buy => "BUY".to_string(),
                            TradeSide::Sell => "SELL".to_string(),
                        },
                        status: "SKIPPED".to_string(),
                        filled_price: 0.0,
                        filled_size: 0.0,
                        requested_amount: order.amount_usd,
                        requested_price: order.price,
                        order_id: None,
                        execution_method: ExecutionMethod::GtcPaper.as_str().to_string(),
                        latency_ms: order.created_at.elapsed().as_millis() as u64,
                        fail_reason: Some("GTC paper expired".to_string()),
                        is_paper: true,
                    })
                    .await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    use std::sync::atomic::{AtomicU64, Ordering};
    static ORDER_COUNTER: AtomicU64 = AtomicU64::new(0);

    fn make_order_with_timeout(token_id: &str, side: TradeSide, price: f64, timeout: Duration) -> PendingGtcPaper {
        let n = ORDER_COUNTER.fetch_add(1, Ordering::Relaxed);
        PendingGtcPaper {
            alloc_id: format!("test_alloc_{}", n),
            token_id: token_id.to_string(),
            side,
            price,
            amount_usd: 5.0,
            is_neg_risk: false,
            created_at: Instant::now(),
            timeout,
            proxy_wallet: "0xtest".to_string(),
            condition_id: Some("cid_test".to_string()),
            transaction_hash: format!("0xtx_{}", n),
        }
    }

    fn make_order(token_id: &str, side: TradeSide, price: f64) -> PendingGtcPaper {
        make_order_with_timeout(token_id, side, price, Duration::from_secs(10))
    }

    fn make_tick(token_id: &str, price: f64) -> PriceTick {
        PriceTick {
            timestamp_ms: 1000,
            token_id: token_id.to_string(),
            price,
            size: 10.0,
            side: "BUY".to_string(),
        }
    }

    #[test]
    fn test_buy_fills_at_or_below_price() {
        // Each scenario uses a fresh tracker to avoid leftover orders
        let tracker = GtcPaperTracker::new(Duration::from_secs(10));
        tracker.submit(make_order("token1", TradeSide::Buy, 0.65));
        let fills = tracker.check_fill(&make_tick("token1", 0.70));
        assert!(fills.is_empty(), "price above limit should not fill");

        // The unfilled order is still pending — check it fills at limit
        let fills = tracker.check_fill(&make_tick("token1", 0.65));
        assert_eq!(fills.len(), 1, "price at limit should fill");

        // New order: fills below limit
        tracker.submit(make_order("token1", TradeSide::Buy, 0.65));
        let fills = tracker.check_fill(&make_tick("token1", 0.60));
        assert_eq!(fills.len(), 1, "price below limit should fill");
    }

    #[test]
    fn test_sell_fills_at_or_above_price() {
        let tracker = GtcPaperTracker::new(Duration::from_secs(10));
        tracker.submit(make_order("token1", TradeSide::Sell, 0.70));
        let fills = tracker.check_fill(&make_tick("token1", 0.65));
        assert!(fills.is_empty(), "price below limit should not fill");

        // The unfilled order fills at limit
        let fills = tracker.check_fill(&make_tick("token1", 0.70));
        assert_eq!(fills.len(), 1, "price at limit should fill");
    }

    #[test]
    fn test_wrong_token_no_fill() {
        let tracker = GtcPaperTracker::new(Duration::from_secs(10));
        tracker.submit(make_order("token1", TradeSide::Buy, 0.65));
        let fills = tracker.check_fill(&make_tick("token2", 0.60));
        assert!(fills.is_empty());
    }

    #[test]
    fn test_sweep_expired() {
        let tracker = GtcPaperTracker::new(Duration::from_secs(10));
        tracker.submit(make_order_with_timeout("token1", TradeSide::Buy, 0.65, Duration::from_millis(1)));
        std::thread::sleep(std::time::Duration::from_millis(5));
        let expired = tracker.sweep_expired();
        assert_eq!(expired.len(), 1);
        assert!(tracker.pending.is_empty());
    }

    #[test]
    fn test_refcount() {
        let tracker = GtcPaperTracker::new(Duration::from_secs(10));
        tracker.increment_ref("token1");
        tracker.increment_ref("token1");
        assert!(!tracker.decrement_ref("token1")); // 2→1, not zero
        assert!(tracker.decrement_ref("token1"));  // 1→0, should unsubscribe
    }
}
