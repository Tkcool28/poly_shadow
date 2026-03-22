use anyhow::Result;
use ethers::contract::{Eip712, EthAbiType};
use ethers::core::types::{Address, U256};
use ethers::signers::{LocalWallet, Signer};
use ethers::utils::keccak256;

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

// ─── Order EIP-712 (manual implementation) ───
//
// The ethers #[derive(Eip712)] macro uses the Rust struct name as the EIP-712 type name.
// Polymarket expects "Order(...)" but Rust structs are "OrderStandard"/"OrderNegRisk".
// We implement EIP-712 manually to produce the correct type hash.
//
// Type string: "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)"

const ORDER_TYPE_STR: &str = "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)";

const CTF_EXCHANGE: &str = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE: &str = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

/// Compute EIP-712 domain separator for a Polymarket exchange contract.
fn domain_separator(verifying_contract: &str) -> [u8; 32] {
    let domain_type = keccak256(
        b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
    );
    let name_hash = keccak256(b"Polymarket CTF Exchange");
    let version_hash = keccak256(b"1");
    let chain_id = U256::from(137);
    let contract: Address = verifying_contract.parse().expect("invalid contract address");

    let mut buf = Vec::with_capacity(5 * 32);
    buf.extend_from_slice(&domain_type);
    buf.extend_from_slice(&name_hash);
    buf.extend_from_slice(&version_hash);
    buf.extend_from_slice(&{
        let mut b = [0u8; 32];
        chain_id.to_big_endian(&mut b);
        b
    });
    // Address is 20 bytes, left-padded to 32
    buf.extend_from_slice(&{
        let mut b = [0u8; 32];
        b[12..].copy_from_slice(contract.as_bytes());
        b
    });

    keccak256(&buf)
}

/// Compute EIP-712 struct hash for an Order.
fn order_struct_hash(
    salt: U256,
    maker: Address,
    signer_addr: Address,
    taker: Address,
    token_id: U256,
    maker_amount: U256,
    taker_amount: U256,
    expiration: U256,
    nonce: U256,
    fee_rate_bps: U256,
    side: u8,
    signature_type: u8,
) -> [u8; 32] {
    let type_hash = keccak256(ORDER_TYPE_STR.as_bytes());

    let mut buf = Vec::with_capacity(13 * 32);
    buf.extend_from_slice(&type_hash);

    // Encode each field as 32-byte ABI word
    for val in [salt, token_id, maker_amount, taker_amount, expiration, nonce, fee_rate_bps] {
        // We'll add these in order — but first, the address fields
        let _ = val; // placeholder
    }
    // Actually, do it properly in order:
    buf.clear();
    buf.extend_from_slice(&type_hash);

    // salt (uint256)
    let mut word = [0u8; 32];
    salt.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // maker (address)
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(maker.as_bytes());
    buf.extend_from_slice(&word);

    // signer (address)
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(signer_addr.as_bytes());
    buf.extend_from_slice(&word);

    // taker (address)
    let mut word = [0u8; 32];
    word[12..].copy_from_slice(taker.as_bytes());
    buf.extend_from_slice(&word);

    // tokenId (uint256)
    let mut word = [0u8; 32];
    token_id.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // makerAmount (uint256)
    let mut word = [0u8; 32];
    maker_amount.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // takerAmount (uint256)
    let mut word = [0u8; 32];
    taker_amount.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // expiration (uint256)
    let mut word = [0u8; 32];
    expiration.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // nonce (uint256)
    let mut word = [0u8; 32];
    nonce.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // feeRateBps (uint256)
    let mut word = [0u8; 32];
    fee_rate_bps.to_big_endian(&mut word);
    buf.extend_from_slice(&word);

    // side (uint8)
    let mut word = [0u8; 32];
    word[31] = side;
    buf.extend_from_slice(&word);

    // signatureType (uint8)
    let mut word = [0u8; 32];
    word[31] = signature_type;
    buf.extend_from_slice(&word);

    keccak256(&buf)
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
    pub fee_rate_bps: u32,   // market's taker fee in basis points (0, 700, 1000)
    pub signature_type: u8,
}

/// Sign an order with EIP-712 (manual implementation matching Polymarket's contract).
/// Uses "Order(...)" type name (not the Rust struct name).
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

    let contract = if is_neg_risk { NEG_RISK_CTF_EXCHANGE } else { CTF_EXCHANGE };
    let domain_sep = domain_separator(contract);
    let struct_hash = order_struct_hash(
        U256::from(params.salt),
        params.maker,
        params.signer,
        Address::zero(), // taker
        token_id,
        maker_amount,
        taker_amount,
        U256::zero(), // expiration
        U256::zero(), // nonce
        U256::from(params.fee_rate_bps),
        side,
        params.signature_type,
    );

    // EIP-712 digest: keccak256("\x19\x01" || domainSeparator || structHash)
    let mut digest_input = Vec::with_capacity(2 + 32 + 32);
    digest_input.push(0x19);
    digest_input.push(0x01);
    digest_input.extend_from_slice(&domain_sep);
    digest_input.extend_from_slice(&struct_hash);
    let digest = keccak256(&digest_input);

    // Sign the raw digest (not typed data — we already computed the EIP-712 hash)
    let sig = wallet.sign_hash(ethers::types::H256::from(digest))?;
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
            fee_rate_bps: 0,
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
            fee_rate_bps: 0,
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
            fee_rate_bps: 0,
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
    }

    #[test]
    fn test_type_hash_matches_polymarket() {
        let expected = "Order(uint256 salt,address maker,address signer,address taker,uint256 tokenId,uint256 makerAmount,uint256 takerAmount,uint256 expiration,uint256 nonce,uint256 feeRateBps,uint8 side,uint8 signatureType)";
        let expected_hash = keccak256(expected.as_bytes());
        let actual_hash = keccak256(ORDER_TYPE_STR.as_bytes());
        assert_eq!(expected_hash, actual_hash, "ORDER_TYPE_STR must match Polymarket's expected type string");
    }

    #[test]
    fn test_domain_separator_standard() {
        let ds = domain_separator(CTF_EXCHANGE);
        // Domain separator should be deterministic
        let ds2 = domain_separator(CTF_EXCHANGE);
        assert_eq!(ds, ds2);
        // Standard and NegRisk should differ (different verifyingContract)
        let ds_neg = domain_separator(NEG_RISK_CTF_EXCHANGE);
        assert_ne!(ds, ds_neg);
    }
}
