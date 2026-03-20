use std::collections::{HashMap, VecDeque};

use tokio::sync::mpsc;
use tokio::time::{Duration, Instant};

use super::{DecodedTrade, TradeSide};

/// Debounce window for taker events (ms).
/// Empirically tuned: 60ms leaked 12% of phantoms; 100ms is the sweet spot.
const TAKER_DEBOUNCE_MS: u64 = 100;

/// Max entries in emitted cache before FIFO eviction.
const MAX_EMITTED: usize = 500;
const EVICT_BATCH: usize = 250;

struct PendingTaker {
    trade: DecodedTrade,
    deadline: Instant,
    created_at: Instant,
}

/// FIFO-evicting cache of emitted (txHash:wallet) → side.
/// Once a side is emitted for a tx+wallet, all subsequent events on the same
/// tx+wallet are suppressed (whether same-side duplicate or opposite-side phantom).
struct EmittedCache {
    map: HashMap<String, TradeSide>,
    order: VecDeque<String>,
}

impl EmittedCache {
    fn new() -> Self {
        Self {
            map: HashMap::with_capacity(MAX_EMITTED),
            order: VecDeque::with_capacity(MAX_EMITTED),
        }
    }

    fn get(&self, key: &str) -> Option<TradeSide> {
        self.map.get(key).copied()
    }

    fn insert(&mut self, key: String, side: TradeSide) {
        // Guard: if key already tracked (shouldn't happen due to already-emitted check),
        // update side but don't duplicate in VecDeque.
        if let std::collections::hash_map::Entry::Occupied(mut e) = self.map.entry(key.clone()) {
            e.insert(side);
            return;
        }
        if self.map.len() >= MAX_EMITTED {
            for _ in 0..EVICT_BATCH {
                if let Some(old) = self.order.pop_front() {
                    self.map.remove(&old);
                }
            }
        }
        self.map.insert(key.clone(), side);
        self.order.push_back(key);
    }
}

fn tx_wallet_key(trade: &DecodedTrade) -> String {
    format!("{}:{}", trade.transaction_hash, trade.proxy_wallet)
}

fn side_str(side: TradeSide) -> &'static str {
    match side {
        TradeSide::Buy => "BUY",
        TradeSide::Sell => "SELL",
    }
}

