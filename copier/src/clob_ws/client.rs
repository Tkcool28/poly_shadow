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
            let _ = self.sub_cmd_tx.try_send(SubCommand::Subscribe(new));
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
    // Force HTTP/1.1 ALPN — Cloudflare rejects WebSocket upgrade over HTTP/2
    let tls_connector = {
        let mut builder = native_tls::TlsConnector::builder();
        builder.request_alpns(&["http/1.1"]);
        let connector = builder.build()?;
        tokio_tungstenite::Connector::NativeTls(connector)
    };
    let (mut ws, _) = tokio_tungstenite::connect_async_tls_with_config(
        url,
        None,
        false,
        Some(tls_connector),
    ).await?;
    tracing::info!("CLOB WS connected");

    // Send initial PING to keep connection alive (server may close idle connections)
    ws.send(Message::Text("PING".to_string())).await?;

    // Re-subscribe all currently tracked token IDs
    let current_ids: Vec<String> = subscribed.iter().map(|r| r.key().clone()).collect();
    if !current_ids.is_empty() {
        send_subscribe(&mut ws, &current_ids).await?;
        tracing::info!(count = current_ids.len(), "CLOB WS re-subscribed on reconnect");
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
                        if let Some(ticks) = parse_price_event(&text) {
                            for tick in ticks {
                                let _ = price_tx.send(tick);
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
    ws.send(Message::Text(msg.to_string())).await?;
    tracing::debug!(count = token_ids.len(), "CLOB WS subscribed");
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
/// Handles both single-event objects and arrays of events.
fn parse_price_event(text: &str) -> Option<Vec<PriceTick>> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;

    // Array of events
    if let Some(arr) = v.as_array() {
        let ticks: Vec<PriceTick> = arr.iter().filter_map(parse_single_event).collect();
        if ticks.is_empty() { return None; }
        return Some(ticks);
    }

    // Single event
    if let Some(tick) = parse_single_event(&v) {
        return Some(vec![tick]);
    }

    // price_change wrapper
    if let Some(changes) = v.get("price_changes").and_then(|c| c.as_array()) {
        let ticks: Vec<PriceTick> = changes.iter().filter_map(parse_single_event).collect();
        if ticks.is_empty() { return None; }
        return Some(ticks);
    }

    None
}

fn parse_single_event(v: &serde_json::Value) -> Option<PriceTick> {
    let event_type = v.get("event_type")?.as_str()?;
    if event_type != "last_trade_price" && event_type != "price_change" {
        return None;
    }

    let asset_id = v.get("asset_id")?.as_str()?;
    let price: f64 = v.get("price")?.as_str()?.parse().ok()?;
    let size: f64 = v.get("size").and_then(|s| s.as_str()?.parse().ok()).unwrap_or(0.0);
    let side = v.get("side").and_then(|s| s.as_str()).unwrap_or("").to_string();
    let timestamp_ms: i64 = v
        .get("timestamp")
        .and_then(|t| t.as_str()?.parse().ok())
        .unwrap_or_else(|| chrono::Utc::now().timestamp_millis());

    Some(PriceTick {
        timestamp_ms,
        token_id: asset_id.to_string(),
        price,
        size,
        side,
    })
}
