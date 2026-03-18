use std::time::Duration;

use anyhow::Result;
use ethers::core::types::Address;
use ethers::signers::{LocalWallet, Signer};
use reqwest::Client;

use crate::config::Config;
use crate::wss::TradeSide;

use super::auth::build_l2_headers;
use super::signer::{generate_salt, sign_order, OrderParams};
use super::types::*;

/// CLOB API client for placing orders on Polymarket.
pub struct ClobClient {
    http: Client,
    base_url: String,
    wallet: LocalWallet,
    wallet_address: String, // checksummed
    funder: Address,
    api_key: String,
    api_secret: String,
    passphrase: String,
    signature_type: u8,
    slippage_upside: f64,
    slippage_min: f64,
}

impl ClobClient {
    /// Create a new ClobClient from config. Returns None if CLOB credentials are missing.
    pub fn from_config(config: &Config) -> Result<Option<Self>> {
        let private_key = match &config.private_key {
            Some(k) => k.strip_prefix("0x").unwrap_or(k),
            None => {
                tracing::warn!("PRIVATE_KEY not set — CLOB client disabled");
                return Ok(None);
            }
        };
        let api_key = match &config.clob_api_key {
            Some(k) => k.clone(),
            None => {
                tracing::warn!("CLOB_API_KEY not set — CLOB client disabled");
                return Ok(None);
            }
        };
        let api_secret = config
            .clob_api_secret
            .clone()
            .unwrap_or_default();
        let passphrase = config.clob_passphrase.clone().unwrap_or_default();

        let wallet: LocalWallet = private_key
            .parse()
            .map_err(|e| anyhow::anyhow!("Invalid PRIVATE_KEY: {}", e))?;
        let wallet_address = format!("{:?}", wallet.address()); // checksummed 0x...

        let funder = config
            .funder_address
            .as_ref()
            .map(|a| a.parse::<Address>())
            .transpose()
            .map_err(|e| anyhow::anyhow!("Invalid FUNDER_ADDRESS: {}", e))?
            .unwrap_or(wallet.address());

        let http = Client::builder()
            .timeout(Duration::from_secs(10))
            .pool_idle_timeout(Duration::from_secs(90))
            .pool_max_idle_per_host(4)
            .tcp_keepalive(Duration::from_secs(30))
            .build()?;

        Ok(Some(ClobClient {
            http,
            base_url: config.clob_base_url.clone(),
            wallet,
            wallet_address,
            funder,
            api_key,
            api_secret,
            passphrase,
            signature_type: config.signature_type,
            slippage_upside: config.slippage_upside_fraction,
            slippage_min: config.slippage_min_absolute,
        }))
    }

    /// Place a FAK (Fill-And-Kill) order.
    pub async fn place_fak_order(
        &self,
        token_id: &str,
        side: TradeSide,
        amount_usd: f64,
        price: f64,
        is_neg_risk: bool,
        tick_size: &str,
    ) -> FillResult {
        let slip_price = slippage_price(price, self.slippage_upside, self.slippage_min);
        let result = self
            .place_order(token_id, side, amount_usd, slip_price, is_neg_risk, tick_size, "FAK", false)
            .await;
        match result {
            Ok(fill) => fill,
            Err(e) => {
                tracing::error!(error = %e, token_id, "FAK order failed");
                FillResult {
                    status: FillStatus::Failed,
                    filled_size: 0.0,
                    filled_price: 0.0,
                    order_id: None,
                    execution_method: ExecutionMethod::Fak,
                }
            }
        }
    }

    /// Place a GTC (Good-Til-Cancelled) order at exact price.
    pub async fn place_gtc_order(
        &self,
        token_id: &str,
        side: TradeSide,
        amount_usd: f64,
        price: f64,
        is_neg_risk: bool,
        tick_size: &str,
    ) -> FillResult {
        let result = self
            .place_order(token_id, side, amount_usd, price, is_neg_risk, tick_size, "GTC", false)
            .await;
        match result {
            Ok(fill) => fill,
            Err(e) => {
                tracing::error!(error = %e, token_id, "GTC order failed");
                FillResult {
                    status: FillStatus::Failed,
                    filled_size: 0.0,
                    filled_price: 0.0,
                    order_id: None,
                    execution_method: ExecutionMethod::Gtc,
                }
            }
        }
    }

