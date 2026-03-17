// Phase 4 filter chain — wired into main loop in Phase 5+ (CLOB client, IPC).
#[allow(dead_code)]
pub mod types;
#[allow(dead_code)]
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
/// All fields are Arc for sharing between the main loop and IPC tasks (Phase 6).
#[allow(dead_code)]
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
