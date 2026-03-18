use serde::{Deserialize, Serialize};

// ─── Outbound: Rust → Node.js ───

#[derive(Debug, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum OutboundMessage {
    SeedRequest,
    TradeDetected {
        proxy_wallet: String,
        token_id: String,
        side: String, // "BUY" / "SELL"
        size: f64,
        price: f64,
        transaction_hash: String,
        is_neg_risk: bool,
        is_maker: bool,
        block_number: u64,
        condition_id: Option<String>,
        event_slug: Option<String>,
        title: Option<String>,
        detection_source: String,
        timestamp: i64,
    },
    CopyTradeResult {
        detected_trade_id: Option<String>,
        allocation_id: String,
        proxy_wallet: String,
        condition_id: Option<String>,
        token_id: String,
        side: String,
        status: String, // "FILLED", "FAILED", "SKIPPED"
        filled_price: f64,
        filled_size: f64,
        requested_amount: f64,
        requested_price: f64,
        order_id: Option<String>,
        execution_method: String, // "FAK", "GTC", "PAPER"
        latency_ms: u64,
        fail_reason: Option<String>,
        is_paper: bool,
    },
}

// ─── Inbound: Node.js → Rust ───

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum InboundMessage {
    SeedState {
        allocations: Vec<SeedAllocation>,
        positions: Vec<SeedPosition>,
        capital: Vec<SeedCapital>,
        majority_data: Vec<SeedMajority>,
        markets: Vec<SeedMarket>,
        daily_live_spend: f64,
        daily_paper_spend: f64,
    },
    AllocationUpdated {
        allocation: SeedAllocation,
    },
    AllocationDeactivated {
        alloc_id: String,
    },
    MarketSettled {
        condition_id: String,
        token_ids: Vec<String>,
        /// Parallel array with token_ids — settlement price for each token.
        settlement_prices: Vec<f64>,
    },
    MarketClosed {
        condition_id: String,
    },
    PositionReconciled {
        token_id: String,
        alloc_id: String,
        is_paper: bool,
        net_shares: f64,
        net_usd: f64,
        buy_cost: f64,
        buy_shares: f64,
    },
    CapitalReconciled {
        alloc_id: String,
        current: f64,
        deployed: f64,
    },
    BalancePause {
        paused: bool,
    },
}

// ─── Seed data structs ───

#[derive(Debug, Clone, Deserialize)]
pub struct SeedAllocation {
    pub id: String,
    pub proxy_wallet: String,
    pub is_paper: bool,
    pub is_active: bool,
    pub initial_capital: f64,
    pub copy_trade_percent: Option<f64>,
    pub max_position_usd: Option<f64>,
    pub max_prediction_position_usd: Option<f64>,
    pub min_buy_price: Option<f64>,
    #[serde(default)]
    pub exclude_event_slug_patterns: Vec<String>,
    #[serde(default)]
    pub exclude_title_patterns: Vec<String>,
    #[serde(default)]
    pub majority_only_mode: bool,
    #[serde(default)]
    pub copy_maker_fills: bool,
}

#[derive(Debug, Deserialize)]
pub struct SeedPosition {
    pub token_id: String,
    pub alloc_id: String,
    pub is_paper: bool,
    pub net_shares: f64,
    pub net_usd: f64,
    pub buy_cost: f64,
    pub buy_shares: f64,
}

#[derive(Debug, Deserialize)]
pub struct SeedCapital {
    pub alloc_id: String,
    pub current: f64,
    pub deployed: f64,
}

#[derive(Debug, Deserialize)]
pub struct SeedMajority {
    pub wallet: String,
    pub condition_id: String,
    pub outcome: String,
    pub usd: f64,
    pub timestamp_ms: u64,
}

#[derive(Debug, Deserialize)]
pub struct SeedMarket {
    pub condition_id: String,
    pub closed: bool,
    pub end_date: Option<i64>,
    pub event_slug: Option<String>,
    pub question: Option<String>,
    pub tokens: Vec<String>,
    #[serde(default = "default_tick_size")]
    pub tick_size: String,
}

fn default_tick_size() -> String {
    "0.01".to_string()
}

// ─── TradeSide conversion helpers ───

use crate::wss::TradeSide;

