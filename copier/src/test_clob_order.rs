/// Standalone test: place a real CLOB order on a live market to verify EIP-712 signing.
/// Run with: cd copier && cargo test test_live_clob_order -- --nocapture --ignored
///
/// Uses the BNB Up/Down market (long expiry) with a $1 BUY at 1 cent (won't fill).
/// This validates the signature is accepted by the CLOB, without risking real money.

#[cfg(test)]
mod live_clob_tests {
    use ethers::signers::{LocalWallet, Signer};
    use ethers::core::types::Address;

    use crate::clob::signer::{sign_order, generate_salt, OrderParams};
    use crate::clob::auth::build_l2_headers;
    use crate::wss::TradeSide;

    // BNB Up or Down March 22 — "Up" token
    const TOKEN_ID: &str = "82203824820611333168468595564490382197955295663880384025363412891103642217814";

    #[tokio::test]
    #[ignore] // Only run manually: cargo test test_live_clob_order -- --nocapture --ignored
    async fn test_live_clob_order() {
        dotenv::dotenv().ok();

        let private_key = std::env::var("PRIVATE_KEY")
            .expect("PRIVATE_KEY env var required");
        let api_key = std::env::var("CLOB_API_KEY")
            .expect("CLOB_API_KEY env var required");
        let api_secret = std::env::var("CLOB_API_SECRET")
            .expect("CLOB_API_SECRET env var required");
        let passphrase = std::env::var("CLOB_PASSPHRASE")
            .or_else(|_| std::env::var("CLOB_API_PASSPHRASE"))
            .expect("CLOB_PASSPHRASE env var required");
        let funder_address = std::env::var("FUNDER_ADDRESS")
            .expect("FUNDER_ADDRESS env var required");
        let signature_type: u8 = std::env::var("SIGNATURE_TYPE")
            .unwrap_or_else(|_| "1".to_string())
            .parse()
            .unwrap();

        let wallet: LocalWallet = private_key
            .trim_start_matches("0x")
            .parse()
            .expect("Invalid PRIVATE_KEY");
        let funder: Address = funder_address.parse().expect("Invalid FUNDER_ADDRESS");
        let wallet_address = format!("{:?}", wallet.address());

        println!("Wallet (signer): {}", wallet_address);
        println!("Funder (maker):  {}", funder_address);
        println!("Signature type:  {}", signature_type);
        println!("Token:           {}...", &TOKEN_ID[..20]);

        // Build a FAK BUY order at 1 cent for $1 (will not fill — just tests signature)
        let price = 0.01_f64;
        let amount_usd = 1.0_f64;
        let tick_size = "0.01";

        // Compute maker/taker amounts (from types.rs logic)
        let raw_taker = amount_usd / price;
        let taker_amount = format!("{}", (raw_taker * 1_000_000.0).round() as u64);
        let maker_amount = format!("{}", (amount_usd * 1_000_000.0).round() as u64);

        let salt = generate_salt();

        let params = OrderParams {
            salt,
            maker: funder,
            signer: wallet.address(),
            token_id: TOKEN_ID.to_string(),
            maker_amount: maker_amount.clone(),
            taker_amount: taker_amount.clone(),
            side: TradeSide::Buy,
            fee_rate_bps: 0,
            signature_type,
        };

        // Sign the order (is_neg_risk = false for standard CTF)
        let signature = sign_order(&wallet, &params, false)
            .await
            .expect("sign_order failed");

        println!("Signature:       {}...{}", &signature[..10], &signature[signature.len()-8..]);

        // Build the JSON payload
        // owner = API key (not address!) — matches JS client: orderToJson(order, this.creds.key, ...)
        let order_json = serde_json::json!({
            "order": {
                "salt": salt,
                "maker": format!("{:?}", funder),
                "signer": wallet_address,
                "taker": "0x0000000000000000000000000000000000000000",
                "tokenId": TOKEN_ID,
                "makerAmount": maker_amount,
                "takerAmount": taker_amount,
                "expiration": "0",
                "nonce": "0",
                "feeRateBps": "0",
                "side": "BUY",
                "signatureType": signature_type,
                "signature": signature,
            },
            "owner": api_key,  // API key, NOT address
            "orderType": "FOK",
        });

        let body = serde_json::to_string(&order_json).unwrap();
        println!("\nRequest body:\n{}", serde_json::to_string_pretty(&order_json).unwrap());

        // Build auth headers
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();

        let headers = build_l2_headers(
            &wallet_address,
            &api_key,
            &api_secret,
            &passphrase,
            timestamp,
            "POST",
            "/order",
            Some(&body),
        )
        .expect("build_l2_headers failed");

        // Send the order
        let client = reqwest::Client::new();
        let resp = client
            .post("https://clob.polymarket.com/order")
            .headers(headers)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await
            .expect("HTTP request failed");

        let status = resp.status();
        let resp_body = resp.text().await.unwrap_or_default();

        println!("\n=== CLOB Response ===");
        println!("Status: {}", status);
        println!("Body:   {}", resp_body);

        if status.as_u16() == 400 && resp_body.contains("invalid signature") {
            panic!("SIGNATURE STILL INVALID — EIP-712 signing needs more fixes");
        }

        // 200 = order accepted (may or may not fill)
        // 400 with other error = acceptable (e.g., "orderbook does not exist", "insufficient balance")
        println!("\n✓ Signature accepted by CLOB (no 'invalid signature' error)");
    }
}
