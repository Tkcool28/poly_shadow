# Scalp Research Notes

Post-mortem for the in-play market-making research strand on Polymarket sports.
Sibling file: `SCALP_LOG.md` (working notes).

## Strategy: Market Making on Polymarket Sports — Retired

**Outcome**: Retired after live paper testing. Tight in-play spreads (1–2c
observed, not the 4–8c hypothesized from low-volume data) and slow event-feed
detection (~10s for goal events vs <1s CLOB repricing) make passive MM
unviable for a non-pro participant on these markets.

**What we proved**:

1. In-play EPL spreads stay at 1c on high-volume matches (CRY/LEE, NOT/FUL, MUN/AST).
2. Quoting 4c wide = filled only by toxic flow (100% adverse selection).
3. Event feed (ESPN) detects goals ~10s after CLOB reprices — too slow for protection.
4. Queue-depth modeling reduces fill count but doesn't change the sign of PnL.
5. Professional MMs dominate these markets with sub-second cancel latency and $40K+ queue depth at top of book.

### Paper test results (2026-03-15)

| Match | Score | Total PnL | Fills | RTs | Avg Spread Capture |
|---|---|---|---|---|---|
| CRY vs LEE | 0-0 | -$32.90 | 31 | 21 | -$0.94/RT |
| NOT vs FUL | 1-0 (Forest) | -$18.37 | 11 | 5 | -$1.22/RT |
| MUN vs AST | 3-1 (MUN) | -$35.91 | 39 | 29 | -$0.72/RT |
| **TOTAL** | | **-$87.18** | **81** | **55** | **-$0.87/RT** |

Config: spread=4c, size=$10, maxInventory=$50, queue=$100, eventPause=30s

---

## CLOB API capabilities (validated — useful for any future strategy)

- **GTC + post-only**: Resting limit orders; rejected if they'd cross spread.
- **Cancel**: Instant. `cancelOrder()`, `cancelAll()`, `cancelMarketOrders()`.
- **Heartbeat**: Auto-cancel on disconnect. Useful crash-safety property.
- **Fees**: Makers zero; EPL/NBA fee-free entirely.
- **Rate Limits**: 350/s order placement.
- **secondsDelay=3**: Affects marketable orders only. Post-only = instant.

---

## Proven dead ends (do not revisit)

1. **Taker scalping via ESPN/API polling**: Market reprices ~10s before ESPN. Zero window.
2. **Taker scalping via CLOB spike detection**: 3s mandatory delay kills it.
3. **Any speed-based taker strategy**: secondsDelay=3 + 0.3s repricing = guaranteed disadvantage.
4. **MM with wide spreads (4c+)**: Only filled by adverse selection. Proven live.
5. **MM with tight spreads (1–2c)**: Can't compete with $40K+ queue depth from pros at our capital. Fill rate ~0.
6. **Event-based quote cancellation via ESPN**: 10–15s latency. CLOB reprices in <1s. Useless for protection.

---

## What might still work (not pursued)

Captured for future reference; not in scope after retiring the MM strand.

1. **Pre-match MM**: Spreads are 1c but depth is massive. Probably the same problem.
2. **Niche / thin markets**: Low-volume exotic props (player specials, correct-score) where pros don't compete — but these may have ~$0 in-play trading.
3. **Cross-market arbitrage**: If the 3 outcomes (Win/Draw/Win) misprice relative to each other during fast moves. Brief opportunity during goals; would need sub-second execution.
4. **Settlement sniping**: Markets near expiry where implied probability deviates from reality. Needs a model + fast execution.
5. **Different asset class**: Crypto, politics, or other Polymarket categories where MM competition is weaker.

---

## Reusable infrastructure (built during this strand)

- Game feeds: `soccer-feed.ts` (ESPN), `nba-feed.ts`, `lol-feed.ts`
- CLOB WS: `clob-market-stream.ts` — real-time trades
- Market discovery: `scalp-market-discovery.ts`
- Sports WS: `wss://sports-api.polymarket.com/ws` — free, real-time scores
- MM engine: `scalp-market-maker.ts` — full quoting + fill sim + risk
- Backtest: `scalp-mm-backtest.ts`
- Risk limits: `scalp-risk-limits.ts`
- Analysis: `scalp-mm-analyze.ts`
- Capital allocator: `scalp-capital-allocator.ts`

### League data

| League | Series ID | Slug | Volume | Status |
|---|---|---|---|---|
| EPL | 10188 | `epl-` | $277K–$469K | Tested, unviable for MM |
| La Liga | 10193 | `lal-` | $148K–$331K | Not tested |
| UCL | 10204 | `ucl-` | $24K–$747K | Not tested |
| NBA | 10345 | `nba-` | $460K–$1.36M | Not tested |

---

## Research phases

- **Phase 0 — Research** (complete): API validation, spread analysis, fee structure.
- **Phase 1 — Paper MM** (complete, retired): Built full MM engine with quoting, fills, risk limits, event feeds. Paper-tested on 3 live EPL matches. Result: -$87.18 total across 55 round trips. No configuration reached positive avg-spread-capture.
- **Phase 2** (not pursued): MM optimization is not relevant once the strategy is retired.

---

## Key decisions

1. **2026-03-15 16:40 UTC**: MM strategy retired after 3-match live paper test. Total -$87.18. Root cause: in-play spreads are 1–2c (not 4–8c as hypothesized from low-volume WHU vs MCI data). Every fill is adverse selection. Event feed too slow (10s vs 0.3s CLOB repricing). Not a parameter-tuning problem — the edge doesn't exist on this microstructure.
2. **2026-03-15 13:06 UTC**: Built capital allocator. Volume-weighted with tier adjustments.
3. **2026-03-15 12:35 UTC**: Historical backtest on ARS vs EVE: all 30 param combos negative without event feed.
4. **2026-03-15 12:05 UTC**: Fixed paper MM treating `price_change` events as trades.
5. **2026-03-15 ~06:00 UTC**: Pivoted from taker to MM strategy after proving taker is unviable.