/// Spawn the phantom debouncer as a tokio task.
///
/// NegRisk complementary fills: when a NegRisk order is matched, the CTF exchange
/// emits TWO OrderFilled events — one for the real fill and one for the complementary
/// (phantom) fill on the opposite side. MAKER events are always the real fill;
/// TAKER events are debounced to allow a MAKER event to arrive and take priority.
///
/// Multi-fill accumulation: if multiple TAKER fills arrive for the same (txHash, wallet)
/// on the same side within the debounce window, they are accumulated with VWAP pricing.
pub fn spawn(
    mut input_rx: mpsc::Receiver<DecodedTrade>,
    output_tx: mpsc::Sender<DecodedTrade>,
) {
    tokio::spawn(async move {
        let mut emitted = EmittedCache::new();
        let mut pending: HashMap<String, PendingTaker> = HashMap::new();
        let mut override_count: u64 = 0;
        let mut override_total_ms: u64 = 0;
        let mut emit_count: u64 = 0;

        loop {
            let next_deadline = pending.values().map(|p| p.deadline).min();

            tokio::select! {
                biased; // prefer incoming events over timer (lower latency for makers)

                event = input_rx.recv() => {
                    let trade = match event {
                        Some(t) => t,
                        None => break, // channel closed
                    };

                    let key = tx_wallet_key(&trade);

                    // 1. Already emitted for this tx+wallet? Suppress.
                    if let Some(emitted_side) = emitted.get(&key) {
                        if emitted_side != trade.side {
                            tracing::debug!(
                                wallet = %&trade.proxy_wallet[..10],
                                suppressed = side_str(trade.side),
                                emitted = side_str(emitted_side),
                                maker = trade.is_maker,
                                tx = %&trade.transaction_hash[..18.min(trade.transaction_hash.len())],
                                "suppressed late phantom (already emitted opposite side)"
                            );
                        }
                        continue;
                    }

                    // 2. MAKER: emit immediately, cancel any pending taker.
                    if trade.is_maker {
                        if let Some(cancelled) = pending.remove(&key) {
                            let phantom_age_ms = cancelled.created_at.elapsed().as_millis() as u64;
                            override_count += 1;
                            override_total_ms += phantom_age_ms;
                            tracing::info!(
                                phantom_age_ms,
                                wallet = %&trade.proxy_wallet[..10],
                                cancelled_side = side_str(cancelled.trade.side),
                                maker_side = side_str(trade.side),
                                tx = %&trade.transaction_hash[..18.min(trade.transaction_hash.len())],
                                total_overrides = override_count,
                                avg_override_ms = override_total_ms / override_count.max(1),
                                "phantom override: MAKER cancelled pending TAKER"
                            );
                        }
                        emit_trade(&key, trade, &mut emitted, &output_tx, &mut emit_count).await;
                        continue;
                    }

                    // 3. TAKER: debounce or accumulate.
                    if let Some(existing) = pending.get_mut(&key) {
                        if existing.trade.side == trade.side {
                            // Same-side multi-fill: VWAP accumulation
                            let old_notional = existing.trade.size * existing.trade.price;
                            existing.trade.size += trade.size;
                            existing.trade.price =
                                (old_notional + trade.size * trade.price) / existing.trade.size;
                            tracing::debug!(
                                wallet = %&trade.proxy_wallet[..10],
                                side = side_str(trade.side),
                                added_size = format!("{:.4}", trade.size),
                                total_size = format!("{:.4}", existing.trade.size),
                                vwap = format!("{:.4}", existing.trade.price),
                                tx = %&trade.transaction_hash[..18.min(trade.transaction_hash.len())],
                                "accumulated multi-fill into pending taker"
                            );
                        }
                        // Opposite-side taker within debounce = phantom-of-phantom → drop
                        continue;
                    }

                    // First taker event for this tx+wallet: start debounce timer
                    let now = Instant::now();
                    pending.insert(key, PendingTaker {
                        trade,
                        deadline: now + Duration::from_millis(TAKER_DEBOUNCE_MS),
                        created_at: now,
                    });
                }

                // Timer branch: emit expired pending takers
                _ = async {
                    match next_deadline {
                        Some(d) => tokio::time::sleep_until(d).await,
                        None => std::future::pending::<()>().await,
                    }
                } => {
                    let now = Instant::now();
                    let expired: Vec<String> = pending
                        .iter()
                        .filter(|(_, p)| p.deadline <= now)
                        .map(|(k, _)| k.clone())
                        .collect();

                    for key in expired {
                        if let Some(p) = pending.remove(&key) {
                            if p.trade.is_neg_risk {
                                // NegRisk TAKER-only: no MAKER arrived → likely phantom complement.
                                // Skip execution to avoid wrong-side trade.
                                tracing::info!(
                                    wallet = %&p.trade.proxy_wallet[..10.min(p.trade.proxy_wallet.len())],
                                    side = side_str(p.trade.side),
                                    price = format!("{:.4}", p.trade.price),
                                    size = format!("{:.4}", p.trade.size),
                                    debounce_ms = p.created_at.elapsed().as_millis() as u64,
                                    tx = %&p.trade.transaction_hash[..18.min(p.trade.transaction_hash.len())],
                                    "skipped NegRisk TAKER-only (no MAKER override — likely phantom)"
                                );
                                emitted.insert(key, p.trade.side); // suppress late duplicates
                                continue;
                            }
                            tracing::debug!(
                                wallet = %&p.trade.proxy_wallet[..10.min(p.trade.proxy_wallet.len())],
                                side = side_str(p.trade.side),
                                size = format!("{:.4}", p.trade.size),
                                price = format!("{:.4}", p.trade.price),
                                debounce_ms = p.created_at.elapsed().as_millis() as u64,
                                tx = %&p.trade.transaction_hash[..18.min(p.trade.transaction_hash.len())],
                                "taker debounce expired, emitting"
                            );
                            emit_trade(&key, p.trade, &mut emitted, &output_tx, &mut emit_count).await;
                        }
                    }
                }
            }
        }

        // Graceful shutdown: flush remaining pending takers (skip NegRisk phantoms)
        for (key, p) in pending.drain() {
            if p.trade.is_neg_risk {
                tracing::debug!(
                    wallet = %&p.trade.proxy_wallet[..10.min(p.trade.proxy_wallet.len())],
                    side = side_str(p.trade.side),
                    "shutdown: skipped NegRisk TAKER-only"
                );
                continue;
            }
            emit_trade(&key, p.trade, &mut emitted, &output_tx, &mut emit_count).await;
        }

        tracing::info!(
            total_emitted = emit_count,
            phantom_overrides = override_count,
            avg_override_ms = override_total_ms / override_count.max(1),
            "phantom debouncer shutting down"
        );
    });
}

