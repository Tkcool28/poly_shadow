pub mod messages;
pub mod receiver;
pub mod sender;

use std::time::Duration;

use anyhow::Result;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use tokio::sync::mpsc;
use tokio::time::Instant;

use crate::filter::SharedState;
use crate::state::capital::Capital;
use crate::state::markets::MarketMeta;
use crate::state::positions::CachedPosition;

use messages::{InboundMessage, OutboundMessage};

/// Connect to IPC socket, send seed_request, block until seed_state response.
/// Returns the connected UnixStream (caller passes it to spawn_ipc_task).
/// On failure: returns Err (caller should still spawn ipc_task with None).
pub async fn connect_and_seed(
    socket_path: &str,
    state: &SharedState,
) -> Result<UnixStream> {
    let mut stream = UnixStream::connect(socket_path).await?;

    // Send seed request directly on the stream (before splitting)
    let req = serde_json::to_string(&OutboundMessage::SeedRequest)?;
    stream
        .write_all(format!("{}\n", req).as_bytes())
        .await?;
    stream.flush().await?;

    // Read seed response with timeout
    let mut buf_reader = BufReader::new(&mut stream);
    let mut line = String::new();
    let seed_timeout = Duration::from_secs(30); // 57K+ majority rows takes ~10s on production DB
    match tokio::time::timeout(seed_timeout, buf_reader.read_line(&mut line)).await {
        Ok(Ok(n)) if n > 0 => {
            let msg: InboundMessage = serde_json::from_str(line.trim())
                .map_err(|e| anyhow::anyhow!("seed parse error: {}", e))?;
            apply_seed(msg, state)?;
        }
        Ok(Ok(_)) => return Err(anyhow::anyhow!("IPC socket closed during seed")),
        Ok(Err(e)) => return Err(e.into()),
        Err(_) => return Err(anyhow::anyhow!("IPC seed timeout (10s)")),
    }

    Ok(stream)
}

fn apply_seed(msg: InboundMessage, state: &SharedState) -> Result<()> {
    match msg {
        InboundMessage::SeedState {
            allocations,
            positions,
            capital,
            majority_data,
            markets,
            daily_live_spend,
            daily_paper_spend,
        } => {
            // Seed allocations
            let allocs: Vec<_> = allocations
                .into_iter()
                .map(receiver::convert_seed_alloc)
                .collect();
            state.allocations.seed(allocs);

            // Seed positions
            let pos_entries: Vec<_> = positions
                .into_iter()
                .map(|p| {
                    (
                        p.token_id,
                        p.alloc_id,
                        p.is_paper,
                        CachedPosition {
                            net_shares: p.net_shares,
                            net_usd: p.net_usd,
                            buy_cost: p.buy_cost,
                            buy_shares: p.buy_shares,
                        },
                    )
                })
                .collect();
            state.positions.seed(pos_entries);

            // Seed capital
            let cap_entries: Vec<_> = capital
                .into_iter()
                .map(|c| {
                    (
                        c.alloc_id,
                        Capital {
                            current: c.current,
                            deployed: c.deployed,
                            pending_buy: 0.0,
                        },
                    )
                })
                .collect();
            state.capital.seed(cap_entries);

            // Seed majority accumulator
            let maj_trades: Vec<_> = majority_data
                .into_iter()
                .map(|m| {
                    (
                        m.wallet,
                        m.condition_id,
                        m.outcome,
                        m.usd,
                        m.timestamp_ms,
                    )
                })
                .collect();
            state.accumulator.seed(maj_trades);

            // Seed markets
            let market_entries: Vec<_> = markets
                .into_iter()
                .map(|m| {
                    (
                        m.condition_id,
                        MarketMeta {
                            closed: m.closed,
                            end_date: m.end_date,
                            event_slug: m.event_slug,
                            question: m.question,
                            tokens: m.tokens,
                            tick_size: m.tick_size,
                            fetched_at: Instant::now(),
                        },
                    )
                })
                .collect();
            state.markets.seed(market_entries);

            // Seed daily spend
            state.capital.seed_daily_spend(false, daily_live_spend);
            state.capital.seed_daily_spend(true, daily_paper_spend);

            tracing::info!(
                allocs = state.allocations.count(),
                positions = state.positions.count(),
                capital = state.capital.count(),
                markets = state.markets.count(),
                "IPC seed applied"
            );
            Ok(())
        }
        _ => Err(anyhow::anyhow!("expected SeedState, got different message type")),
    }
}

/// Spawn the long-lived IPC task. Owns the outbound receiver.
/// Accepts Option<UnixStream> — None means seed failed, start in reconnect mode.
/// On disconnect: reconnects with exponential backoff (5s→30s cap).
/// Does NOT re-seed on reconnect (state is authoritative in Rust after startup).
pub fn spawn_ipc_task(
    initial_stream: Option<UnixStream>,
    socket_path: String,
    state: SharedState,
    outbound_rx: mpsc::Receiver<OutboundMessage>,
) {
    tokio::spawn(async move {
        let mut outbound_rx = outbound_rx;
        let mut maybe_stream = initial_stream;

        loop {
            // Get a connected stream (either from seed or reconnect)
            let stream = match maybe_stream.take() {
                Some(s) => s,
                None => {
                    let mut backoff = Duration::from_secs(5);
                    loop {
                        tokio::time::sleep(backoff).await;
                        match UnixStream::connect(&socket_path).await {
                            Ok(s) => {
                                tracing::info!("IPC reconnected");
                                break s;
                            }
                            Err(e) => {
                                tracing::warn!(
                                    error = %e,
                                    backoff_s = backoff.as_secs(),
                                    "IPC reconnect failed"
                                );
                                backoff = (backoff * 2).min(Duration::from_secs(30));
                            }
                        }
                    }
                }
            };

            let (read_half, write_half) = stream.into_split();

            // Spawn reader as child task
            let reader_state = state.clone();
            let reader_handle = tokio::spawn(async move {
                receiver::run(read_half, reader_state).await;
            });

            // Run writer INLINE (blocks until disconnect or rx closed)
            // sender::run takes &mut rx so the receiver survives across reconnections
            sender::run(write_half, &mut outbound_rx).await;

            // Writer exited → disconnect. Abort reader.
            reader_handle.abort();
            tracing::warn!("IPC disconnected, will reconnect...");
            // maybe_stream is None, so next iteration enters reconnect loop
        }
    });
}
