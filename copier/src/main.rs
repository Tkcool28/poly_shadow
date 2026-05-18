mod clob;
mod clob_ws;
mod config;
mod filter;
mod gtc_paper;
mod market_scanner;
#[cfg(unix)]
mod ipc;
#[cfg(not(unix))]
#[path = "ipc_stub.rs"]
mod ipc;
mod state;
mod wss;
#[cfg(test)]
mod test_clob_order;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use tokio::sync::mpsc;
use tracing_subscriber::{fmt, EnvFilter};

use clob::types::{ExecutionMethod, FillResult, FillStatus};
use filter::types::{FilterConfig, FilterResult, TradeSignal};
use filter::SharedState;
use ipc::messages::{self, OutboundMessage};
use wss::TradeSide;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Initialize structured logging
    fmt()
        .with_env_filter(
            EnvFilter::from_default_env()
                .add_directive("polymarket_copier=info".parse()?),
        )
        .with_target(false)
        .init();

    tracing::info!("polymarket-copier v0.2.0 starting");

    let cfg = config::Config::from_env()?;
    let filter_config = FilterConfig::from_env();
    tracing::info!(
        wss_providers = cfg.wss_provider_count(),
        wallets = cfg.watched_wallets.len(),
        paper_only = cfg.paper_only,
        "config loaded"
    );
    if cfg.paper_only {
        tracing::warn!("PAPER_ONLY=true — all allocations forced to paper mode, no real CLOB orders");
    }

    // ── State initialization ──
    let allocations = Arc::new(state::allocations::AllocationStore::new());
    let positions = Arc::new(state::positions::PositionTracker::new());
    let capital = Arc::new(state::capital::CapitalTracker::new());
    let markets = Arc::new(state::markets::MarketCache::new());
    let cooldowns = Arc::new(state::cooldowns::CooldownMaps::new());
    let accumulator = Arc::new(state::accumulator::MajorityAccumulator::new());
    let balance_paused = Arc::new(AtomicBool::new(false));
    let alloc_mutexes = Arc::new(state::alloc_mutex::AllocMutexMap::new());

    let shared_state = SharedState {
        allocations: allocations.clone(),
        positions: positions.clone(),
        capital: capital.clone(),
        markets: markets.clone(),
        cooldowns: cooldowns.clone(),
        accumulator: accumulator.clone(),
        balance_paused: balance_paused.clone(),
    };

    // ── CLOB client ──
    let clob_client = clob::ClobClient::from_config(&cfg)?;
    let clob_arc = clob_client.map(Arc::new);
    if clob_arc.is_some() {
        tracing::info!("CLOB client initialized");
    } else {
        tracing::warn!("CLOB client disabled (missing credentials) — paper-only mode");
    }

    // ── Metadata resolver ──
    let metadata_resolver = Arc::new(clob::metadata::MetadataResolver::new(
        &cfg.clob_base_url,
        markets.clone(),
    ));

    // ── IPC: connect + seed ──
    let (ipc_tx, ipc_rx) = mpsc::channel::<OutboundMessage>(256);
    let ipc_socket_path = std::env::var("IPC_SOCKET_PATH")
        .unwrap_or_else(|_| "/tmp/polymarket-copier.sock".to_string());

    let seed_stream = ipc::connect_and_seed(&ipc_socket_path, &shared_state).await;
    match &seed_stream {
        Ok(_) => tracing::info!("IPC connected, state seeded"),
        Err(e) => tracing::warn!(error = %e, "IPC seed failed, will connect in background"),
    }
    // Always spawn IPC task — if seed succeeded, pass the stream; if not, start in reconnect mode
    ipc::spawn_ipc_task(
        seed_stream.ok(),
        ipc_socket_path,
        shared_state.clone(),
        ipc_rx,
    );

    // ── GTC Paper: CLOB Market WS + price recording + fill tracking ──
    let (clob_ws_client, gtc_tracker) = if cfg.gtc_paper_enabled {
        tracing::info!(
            timeout_ms = cfg.gtc_paper_timeout_ms,
            parquet_dir = %cfg.parquet_data_dir,
            "GTC paper mode enabled"
        );
        let (client, _sub_tx) = clob_ws::ClobWsClient::spawn(cfg.clob_ws_url.clone());

        // Parquet price writer
        let parquet_rx = client.subscribe_prices();
        clob_ws::spawn_parquet_writer(
            parquet_rx,
            cfg.parquet_data_dir.clone(),
            cfg.parquet_flush_rows,
            cfg.parquet_flush_interval_ms,
        );

        // GTC paper tracker + tasks
        let tracker = Arc::new(gtc_paper::GtcPaperTracker::new(
            std::time::Duration::from_millis(cfg.gtc_paper_timeout_ms),
        ));
        let fill_rx = client.subscribe_prices();
        gtc_paper::spawn_fill_monitor(
            tracker.clone(),
            fill_rx,
            capital.clone(),
            ipc_tx.clone(),
            client.clone(),
        );
        gtc_paper::spawn_timeout_sweeper(
            tracker.clone(),
            capital.clone(),
            ipc_tx.clone(),
            client.clone(),
        );

        (client, tracker)
    } else {
        // No WS connection or tasks when GTC paper is disabled
        let client = clob_ws::ClobWsClient::new_disconnected();
        let tracker = Arc::new(gtc_paper::GtcPaperTracker::new(std::time::Duration::from_secs(10)));
        (client, tracker)
    };

    // ── Market Scanner: permanent updown market subscriptions ──
    if cfg.market_scanner_enabled && cfg.gtc_paper_enabled {
        tracing::info!("market scanner enabled — discovering updown markets");
        market_scanner::spawn_market_scanner(clob_ws_client.clone());
    }

    // ── WSS pipeline ──
    let (event_tx, mut event_rx) = mpsc::channel::<wss::RawLogEvent>(4096);
    let (phantom_tx, phantom_rx) = mpsc::channel::<wss::DecodedTrade>(1024);
    let (trade_tx, mut trade_rx) = mpsc::channel::<wss::DecodedTrade>(1024);

    wss::provider::spawn_providers(&cfg, event_tx);
    wss::phantom::spawn(phantom_rx, trade_tx);

    // Decode + dedup task
    let watched_wallets = cfg.watched_wallets.clone();
    let dedup = wss::dedup::DedupCache::new(500);
    tokio::spawn(async move {
        while let Some(raw_event) = event_rx.recv().await {
            let trade = match wss::decoder::decode_order_filled(&raw_event, &watched_wallets) {
                Some(t) => t,
                None => continue,
            };
            if !dedup.check_and_insert(&trade.dedup_key()) {
                continue;
            }
            if phantom_tx.send(trade).await.is_err() {
                tracing::warn!("phantom channel closed");
                break;
            }
        }
    });

    // ── Main trade consumer loop ──
    let mut trade_count: u64 = 0;
    let mut execute_count: u64 = 0;
    let mut skip_count: u64 = 0;

    while let Some(trade) = trade_rx.recv().await {
        trade_count += 1;
        let t0 = std::time::Instant::now();

        // 1. Look up allocation
        let mut alloc = match shared_state.allocations.get_active_by_wallet(&trade.proxy_wallet) {
            Some(a) => a,
            None => {
                tracing::info!(
                    wallet = %&trade.proxy_wallet[..10.min(trade.proxy_wallet.len())],
                    side = ?trade.side,
                    maker = trade.is_maker,
                    "no active allocation"
                );
                continue;
            }
        };

        // PAPER_ONLY safety guard: force all allocations to paper mode
        if cfg.paper_only && !alloc.is_paper {
            alloc.is_paper = true;
        }

        // 2. Maker fill filter (per-allocation opt-in)
        if trade.is_maker && !alloc.copy_maker_fills {
            tracing::info!(
                wallet = %&trade.proxy_wallet[..10.min(trade.proxy_wallet.len())],
                alloc = %alloc.id,
                "maker fill skipped (copyMakerFills=false)"
            );
            continue;
        }

        // 3. Resolve conditionId (cache-first, non-blocking)
        let condition_id = shared_state.markets.condition_for_token(&trade.token_id);
        if condition_id.is_none() {
            // Cache miss: spawn background resolution, skip this trade
            if !metadata_resolver.is_resolving(&trade.token_id) {
                let resolver = metadata_resolver.clone();
                let token_id = trade.token_id.clone();
                tokio::spawn(async move {
                    resolver.resolve_condition_id(&token_id).await;
                });
            }
            tracing::info!(
                token = %&trade.token_id[..16.min(trade.token_id.len())],
                wallet = %&trade.proxy_wallet[..10.min(trade.proxy_wallet.len())],
                "metadata cache miss, resolving in background"
            );
            continue;
        }

        // 4. Resolve tick_size (cache only, default "0.01")
        let tick_size = shared_state
            .markets
            .tick_size_for_token(&trade.token_id)
            .unwrap_or_else(|| "0.01".to_string());

        // 5. Build TradeSignal
        let signal = TradeSignal::from_decoded(&trade, condition_id.clone());

        // 6. Acquire per-allocation mutex
        let alloc_mutex = alloc_mutexes.get(&alloc.id);
        let _lock = alloc_mutex.lock().await;

        // 7. Run filter chain
        let filter_result = filter::chain::run(&signal, &alloc, &filter_config, &shared_state);

        // 8. Send TradeDetected IPC (fire-and-forget, ok to drop under load)
        if let Err(_) = ipc_tx.try_send(OutboundMessage::TradeDetected {
            proxy_wallet: trade.proxy_wallet.clone(),
            token_id: trade.token_id.clone(),
            side: messages::side_to_string(trade.side),
            size: trade.size,
            price: trade.price,
            transaction_hash: trade.transaction_hash.clone(),
            is_neg_risk: trade.is_neg_risk,
            is_maker: trade.is_maker,
            block_number: trade.block_number,
            condition_id: condition_id.clone(),
            event_slug: condition_id
                .as_ref()
                .and_then(|cid| shared_state.markets.event_slug(cid)),
            title: condition_id
                .as_ref()
                .and_then(|cid| shared_state.markets.question(cid)),
            detection_source: if trade.is_maker {
                "CHAIN_MAKER"
            } else {
                "CHAIN"
            }
            .to_string(),
            timestamp: chrono::Utc::now().timestamp(),
        }) {
            tracing::warn!("IPC TradeDetected dropped (channel full)");
        }

        // 9. Execute or skip
        match filter_result {
            FilterResult::Skip(reason) => {
                skip_count += 1;
                tracing::info!(
                    n = trade_count,
                    wallet = %&trade.proxy_wallet[..10.min(trade.proxy_wallet.len())],
                    side = ?trade.side,
                    token = %&trade.token_id[..16.min(trade.token_id.len())],
                    usd = format!("{:.2}", signal.usd),
                    alloc = %alloc.id,
                    paper = alloc.is_paper,
                    elapsed_us = t0.elapsed().as_micros() as u64,
                    "SKIP: {reason}"
                );
            }
            FilterResult::Execute(params) => {
                execute_count += 1;
                let exec_start = std::time::Instant::now();

                // Reserve capital for BUY
                if params.side == TradeSide::Buy {
                    if !shared_state
                        .capital
                        .reserve_buy(&alloc.id, params.copy_amount_usd)
                    {
                        tracing::warn!(
                            alloc = %alloc.id,
                            amount = params.copy_amount_usd,
                            "capital reserve failed at execution"
                        );
                        continue;
                    }
                }

                // Route: GTC paper → legacy paper → live
                let fill = if alloc.is_paper && cfg.gtc_paper_enabled {
                    // GTC paper: submit pending order, fill resolved async
                    let amount_usd = if params.side == TradeSide::Sell {
                        params.sell_shares.unwrap_or(0.0) * params.price
                    } else {
                        params.copy_amount_usd
                    };
                    clob_ws_client.subscribe(&[params.token_id.clone()]);
                    gtc_tracker.increment_ref(&params.token_id);
                    gtc_tracker.submit(gtc_paper::PendingGtcPaper {
                        alloc_id: alloc.id.clone(),
                        token_id: params.token_id.clone(),
                        side: params.side,
                        price: params.price,
                        amount_usd,
                        is_neg_risk: params.is_neg_risk,
                        created_at: std::time::Instant::now(),
                        timeout: std::time::Duration::from_millis(cfg.gtc_paper_timeout_ms),
                        proxy_wallet: alloc.proxy_wallet.clone(),
                        condition_id: signal.condition_id.clone(),
                        transaction_hash: trade.transaction_hash.clone(),
                    });
                    // Capital already reserved above — fill_monitor will commit or sweeper will release
                    // DON'T send CopyTradeResult — fill_monitor or timeout_sweeper handles it async
                    continue;
                } else if alloc.is_paper {
                    // Legacy paper: simulate immediately
                    let amount_usd = if params.side == TradeSide::Sell {
                        params.sell_shares.unwrap_or(0.0) * params.price
                    } else {
                        params.copy_amount_usd
                    };
                    match &clob_arc {
                        Some(clob) => {
                            clob.simulate_paper_fill(params.side, amount_usd, params.price)
                        }
                        None => FillResult {
                            status: FillStatus::Filled,
                            filled_size: amount_usd / params.price,
                            filled_price: params.price,
                            order_id: None,
                            execution_method: ExecutionMethod::Paper,
                        },
                    }
                } else {
                    // Live: FAK order
                    match &clob_arc {
                        Some(clob) => {
                            let amount_usd = if params.side == TradeSide::Sell {
                                // Convert sell_shares to USD for CLOB API
                                params.sell_shares.unwrap_or(0.0) * params.price
                            } else {
                                params.copy_amount_usd
                            };
                            let fee_bps = shared_state.markets.taker_base_fee_for_token(&params.token_id);
                            clob.place_fak_order(
                                &params.token_id,
                                params.side,
                                amount_usd,
                                params.price,
                                params.is_neg_risk,
                                &tick_size,
                                fee_bps,
                            )
                            .await
                        }
                        None => {
                            tracing::error!("live trade but no CLOB client");
                            if params.side == TradeSide::Buy {
                                shared_state
                                    .capital
                                    .release_pending(&alloc.id, params.copy_amount_usd);
                            }
                            continue;
                        }
                    }
                };

                let latency_ms = exec_start.elapsed().as_millis() as u64;

                // Handle fill result
                match fill.status {
                    FillStatus::Filled => {
                        let fill_usd = fill.filled_size * fill.filled_price;

                        match params.side {
                            TradeSide::Buy => {
                                shared_state
                                    .capital
                                    .commit_buy(&alloc.id, fill_usd, alloc.is_paper);
                                shared_state.positions.add_fill(
                                    &params.token_id,
                                    &alloc.id,
                                    alloc.is_paper,
                                    TradeSide::Buy,
                                    fill.filled_size,
                                    fill_usd,
                                );
                            }
                            TradeSide::Sell => {
                                // Compute cost basis from average buy price
                                let pos = shared_state.positions.get(
                                    &params.token_id,
                                    &alloc.id,
                                    alloc.is_paper,
                                );
                                let avg_buy_price = if pos.buy_shares > 0.0 {
                                    pos.buy_cost / pos.buy_shares
                                } else {
                                    fill.filled_price
                                };
                                let cost_basis = fill.filled_size * avg_buy_price;
                                shared_state
                                    .capital
                                    .record_sell(&alloc.id, fill_usd, cost_basis);
                                shared_state.positions.add_fill(
                                    &params.token_id,
                                    &alloc.id,
                                    alloc.is_paper,
                                    TradeSide::Sell,
                                    fill.filled_size,
                                    fill_usd,
                                );
                                shared_state
                                    .cooldowns
                                    .record_sell_fill(&alloc.id, &params.token_id);
                            }
                        }

                        // IPC: CopyTradeResult — MUST persist, use blocking send with timeout
                        let ipc_msg = OutboundMessage::CopyTradeResult {
                            detected_trade_id: Some(trade.transaction_hash.clone()),
                            allocation_id: alloc.id.clone(),
                            proxy_wallet: trade.proxy_wallet.clone(),
                            condition_id: condition_id.clone(),
                            token_id: params.token_id.clone(),
                            side: messages::side_to_string(params.side),
                            status: "FILLED".into(),
                            filled_price: fill.filled_price,
                            filled_size: fill.filled_size,
                            requested_amount: params.copy_amount_usd,
                            requested_price: params.price,
                            order_id: fill.order_id.clone(),
                            execution_method: fill.execution_method.as_str().to_string(),
                            latency_ms,
                            fail_reason: None,
                            is_paper: alloc.is_paper,
                        };
                        match tokio::time::timeout(
                            std::time::Duration::from_secs(1),
                            ipc_tx.send(ipc_msg),
                        )
                        .await
                        {
                            Ok(Ok(())) => {}
                            Ok(Err(_)) => tracing::error!("IPC channel closed, CopyTradeResult lost"),
                            Err(_) => tracing::error!("IPC send timeout (1s), CopyTradeResult lost"),
                        }

                        tracing::info!(
                            n = trade_count,
                            alloc = %alloc.id,
                            side = ?params.side,
                            token = %&params.token_id[..16.min(params.token_id.len())],
                            filled_size = format!("{:.4}", fill.filled_size),
                            filled_price = format!("{:.4}", fill.filled_price),
                            method = ?fill.execution_method,
                            latency_ms,
                            paper = alloc.is_paper,
                            "FILLED"
                        );
                    }
                    FillStatus::Skipped => {
                        // FAK ghost fill — handle GTC fallback
                        if params.side == TradeSide::Buy {
                            if !alloc.is_paper && cfg.gtc_fallback_enabled {
                                // Capital stays reserved — pass to GTC task
                                let gtc_fee_bps = shared_state.markets.taker_base_fee_for_token(&params.token_id);
                                clob::gtc_fallback::spawn(
                                    clob_arc.clone().unwrap(),
                                    clob::gtc_fallback::GtcFallbackParams {
                                        alloc_id: alloc.id.clone(),
                                        token_id: params.token_id.clone(),
                                        side: params.side,
                                        amount_usd: params.copy_amount_usd,
                                        price: params.price,
                                        is_neg_risk: params.is_neg_risk,
                                        tick_size: tick_size.clone(),
                                        fee_bps: gtc_fee_bps,
                                        is_paper: alloc.is_paper,
                                        rest_ms: cfg.gtc_fallback_rest_ms,
                                        alloc_mutex: alloc_mutex.clone(),
                                        proxy_wallet: trade.proxy_wallet.clone(),
                                        transaction_hash: trade.transaction_hash.clone(),
                                        condition_id: condition_id.clone(),
                                    },
                                    shared_state.capital.clone(),
                                    shared_state.positions.clone(),
                                    shared_state.cooldowns.clone(),
                                    ipc_tx.clone(),
                                );
                            } else {
                                // No GTC fallback — release capital
                                shared_state
                                    .capital
                                    .release_pending(&alloc.id, params.copy_amount_usd);
                            }
                            shared_state
                                .cooldowns
                                .record_buy_failure(&alloc.id, &params.token_id);
                        } else {
                            // SELL ghost fill — record cooldown
                            shared_state
                                .cooldowns
                                .record_sell_failure(&alloc.id, &params.token_id);
                        }

                        tracing::info!(
                            alloc = %alloc.id,
                            side = ?params.side,
                            token = %&params.token_id[..16.min(params.token_id.len())],
                            latency_ms,
                            gtc = cfg.gtc_fallback_enabled && !alloc.is_paper
                                && params.side == TradeSide::Buy,
                            "FAK unmatched"
                        );
                    }
                    FillStatus::Failed => {
                        if params.side == TradeSide::Buy {
                            shared_state
                                .capital
                                .release_pending(&alloc.id, params.copy_amount_usd);
                            shared_state
                                .cooldowns
                                .record_buy_failure(&alloc.id, &params.token_id);
                        } else {
                            shared_state
                                .cooldowns
                                .record_sell_failure(&alloc.id, &params.token_id);
                        }

                        tracing::warn!(
                            alloc = %alloc.id,
                            side = ?params.side,
                            token = %&params.token_id[..16.min(params.token_id.len())],
                            latency_ms,
                            "CLOB order failed"
                        );
                    }
                }
            }
        }
    }

    tracing::info!(
        total = trade_count,
        executed = execute_count,
        skipped = skip_count,
        "shutting down"
    );
    Ok(())
}
