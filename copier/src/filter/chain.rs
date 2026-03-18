use std::sync::atomic::Ordering;

use crate::state::allocations::Allocation;
use crate::wss::TradeSide;

use super::SharedState;
use super::types::{ExecuteParams, FilterConfig, FilterResult, TradeSignal};

/// Run the complete 21-step filter chain.
/// Matches Node.js phaseA (copy-trader.ts lines 297-707) exactly.
///
/// Side effects: records majority accumulator BUY (step 5) regardless of outcome.
/// Caller is responsible for per-allocation Mutex serialization.
pub fn run(
    signal: &TradeSignal,
    alloc: &Allocation,
    config: &FilterConfig,
    state: &SharedState,
) -> FilterResult {
    let is_paper = alloc.is_paper;
    let is_buy = signal.side == TradeSide::Buy;

    // Effective config (per-allocation overrides > global defaults)
    let copy_percent = alloc.copy_trade_percent.unwrap_or(config.copy_trade_percent);
    let max_per_trade = alloc.max_position_usd.unwrap_or(config.max_position_usd);
    let max_per_prediction = alloc
        .max_prediction_position_usd
        .unwrap_or(config.max_prediction_position_usd);

    // ─── 1. Config validation ───
    if copy_percent <= 0.0 || copy_percent > 1.0 || max_per_trade <= 0.0 {
        return FilterResult::Skip("invalid sizing config".into());
    }

    // ─── 2. Balance pause (live BUY only) ───
    if !is_paper && is_buy && state.balance_paused.load(Ordering::Relaxed) {
        return FilterResult::Skip(
            "live trading paused: insufficient wallet balance".into(),
        );
    }

    // ─── 3. Market closed (BUY only) ───
    if is_buy && config.market_end_gatekeep_enabled
        && let Some(cid) = &signal.condition_id
            && state.markets.is_closed(cid) == Some(true) {
                return FilterResult::Skip("market already closed".into());
            }

    // ─── 4. Crypto updown expiration (BUY only) ───
    if is_buy && config.market_end_gatekeep_enabled
        && let Some(cid) = &signal.condition_id
            && let Some(slug) = state.markets.event_slug(cid) {
                let is_updown = slug.starts_with("btc-updown")
                    || slug.starts_with("sol-updown")
                    || slug.starts_with("eth-updown")
                    || slug.starts_with("xrp-updown");
                if is_updown
                    && let Some(end_ts) = state.markets.end_date(cid) {
                        let now_ts = chrono::Utc::now().timestamp();
                        if now_ts > end_ts {
                            return FilterResult::Skip(format!(
                                "crypto updown market expired (endDate: {end_ts})"
                            ));
                        }
                    }
            }

    // ─── 5. Majority accumulator recording (BUY only, always) ───
    // Must happen BEFORE skip filters so accumulator has complete data.
    if is_buy
        && let Some(cid) = &signal.condition_id {
            let now_ms = chrono::Utc::now().timestamp_millis() as u64;
            state.accumulator.record_buy(
                &signal.proxy_wallet,
                cid,
                &signal.token_id, // tokenId as outcome key
                signal.usd,
                now_ms,
            );
        }

    // ─── 6. Signal age (live BUY only) ───
    if !is_paper && is_buy && config.max_signal_age_ms > 0 {
        let now_ms = chrono::Utc::now().timestamp_millis() as u64;
        let age_ms = now_ms.saturating_sub(signal.detected_at_ms);
        if age_ms > config.max_signal_age_ms {
            return FilterResult::Skip(format!(
                "signal too old: {}s > {}s max",
                age_ms / 1000,
                config.max_signal_age_ms / 1000
            ));
        }
    }

    // ─── 7. Min buy price (BUY only) ───
    if is_buy
        && let Some(min_price) = alloc.min_buy_price
            && signal.price < min_price - 0.001 {
                return FilterResult::Skip(format!(
                    "price {:.2} below minBuyPrice {:.2}",
                    signal.price, min_price
                ));
            }

    // ─── 8. Event slug exclusion (BUY only, fail-closed) ───
    if is_buy && !alloc.exclude_event_slug_patterns.is_empty() {
        match &signal.condition_id {
            Some(cid) => match state.markets.event_slug(cid) {
                Some(slug) => {
                    let slug_lower = slug.to_lowercase();
                    if alloc
                        .exclude_event_slug_patterns
                        .iter()
                        .any(|p| slug_lower.contains(p))
                    {
                        return FilterResult::Skip(format!(
                            "eventSlug \"{slug}\" matches exclude pattern"
                        ));
                    }
                }
                None => {
                    return FilterResult::Skip(
                        "eventSlug unavailable (fail-closed for exclude filter)".into(),
                    );
                }
            },
            None => {
                return FilterResult::Skip(
                    "conditionId unavailable (fail-closed for exclude filter)".into(),
                );
            }
        }
    }

    // ─── 9. Title exclusion (BUY only, fail-closed) ───
    if is_buy && !alloc.exclude_title_patterns.is_empty() {
        match &signal.condition_id {
            Some(cid) => match state.markets.question(cid) {
                Some(title) => {
                    let title_lower = title.to_lowercase();
                    if alloc
                        .exclude_title_patterns
                        .iter()
                        .any(|p| title_lower.contains(p))
                    {
                        return FilterResult::Skip("title matches exclude pattern".into());
                    }
                }
                None => {
                    return FilterResult::Skip(
                        "title unavailable (fail-closed for exclude filter)".into(),
                    );
                }
            },
            None => {
                return FilterResult::Skip(
                    "conditionId unavailable (fail-closed for title filter)".into(),
                );
            }
        }
    }

    // ─── 10. Majority gate (BUY only, opt-in) ───
    let mut majority_total_usd: Option<f64> = None;
    if is_buy && alloc.majority_only_mode {
        match &signal.condition_id {
            Some(cid) => {
                let result = state.accumulator.get_majority(
                    &signal.proxy_wallet,
                    cid,
                    config.majority_min_usd,
                    config.majority_min_ratio,
                    Some(&signal.token_id),
                    signal.usd,
                );
                match result {
                    None => {
                        return FilterResult::Skip(
                            "majority accumulating: insufficient signal".into(),
                        );
                    }
                    Some(ref maj) if maj.num_outcomes < 2 => {
                        return FilterResult::Skip(format!(
                            "majority gate: only {} outcome(s) seen (${:.0}) — waiting for both sides",
                            maj.num_outcomes, maj.total_usd
                        ));
                    }
                    Some(ref maj) if signal.token_id != maj.outcome => {
                        return FilterResult::Skip(format!(
                            "majority is \"{}\" ({:.0}% of ${:.0}) — skipping minority",
                            truncate(&maj.outcome, 16),
                            maj.ratio * 100.0,
                            maj.total_usd,
                        ));
                    }
                    Some(ref maj) => {
                        majority_total_usd = Some(maj.total_usd);
                    }
                }
            }
            None => {
                return FilterResult::Skip(
                    "majority gate: conditionId unavailable (fail-closed)".into(),
                );
            }
        }
    }

    // ─── 11. Committed side lock (BUY only) ───
    if is_buy && config.committed_side_lock
        && let Some(opposite_token) = state.markets.opposite_token(&signal.token_id) {
            let opp_pos = state.positions.get(&opposite_token, &alloc.id, is_paper);
            if opp_pos.net_usd >= 0.01 {
                return FilterResult::Skip(format!(
                    "committed side lock: ${:.2} on opposite outcome",
                    opp_pos.net_usd
                ));
            }
        }

    // ─── 12. Sell cooldown (BUY only) ───
    if is_buy && state.cooldowns.is_sell_cooldown(&alloc.id, &signal.token_id) {
        return FilterResult::Skip("token sell cool-down active".into());
    }

    // ─── 13. Buy failure cooldown (BUY only) ───
    if is_buy && state.cooldowns.is_buy_failure_cooldown(&alloc.id, &signal.token_id) {
        return FilterResult::Skip("buy failure cooldown active".into());
    }

    // ─── 14. Live SELL-copy disabled ───
    if !is_paper && signal.side == TradeSide::Sell {
        return FilterResult::Skip(
            "live SELL-copy disabled (hold-to-settlement strategy)".into(),
        );
    }

    // ═══════════════════════════════════════════════════════
    // SIZING
    // ═══════════════════════════════════════════════════════

    let copy_amount_usd: f64;
    let mut sell_shares: Option<f64> = None;

    if signal.side == TradeSide::Sell {
        // ─── SELL PATH ───

        // Sell failure cooldown
        if state
            .cooldowns
            .is_sell_failure_cooldown(&alloc.id, &signal.token_id)
        {
            return FilterResult::Skip("sell failure cooldown active".into());
        }

        // Check held shares (settled positions are cleared via IPC → netShares = 0)
        let held = state
            .positions
            .get(&signal.token_id, &alloc.id, is_paper);
        if held.net_shares < 0.01 {
            return FilterResult::Skip("no shares held to sell".into());
        }

        // Floor to 2 decimal places
        let shares = (held.net_shares * 100.0).floor() / 100.0;
        copy_amount_usd = shares * signal.price;
        sell_shares = Some(shares);
    } else {
        // ─── BUY PATH ───

        // Available capital
        let available = state.capital.available(&alloc.id);
        if available <= 0.0 {
            return FilterResult::Skip(
                "insufficient allocated capital (zero balance)".into(),
            );
        }

        // Sizing base
        let fragment_usd = signal.usd;
        let trader_trade_usd = majority_total_usd.unwrap_or(fragment_usd);

        // Min signal trade USD (disabled if 0)
        if config.min_signal_trade_usd > 0.0 && trader_trade_usd < config.min_signal_trade_usd {
            return FilterResult::Skip(format!(
                "signal trade size ${:.2} below minimum ${:.2}",
                trader_trade_usd, config.min_signal_trade_usd
            ));
        }

        // Copy percent & max per trade cap
        let mut amt = (trader_trade_usd * copy_percent).min(max_per_trade);

        // Position for this token (used by multiple checks below)
        let position = state
            .positions
            .get(&signal.token_id, &alloc.id, is_paper);

        // ─── 15. Per-prediction position cap ───
        if max_per_prediction > 0.0 {
            let remaining = max_per_prediction - position.net_usd;
            if remaining < 0.01 {
                return FilterResult::Skip("prediction position limit reached".into());
            }
            amt = amt.min(remaining);
        }

        // ─── 16. Hedge guard ───
        let mut hedge_max_usd = f64::MAX;
        if config.hedge_price_ratio > 0.0 && signal.price < config.hedge_price_ratio
            && let Some(opp_token) = state.markets.opposite_token(&signal.token_id) {
                let opp = state.positions.get(&opp_token, &alloc.id, is_paper);
                let avg_buy_price = if opp.buy_shares > 0.0 {
                    opp.buy_cost / opp.buy_shares
                } else {
                    0.0
                };
                let has_opposite = avg_buy_price > 0.0 && opp.net_usd >= 0.01;

                if !has_opposite {
                    // Naked BUY — block cheap entries with no backing position
                    if config.hedge_naked_max_price > 0.0
                        && signal.price <= config.hedge_naked_max_price
                    {
                        return FilterResult::Skip(format!(
                            "hedge guard: naked BUY @{:.2} ≤ {:.2} with no opposite position",
                            signal.price, config.hedge_naked_max_price
                        ));
                    }
                } else {
                    // Has opposite position
                    let is_hedge = signal.price < config.hedge_price_ratio * avg_buy_price;
                    if is_hedge {
                        if opp.net_usd < config.hedge_min_opposite_usd {
                            return FilterResult::Skip(format!(
                                "hedge guard: opposite ${:.2} < ${:.2} minimum",
                                opp.net_usd, config.hedge_min_opposite_usd
                            ));
                        }
                        hedge_max_usd = opp.net_usd * config.hedge_max_ratio;
                        amt = amt.min(hedge_max_usd);
                    }
                }
            }

        // ─── 17. CLOB $1 minimum (live BUY only) ───
        if !is_paper && amt < config.clob_min_order_usd {
            if position.net_usd < 0.01 {
                // First entry → bump to minimum (capped by hedge)
                let bumped = config.clob_min_order_usd.min(hedge_max_usd);
                if bumped < config.clob_min_order_usd {
                    return FilterResult::Skip(format!(
                        "hedge cap ${:.2} below CLOB minimum ${:.2}",
                        hedge_max_usd, config.clob_min_order_usd
                    ));
                }
                amt = bumped;
            } else {
                // Add-on sub-$1 → skip (no pooling in V2)
                return FilterResult::Skip(format!(
                    "sub-$1 add-on ${:.2} (no pooling in V2)",
                    amt
                ));
            }
        }

        // ─── 18. Daily loss limit ───
        let daily_remaining =
            config.max_daily_loss_usd - state.capital.daily_spend(is_paper);
        if daily_remaining <= 0.0 {
            return FilterResult::Skip("global daily loss limit reached".into());
        }
        amt = amt.min(daily_remaining);

        // ─── 19. Zero amount ───
        if amt <= 0.0 {
            return FilterResult::Skip("zero copy amount".into());
        }

        // ─── 20. Pool routing (V2: sub-threshold → skip) ───
        let pool_threshold = if is_paper {
            config.pool_min_amount_usd
        } else {
            config.live_pool_min_amount_usd
        };
        if amt < pool_threshold {
            return FilterResult::Skip(format!(
                "sub-threshold ${:.2} < ${:.2} (no pooling in V2)",
                amt, pool_threshold
            ));
        }

        // ─── 21. Final capital sufficiency ───
        let final_available = state.capital.available(&alloc.id);
        if amt > final_available {
            return FilterResult::Skip("insufficient allocated capital".into());
        }

        copy_amount_usd = amt;
    }

    FilterResult::Execute(ExecuteParams {
        copy_amount_usd,
        side: signal.side,
        token_id: signal.token_id.clone(),
        sell_shares,
        is_neg_risk: signal.is_neg_risk,
        price: signal.price,
    })
}

