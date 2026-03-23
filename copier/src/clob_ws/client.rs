use dashmap::DashSet;
use futures_util::{SinkExt, StreamExt};
use std::sync::Arc;
use tokio::sync::{broadcast, mpsc};
use tokio_tungstenite::tungstenite::Message;

const INITIAL_RECONNECT_MS: u64 = 1000;
const MAX_RECONNECT_MS: u64 = 30_000;
const PING_INTERVAL_MS: u64 = 10_000;
const STALE_THRESHOLD_MS: u64 = 30_000;
const BROADCAST_CAPACITY: usize = 4096;

/// A single price tick from CLOB Market WS.
#[derive(Debug, Clone)]
pub struct PriceTick {
    pub timestamp_ms: i64,
    pub token_id: String,
    pub price: f64,
    pub size: f64,
    pub side: String,
}

pub enum SubCommand {
    Subscribe(Vec<String>),
    Unsubscribe(Vec<String>),
}

/// Client for the Polymarket CLOB Market WebSocket.
/// Broadcasts PriceTick events to multiple consumers (fill_monitor, parquet_writer).
pub struct ClobWsClient {
    price_tx: broadcast::Sender<PriceTick>,
    subscribed: Arc<DashSet<String>>,
    sub_cmd_tx: mpsc::Sender<SubCommand>,
}

impl ClobWsClient {
    /// Get a new broadcast receiver for price ticks.
    pub fn subscribe_prices(&self) -> broadcast::Receiver<PriceTick> {
        self.price_tx.subscribe()
    }

    /// Subscribe to additional token IDs on the CLOB Market WS.
    pub fn subscribe(&self, token_ids: &[String]) {
        let new: Vec<String> = token_ids
            .iter()
            .filter(|id| self.subscribed.insert(id.to_string()))
            .cloned()
            .collect();
        if !new.is_empty() {
            tracing::info!(count = new.len(), first = %&new[0][..new[0].len().min(20)], "CLOB WS subscribing");
            if let Err(e) = self.sub_cmd_tx.try_send(SubCommand::Subscribe(new)) {
                tracing::warn!(error = %e, "CLOB WS subscribe send failed");
            }
        }
    }

    /// Unsubscribe from token IDs.
    pub fn unsubscribe(&self, token_ids: &[String]) {
        let removed: Vec<String> = token_ids
            .iter()
            .filter(|id| self.subscribed.remove(id.as_str()).is_some())
            .cloned()
            .collect();
        if !removed.is_empty() {
            let _ = self.sub_cmd_tx.try_send(SubCommand::Unsubscribe(removed));
        }
    }

    /// Create a disconnected client (no WS task). Used when GTC paper is disabled.
    pub fn new_disconnected() -> Arc<Self> {
        let (price_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (sub_cmd_tx, _) = mpsc::channel(256);
        Arc::new(Self {
            price_tx,
            subscribed: Arc::new(DashSet::new()),
            sub_cmd_tx,
        })
    }

    /// Spawn the WS client task. Returns the client and a sender for direct commands.
    pub fn spawn(url: String) -> (Arc<Self>, mpsc::Sender<SubCommand>) {
        let (price_tx, _) = broadcast::channel(BROADCAST_CAPACITY);
        let (sub_cmd_tx, sub_cmd_rx) = mpsc::channel(256);
        let subscribed = Arc::new(DashSet::new());

        let client = Arc::new(Self {
            price_tx: price_tx.clone(),
            subscribed: subscribed.clone(),
            sub_cmd_tx: sub_cmd_tx.clone(),
        });

        tokio::spawn(async move {
            run_ws_loop(url, price_tx, subscribed, sub_cmd_rx).await;
        });

        (client, sub_cmd_tx)
    }
}

/// Main WS loop with auto-reconnect. Never returns.
async fn run_ws_loop(
    url: String,
    price_tx: broadcast::Sender<PriceTick>,
    subscribed: Arc<DashSet<String>>,
    mut sub_cmd_rx: mpsc::Receiver<SubCommand>,
) {
    let mut reconnect_delay = INITIAL_RECONNECT_MS;

    loop {
        tracing::info!(url = %url, "CLOB WS connecting");

        match connect_and_stream(&url, &price_tx, &subscribed, &mut sub_cmd_rx).await {
            Ok(()) => {
                tracing::warn!("CLOB WS connection closed cleanly");
                reconnect_delay = INITIAL_RECONNECT_MS;
            }
            Err(e) => {
                tracing::error!(error = %e, "CLOB WS connection failed");
            }
        }

        tracing::info!(delay_ms = reconnect_delay, "CLOB WS reconnecting");
        tokio::time::sleep(tokio::time::Duration::from_millis(reconnect_delay)).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_MS);
    }
}

