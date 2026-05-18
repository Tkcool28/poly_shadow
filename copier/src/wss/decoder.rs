use std::collections::HashSet;

use super::{DecodedTrade, RawLogEvent, TradeSide};

/// Standard CTF Exchange contract
#[allow(dead_code)] // Used in Phase 5 CLOB client (EIP-712 domain verifyingContract)
const CTF_EXCHANGE: &str = "0x4bfb41d5b3570defd03c39a9a4d8de6bd8b8982e";
/// NegRisk CTF Exchange contract (BTC/SOL price bands)
const NEG_RISK_EXCHANGE: &str = "0xc5d563a36ae78145c45a50134d48a1215220f80a";
/// OrderFilled event topic hash
const ORDER_FILLED_TOPIC: &str =
    "0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6";

/// Decode an OrderFilled log event into a DecodedTrade.
/// Returns None if the event is not relevant (wrong topic, zero-size, etc.)
pub fn decode_order_filled(
    event: &RawLogEvent,
    watched_wallets: &HashSet<String>,
) -> Option<DecodedTrade> {
    // Must have 4 topics: [event_sig, orderHash, maker, taker]
    if event.topics.len() < 4 {
        return None;
    }

    // Verify event topic
    if event.topics[0].to_lowercase() != ORDER_FILLED_TOPIC {
        return None;
    }

    // Extract maker and taker addresses from topics (padded to 32 bytes)
    let maker = extract_address(&event.topics[2])?;
    let taker = extract_address(&event.topics[3])?;

    // Determine which watched wallet is involved and its role
    let (proxy_wallet, is_maker) = if watched_wallets.contains(&maker) {
        (maker.clone(), true)
    } else if watched_wallets.contains(&taker) {
        (taker.clone(), false)
    } else {
        return None; // Neither maker nor taker is a watched wallet
    };

    // Determine if NegRisk contract
    let is_neg_risk = event.address.to_lowercase() == NEG_RISK_EXCHANGE;

    // Decode data field: 5 × uint256 (each 32 bytes = 64 hex chars)
    // [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee]
    let data = event.data.strip_prefix("0x").unwrap_or(&event.data);
    if data.len() < 320 {
        // 5 * 64 hex chars
        return None;
    }

    let maker_asset_id = &data[0..64];
    let taker_asset_id = &data[64..128];
    let maker_amount_raw = parse_u256_to_f64(&data[128..192])?;
    let taker_amount_raw = parse_u256_to_f64(&data[192..256])?;
    // fee at data[256..320] — not used for trade construction

    // Convert from 6-decimal fixed-point (USDC uses 6 decimals on Polygon)
    let maker_amount = maker_amount_raw / 1_000_000.0;
    let taker_amount = taker_amount_raw / 1_000_000.0;

    // Determine USDC side: assetId == 0 means USDC
    let maker_is_usdc = is_zero_asset(maker_asset_id);
    let taker_is_usdc = is_zero_asset(taker_asset_id);

    // Guard: both non-USDC (token-to-token swap) — not a standard trade
    if !maker_is_usdc && !taker_is_usdc {
        return None;
    }

    let (side, token_id, size, price) = if is_maker {
        compute_trade_params(maker_is_usdc, maker_asset_id, taker_asset_id, maker_amount, taker_amount)
    } else {
        compute_trade_params(taker_is_usdc, taker_asset_id, maker_asset_id, taker_amount, maker_amount)
    }?;

    // Zero-size guard (FOK non-fills emit zero-size events)
    if size <= 0.0 || price <= 0.0 {
        return None;
    }

    Some(DecodedTrade {
        proxy_wallet,
        token_id,
        side,
        size,
        price,
        transaction_hash: event.transaction_hash.clone(),
        is_neg_risk,
        is_maker,
        block_number: event.block_number,
        log_index: event.log_index,
    })
}

/// Compute (side, tokenId, size, price) from the perspective of the wallet.
/// `wallet_is_usdc` = true if the wallet's asset is USDC.
/// `wallet_asset` = the wallet's assetId hex, `other_asset` = counterparty's.
/// `wallet_amount` = wallet's filled amount, `other_amount` = counterparty's.
fn compute_trade_params(
    wallet_is_usdc: bool,
    wallet_asset: &str,
    other_asset: &str,
    wallet_amount: f64,
    other_amount: f64,
) -> Option<(TradeSide, String, f64, f64)> {
    if wallet_amount <= 0.0 || other_amount <= 0.0 {
        return None;
    }

    if wallet_is_usdc {
        // Wallet paid USDC → BUY
        let token_id = u256_hex_to_decimal(other_asset)?;
        let size = other_amount; // shares received
        let price = wallet_amount / other_amount; // USDC per share
        Some((TradeSide::Buy, token_id, size, price))
    } else {
        // Wallet gave tokens → SELL
        let token_id = u256_hex_to_decimal(wallet_asset)?;
        let size = wallet_amount; // shares sold
        let price = other_amount / wallet_amount; // USDC per share
        Some((TradeSide::Sell, token_id, size, price))
    }
}

/// Extract an Ethereum address from a 32-byte padded topic (last 20 bytes).
fn extract_address(topic: &str) -> Option<String> {
    let hex = topic.strip_prefix("0x").unwrap_or(topic);
    if hex.len() < 40 {
        return None;
    }
    let addr = &hex[hex.len() - 40..];
    Some(format!("0x{}", addr.to_lowercase()))
}

/// Check if a 256-bit asset ID is zero (= USDC).
fn is_zero_asset(hex: &str) -> bool {
    hex.chars().all(|c| c == '0')
}

/// Parse a 64-char hex string as a u256 and convert to f64.
/// Only handles values that fit in u128 (sufficient for USDC amounts).
fn parse_u256_to_f64(hex: &str) -> Option<f64> {
    // For amounts that fit in u128 (< 2^128), the upper 128 bits should be zero
    let value = u128::from_str_radix(hex.trim_start_matches('0').max("0"), 16).ok()?;
    Some(value as f64)
}

/// Convert a 256-bit hex asset ID to its decimal string representation.
/// Token IDs on Polymarket are large uint256 values stored as decimal strings.
fn u256_hex_to_decimal(hex: &str) -> Option<String> {
    let value = alloy_primitives::U256::from_str_radix(hex.trim_start_matches('0').max("0"), 16).ok()?;
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_address() {
        let topic = "0x0000000000000000000000001234567890abcdef1234567890abcdef12345678";
        assert_eq!(
            extract_address(topic),
            Some("0x1234567890abcdef1234567890abcdef12345678".to_string())
        );
    }

    #[test]
    fn test_is_zero_asset() {
        assert!(is_zero_asset("0000000000000000000000000000000000000000000000000000000000000000"));
        assert!(!is_zero_asset("000000000000000000000000000000000000000000000000000000000000000a"));
    }

    #[test]
    fn test_parse_u256_to_f64() {
        // 1,000,000 in hex = 0xF4240
        assert_eq!(parse_u256_to_f64("00000000000000000000000000000000000000000000000000000000000f4240"), Some(1_000_000.0));
    }
}
