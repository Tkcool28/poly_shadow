use std::sync::Arc;
use std::time::Duration;

use tokio::sync::{mpsc, Mutex};

use crate::clob::types::{ExecutionMethod, FillStatus};
use crate::clob::ClobClient;
use crate::ipc::messages::{self, OutboundMessage};
use crate::state::capital::CapitalTracker;
use crate::state::cooldowns::CooldownMaps;
use crate::state::positions::PositionTracker;
use crate::wss::TradeSide;

/// Parameters for a GTC fallback order.
pub struct GtcFallbackParams {
    pub alloc_id: String,
    pub token_id: String,
    pub side: TradeSide,
    pub amount_usd: f64,
    pub price: f64, // signal price (GTC rests at fair value, no slippage)
    pub is_neg_risk: bool,
    pub tick_size: String,
    pub fee_bps: u32,
    pub is_paper: bool,
    pub rest_ms: u64,
    pub alloc_mutex: Arc<Mutex<()>>,
    pub proxy_wallet: String,
    pub transaction_hash: String,
    pub condition_id: Option<String>,
}

/// Spawn a fire-and-forget GTC fallback task.
/// Capital is ALREADY reserved by caller (from the FAK attempt).
/// The task places a GTC order, waits, then resolves (fill or cancel).
pub fn spawn(
    clob: Arc<ClobClient>,
    params: GtcFallbackParams,
    capital: Arc<CapitalTracker>,
    positions: Arc<PositionTracker>,
    cooldowns: Arc<CooldownMaps>,
    ipc_tx: mpsc::Sender<OutboundMessage>,
) {
    tokio::spawn(async move {
        // Step 0: Check minimum order size (CLOB rejects GTC < $5 / 5 shares)
        let min_shares = params.amount_usd / params.price;
        if params.amount_usd < 5.0 || min_shares < 5.0 {
            let _lock = params.alloc_mutex.lock().await;
            capital.release_pending(&params.alloc_id, params.amount_usd);
            tracing::debug!(
                alloc = %params.alloc_id,
                amount_usd = params.amount_usd,
                shares = min_shares,
                "GTC fallback: below minimum size, releasing capital"
            );
            return;
        }

        // Step 1: Place GTC order (outside mutex — idempotent)
        let fill = clob
            .place_gtc_order(
                &params.token_id,
                params.side,
                params.amount_usd,
                params.price,
                params.is_neg_risk,
                &params.tick_size,
                params.fee_bps,
            )
            .await;

        let order_id = match &fill.order_id {
            Some(id) if fill.status == FillStatus::Failed => {
                // Failed WITH order_id — CLOB may have accepted then rejected.
                // Cancel defensively to prevent silent fills.
                let _ = clob.cancel_order(id).await;
                let _lock = params.alloc_mutex.lock().await;
                capital.release_pending(&params.alloc_id, params.amount_usd);
                cooldowns.record_buy_failure(&params.alloc_id, &params.token_id);
                tracing::warn!(
                    alloc = %params.alloc_id,
                    order_id = %id,
                    "GTC fallback: failed with order_id, cancelled defensively"
                );
                return;
            }
            Some(id) => id.clone(),
            None => {
                // No order_id — genuine placement failure, nothing on CLOB to cancel
                let _lock = params.alloc_mutex.lock().await;
                capital.release_pending(&params.alloc_id, params.amount_usd);
                cooldowns.record_buy_failure(&params.alloc_id, &params.token_id);
                tracing::warn!(
                    alloc = %params.alloc_id,
                    token = %&params.token_id[..16.min(params.token_id.len())],
                    "GTC fallback: placement failed (no order_id)"
                );
                return;
            }
        };

        // Step 2: If already filled immediately (rare but possible)
        if fill.status == FillStatus::Filled && fill.filled_size > 0.0 {
            let _lock = params.alloc_mutex.lock().await;
            let fill_usd = fill.filled_size * fill.filled_price;
            capital.commit_buy(&params.alloc_id, fill_usd, params.is_paper);
            positions.add_fill(
                &params.token_id,
                &params.alloc_id,
                params.is_paper,
                params.side,
                fill.filled_size,
                fill_usd,
            );
            send_result(
                &ipc_tx,
                &params,
                "FILLED",
                fill.filled_price,
                fill.filled_size,
                Some(&order_id),
            );
            tracing::info!(
                alloc = %params.alloc_id,
                size = fill.filled_size,
                price = fill.filled_price,
                "GTC fallback: immediate fill"
            );
            return;
        }

        // Step 3: Wait for the rest period
        tokio::time::sleep(Duration::from_millis(params.rest_ms)).await;

        // Step 4: Check status under mutex
        let _lock = params.alloc_mutex.lock().await;

        match clob.get_order(&order_id).await {
            Ok(order_resp) => {
                let status = order_resp.status.as_deref().unwrap_or("unknown");

                if status == "MATCHED" || status == "matched" {
                    // Parse fill amounts from response
                    let making = order_resp
                        .making_amount
                        .as_deref()
                        .unwrap_or("0");
                    let taking = order_resp
                        .taking_amount
                        .as_deref()
                        .unwrap_or("0");

                    let (filled_size, filled_price) =
                        crate::clob::types::parse_fill_amounts(making, taking, params.side);

                    if filled_size > 0.0 && filled_price > 0.0 {
                        let fill_usd = filled_size * filled_price;
                        capital.commit_buy(&params.alloc_id, fill_usd, params.is_paper);
                        positions.add_fill(
                            &params.token_id,
                            &params.alloc_id,
                            params.is_paper,
                            params.side,
                            filled_size,
                            fill_usd,
                        );
                        send_result(
                            &ipc_tx,
                            &params,
                            "FILLED",
                            filled_price,
                            filled_size,
                            Some(&order_id),
                        );
                        tracing::info!(
                            alloc = %params.alloc_id,
                            size = filled_size,
                            price = filled_price,
                            order_id,
                            "GTC fallback filled"
                        );
                    } else {
                        // Matched but zero amounts — ghost fill
                        capital.release_pending(&params.alloc_id, params.amount_usd);
                        send_result(
                            &ipc_tx,
                            &params,
                            "SKIPPED",
                            0.0,
                            0.0,
                            Some(&order_id),
                        );
                    }
                } else {
                    // Not filled — MUST cancel before releasing capital
                    let cancel_ok = clob.cancel_order(&order_id).await.unwrap_or(false);
                    if !cancel_ok {
                        tracing::error!(
                            order_id,
                            alloc = %params.alloc_id,
                            "GTC cancel FAILED — order may still be live on CLOB!"
                        );
                    }
                    capital.release_pending(&params.alloc_id, params.amount_usd);
                    cooldowns.record_buy_failure(&params.alloc_id, &params.token_id);
                    send_result(
                        &ipc_tx,
                        &params,
                        "SKIPPED",
                        0.0,
                        0.0,
                        Some(&order_id),
                    );
                    tracing::info!(
                        alloc = %params.alloc_id,
                        status,
                        order_id,
                        cancelled = cancel_ok,
                        "GTC fallback unfilled, cancelled"
                    );
                }
            }
            Err(e) => {
                // get_order failed — CANCEL the order first, THEN release capital.
                // CRITICAL: Without cancellation, the GTC order stays live on CLOB
                // and may fill later, deploying real money with no tracking.
                let cancel_ok = clob.cancel_order(&order_id).await.unwrap_or(false);
                capital.release_pending(&params.alloc_id, params.amount_usd);
                cooldowns.record_buy_failure(&params.alloc_id, &params.token_id);
                tracing::error!(
                    error = %e,
                    alloc = %params.alloc_id,
                    order_id,
                    cancelled = cancel_ok,
                    "GTC fallback: get_order failed, cancelling order and releasing capital"
                );
                if !cancel_ok {
                    tracing::error!(
                        order_id,
                        "GTC cancel FAILED after get_order error — order may still be live!"
                    );
                }
            }
        }
    });
}

fn send_result(
    ipc_tx: &mpsc::Sender<OutboundMessage>,
    params: &GtcFallbackParams,
    status: &str,
    filled_price: f64,
    filled_size: f64,
    order_id: Option<&str>,
) {
    let _ = ipc_tx.try_send(OutboundMessage::CopyTradeResult {
        detected_trade_id: Some(params.transaction_hash.clone()),
        allocation_id: params.alloc_id.clone(),
        proxy_wallet: params.proxy_wallet.clone(),
        condition_id: params.condition_id.clone(),
        token_id: params.token_id.clone(),
        side: messages::side_to_string(params.side),
        status: status.to_string(),
        filled_price,
        filled_size,
        requested_amount: params.amount_usd,
        requested_price: params.price,
        order_id: order_id.map(|s| s.to_string()),
        execution_method: "GTC".to_string(),
        latency_ms: params.rest_ms,
        fail_reason: None,
        is_paper: params.is_paper,
    });
}