/// Connect, subscribe, and stream price events.
async fn connect_and_stream(
    url: &str,
    price_tx: &broadcast::Sender<PriceTick>,
    subscribed: &Arc<DashSet<String>>,
    sub_cmd_rx: &mut mpsc::Receiver<SubCommand>,
) -> anyhow::Result<()> {
    // Build request with headers that Cloudflare expects
    let request = tokio_tungstenite::tungstenite::http::Request::builder()
        .uri(url)
        .header("Host", "ws-subscriptions-clob.polymarket.com")
        .header("Origin", "https://polymarket.com")
        .header("User-Agent", "Mozilla/5.0")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header("Sec-WebSocket-Key", tokio_tungstenite::tungstenite::handshake::client::generate_key())
        .body(())?;

    // Force HTTP/1.1 ALPN — Cloudflare rejects WebSocket upgrade over HTTP/2
    let tls_connector = {
        let mut builder = native_tls::TlsConnector::builder();
        builder.request_alpns(&["http/1.1"]);
        let connector = builder.build()?;
        tokio_tungstenite::Connector::NativeTls(connector)
    };
    let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        request,
        None,
        false,
        Some(tls_connector),
    ).await?;
    tracing::info!("CLOB WS connected");

    // Send subscription immediately — server disconnects if no subscription within ~20ms
    // Use a dummy token ID if nothing to subscribe to yet (server needs at least one sub message)
    // Re-subscribe tracked token IDs on reconnect
    let current_ids: Vec<String> = subscribed.iter().map(|r| r.key().clone()).collect();
    if !current_ids.is_empty() {
        send_subscribe(&mut ws, &current_ids).await?;
        tracing::info!(count = current_ids.len(), "CLOB WS subscribed on connect");
    }

    let ping_interval = tokio::time::Duration::from_millis(PING_INTERVAL_MS);
    let stale_threshold = tokio::time::Duration::from_millis(STALE_THRESHOLD_MS);
    let mut ping_timer = tokio::time::interval(ping_interval);
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        if text == "PONG" {
                            continue;
                        }
                        // Count raw messages for debugging
                        static MSG_COUNT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
                        let n = MSG_COUNT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                        if n == 0 || n == 10 || n == 100 {
                            tracing::info!(n, len = text.len(), preview = %&text[..text.len().min(80)], "CLOB WS raw msg");
                        }
                        if let Some(ticks) = parse_price_event(&text) {
                            for tick in &ticks {
                                let _ = price_tx.send(tick.clone());
                            }
                            static LOGGED_FIRST: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
                            if !LOGGED_FIRST.swap(true, std::sync::atomic::Ordering::Relaxed) {
                                tracing::info!(count = ticks.len(), "CLOB WS first price data parsed");
                            }
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        last_activity = tokio::time::Instant::now();
                        let _ = ws.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_activity = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Close(_))) => return Ok(()),
                    Some(Err(e)) => return Err(e.into()),
                    None => return Ok(()),
                    _ => {}
                }
            }
            _ = ping_timer.tick() => {
                if last_activity.elapsed() > stale_threshold {
                    tracing::warn!(
                        stale_ms = last_activity.elapsed().as_millis() as u64,
                        "CLOB WS stale, forcing reconnect"
                    );
                    return Err(anyhow::anyhow!("CLOB WS stale"));
                }
                let _ = ws.send(Message::Text("PING".to_string())).await;
            }
            cmd = sub_cmd_rx.recv() => {
                match cmd {
                    Some(SubCommand::Subscribe(ids)) => {
                        send_subscribe(&mut ws, &ids).await?;
                    }
                    Some(SubCommand::Unsubscribe(ids)) => {
                        send_unsubscribe(&mut ws, &ids).await?;
                    }
                    None => return Ok(()),
                }
            }
        }
    }
}

/// Send subscribe message to CLOB Market WS.
async fn send_subscribe(
    ws: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    token_ids: &[String],
) -> anyhow::Result<()> {
    let msg = serde_json::json!({
        "assets_ids": token_ids,
        "type": "market",
        "custom_feature_enabled": true,
    });
    let msg_str = msg.to_string();
    tracing::info!(count = token_ids.len(), msg_len = msg_str.len(), "CLOB WS sending subscribe");
    ws.send(Message::Text(msg_str)).await?;
    Ok(())
}

