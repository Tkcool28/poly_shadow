use std::sync::atomic::Ordering;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::net::unix::OwnedReadHalf;

use crate::filter::SharedState;
use crate::state::positions::CachedPosition;

use super::messages::{InboundMessage, SeedAllocation};

/// Run the reader loop: read JSONL from the socket and dispatch to state.
/// Returns when the socket is closed or a read error occurs.
pub async fn run(read_half: OwnedReadHalf, state: SharedState) {
    let mut reader = BufReader::new(read_half);
    let mut line = String::new();

    loop {
        line.clear();
        match reader.read_line(&mut line).await {
            Ok(0) => {
                tracing::warn!("IPC socket closed by Node.js");
                break;
            }
            Ok(_) => {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }
                match serde_json::from_str::<InboundMessage>(trimmed) {
                    Ok(msg) => dispatch(msg, &state),
                    Err(e) => {
                        let preview = &trimmed[..64.min(trimmed.len())];
                        tracing::warn!(error = %e, line = %preview, "IPC parse error");
                    }
                }
            }
            Err(e) => {
                tracing::error!(error = %e, "IPC read error");
                break;
            }
        }
    }
}

fn dispatch(msg: InboundMessage, state: &SharedState) {
    match msg {
        InboundMessage::AllocationUpdated { allocation } => {
            let alloc = convert_seed_alloc(allocation);
            tracing::info!(
                id = %alloc.id,
                wallet = %&alloc.proxy_wallet[..10.min(alloc.proxy_wallet.len())],
                "allocation updated via IPC"
            );
            state.allocations.upsert(alloc);
        }
        InboundMessage::AllocationDeactivated { alloc_id } => {
            state.allocations.deactivate(&alloc_id);
            tracing::info!(id = %alloc_id, "allocation deactivated via IPC");
        }
        InboundMessage::MarketSettled {
            condition_id,
            token_ids,
            settlement_prices,
        } => {
            state.markets.mark_closed(&condition_id);
            // Release capital + clear positions for ALL active allocations
            for alloc in state.allocations.get_all_active() {
                for (i, token_id) in token_ids.iter().enumerate() {
                    let pos =
                        state
                            .positions
                            .get(token_id, &alloc.id, alloc.is_paper);
                    if pos.net_shares > 0.0 {
                        let settlement_value = pos.net_shares
                            * settlement_prices.get(i).copied().unwrap_or(0.0);
                        let cost_basis = pos.buy_cost;
                        state.capital.release_settlement(
                            &alloc.id,
                            settlement_value,
                            cost_basis,
                        );
                    }
                }
                state.positions.clear_for_condition(
                    &token_ids,
                    &alloc.id,
                    alloc.is_paper,
                );
            }
            tracing::info!(
                condition = %&condition_id[..16.min(condition_id.len())],
                tokens = token_ids.len(),
                "market settled via IPC"
            );
        }
        InboundMessage::MarketClosed { condition_id } => {
            state.markets.mark_closed(&condition_id);
            tracing::debug!(condition = %&condition_id[..16.min(condition_id.len())], "market closed via IPC");
        }
        InboundMessage::PositionReconciled {
            token_id,
            alloc_id,
            is_paper,
            net_shares,
            net_usd,
            buy_cost,
            buy_shares,
        } => {
            state.positions.set(
                &token_id,
                &alloc_id,
                is_paper,
                CachedPosition {
                    net_shares,
                    net_usd,
                    buy_cost,
                    buy_shares,
                },
            );
            tracing::debug!(
                token = %&token_id[..16.min(token_id.len())],
                alloc = %alloc_id,
                shares = net_shares,
                "position reconciled via IPC"
            );
        }
        InboundMessage::CapitalReconciled {
            alloc_id,
            current,
            deployed,
        } => {
            state.capital.reconcile(&alloc_id, current, deployed);
            tracing::debug!(
                alloc = %alloc_id,
                current,
                deployed,
                "capital reconciled via IPC"
            );
        }
        InboundMessage::BalancePause { paused } => {
            state.balance_paused.store(paused, Ordering::Relaxed);
            tracing::info!(paused, "balance pause updated via IPC");
        }
        InboundMessage::SeedState { .. } => {
            // SeedState is handled during connect_and_seed(), not in the reader loop.
            tracing::warn!("unexpected SeedState in reader loop, ignoring");
        }
    }
}

pub fn convert_seed_alloc(
    sa: SeedAllocation,
) -> crate::state::allocations::Allocation {
    crate::state::allocations::Allocation {
        id: sa.id,
        proxy_wallet: sa.proxy_wallet,
        is_paper: sa.is_paper,
        is_active: sa.is_active,
        initial_capital: sa.initial_capital,
        copy_trade_percent: sa.copy_trade_percent,
        max_position_usd: sa.max_position_usd,
        max_prediction_position_usd: sa.max_prediction_position_usd,
        min_buy_price: sa.min_buy_price,
        exclude_event_slug_patterns: sa.exclude_event_slug_patterns,
        exclude_title_patterns: sa.exclude_title_patterns,
        majority_only_mode: sa.majority_only_mode,
        copy_maker_fills: sa.copy_maker_fills,
    }
}
