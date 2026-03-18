use anyhow::Result;
use ethers::contract::{Eip712, EthAbiType};
use ethers::core::types::{Address, U256};
use ethers::signers::{LocalWallet, Signer};

use crate::wss::TradeSide;

// ─── ClobAuth EIP-712 (L1 authentication) ───
// Domain: name="ClobAuthDomain", version="1", chainId=137
// NO verifyingContract

#[derive(Clone, Debug, Eip712, EthAbiType)]
#[eip712(name = "ClobAuthDomain", version = "1", chain_id = 137)]
struct ClobAuth {
    address: Address,
    timestamp: String,
    nonce: U256,
    message: String,
}

const CLOB_AUTH_MESSAGE: &str = "This message attests that I control the given wallet";

/// Sign a ClobAuth EIP-712 message (L1 authentication).
/// Used for /auth/api-key endpoint. NOT needed at runtime if API keys are in env.
pub async fn sign_clob_auth(
    wallet: &LocalWallet,
    timestamp: u64,
    nonce: u64,
) -> Result<String> {
    let auth = ClobAuth {
        address: wallet.address(),
        timestamp: timestamp.to_string(),
        nonce: U256::from(nonce),
        message: CLOB_AUTH_MESSAGE.to_string(),
    };

    let sig = wallet.sign_typed_data(&auth).await?;
    Ok(format!("0x{}", sig))
}

// ─── Order EIP-712 (on-chain order signing) ───
// Two domains: Standard CTF Exchange and NegRisk CTF Exchange
// Both have name="Polymarket CTF Exchange", version="1", chainId=137
// Different verifyingContract addresses

#[derive(Clone, Debug, Eip712, EthAbiType)]
#[eip712(
    name = "Polymarket CTF Exchange",
    version = "1",
    chain_id = 137,
    verifying_contract = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E"
)]
struct OrderStandard {
    salt: U256,
    maker: Address,
    signer: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
}

#[derive(Clone, Debug, Eip712, EthAbiType)]
#[eip712(
    name = "Polymarket CTF Exchange",
    version = "1",
    chain_id = 137,
    verifying_contract = "0xC5d563A36AE78145C45a50134d48A1215220f80a"
)]
struct OrderNegRisk {
    salt: U256,
    maker: Address,
    signer: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
}

/// Parameters for constructing an order to sign.
pub struct OrderParams {
    pub salt: u64,
    pub maker: Address,      // funder address
    pub signer: Address,     // wallet address
    pub token_id: String,    // decimal string
    pub maker_amount: String, // 6-decimal string
    pub taker_amount: String, // 6-decimal string
    pub side: TradeSide,
    pub signature_type: u8,
}

/// Sign an order with EIP-712.
/// Uses the standard CTF Exchange domain or NegRisk domain based on `is_neg_risk`.
pub async fn sign_order(
    wallet: &LocalWallet,
    params: &OrderParams,
    is_neg_risk: bool,
) -> Result<String> {
    let token_id = U256::from_dec_str(&params.token_id)
        .map_err(|e| anyhow::anyhow!("Invalid tokenId '{}': {}", params.token_id, e))?;
    let maker_amount = U256::from_dec_str(&params.maker_amount)
        .map_err(|e| anyhow::anyhow!("Invalid makerAmount '{}': {}", params.maker_amount, e))?;
    let taker_amount = U256::from_dec_str(&params.taker_amount)
        .map_err(|e| anyhow::anyhow!("Invalid takerAmount '{}': {}", params.taker_amount, e))?;

    let side = match params.side {
        TradeSide::Buy => 0u8,
        TradeSide::Sell => 1u8,
    };

    let sig = if is_neg_risk {
        let order = OrderNegRisk {
            salt: U256::from(params.salt),
            maker: params.maker,
            signer: params.signer,
            taker: Address::zero(),
            token_id,
            maker_amount,
            taker_amount,
            expiration: U256::zero(),
            nonce: U256::zero(),
            fee_rate_bps: U256::zero(),
            side,
            signature_type: params.signature_type,
        };
        wallet.sign_typed_data(&order).await?
    } else {
        let order = OrderStandard {
            salt: U256::from(params.salt),
            maker: params.maker,
            signer: params.signer,
            taker: Address::zero(),
            token_id,
            maker_amount,
            taker_amount,
            expiration: U256::zero(),
            nonce: U256::zero(),
            fee_rate_bps: U256::zero(),
            side,
            signature_type: params.signature_type,
        };
        wallet.sign_typed_data(&order).await?
    };

    Ok(format!("0x{}", sig))
}

/// Generate a random salt matching JS: Math.round(Math.random() * Date.now())
pub fn generate_salt() -> u64 {
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;
    (rand::random::<f64>() * now_ms).round() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use ethers::signers::LocalWallet;

    // Hardhat default #0 key (NOT a real key)
    const TEST_KEY: &str = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";

    fn test_wallet() -> LocalWallet {
        TEST_KEY.parse::<LocalWallet>().unwrap()
    }

    #[tokio::test]
    async fn test_sign_clob_auth() {
        let wallet = test_wallet();
        let sig = sign_clob_auth(&wallet, 1700000000, 0).await;
        assert!(sig.is_ok());
        let s = sig.unwrap();
        assert!(s.starts_with("0x"));
        assert_eq!(s.len(), 132); // 0x + 130 hex chars (65 bytes)
    }

    #[tokio::test]
    async fn test_sign_order_standard() {
        let wallet = test_wallet();
        let params = OrderParams {
            salt: 12345,
            maker: wallet.address(),
            signer: wallet.address(),
            token_id: "1234567890".to_string(),
            maker_amount: "5000000".to_string(),
            taker_amount: "7690000".to_string(),
            side: TradeSide::Buy,
            signature_type: 1,
        };
        let sig = sign_order(&wallet, &params, false).await;
        assert!(sig.is_ok());
        let s = sig.unwrap();
        assert!(s.starts_with("0x"));
        assert_eq!(s.len(), 132);
    }

    #[tokio::test]
    async fn test_sign_order_neg_risk() {
        let wallet = test_wallet();
        let params = OrderParams {
            salt: 12345,
            maker: wallet.address(),
            signer: wallet.address(),
            token_id: "1234567890".to_string(),
            maker_amount: "5000000".to_string(),
            taker_amount: "7690000".to_string(),
            side: TradeSide::Buy,
            signature_type: 1,
        };
        let sig_standard = sign_order(&wallet, &params, false).await.unwrap();
        let sig_negrisk = sign_order(&wallet, &params, true).await.unwrap();
        // Different domains must produce different signatures
        assert_ne!(sig_standard, sig_negrisk);
    }

    #[tokio::test]
    async fn test_sign_order_deterministic() {
        let wallet = test_wallet();
        let params = OrderParams {
            salt: 99999,
            maker: wallet.address(),
            signer: wallet.address(),
            token_id: "42".to_string(),
            maker_amount: "1000000".to_string(),
            taker_amount: "2000000".to_string(),
            side: TradeSide::Sell,
            signature_type: 0,
        };
        let sig1 = sign_order(&wallet, &params, false).await.unwrap();
        let sig2 = sign_order(&wallet, &params, false).await.unwrap();
        assert_eq!(sig1, sig2); // Same inputs = same signature
    }

    #[test]
    fn test_generate_salt() {
        let s1 = generate_salt();
        let s2 = generate_salt();
        assert!(s1 > 0);
        assert!(s2 > 0);
        // Very unlikely to be equal
        // (but not impossible, so not asserting ne)
    }
}
