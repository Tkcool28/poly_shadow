pub mod provider;
pub mod decoder;
pub mod dedup;
pub mod phantom;

/// Raw log event from WSS eth_subscription
#[derive(Debug, Clone)]
pub struct RawLogEvent {
    #[allow(dead_code)] // Used in Phase 3+ logging/metrics
    pub provider_label: String,
    pub address: String,
    pub topics: Vec<String>,
    pub data: String,
    pub block_number: u64,
    pub transaction_hash: String,
    pub log_index: u64,
}

/// Decoded trade from OrderFilled event
#[derive(Debug, Clone)]
pub struct DecodedTrade {
    pub proxy_wallet: String,
    pub token_id: String,
    pub side: TradeSide,
    pub size: f64,
    pub price: f64,
    pub transaction_hash: String,
    pub is_neg_risk: bool,
    pub is_maker: bool,
    pub block_number: u64,
    pub log_index: u64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum TradeSide {
    Buy,
    Sell,
}

impl DecodedTrade {
    /// Dedup key: txHash:logIndex
    pub fn dedup_key(&self) -> String {
        format!("{}:{}", self.transaction_hash, self.log_index)
    }
}
