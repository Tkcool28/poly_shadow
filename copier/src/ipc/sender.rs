use tokio::io::AsyncWriteExt;
use tokio::net::unix::OwnedWriteHalf;
use tokio::sync::mpsc;

use super::messages::OutboundMessage;

/// Run the writer loop: drain outbound messages and write JSONL to the socket.
/// Takes `&mut Receiver` so the receiver survives across reconnections.
/// Returns when the socket write fails (disconnect) or the channel is closed.
pub async fn run(
    mut write_half: OwnedWriteHalf,
    rx: &mut mpsc::Receiver<OutboundMessage>,
) {
    while let Some(msg) = rx.recv().await {
        match serde_json::to_string(&msg) {
            Ok(json) => {
                let line = format!("{}\n", json);
                if let Err(e) = write_half.write_all(line.as_bytes()).await {
                    tracing::warn!(error = %e, "IPC write failed, disconnecting");
                    return;
                }
                // Flush after each message — low volume, latency matters for DB writes
                if let Err(e) = write_half.flush().await {
                    tracing::warn!(error = %e, "IPC flush failed, disconnecting");
                    return;
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "IPC serialize failed, dropping message");
            }
        }
    }
    tracing::info!("IPC outbound channel closed, writer exiting");
}
