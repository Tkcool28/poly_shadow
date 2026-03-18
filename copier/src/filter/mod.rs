pub mod types;
pub mod chain;

use std::sync::atomic::AtomicBool;
use std::sync::Arc;

use crate::state::{
    accumulator::MajorityAccumulator,
    allocations::AllocationStore,
    capital::CapitalTracker,
    cooldowns::CooldownMaps,
    markets::MarketCache,
    positions::PositionTracker,
};

/// Shared state accessible by the filter chain.
/// All fields are Arc for sharing between the main loop, IPC tasks, and GTC fallback.
/// Clone is cheap — just Arc ref count bumps.
#[derive(Clone)]
pub struct SharedState {
    pub allocations: Arc<AllocationStore>,
    pub positions: Arc<PositionTracker>,
    pub capital: Arc<CapitalTracker>,
    pub markets: Arc<MarketCache>,
    pub cooldowns: Arc<CooldownMaps>,
    pub accumulator: Arc<MajorityAccumulator>,
    /// Set by IPC from Node.js when wallet balance is insufficient for live trading.
    pub balance_paused: Arc<AtomicBool>,
}
