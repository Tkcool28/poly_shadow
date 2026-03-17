use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use crate::config::Config;
use super::RawLogEvent;

/// Contract addresses to subscribe to
const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";
const ORDER_FILLED_TOPIC: &str = "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";

const INITIAL_RECONNECT_MS: u64 = 1000;
const MAX_RECONNECT_MS: u64 = 30_000;

/// Spawn all configured WSS providers as independent tokio tasks.
pub fn spawn_providers(cfg: &Config, event_tx: mpsc::Sender<RawLogEvent>) {
    // Provider A (always)
    let cfg_a = cfg.clone();
    let tx_a = event_tx.clone();
    tokio::spawn(async move {
        run("A", &cfg_a.polygon_ws_rpc_url, &cfg_a.polygon_http_rpc_url, &cfg_a, tx_a).await;
    });

    // Provider B
    if let Some(ref url_b) = cfg.polygon_ws_rpc_url_b {
        let ws_url = url_b.clone();
        let http_url = cfg.polygon_http_rpc_url_b.clone().unwrap_or_default();
        let cfg_b = cfg.clone();
        let tx_b = event_tx.clone();
        tokio::spawn(async move {
            run("B", &ws_url, &http_url, &cfg_b, tx_b).await;
        });
    }

    // Provider C (only if different from A)
    if let Some(ref url_c) = cfg.polygon_ws_rpc_url_c.as_ref().filter(|c| *c != &cfg.polygon_ws_rpc_url) {
        let ws_url = url_c.to_string();
        let http_url = cfg.polygon_http_rpc_url_c.clone().unwrap_or_default();
        let cfg_c = cfg.clone();
        let tx_c = event_tx;
        tokio::spawn(async move {
            run("C", &ws_url, &http_url, &cfg_c, tx_c).await;
        });
    }
}

/// Run a single WSS provider with auto-reconnect.
/// This function never returns — it reconnects on failure with exponential backoff.
async fn run(
    label: &str,
    ws_url: &str,
    _http_url: &str,
    cfg: &Config,
    event_tx: mpsc::Sender<RawLogEvent>,
) {
    let mut reconnect_delay = INITIAL_RECONNECT_MS;

    loop {
        tracing::info!(provider = label, url = ws_url, "connecting to WSS");

        match connect_and_subscribe(label, ws_url, cfg, &event_tx).await {
            Ok(()) => {
                tracing::warn!(provider = label, "WSS connection closed cleanly");
                reconnect_delay = INITIAL_RECONNECT_MS; // Reset on clean close
            }
            Err(e) => {
                tracing::error!(provider = label, error = %e, "WSS connection failed");
            }
        }

        tracing::info!(
            provider = label,
            delay_ms = reconnect_delay,
            "reconnecting"
        );
        tokio::time::sleep(tokio::time::Duration::from_millis(reconnect_delay)).await;
        reconnect_delay = (reconnect_delay * 2).min(MAX_RECONNECT_MS);
    }
}

