use serde::{Deserialize, Serialize};

use crate::wss::TradeSide;

// ─── Order Payload (POST /order body) ───

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderPayload {
    pub order: SignedOrder,
    pub owner: String,
    pub order_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub post_only: Option<bool>,
    pub defer_exec: bool,
}

/// Signed order as sent to the CLOB API.
/// Field types verified from orderToJson() in @polymarket/clob-client/dist/utilities.js.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignedOrder {
    pub salt: u64,
    pub maker: String,
    pub signer: String,
    pub taker: String,
    pub token_id: String,
    pub maker_amount: String,
    pub taker_amount: String,
    pub expiration: String,
    pub nonce: String,
    pub fee_rate_bps: String,
    pub side: String,           // "BUY" or "SELL"
    pub signature_type: u8,     // 0=EOA, 1=POLY_PROXY, 2=GNOSIS_SAFE
    pub signature: String,      // 0x-prefixed hex
}

// ─── Order Response (from CLOB API) ───
// POST /order returns { success, orderID, ... }
// GET /data/order/:id returns { status, makingAmount, takingAmount, ... } (no success field)

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderResponse {
    #[serde(default = "default_true")]
    pub success: bool,
    pub status: Option<String>,
    #[serde(rename = "orderID")]
    pub order_id: Option<String>,
    pub transactions_hashes: Option<Vec<String>>,
    pub making_amount: Option<String>,
    pub taking_amount: Option<String>,
    pub error_msg: Option<String>,
}

fn default_true() -> bool {
    true
}

// ─── Fill Result (internal) ───

#[derive(Debug, Clone)]
pub struct FillResult {
    pub status: FillStatus,
    pub filled_size: f64,
    pub filled_price: f64,
    pub order_id: Option<String>,
    pub execution_method: ExecutionMethod,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FillStatus {
    Filled,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ExecutionMethod {
    Fak,
    Gtc,
    Paper,
}

impl ExecutionMethod {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Fak => "FAK",
            Self::Gtc => "GTC",
            Self::Paper => "PAPER",
        }
    }
}

// ─── Rounding ───

/// Returns (price_decimals, size_decimals, amount_decimals) for a given tick size.
pub fn rounding_config(tick_size: &str) -> (u32, u32, u32) {
    match tick_size {
        "0.1" => (1, 2, 3),
        "0.01" => (2, 2, 4),
        "0.001" => (3, 2, 5),
        "0.0001" => (4, 2, 6),
        _ => (2, 2, 4), // safe default
    }
}

/// Round to nearest (standard rounding). Matches JS roundNormal.
pub fn round_normal(num: f64, decimals: u32) -> f64 {
    if decimal_places(num) <= decimals {
        return num;
    }
    let factor = 10f64.powi(decimals as i32);
    ((num + f64::EPSILON) * factor).round() / factor
}

/// Round down (floor). Matches JS roundDown.
pub fn round_down(num: f64, decimals: u32) -> f64 {
    if decimal_places(num) <= decimals {
        return num;
    }
    let factor = 10f64.powi(decimals as i32);
    (num * factor).floor() / factor
}

/// Round up (ceiling). Matches JS roundUp.
pub fn round_up(num: f64, decimals: u32) -> f64 {
    if decimal_places(num) <= decimals {
        return num;
    }
    let factor = 10f64.powi(decimals as i32);
    (num * factor).ceil() / factor
}

/// Count decimal places in a number. Matches JS decimalPlaces.
pub fn decimal_places(num: f64) -> u32 {
    if num == num.floor() {
        return 0;
    }
    let s = format!("{}", num);
    match s.find('.') {
        Some(pos) => (s.len() - pos - 1) as u32,
        None => 0,
    }
}

/// Convert a floating-point amount to a 6-decimal integer string.
/// Equivalent to ethers.js `parseUnits(amount.toString(), 6)`.
pub fn to_units_string(amount: f64, decimals: u32) -> String {
    let factor = 10u64.pow(decimals);
    let units = (amount * factor as f64).round() as u64;
    units.to_string()
}

// ─── Amount Computation ───

/// CLOB decimal limits:
/// - USDC side: always max 2 decimals
/// - Shares side: max 4 decimals (CLOB rejects anything beyond)
const USDC_MAX_DECIMALS: u32 = 2;
const SHARES_MAX_DECIMALS: u32 = 4;