fn truncate(s: &str, max_len: usize) -> &str {
    if s.len() <= max_len {
        return s;
    }
    // Find last char boundary at or before max_len (safe for multi-byte UTF-8)
    match s.char_indices().take_while(|(i, _)| *i < max_len).last() {
        Some((i, c)) => &s[..i + c.len_utf8()],
        None => "",
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicBool;
    use std::sync::Arc;

    use tokio::time::Instant;

    use crate::state::allocations::{Allocation, AllocationStore};
    use crate::state::capital::CapitalTracker;
    use crate::state::cooldowns::CooldownMaps;
    use crate::state::markets::{MarketCache, MarketMeta};
    use crate::state::accumulator::MajorityAccumulator;
    use crate::state::positions::PositionTracker;
    use crate::wss::TradeSide;

    use super::*;

    fn default_config() -> FilterConfig {
        FilterConfig {
            copy_trade_percent: 0.10,
            max_position_usd: 5.0,
            max_prediction_position_usd: 5.0,
            max_daily_loss_usd: 200.0,
            max_signal_age_ms: 300_000,
            majority_min_usd: 175.0,
            majority_min_ratio: 0.50,
            committed_side_lock: true,
            market_end_gatekeep_enabled: true,
            min_composite_score: 0.0,
            min_signal_trade_usd: 0.0,
            clob_min_order_usd: 1.0,
            hedge_price_ratio: 0.25,
            hedge_naked_max_price: 0.10,
            hedge_min_opposite_usd: 5.0,
            hedge_max_ratio: 0.20,
            pool_min_amount_usd: 0.50,
            live_pool_min_amount_usd: 1.0,
        }
    }

    fn default_alloc() -> Allocation {
        Allocation {
            id: "alloc1".into(),
            proxy_wallet: "0xtrader".into(),
            is_paper: false,
            is_active: true,
            initial_capital: 100.0,
            copy_trade_percent: Some(0.10),
            max_position_usd: Some(5.0),
            max_prediction_position_usd: Some(30.0),
            min_buy_price: Some(0.60),
            exclude_event_slug_patterns: vec!["updown-5m".into(), "updown-15m".into()],
            exclude_title_patterns: vec![],
            majority_only_mode: false,
            copy_maker_fills: true,
        }
    }

    fn default_state() -> SharedState {
        let markets = Arc::new(MarketCache::new());
        markets.upsert(
            "cond1",
            MarketMeta {
                closed: false,
                end_date: None,
                event_slug: Some("will-x-happen".into()),
                question: Some("Will X happen?".into()),
                tokens: vec!["tokenA".into(), "tokenB".into()],
                tick_size: "0.01".into(),
                fetched_at: Instant::now(),
            },
        );

        let capital = Arc::new(CapitalTracker::new());
        capital.init_allocation("alloc1", 100.0);

        SharedState {
            allocations: Arc::new(AllocationStore::new()),
            positions: Arc::new(PositionTracker::new()),
            capital,
            markets,
            cooldowns: Arc::new(CooldownMaps::new()),
            accumulator: Arc::new(MajorityAccumulator::new()),
            balance_paused: Arc::new(AtomicBool::new(false)),
        }
    }

    fn buy_signal(price: f64, usd: f64) -> TradeSignal {
        TradeSignal {
            proxy_wallet: "0xtrader".into(),
            token_id: "tokenA".into(),
            condition_id: Some("cond1".into()),
            side: TradeSide::Buy,
            size: usd / price,
            price,
            usd,
            is_neg_risk: false,
            is_maker: false,
            detected_at_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }

    fn sell_signal(price: f64) -> TradeSignal {
        TradeSignal {
            proxy_wallet: "0xtrader".into(),
            token_id: "tokenA".into(),
            condition_id: Some("cond1".into()),
            side: TradeSide::Sell,
            size: 10.0,
            price,
            usd: 10.0 * price,
            is_neg_risk: false,
            is_maker: false,
            detected_at_ms: chrono::Utc::now().timestamp_millis() as u64,
        }
    }

    #[test]
    fn test_buy_passes_basic_filters() {
        let config = default_config();
        let alloc = default_alloc();
        let state = default_state();
        let signal = buy_signal(0.70, 50.0); // $50 trade @ 0.70

        match run(&signal, &alloc, &config, &state) {
            FilterResult::Execute(params) => {
                // 50 * 0.10 = 5.0, capped at max_position_usd=5.0
                assert_eq!(params.copy_amount_usd, 5.0);
                assert_eq!(params.side, TradeSide::Buy);
            }
            FilterResult::Skip(reason) => panic!("expected Execute, got Skip: {reason}"),
        }
    }

    #[test]
    fn test_min_buy_price_filter() {
        let config = default_config();
        let alloc = default_alloc(); // minBuyPrice = 0.60
        let state = default_state();
        let signal = buy_signal(0.50, 50.0); // Price 0.50 < 0.60

        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("below minBuyPrice"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for low price"),
        }
    }

    #[test]
    fn test_slug_exclusion() {
        let config = default_config();
        let alloc = default_alloc(); // excludes "updown-5m"
        let state = default_state();

        // Override market slug to match exclusion
        state.markets.upsert(
            "cond1",
            MarketMeta {
                closed: false,
                end_date: None,
                event_slug: Some("btc-updown-5m-round1".into()),
                question: Some("BTC up?".into()),
                tokens: vec!["tokenA".into(), "tokenB".into()],
                tick_size: "0.01".into(),
                fetched_at: Instant::now(),
            },
        );

        let signal = buy_signal(0.70, 50.0);
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("exclude pattern"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for excluded slug"),
        }
    }

    #[test]
    fn test_committed_side_lock() {
        let config = default_config();
        let alloc = default_alloc();
        let state = default_state();

        // Add position on opposite token
        state
            .positions
            .add_fill("tokenB", "alloc1", false, TradeSide::Buy, 10.0, 5.0);

        let signal = buy_signal(0.70, 50.0); // Trying to buy tokenA
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("committed side lock"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for committed side"),
        }
    }

    #[test]
    fn test_prediction_position_cap() {
        let config = default_config();
        let alloc = default_alloc(); // maxPredictionPositionUsd = 30
        let state = default_state();

        // Already have $28 position
        state
            .positions
            .add_fill("tokenA", "alloc1", false, TradeSide::Buy, 40.0, 28.0);

        let signal = buy_signal(0.70, 50.0); // Wants to add $5 (10% of $50)
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Execute(params) => {
                // Remaining = 30 - 28 = 2, so capped at $2
                assert!(
                    (params.copy_amount_usd - 2.0).abs() < 0.01,
                    "expected ~$2, got ${:.2}",
                    params.copy_amount_usd
                );
            }
            FilterResult::Skip(reason) => panic!("expected Execute, got Skip: {reason}"),
        }
    }

    #[test]
    fn test_clob_minimum_bump_first_entry() {
        let config = default_config();
        let alloc = default_alloc();
        let state = default_state();
        let signal = buy_signal(0.70, 5.0); // $5 * 10% = $0.50, below $1 CLOB min

        match run(&signal, &alloc, &config, &state) {
            FilterResult::Execute(params) => {
                // Should bump to $1 (first entry, no existing position)
                assert_eq!(params.copy_amount_usd, 1.0);
            }
            FilterResult::Skip(reason) => panic!("expected Execute with bump, got Skip: {reason}"),
        }
    }

    #[test]
    fn test_clob_minimum_addon_skipped() {
        let config = default_config();
        let alloc = default_alloc();
        let state = default_state();

        // Existing position on this token
        state
            .positions
            .add_fill("tokenA", "alloc1", false, TradeSide::Buy, 5.0, 2.0);

        let signal = buy_signal(0.70, 5.0); // $0.50 add-on
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("sub-$1 add-on"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for sub-$1 add-on"),
        }
    }

    #[test]
    fn test_sell_uses_held_shares() {
        let config = default_config();
        let mut alloc = default_alloc();
        alloc.is_paper = true; // Paper SELL allowed
        let state = default_state();

        // Position: 10.567 shares
        state
            .positions
            .add_fill("tokenA", "alloc1", true, TradeSide::Buy, 10.567, 7.0);

        let signal = sell_signal(0.70);
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Execute(params) => {
                // Floor(10.567 * 100) / 100 = 10.56 shares
                assert_eq!(params.sell_shares, Some(10.56));
                assert!((params.copy_amount_usd - 10.56 * 0.70).abs() < 0.01);
            }
            FilterResult::Skip(reason) => panic!("expected Execute, got Skip: {reason}"),
        }
    }

    #[test]
    fn test_live_sell_disabled() {
        let config = default_config();
        let alloc = default_alloc(); // is_paper = false
        let state = default_state();

        let signal = sell_signal(0.70);
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("live SELL-copy disabled"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for live SELL"),
        }
    }

    #[test]
    fn test_daily_loss_limit_caps() {
        let config = default_config(); // max_daily_loss_usd = 200
        let alloc = default_alloc();
        let state = default_state();

        // Seed daily spend to $198 without depleting capital
        state.capital.seed_daily_spend(false, 198.0);

        let signal = buy_signal(0.70, 50.0); // Wants $5
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Execute(params) => {
                // Daily remaining = 200 - 198 = 2, capped
                assert!(
                    (params.copy_amount_usd - 2.0).abs() < 0.01,
                    "expected ~$2, got ${:.2}",
                    params.copy_amount_usd
                );
            }
            FilterResult::Skip(reason) => panic!("expected Execute, got Skip: {reason}"),
        }
    }

    #[test]
    fn test_balance_paused() {
        let config = default_config();
        let alloc = default_alloc();
        let state = default_state();
        state.balance_paused.store(true, Ordering::Relaxed);

        let signal = buy_signal(0.70, 50.0);
        match run(&signal, &alloc, &config, &state) {
            FilterResult::Skip(reason) => {
                assert!(reason.contains("insufficient wallet balance"), "got: {reason}");
            }
            FilterResult::Execute(_) => panic!("expected Skip for paused"),
        }
    }
}
