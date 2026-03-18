# Scalp Trading Agent Memory

> **Last check-in**: 2026-03-15 16:40 UTC — MM strategy declared dead after live paper test. Analyzing pivot options.
> **Current phase**: Post-mortem. All 3 EPL paper tests completed. Total loss -$87.18 across 9 markets. Strategy is structurally unviable.

## Strategy: Market Making on Polymarket Sports — DEAD

**Verdict**: Unviable. Killed by tight in-play spreads (1-2c vs expected 4-8c) and adverse selection.

**What we proved**:
1. In-play EPL spreads stay at 1c on high-volume matches (CRY/LEE, NOT/FUL, MUN/AST)
2. Quoting 4c wide = only filled by toxic flow (100% adverse selection)
3. Event feed (ESPN) detects goals ~10s after CLOB reprices -- too slow for protection
4. Queue depth modeling reduces fill count but doesn't change the sign of PnL
5. Professional MMs dominate these markets with sub-second cancel latency and $40K+ queue depth

### Paper Test Results (2026-03-15)

| Match | Score | Total PnL | Fills | RTs | Avg Spread Capture |
|---|---|---|---|---|---|
| CRY vs LEE | 0-0 | -$32.90 | 31 | 21 | -$0.94/RT |
| NOT vs FUL | 1-0 (Forest) | -$18.37 | 11 | 5 | -$1.22/RT |
| MUN vs AST | 3-1 (MUN) | -$35.91 | 39 | 29 | -$0.72/RT |
| **TOTAL** | | **-$87.18** | **81** | **55** | **-$0.87/RT** |

Config: spread=4c, size=$10, maxInventory=$50, queue=$100, eventPause=30s

---

## CLOB API Capabilities (VALIDATED — still useful for any future strategy)

- **GTC + post-only**: Resting limit orders, rejected if they'd cross spread
- **Cancel**: Instant. `cancelOrder()`, `cancelAll()`, `cancelMarketOrders()`
- **Heartbeat**: Auto-cancel on disconnect. Great crash safety.
- **Fees**: Makers ZERO. EPL/NBA fee-free entirely.
- **Rate Limits**: 350/s order placement
- **secondsDelay=3**: Affects marketable orders only. Post-only = instant.

---

## Proven Dead Ends (DO NOT REVISIT)

1. **Taker scalping via ESPN/API polling**: Market reprices ~10s before ESPN. Zero window.
2. **Taker scalping via CLOB spike detection**: 3s mandatory delay kills it.
3. **Any speed-based taker strategy**: secondsDelay=3 + 0.3s repricing = guaranteed disadvantage.
4. **MM with wide spreads (4c+)**: Only filled by adverse selection. Proved live today.
5. **MM with tight spreads (1-2c)**: Can't compete with $40K+ queue depth from pros. Fill rate ~0 at our capital.
6. **Event-based quote cancellation via ESPN**: 10-15s latency. CLOB reprices in <1s. Useless for protection.

---

## What MIGHT Still Work (needs research)

1. **Pre-match MM**: Spreads are 1c but depth is massive. Probably same problem.
2. **Niche/thin markets**: Low-volume exotic props (player specials, correct score) where pros don't compete. But these may have $0 in-play trading.
3. **Cross-market arbitrage**: If 3 outcomes (Win/Draw/Win) misprice relative to each other during fast moves. Brief opportunity during goals. Would need sub-second execution.
4. **Settlement sniping**: Markets near expiry where implied probability deviates from reality. Needs a model + fast execution.
5. **Different asset class entirely**: Crypto, politics, or other Polymarket categories where MM competition is weaker.

---

## Available Infrastructure (built, reusable)

- Game feeds: `soccer-feed.ts` (ESPN), `nba-feed.ts`, `lol-feed.ts`
- CLOB WS: `clob-market-stream.ts` — real-time trades
- Market discovery: `scalp-market-discovery.ts`
- Sports WS: `wss://sports-api.polymarket.com/ws` — free, real-time scores
- MM engine: `scalp-market-maker.ts` — full quoting/fill sim/risk
- Backtest: `scalp-mm-backtest.ts`
- Risk limits: `scalp-risk-limits.ts`
- Analysis: `scalp-mm-analyze.ts`
- Capital allocator: `scalp-capital-allocator.ts`

### League Data

| League | Series ID | Slug | Volume | Status |
|---|---|---|---|---|
| EPL | 10188 | `epl-` | $277K-$469K | Tested, unviable for MM |
| La Liga | 10193 | `lal-` | $148K-$331K | Not tested |
| UCL | 10204 | `ucl-` | $24K-$747K | Not tested |
| NBA | 10345 | `nba-` | $460K-$1.36M | Not tested |

---

## Implementation Phases

### Phase 0 — Research (COMPLETE)
- [x] All API validation, spread analysis, fee structure

### Phase 1 — Paper MM (COMPLETE — FAILED)
- [x] Built full MM engine with quoting, fills, risk limits, event feeds
- [x] Paper tested on 3 live EPL matches
- [x] Result: -$87.18 total. Strategy structurally unviable.

### Phase 2 — CANCELLED
MM optimization no longer relevant.

### Phase NEXT — Pivot Decision (PENDING USER INPUT)
- [ ] User decides: pivot to a different strategy, or shelve scalp trading entirely
- Options: cross-market arb, thin-market MM, settlement sniping, different asset class, or stop

---

## Active Monitors

**Still running from earlier (may have timed out)**:
- Sports WS Logger: PIDs 63867/64031 (240min, started ~11 UTC)
- OB Monitors: PIDs 55834/55860/55910/58044 (started ~11:54 UTC)
- Crons: multiple scheduled for NBA/La Liga tonight (may want to cancel)

## Scheduled Crons (from earlier session — may want to CANCEL)

| ID | Time (UTC) | Purpose | Status |
|---|---|---|---|
| 2b015e2c | 16:50 | NBA: MIN vs OKC | Pending — probably should cancel |
| 0086c519 | 19:22 | NBA: DAL/DET/IND batch | Pending |
| 70ed45d8 | 21:52 | NBA: POR vs PHI | Pending |
| a165067e | 23:52 | NBA: GSW vs NYK | Pending |
| b533cea2 | 20:05 | La Liga: BAR vs SEV | Pending |
| Various check-ins | Various | Status checks | Pending |

## Errors / Blockers

- **STRATEGY IS DEAD**: MM on Polymarket sports markets is structurally unviable. Need user direction on pivot or shutdown.

## Decisions Log

1. **2026-03-15 16:40 UTC**: MM strategy declared dead after 3-match live paper test. Total -$87.18. Root cause: in-play spreads are 1-2c (not 4-8c as hypothesized from low-volume WHU vs MCI data). Every fill is adverse selection. Event feed too slow (10s vs 0.3s CLOB repricing). No parameter tuning can fix this — the edge doesn't exist.
2. **2026-03-15 13:06 UTC**: Built capital allocator. Volume-weighted with tier adjustments.
3. **2026-03-15 12:35 UTC**: Historical backtest on ARS vs EVE: ALL 30 param combos negative without event feed.
4. **2026-03-15 12:05 UTC**: Fixed paper MM treating `price_change` events as trades.
5. **2026-03-15 ~06:00 UTC**: Pivoted from taker to MM strategy after proving taker is unviable.
