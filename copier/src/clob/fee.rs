/// Calculate the taker fee for a given price and base fee rate.
///
/// The fee formula varies by market category:
/// - Crypto (baseFee >= 1000): quadratic curve, peak ~1.56% at p=0.50
/// - Sports (baseFee >= 700):  linear curve, peak ~0.44% at p=0.50
/// - Zero fee otherwise
pub fn calculate_taker_fee(price: f64, base_fee: u32) -> f64 {
    if base_fee == 0 {
        return 0.0;
    }
    let (rate, exp) = if base_fee >= 1000 {
        (0.25, 2) // crypto
    } else if base_fee >= 700 {
        (0.0175, 1) // sports
    } else {
        return 0.0;
    };
    rate * (price * (1.0 - price)).powi(exp)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_zero_base_fee() {
        assert_eq!(calculate_taker_fee(0.50, 0), 0.0);
    }

    #[test]
    fn test_low_base_fee() {
        assert_eq!(calculate_taker_fee(0.50, 500), 0.0);
    }

    #[test]
    fn test_crypto_fee_at_50() {
        // peak: 0.25 * (0.5 * 0.5)^2 = 0.25 * 0.0625 = 0.015625
        let fee = calculate_taker_fee(0.50, 1000);
        assert!((fee - 0.015625).abs() < 1e-10);
    }

    #[test]
    fn test_crypto_fee_at_extremes() {
        // At p=0.01: 0.25 * (0.01 * 0.99)^2 ≈ tiny
        let fee = calculate_taker_fee(0.01, 1000);
        assert!(fee < 0.001);
        // At p=0.99: symmetric
        let fee2 = calculate_taker_fee(0.99, 1000);
        assert!((fee - fee2).abs() < 1e-10);
    }

    #[test]
    fn test_sports_fee_at_50() {
        // 0.0175 * (0.5 * 0.5)^1 = 0.0175 * 0.25 = 0.004375
        let fee = calculate_taker_fee(0.50, 700);
        assert!((fee - 0.004375).abs() < 1e-10);
    }

    #[test]
    fn test_sports_fee_symmetry() {
        let fee_30 = calculate_taker_fee(0.30, 700);
        let fee_70 = calculate_taker_fee(0.70, 700);
        assert!((fee_30 - fee_70).abs() < 1e-10);
    }
}