    /// Core order placement logic shared between FAK and GTC.
    async fn place_order(
        &self,
        token_id: &str,
        side: TradeSide,
        amount_usd: f64,
        price: f64,
        is_neg_risk: bool,
        tick_size: &str,
        order_type: &str,
        retried: bool,
    ) -> Result<FillResult> {
        let exec_method = if order_type == "GTC" {
            ExecutionMethod::Gtc
        } else {
            ExecutionMethod::Fak
        };

        // Compute amounts
        let (maker_amount, taker_amount) = match side {
            TradeSide::Buy => compute_buy_amounts(amount_usd, price, tick_size),
            TradeSide::Sell => {
                let shares = amount_usd / price;
                compute_sell_amounts(shares, price, tick_size)
            }
        };

        // Generate salt and sign
        let salt = generate_salt();
        let params = OrderParams {
            salt,
            maker: self.funder,
            signer: self.wallet.address(),
            token_id: token_id.to_string(),
            maker_amount: maker_amount.clone(),
            taker_amount: taker_amount.clone(),
            side,
            signature_type: self.signature_type,
        };
        let signature = sign_order(&self.wallet, &params, is_neg_risk).await?;

        // Build payload
        let payload = OrderPayload {
            order: SignedOrder {
                salt,
                maker: format!("{:?}", self.funder),
                signer: self.wallet_address.clone(),
                taker: format!("{:?}", Address::zero()),
                token_id: token_id.to_string(),
                maker_amount,
                taker_amount,
                expiration: "0".to_string(),
                nonce: "0".to_string(),
                fee_rate_bps: "0".to_string(),
                side: side_to_string(side),
                signature_type: self.signature_type,
                signature,
            },
            owner: self.api_key.clone(),
            order_type: order_type.to_string(),
            post_only: if order_type == "GTC" {
                Some(false)
            } else {
                None
            },
            defer_exec: false,
        };

        // Serialize body for HMAC
        let body = serde_json::to_string(&payload)?;

        // Log payload for debugging (first order verification)
        tracing::debug!(
            order_type,
            token_id,
            side = ?side,
            body_len = body.len(),
            "CLOB order payload"
        );

        // Build L2 auth headers
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let headers = build_l2_headers(
            &self.wallet_address,
            &self.api_key,
            &self.api_secret,
            &self.passphrase,
            timestamp,
            "POST",
            "/order",
            Some(&body),
        )?;

        // POST /order
        let url = format!("{}/order", self.base_url);
        let resp = self
            .http
            .post(&url)
            .headers(headers)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;

        let status_code = resp.status();

        // Handle 429 rate limit: retry ONCE after 1s
        if status_code == reqwest::StatusCode::TOO_MANY_REQUESTS {
            if retried {
                tracing::error!("CLOB 429 rate limited twice, giving up");
                return Ok(FillResult {
                    status: FillStatus::Failed,
                    filled_size: 0.0,
                    filled_price: 0.0,
                    order_id: None,
                    execution_method: exec_method,
                });
            }
            tracing::warn!("CLOB 429 rate limited, retrying in 1s");
            tokio::time::sleep(Duration::from_secs(1)).await;
            return Box::pin(self.place_order(
                token_id, side, amount_usd, price, is_neg_risk, tick_size, order_type, true,
            ))
            .await;
        }

        let resp_text = resp.text().await?;

        if !status_code.is_success() {
            tracing::error!(status = %status_code, body = %resp_text, "CLOB order rejected");
            return Ok(FillResult {
                status: FillStatus::Failed,
                filled_size: 0.0,
                filled_price: 0.0,
                order_id: None,
                execution_method: exec_method,
            });
        }

        let order_resp: OrderResponse = serde_json::from_str(&resp_text)
            .map_err(|e| anyhow::anyhow!("Failed to parse CLOB response: {} body={}", e, resp_text))?;

        self.parse_response(order_resp, side, exec_method)
    }

    /// Parse CLOB API response into FillResult.
    fn parse_response(
        &self,
        resp: OrderResponse,
        side: TradeSide,
        exec_method: ExecutionMethod,
    ) -> Result<FillResult> {
        if !resp.success {
            let msg = resp.error_msg.unwrap_or_default();
            tracing::warn!(error = %msg, "CLOB order unsuccessful");
            return Ok(FillResult {
                status: FillStatus::Failed,
                filled_size: 0.0,
                filled_price: 0.0,
                order_id: resp.order_id,
                execution_method: exec_method,
            });
        }

        let making = resp.making_amount.as_deref().unwrap_or("0");
        let taking = resp.taking_amount.as_deref().unwrap_or("0");
        let (filled_size, filled_price) = parse_fill_amounts(making, taking, side);

        if filled_size <= 0.0 {
            // Ghost fill: success=true but zero amounts (FOK non-fill)
            return Ok(FillResult {
                status: FillStatus::Skipped,
                filled_size: 0.0,
                filled_price: 0.0,
                order_id: resp.order_id,
                execution_method: exec_method,
            });
        }

        tracing::info!(
            size = filled_size,
            price = filled_price,
            order_id = ?resp.order_id,
            method = ?exec_method,
            "CLOB order filled"
        );

        Ok(FillResult {
            status: FillStatus::Filled,
            filled_size,
            filled_price,
            order_id: resp.order_id,
            execution_method: exec_method,
        })
    }

    /// Get order status by ID.
    pub async fn get_order(&self, order_id: &str) -> Result<OrderResponse> {
        let path = format!("/data/order/{}", order_id);
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let headers = build_l2_headers(
            &self.wallet_address,
            &self.api_key,
            &self.api_secret,
            &self.passphrase,
            timestamp,
            "GET",
            &path,
            None,
        )?;

        let url = format!("{}{}", self.base_url, path);
        let resp = self.http.get(&url).headers(headers).send().await?;
        let text = resp.text().await?;
        Ok(serde_json::from_str(&text)?)
    }

    /// Cancel an order by ID.
    pub async fn cancel_order(&self, order_id: &str) -> Result<bool> {
        let body = serde_json::json!({ "orderID": order_id }).to_string();
        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)?
            .as_secs();
        let headers = build_l2_headers(
            &self.wallet_address,
            &self.api_key,
            &self.api_secret,
            &self.passphrase,
            timestamp,
            "DELETE",
            "/order",
            Some(&body),
        )?;

        let url = format!("{}/order", self.base_url);
        let resp = self
            .http
            .delete(&url)
            .headers(headers)
            .header("Content-Type", "application/json")
            .body(body)
            .send()
            .await?;

        Ok(resp.status().is_success())
    }

    /// Simulate a paper fill (no CLOB call).
    pub fn simulate_paper_fill(
        &self,
        _side: TradeSide,
        amount_usd: f64,
        price: f64,
    ) -> FillResult {
        let shares = amount_usd / price;
        FillResult {
            status: FillStatus::Filled,
            filled_size: shares,
            filled_price: price,
            order_id: None,
            execution_method: ExecutionMethod::Paper,
        }
    }
}
