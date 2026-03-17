mod config;
mod state;
mod wss;

use tracing_subscriber::{fmt, EnvFilter};

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

    tracing::info!("polymarket-copier v0.1.0 starting");

    let cfg = config::Config::from_env()?;
    tracing::info!(
        wss_providers = cfg.wss_provider_count(),
        wallets = cfg.watched_wallets.len(),
        "config loaded"
    );

    // Channel: WSS providers → decode+dedup loop
    let (event_tx, mut event_rx) = tokio::sync::mpsc::channel::<wss::RawLogEvent>(4096);

    // Channel: decode+dedup → phantom debouncer
    let (phantom_tx, phantom_rx) = tokio::sync::mpsc::channel::<wss::DecodedTrade>(1024);

    // Channel: phantom debouncer → trade consumer
    let (trade_tx, mut trade_rx) = tokio::sync::mpsc::channel::<wss::DecodedTrade>(1024);

    // Start WSS providers as independent tasks
    wss::provider::spawn_providers(&cfg, event_tx);

    // Start phantom debouncer (taker debounce + maker override + VWAP accumulation)
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

    // Main trade consumer loop (post-phantom-debounce)
    let mut trade_count: u64 = 0;
    while let Some(trade) = trade_rx.recv().await {
        trade_count += 1;

        // TODO Phase 3+4: filter chain
        // TODO Phase 5: CLOB order

        tracing::info!(
            n = trade_count,
            wallet = %&trade.proxy_wallet[..10],
            side = ?trade.side,
            token = %&trade.token_id[..16.min(trade.token_id.len())],
            size = format!("{:.4}", trade.size),
            price = format!("{:.4}", trade.price),
            maker = trade.is_maker,
            neg_risk = trade.is_neg_risk,
            block = trade.block_number,
            tx = %&trade.transaction_hash[..18.min(trade.transaction_hash.len())],
            "trade ready for filter chain"
        );
    }

    tracing::info!(total_trades = trade_count, "shutting down");
    Ok(())
}