async fn emit_trade(
    key: &str,
    trade: DecodedTrade,
    emitted: &mut EmittedCache,
    output_tx: &mpsc::Sender<DecodedTrade>,
    emit_count: &mut u64,
) {
    emitted.insert(key.to_string(), trade.side);
    *emit_count += 1;

    if output_tx.send(trade).await.is_err() {
        tracing::warn!("phantom output channel closed");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_trade(
        tx_hash: &str,
        wallet: &str,
        side: TradeSide,
        is_maker: bool,
        size: f64,
        price: f64,
    ) -> DecodedTrade {
        DecodedTrade {
            proxy_wallet: wallet.to_string(),
            token_id: "1234567890123456789".to_string(),
            side,
            size,
            price,
            transaction_hash: tx_hash.to_string(),
            is_neg_risk: false, // default to standard CTF; NegRisk tests set true explicitly
            is_maker,
            block_number: 100,
            log_index: 1,
        }
    }

    #[tokio::test(start_paused = true)]
    async fn test_maker_emits_immediately() {
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        let trade = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            true,
            10.0,
            0.50,
        );
        in_tx.send(trade).await.unwrap();

        // Maker should emit without waiting for debounce
        let result = tokio::time::timeout(Duration::from_millis(10), out_rx.recv())
            .await
            .expect("maker should emit immediately")
            .unwrap();
        assert!(result.is_maker);
        assert_eq!(result.side, TradeSide::Buy);
        assert_eq!(result.size, 10.0);
    }

    #[tokio::test(start_paused = true)]
    async fn test_taker_debounced_100ms() {
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // Standard CTF taker: 100ms debounce (all takers get same debounce in Rust)
        // But since is_neg_risk=false, it should still EMIT after debounce (not skip)
        let trade = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            false,
            10.0,
            0.50,
        );
        in_tx.send(trade).await.unwrap();

        // Not emitted at 50ms
        let early = tokio::time::timeout(Duration::from_millis(50), out_rx.recv()).await;
        assert!(early.is_err(), "taker should not emit before debounce expires");

        // Emitted by 110ms (100ms debounce + margin)
        let result = tokio::time::timeout(Duration::from_millis(60), out_rx.recv())
            .await
            .expect("standard CTF taker should emit after 100ms debounce")
            .unwrap();
        assert!(!result.is_maker);
        assert_eq!(result.side, TradeSide::Buy);
    }

    #[tokio::test(start_paused = true)]
    async fn test_maker_overrides_pending_taker() {
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // NegRisk taker phantom arrives first
        let mut taker = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Sell,
            false,
            5.0,
            0.40,
        );
        taker.is_neg_risk = true;
        in_tx.send(taker).await.unwrap();

        // 30ms later, maker (real fill) arrives
        tokio::time::sleep(Duration::from_millis(30)).await;
        let mut maker = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            true,
            5.0,
            0.60,
        );
        maker.is_neg_risk = true;
        in_tx.send(maker).await.unwrap();

        // Should emit MAKER, not TAKER
        let result = tokio::time::timeout(Duration::from_millis(10), out_rx.recv())
            .await
            .expect("maker should emit")
            .unwrap();
        assert!(result.is_maker);
        assert_eq!(result.side, TradeSide::Buy);
        assert_eq!(result.price, 0.60);

        // No further events (taker cancelled + already-emitted suppression)
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(out_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn test_negrisk_vwap_then_maker_override() {
        // NegRisk: multiple taker fills accumulate, then MAKER overrides
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // First NegRisk taker fill
        let mut t1 = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            false,
            10.0,
            0.50,
        );
        t1.is_neg_risk = true;
        in_tx.send(t1).await.unwrap();

        // Second same-side fill 20ms later (VWAP accumulation)
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut t2 = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            false,
            20.0,
            0.60,
        );
        t2.is_neg_risk = true;
        t2.log_index = 2;
        in_tx.send(t2).await.unwrap();

        // MAKER arrives 30ms after second fill — overrides accumulated taker
        tokio::time::sleep(Duration::from_millis(30)).await;
        let mut maker = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            true,
            30.0,
            0.55,
        );
        maker.is_neg_risk = true;
        in_tx.send(maker).await.unwrap();

        // Should emit MAKER, not accumulated taker
        let result = tokio::time::timeout(Duration::from_millis(10), out_rx.recv())
            .await
            .expect("maker should emit")
            .unwrap();
        assert!(result.is_maker);
        assert_eq!(result.size, 30.0);
        assert_eq!(result.price, 0.55);

        // No taker events
        tokio::time::sleep(Duration::from_millis(200)).await;
        assert!(out_rx.try_recv().is_err());
    }

    #[tokio::test(start_paused = true)]
    async fn test_negrisk_opposite_taker_both_skipped() {
        // NegRisk: two opposite-side takers with no MAKER — both get skipped
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // First NegRisk taker (BUY)
        let mut t1 = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            false,
            10.0,
            0.50,
        );
        t1.is_neg_risk = true;
        in_tx.send(t1).await.unwrap();

        // Opposite-side taker (SELL) arrives — phantom-of-phantom, dropped by pending logic
        tokio::time::sleep(Duration::from_millis(20)).await;
        let mut t2 = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Sell,
            false,
            10.0,
            0.50,
        );
        t2.is_neg_risk = true;
        t2.log_index = 2;
        in_tx.send(t2).await.unwrap();

        // Wait for debounce — NegRisk taker-only gets skipped
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Nothing emitted (NegRisk taker-only skipped)
        assert!(
            out_rx.try_recv().is_err(),
            "NegRisk taker-only should be skipped"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn test_negrisk_taker_only_skipped() {
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // NegRisk TAKER with no MAKER following
        let mut trade = make_trade(
            "0xabc123def456abc123",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Sell,
            false, // taker
            5.0,
            0.22, // phantom complement price
        );
        trade.is_neg_risk = true; // NegRisk market
        in_tx.send(trade).await.unwrap();

        // Wait well past debounce
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Should NOT emit (NegRisk taker-only is suppressed)
        assert!(
            out_rx.try_recv().is_err(),
            "NegRisk taker-only should be skipped"
        );
    }

    #[tokio::test(start_paused = true)]
    async fn test_standard_ctf_taker_still_emits() {
        let (in_tx, in_rx) = mpsc::channel(16);
        let (out_tx, mut out_rx) = mpsc::channel(16);
        spawn(in_rx, out_tx);

        // Standard CTF (non-NegRisk) taker — 100ms debounce, should emit (not skip)
        let trade = make_trade(
            "0xdef456abc123def456",
            "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
            TradeSide::Buy,
            false,
            10.0,
            0.50,
        );
        // is_neg_risk=false by default from make_trade
        in_tx.send(trade).await.unwrap();

        // Wait for 100ms debounce to expire
        tokio::time::sleep(Duration::from_millis(200)).await;

        // Standard CTF taker should emit (not skipped like NegRisk)
        let result = out_rx.try_recv()
            .expect("standard CTF taker should emit after debounce (not skipped)");
        assert_eq!(result.side, TradeSide::Buy);
    }
}