pub fn side_to_string(side: TradeSide) -> String {
    match side {
        TradeSide::Buy => "BUY".to_string(),
        TradeSide::Sell => "SELL".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_outbound_serialization() {
        let msg = OutboundMessage::SeedRequest;
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"seed_request\""));
    }

    #[test]
    fn test_outbound_trade_detected() {
        let msg = OutboundMessage::TradeDetected {
            proxy_wallet: "0xabc".into(),
            token_id: "123".into(),
            side: "BUY".into(),
            size: 10.0,
            price: 0.65,
            transaction_hash: "0xdef".into(),
            is_neg_risk: false,
            is_maker: false,
            block_number: 100,
            condition_id: Some("cond1".into()),
            event_slug: Some("test".into()),
            title: Some("Test?".into()),
            detection_source: "CHAIN".into(),
            timestamp: 1700000000,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"trade_detected\""));
        assert!(json.contains("\"proxy_wallet\":\"0xabc\""));
    }

    #[test]
    fn test_inbound_seed_state_deserialization() {
        let json = r#"{
            "type": "seed_state",
            "allocations": [],
            "positions": [],
            "capital": [],
            "majority_data": [],
            "markets": [],
            "daily_live_spend": 5.0,
            "daily_paper_spend": 10.0
        }"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        match msg {
            InboundMessage::SeedState {
                daily_live_spend,
                daily_paper_spend,
                ..
            } => {
                assert_eq!(daily_live_spend, 5.0);
                assert_eq!(daily_paper_spend, 10.0);
            }
            _ => panic!("expected SeedState"),
        }
    }

    #[test]
    fn test_inbound_allocation_updated() {
        let json = r#"{
            "type": "allocation_updated",
            "allocation": {
                "id": "alloc1",
                "proxy_wallet": "0x123",
                "is_paper": true,
                "is_active": true,
                "initial_capital": 100.0,
                "copy_trade_percent": 0.10,
                "max_position_usd": null,
                "max_prediction_position_usd": null,
                "min_buy_price": null,
                "majority_only_mode": true,
                "copy_maker_fills": false
            }
        }"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        match msg {
            InboundMessage::AllocationUpdated { allocation } => {
                assert_eq!(allocation.id, "alloc1");
                assert!(allocation.majority_only_mode);
            }
            _ => panic!("expected AllocationUpdated"),
        }
    }

    #[test]
    fn test_inbound_market_settled() {
        let json = r#"{
            "type": "market_settled",
            "condition_id": "cond1",
            "token_ids": ["tokenA", "tokenB"],
            "settlement_prices": [1.0, 0.0]
        }"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        match msg {
            InboundMessage::MarketSettled {
                condition_id,
                token_ids,
                settlement_prices,
            } => {
                assert_eq!(condition_id, "cond1");
                assert_eq!(token_ids.len(), 2);
                assert_eq!(settlement_prices[0], 1.0);
            }
            _ => panic!("expected MarketSettled"),
        }
    }

    #[test]
    fn test_inbound_balance_pause() {
        let json = r#"{"type": "balance_pause", "paused": true}"#;
        let msg: InboundMessage = serde_json::from_str(json).unwrap();
        match msg {
            InboundMessage::BalancePause { paused } => assert!(paused),
            _ => panic!("expected BalancePause"),
        }
    }

    #[test]
    fn test_round_trip_copy_trade_result() {
        let msg = OutboundMessage::CopyTradeResult {
            detected_trade_id: Some("dt_123".into()),
            allocation_id: "alloc1".into(),
            proxy_wallet: "0xabc".into(),
            condition_id: Some("cond1".into()),
            token_id: "token123".into(),
            side: "BUY".into(),
            status: "FILLED".into(),
            filled_price: 0.65,
            filled_size: 7.69,
            requested_amount: 5.0,
            requested_price: 0.65,
            order_id: Some("order_abc".into()),
            execution_method: "FAK".into(),
            latency_ms: 42,
            fail_reason: None,
            is_paper: false,
        };
        let json = serde_json::to_string(&msg).unwrap();
        assert!(json.contains("\"type\":\"copy_trade_result\""));
        assert!(json.contains("\"filled_price\":0.65"));
        assert!(json.contains("\"is_paper\":false"));
    }
}