/// Compute maker/taker amounts for a BUY order.
/// Returns (makerAmount, takerAmount) as 6-decimal strings.
/// BUY: maker = USDC you pay (max 2 dec), taker = shares you get (max 4 dec).
pub fn compute_buy_amounts(
    amount_usd: f64,
    price: f64,
    tick_size: &str,
) -> (String, String) {
    let (price_dec, size_dec, _amount_dec) = rounding_config(tick_size);
    let effective_size_dec = size_dec.min(SHARES_MAX_DECIMALS);
    let rounded_price = round_normal(price, price_dec);
    let shares = amount_usd / rounded_price;
    let raw_taker = round_down(shares, effective_size_dec);
    // Maker is USDC: enforce max 2 decimals (CLOB requirement)
    let raw_maker = round_down(raw_taker * rounded_price, USDC_MAX_DECIMALS);

    (to_units_string(raw_maker, 6), to_units_string(raw_taker, 6))
}

/// Compute maker/taker amounts for a SELL order.
/// Returns (makerAmount, takerAmount) as 6-decimal strings.
/// SELL: maker = shares you give (max 4 dec), taker = USDC you get (max 2 dec).
pub fn compute_sell_amounts(
    shares: f64,
    price: f64,
    tick_size: &str,
) -> (String, String) {
    let (price_dec, size_dec, _amount_dec) = rounding_config(tick_size);
    let effective_size_dec = size_dec.min(SHARES_MAX_DECIMALS);
    let rounded_price = round_normal(price, price_dec);
    let raw_maker = round_down(shares, effective_size_dec);
    // Taker is USDC: enforce max 2 decimals (CLOB requirement)
    let raw_taker = round_down(raw_maker * rounded_price, USDC_MAX_DECIMALS);

    (to_units_string(raw_maker, 6), to_units_string(raw_taker, 6))
}

/// Compute slippage price for FAK orders.
pub fn slippage_price(price: f64, upside_fraction: f64, min_absolute: f64) -> f64 {
    let bump = (upside_fraction * (1.0 - price)).max(min_absolute);
    (price + bump).min(0.99)
}

/// Convert TradeSide to API string.
pub fn side_to_string(side: TradeSide) -> String {
    match side {
        TradeSide::Buy => "BUY".to_string(),
        TradeSide::Sell => "SELL".to_string(),
    }
}

/// Convert TradeSide to EIP-712 numeric value.
pub fn side_to_u8(side: TradeSide) -> u8 {
    match side {
        TradeSide::Buy => 0,
        TradeSide::Sell => 1,
    }
}

// ─── NegRisk Response Parsing ───