/// Connect to WSS, subscribe to OrderFilled events, and stream events to channel.
async fn connect_and_subscribe(
    label: &str,
    ws_url: &str,
    cfg: &Config,
    event_tx: &mpsc::Sender<RawLogEvent>,
) -> anyhow::Result<()> {
    let (mut ws, _response) = connect_async(ws_url).await?;
    tracing::info!(provider = label, "WSS connected");

    // Subscribe per wallet: 2 subscriptions each (maker topic[2], taker topic[3])
    let mut sub_id: u32 = 100;
    for wallet in &cfg.watched_wallets {
        let padded = format!("0x{:0>64}", &wallet[2..]);

        // Subscription 1: wallet as maker (topics[2])
        let maker_sub = serde_json::json!({
            "jsonrpc": "2.0",
            "id": sub_id,
            "method": "eth_subscribe",
            "params": ["logs", {
                "address": [CTF_EXCHANGE, NEG_RISK_EXCHANGE],
                "topics": [ORDER_FILLED_TOPIC, null, padded]
            }]
        });
        ws.send(Message::Text(maker_sub.to_string())).await?;
        sub_id += 1;

        // Subscription 2: wallet as taker (topics[3])
        let taker_sub = serde_json::json!({
            "jsonrpc": "2.0",
            "id": sub_id,
            "method": "eth_subscribe",
            "params": ["logs", {
                "address": [CTF_EXCHANGE, NEG_RISK_EXCHANGE],
                "topics": [ORDER_FILLED_TOPIC, null, null, padded]
            }]
        });
        ws.send(Message::Text(taker_sub.to_string())).await?;
        sub_id += 1;

        tracing::info!(
            provider = label,
            wallet = %&wallet[..10],
            subs = 2,
            "subscribed to OrderFilled"
        );
    }

    // Heartbeat timer
    let heartbeat_interval = tokio::time::Duration::from_millis(cfg.chain_heartbeat_ms);
    let stale_threshold = tokio::time::Duration::from_millis(cfg.chain_stale_ms);
    let mut heartbeat_timer = tokio::time::interval(heartbeat_interval);
    let mut last_activity = tokio::time::Instant::now();

    loop {
        tokio::select! {
            msg = ws.next() => {
                match msg {
                    Some(Ok(Message::Text(text))) => {
                        last_activity = tokio::time::Instant::now();
                        if let Some(event) = parse_subscription_event(&text, label)  {
                            event_tx.send(event).await.map_err(|_| {
                                tracing::warn!(provider = label, "event channel closed");
                                anyhow::anyhow!("event channel closed")
                            })?;
                        }
                    }
                    Some(Ok(Message::Ping(data))) => {
                        last_activity = tokio::time::Instant::now();
                        let _ = ws.send(Message::Pong(data)).await;
                    }
                    Some(Ok(Message::Pong(_))) => {
                        last_activity = tokio::time::Instant::now();
                    }
                    Some(Ok(Message::Close(_))) => {
                        tracing::info!(provider = label, "received close frame");
                        return Ok(());
                    }
                    Some(Err(e)) => {
                        return Err(e.into());
                    }
                    None => {
                        return Ok(()); // Stream ended
                    }
                    _ => {} // Binary, Frame — ignore
                }
            }
            _ = heartbeat_timer.tick() => {
                // Check stale connection
                if last_activity.elapsed() > stale_threshold {
                    tracing::warn!(
                        provider = label,
                        stale_ms = last_activity.elapsed().as_millis() as u64,
                        "connection stale, forcing reconnect"
                    );
                    return Err(anyhow::anyhow!("connection stale"));
                }

                // Send keepalive: eth_chainId + ws ping
                let keepalive = serde_json::json!({
                    "jsonrpc": "2.0",
                    "id": 999,
                    "method": "eth_chainId",
                    "params": []
                });
                let _ = ws.send(Message::Text(keepalive.to_string())).await;
                let _ = ws.send(Message::Ping(vec![])).await;
            }
        }
    }
}

/// Parse a WSS message as an eth_subscription log event.
/// Returns None for subscription confirmations, heartbeat responses, etc.
fn parse_subscription_event(text: &str, label: &str) -> Option<RawLogEvent> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;

    // eth_subscription notification: { "jsonrpc": "2.0", "method": "eth_subscription", "params": { "result": { ... } } }
    if v.get("method")?.as_str()? != "eth_subscription" {
        return None;
    }

    let result = v.get("params")?.get("result")?;

    let address = result.get("address")?.as_str()?.to_string();
    let topics: Vec<String> = result
        .get("topics")?
        .as_array()?
        .iter()
        .filter_map(|t| t.as_str().map(String::from))
        .collect();
    let data = result.get("data")?.as_str()?.to_string();
    let block_number = u64::from_str_radix(
        result.get("blockNumber")?.as_str()?.trim_start_matches("0x"),
        16,
    )
    .ok()?;
    let transaction_hash = result.get("transactionHash")?.as_str()?.to_string();
    let log_index = u64::from_str_radix(
        result.get("logIndex")?.as_str()?.trim_start_matches("0x"),
        16,
    )
    .ok()?;

    Some(RawLogEvent {
        provider_label: label.to_string(),
        address,
        topics,
        data,
        block_number,
        transaction_hash,
        log_index,
    })
}
