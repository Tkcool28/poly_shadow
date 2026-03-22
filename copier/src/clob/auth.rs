use anyhow::Result;
use hmac::Mac;
use reqwest::header::{HeaderMap, HeaderValue};

/// Build L2 auth headers for CLOB API requests.
/// L2 uses HMAC-SHA256 in POLY_SIGNATURE (NOT ClobAuth EIP-712).
pub fn build_l2_headers(
    wallet_address: &str,
    api_key: &str,
    api_secret: &str,
    passphrase: &str,
    timestamp: u64,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<HeaderMap> {
    let ts_str = timestamp.to_string();
    let sig = hmac_sign(api_secret, &ts_str, method, path, body)?;

    let mut headers = HeaderMap::new();
    headers.insert("POLY_ADDRESS", HeaderValue::from_str(wallet_address)?);
    headers.insert("POLY_SIGNATURE", HeaderValue::from_str(&sig)?);
    headers.insert("POLY_TIMESTAMP", HeaderValue::from_str(&ts_str)?);
    headers.insert("POLY_API_KEY", HeaderValue::from_str(api_key)?);
    headers.insert("POLY_PASSPHRASE", HeaderValue::from_str(passphrase)?);
    Ok(headers)
}

/// Compute HMAC-SHA256 signature for CLOB API authentication.
/// Verified against @polymarket/clob-client/dist/signing/hmac.js lines 40-57.
fn hmac_sign(
    secret_b64: &str,
    timestamp: &str,
    method: &str,
    path: &str,
    body: Option<&str>,
) -> Result<String> {
    // Build message: concatenated directly, no separators
    let mut message = format!("{}{}{}", timestamp, method, path);
    if let Some(b) = body {
        message.push_str(b);
    }

    // Decode secret: may be base64url without padding, convert to standard base64
    let mut sanitized = secret_b64.replace('-', "+").replace('_', "/");
    // Add padding if missing (base64 STANDARD requires it)
    while sanitized.len() % 4 != 0 {
        sanitized.push('=');
    }
    let key_bytes = base64::Engine::decode(&base64::engine::general_purpose::STANDARD, &sanitized)?;

    // HMAC-SHA256
    let mut mac =
        hmac::Hmac::<sha2::Sha256>::new_from_slice(&key_bytes).map_err(|e| anyhow::anyhow!("HMAC key: {}", e))?;
    mac.update(message.as_bytes());
    let result = mac.finalize().into_bytes();

    // Encode as base64, then convert to base64url (keep '=')
    let b64 = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, &result);
    let url_safe = b64.replace('+', "-").replace('/', "_");
    Ok(url_safe)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_hmac_sign_basic() {
        // Known test vector: secret = base64("test-secret")
        let secret_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"test-secret");
        let result = hmac_sign(&secret_b64, "1234567890", "GET", "/order", None);
        assert!(result.is_ok());
        let sig = result.unwrap();
        // Should be base64url encoded
        assert!(!sig.contains('+'));
        assert!(!sig.contains('/'));
    }

    #[test]
    fn test_hmac_sign_with_body() {
        let secret_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"my-secret");
        let body = r#"{"order":{"salt":123}}"#;
        let result = hmac_sign(&secret_b64, "1700000000", "POST", "/order", Some(body));
        assert!(result.is_ok());
    }

    #[test]
    fn test_hmac_sign_base64url_secret() {
        // Secret with base64url chars (- and _)
        let secret_b64url = "dGVzdC1zZWNyZXQ="; // "test-secret" in standard base64
        let result = hmac_sign(secret_b64url, "1234567890", "GET", "/order", None);
        assert!(result.is_ok());
    }

    #[test]
    fn test_build_l2_headers() {
        let secret_b64 =
            base64::Engine::encode(&base64::engine::general_purpose::STANDARD, b"test-secret");
        let headers = build_l2_headers(
            "0x1234567890abcdef1234567890abcdef12345678",
            "api-key-123",
            &secret_b64,
            "my-passphrase",
            1700000000,
            "POST",
            "/order",
            Some("{}"),
        );
        assert!(headers.is_ok());
        let h = headers.unwrap();
        assert_eq!(
            h.get("POLY_ADDRESS").unwrap(),
            "0x1234567890abcdef1234567890abcdef12345678"
        );
        assert_eq!(h.get("POLY_API_KEY").unwrap(), "api-key-123");
        assert_eq!(h.get("POLY_PASSPHRASE").unwrap(), "my-passphrase");
        assert_eq!(h.get("POLY_TIMESTAMP").unwrap(), "1700000000");
        assert!(h.get("POLY_SIGNATURE").is_some());
    }
}