/// Parse fill amounts from CLOB response, handling NegRisk flipped conventions.
/// Returns (filled_size_shares, filled_price).
pub fn parse_fill_amounts(
    making_amount_str: &str,
    taking_amount_str: &str,
    side: TradeSide,
) -> (f64, f64) {
    // CLOB API returns amounts as direct float strings (e.g., "2.127658"), NOT 6-decimal units.
    // We SEND in 6-decimal units (to_units_string) but RECEIVE as floats.
    let making = making_amount_str.parse::<f64>().unwrap_or(0.0);
    let taking = taking_amount_str.parse::<f64>().unwrap_or(0.0);

    if making <= 0.0 || taking <= 0.0 {
        return (0.0, 0.0);
    }

    match side {
        TradeSide::Buy => {
            // Normal: making=shares, taking=usdc
            let price = taking / making;
            if price > 1.0 {
                // NegRisk flip: amounts are swapped
                let shares = taking;
                let usdc = making;
                (shares, usdc / shares)
            } else {
                (making, price)
            }
        }
        TradeSide::Sell => {
            // Normal: making=usdc, taking=shares
            let price = making / taking;
            if price > 1.0 {
                // NegRisk flip
                let shares = making;
                let usdc = taking;
                (shares, usdc / shares)
            } else {
                (taking, price)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_rounding_config() {
        assert_eq!(rounding_config("0.01"), (2, 2, 4));
        assert_eq!(rounding_config("0.001"), (3, 2, 5));
        assert_eq!(rounding_config("unknown"), (2, 2, 4));
    }

    #[test]
    fn test_round_normal() {
        assert_eq!(round_normal(0.655, 2), 0.66);
        assert_eq!(round_normal(0.644, 2), 0.64);
        assert_eq!(round_normal(0.5, 0), 1.0);
    }

    #[test]
    fn test_round_down() {
        assert_eq!(round_down(0.659, 2), 0.65);
        assert_eq!(round_down(7.999, 2), 7.99);
    }

    #[test]
    fn test_round_up() {
        assert_eq!(round_up(0.651, 2), 0.66);
        assert_eq!(round_up(7.001, 2), 7.01);
    }

    #[test]
    fn test_decimal_places() {
        assert_eq!(decimal_places(1.0), 0);
        assert_eq!(decimal_places(1.5), 1);
        assert_eq!(decimal_places(1.23), 2);
        assert_eq!(decimal_places(0.001), 3);
    }

    #[test]
    fn test_to_units_string() {
        assert_eq!(to_units_string(1.0, 6), "1000000");
        assert_eq!(to_units_string(0.5, 6), "500000");
        assert_eq!(to_units_string(1.234567, 6), "1234567");
    }

    #[test]
    fn test_compute_buy_amounts() {
        // BUY $5 at price 0.65, tick_size "0.01"
        let (maker, taker) = compute_buy_amounts(5.0, 0.65, "0.01");
        // shares = 5.0 / 0.65 ≈ 7.692... → round_down(2) = 7.69
        // maker = 7.69 * 0.65 = 4.9985 → within 4 decimals
        let maker_val: u64 = maker.parse().unwrap();
        let taker_val: u64 = taker.parse().unwrap();
        assert_eq!(taker_val, 7690000); // 7.69 shares
        assert!(maker_val > 0 && maker_val <= 5000000); // ≤ $5 USDC
    }

    #[test]
    fn test_compute_sell_amounts() {
        // SELL 10 shares at price 0.70, tick_size "0.001"
        let (maker, taker) = compute_sell_amounts(10.0, 0.70, "0.001");
        let maker_val: u64 = maker.parse().unwrap();
        let taker_val: u64 = taker.parse().unwrap();
        assert_eq!(maker_val, 10000000); // 10.0 shares
        assert_eq!(taker_val, 7000000); // 10.0 * 0.70 = 7.0 USDC
    }

    #[test]
    fn test_slippage_price() {
        // price=0.65, upside=0.05, min=0.01
        let sp = slippage_price(0.65, 0.05, 0.01);
        // bump = max(0.05 * 0.35, 0.01) = max(0.0175, 0.01) = 0.0175
        // slippage = min(0.65 + 0.0175, 0.99) = 0.6675
        assert!((sp - 0.6675).abs() < 1e-10);
    }

    #[test]
    fn test_slippage_price_high() {
        // price=0.95, min kicks in
        let sp = slippage_price(0.95, 0.05, 0.01);
        // bump = max(0.05 * 0.05, 0.01) = max(0.0025, 0.01) = 0.01
        // slippage = min(0.96, 0.99) = 0.96
        assert!((sp - 0.96).abs() < 1e-10);
    }

    #[test]
    fn test_slippage_price_cap() {
        let sp = slippage_price(0.99, 0.05, 0.01);
        assert!(sp <= 0.99);
    }

    #[test]
    fn test_parse_fill_normal_buy() {
        // BUY: making=shares, taking=usdc (CLOB returns direct float strings)
        let (size, price) = parse_fill_amounts("7.69", "5.0", TradeSide::Buy);
        assert!((size - 7.69).abs() < 0.001);
        assert!((price - 0.6502).abs() < 0.01);
    }

    #[test]
    fn test_parse_fill_negrisk_buy() {
        // NegRisk BUY: amounts swapped, price > 1.0 triggers flip
        let (size, price) = parse_fill_amounts("5.0", "7.69", TradeSide::Buy);
        // Normal: price = 7.69/5.0 = 1.538 > 1.0 → flip
        // After flip: shares=7.69, price=5.0/7.69≈0.65
        assert!((size - 7.69).abs() < 0.001);
        assert!((price - 0.65).abs() < 0.01);
    }

    #[test]
    fn test_parse_fill_zero() {
        let (size, price) = parse_fill_amounts("0", "0", TradeSide::Buy);
        assert_eq!(size, 0.0);
        assert_eq!(price, 0.0);
    }
}