/// Send unsubscribe message to CLOB Market WS.
async fn send_unsubscribe(
    ws: &mut (impl SinkExt<Message, Error = tokio_tungstenite::tungstenite::Error> + Unpin),
    token_ids: &[String],
) -> anyhow::Result<()> {
    let msg = serde_json::json!({
        "assets_ids": token_ids,
        "type": "market",
        "unsubscribe": true,
    });
    ws.send(Message::Text(msg.to_string())).await?;
    tracing::debug!(count = token_ids.len(), "CLOB WS unsubscribed");
    Ok(())
}

/// Parse CLOB Market WS events into PriceTicks.
/// The frontend endpoint often omits `event_type` — detect from structure.
fn parse_price_event(text: &str) -> Option<Vec<PriceTick>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;

    // Array of events
    if let Some(arr) = v.as_array() {
        let mut ticks = Vec::new();
        for item in arr {
            ticks.extend(parse_any_event(item));
        }
        if ticks.is_empty() { return None; }
        return Some(ticks);
    }

    // Single event
    let ticks = parse_any_event(&v);
    if ticks.is_empty() { None } else { Some(ticks) }
}

/// Parse any event by detecting type from structure (not event_type field).
fn parse_any_event(v: &serde_json::Value) -> Vec<PriceTick> {
    // 1. Has "price_changes" array → orderbook update
    if v.get("price_changes").and_then(|c| c.as_array()).is_some() {
        return parse_price_changes(v);
    }

    // 2. Has "bids"/"asks" → book snapshot
    if v.get("bids").is_some() && v.get("asks").is_some() {
        if let Some(tick) = parse_book_snapshot(v) {
            return vec![tick];
        }
    }

    // 3. Has explicit event_type (non-frontend endpoint)
    if let Some(tick) = parse_single_event(v) {
        return vec![tick];
    }

    Vec::new()
}

fn parse_single_event(v: &serde_json::Value) -> Option<PriceTick> {
    let event_type = v.get("event_type")?.as_str()?;
    if event_type != "last_trade_price" { return None; }

    let asset_id = v.get("asset_id")?.as_str()?;
    let price: f64 = v.get("price").and_then(|p| {
        p.as_str().and_then(|s| s.parse().ok()).or_else(|| p.as_f64())
    })?;
    let size: f64 = v.get("size").and_then(|s| {
        s.as_str().and_then(|s| s.parse().ok()).or_else(|| s.as_f64())
    }).unwrap_or(0.0);
    let side = v.get("side").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let timestamp_ms: i64 = v.get("timestamp").and_then(|t| {
        t.as_str().and_then(|s| s.parse().ok()).or_else(|| t.as_i64())
    }).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    Some(PriceTick { timestamp_ms, token_id: asset_id.to_string(), price, size, side })
}

/// Parse a book snapshot into a PriceTick (best ask price for GTC fill detection).
fn parse_book_snapshot(v: &serde_json::Value) -> Option<PriceTick> {
    let asset_id = v.get("asset_id")?.as_str()?;
    let asks = v.get("asks")?.as_array()?;
    if asks.is_empty() { return None; }
    let best_ask = asks.iter()
        .filter_map(|a| a.get("price").and_then(|p| p.as_str()?.parse::<f64>().ok()))
        .fold(f64::MAX, f64::min);
    if best_ask >= 1.0 { return None; }
    let timestamp_ms: i64 = v.get("timestamp").and_then(|t| {
        t.as_str().and_then(|s| s.parse().ok())
    }).unwrap_or_else(|| chrono::Utc::now().timestamp_millis());
    Some(PriceTick {
        timestamp_ms,
        token_id: asset_id.to_string(),
        price: best_ask,
        size: 0.0,
        side: "ASK".to_string(),
    })
}

/// Parse price_change events with nested price_changes array.
fn parse_price_changes(v: &serde_json::Value) -> Vec<PriceTick> {
    let mut ticks = Vec::new();
    let asset_id = match v.get("asset_id").and_then(|a| a.as_str()) {
        Some(id) => id,
        None => return ticks,
    };
    let changes = match v.get("price_changes").and_then(|c| c.as_array()) {
        Some(arr) => arr,
        None => return ticks,
    };
    let ts = chrono::Utc::now().timestamp_millis();
    for pc in changes {
        let price: f64 = match pc.get("price").and_then(|p| p.as_str()?.parse().ok()) {
            Some(p) => p,
            None => continue,
        };
        let size: f64 = pc.get("size").and_then(|s| s.as_str()?.parse().ok()).unwrap_or(0.0);
        let side = pc.get("side").and_then(|s| s.as_str()).unwrap_or("").to_string();
        ticks.push(PriceTick { timestamp_ms: ts, token_id: asset_id.to_string(), price, size, side });
    }
    ticks
}
