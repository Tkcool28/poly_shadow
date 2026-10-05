# WS_FEASIBILITY — WebSocket trade-source investigation (Phase 3 §8)

**Verdict: REJECTED as a watched-wallet trade-discovery source.**
Investigated 2026-10-05 from official docs and client/SDK issue reports.

## Candidates examined

### 1. CLOB market channel — `wss://ws-subscriptions-clob.polymarket.com/ws/market`

- Public, no auth. Subscribe by asset/token IDs.
- Event types: `book`, `price_change`, `tick_size_change`,
  `last_trade_price`, `best_bid_ask`, `new_market`, `market_resolved`.
- **No wallet identity anywhere in the schema.** `last_trade_price` carries
  price/size for the market, not the participants. Cannot attribute activity
  to watched wallets → not a wallet-trade signal.
- Secondary concern: community reports (Polymarket/py-clob-client#292)
  describe silent freezes where the server accepts subscriptions but stops
  delivering events for hours — poor completeness guarantees even for its
  own population.

### 2. CLOB user channel — `wss://ws-subscriptions-clob.polymarket.com/ws/user`

- Reports order/trade lifecycle **for the authenticated account only**.
- Requires CLOB API key/secret/passphrase — explicitly banned by this
  project's safety rules (no CLOB authenticated trading client). Out of
  scope by policy, regardless of data quality.

### 3. RTDS — `wss://ws-live-data.polymarket.com`

- Topics: `crypto_prices`, `crypto_prices_chainlink`, `equity_prices`,
  `comments`. Reference-price and comment streams — no per-wallet trade
  activity schema documented. Not a wallet-trade source.

## What already covers low-latency discovery

The Phase 2 chain observer subscribes to Polygon logs over WSS with a
backfill verifier — real-time, wallet-attributable, completeness-audited.
Adding an unattributable order-book price feed would add neither speed nor
completeness for **watched-wallet discovery**.

## Revisit triggers

- Polymarket ships a PUBLIC per-market trades stream that includes maker/
  taker wallet addresses.
- A documented RTDS trade-activity topic with wallet identity appears.
Either would justify re-opening this document and a fresh feasibility pass.
