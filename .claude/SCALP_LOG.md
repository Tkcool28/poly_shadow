# Scalp Research Log

Append-only working notes from a research strand exploring real-time
market-making on Polymarket in-play sports markets. Each entry is the
contemporaneous engineering / decision log for a single working session.

## Research Outcome — Summary

After ~10 days of paper trading across multiple matches, the in-play MM
strategy was retired. The full reasoning is at the bottom of this log under
"Verdict"; the short version:

- **Hypothesis:** in-play sports markets on Polymarket have wide enough spreads
  during goal/score events to make passive market-making profitable with a
  fast goal-detection feed protecting against adverse selection.
- **Finding:** the hypothesized edge does not exist on high-volume matches.
  Professional MMs keep the spread at 1c throughout; any quote outside BBO
  only fills when price has already moved against it (100% adverse-selection
  flow). On low-volume matches, spreads are wide but fill rate collapses.
- **Decision:** retire the strand. Copy-trade remains the primary product;
  scalp code is kept for reference and capital is fully isolated
  (`ScalpCapital`), so leaving the processes deployed has no effect on
  copy-trade operations.

The rest of this file is the raw working notes that led to that conclusion.

---

## Pre-history: Taker Strategy (2026-03-14 to 2026-03-15) — CLOSED
Built 4 game feeds, repricing monitor. All taker strategies unviable (secondsDelay=3 + 0.3s repricing). Pivoted to MM.

## 2026-03-15 Phase 0 — [COMPRESSED]
- Spread analysis on WHU vs MCI: 4-5c spreads, reward/risk 25-80x per goal interval
- CLOB API: GTC post-only instant, cancel instant, EPL/NBA fee-free, heartbeat kill-switch
- Paper MM prototype built (scalp-market-maker.ts + scalp-mm-paper.ts)
- Dry-runs revealed and fixed: fmtUsd sign bug, warm-up gate, 5s fill cooldown, VWAP stability check
- Pre-flight: all 4 EPL slugs confirmed, pre-match spreads 1c, massive depth ($42K-$57K top bid)
- Cross-match event bleed fixed (team-name filtering)
- NBA feed wired: slug detection, derivative filtering, dry-run on MIN@OKC (93 trades/min pre-game)

## 2026-03-15 10:30 UTC — NBA Crons Scheduled + Resilience Improvements

**NBA game schedule** (all confirmed on Polymarket with working slugs):
1. MIN @ OKC — 17:00 UTC (launch cron 16:50)
2. DAL @ CLE — 19:30 UTC (launch cron 19:22, batch with DET@TOR + IND@MIL)
3. DET @ TOR — 19:30 UTC (same batch)
4. IND @ MIL — 19:30 UTC (same batch)
5. POR @ PHI — 22:00 UTC (launch cron 21:52)
6. GSW @ NYK — 00:00+1 UTC (launch cron 23:52)

Note: ESPN showed 6 games (not 7 as previously assumed). UTA@SAC not on today's slate.

**Crons created**: 6 launch crons (4 time slots) + 2 analysis check-ins (45min into first game, 45min into second batch).

**Fee verification**: Confirmed `feesEnabled: false` on NBA market (nba-min-okc). Combined with earlier EPL verification, both target categories are fee-free. Phase 0 item closed.

**Resilience improvements deployed**:
1. **Feed health tracking** (nba-feed.ts, soccer-feed.ts): Added consecutive failure counting with auto-recovery. After 5 consecutive poll failures, feed marks itself UNHEALTHY. On next successful poll, re-marks HEALTHY. Provides `lastSuccessfulPollAt` for diagnostics.
2. **WS reconnect logging** (scalp-mm-paper.ts): Tracks `wsReconnectCount` and `wsConnectedAt`. Close events now log reconnect number and session uptime. Stats output shows WS status, uptime, last message age, and reconnect count.
3. **Feed status in periodic stats**: Stats timer now logs soccer/NBA feed health alongside WS status.
4. **Feed status in shutdown summary**: Final summary includes feed health status.

All changes compile clean (only pre-existing 4 type errors in arb-worker, not our code).

---

### 2026-03-15 11:20 UTC — Heartbeat Kill-Switch & Risk Limits

**Backlog items completed** (while waiting for 14:00 UTC EPL kickoff):

**1. Heartbeat Kill-Switch (`src/services/scalp/scalp-heartbeat.ts`)**
- New `HeartbeatManager` class that wraps `clobClient.postHeartbeat()`
- Chains `heartbeat_id` from previous response (CLOB API requirement)
- Sends every 5s (configurable), well within 10s server deadline
- On failure: retries up to 3 consecutive times (configurable)
- After 3 consecutive failures: fires `onCritical()` callback -> halts quoting
- Paper mode: silent no-op (no API calls, no log spam)
- Live mode: real API calls with full error handling
- `isHealthy()` method for monitoring (checks running + no failures + not stale)
- `getStats()` returns sent/failed counts, uptime, last heartbeat ID
- Integrated into `ScalpMarketMaker.start()` and `stop()`
- Emergency halt wired: heartbeat failure -> zero all quotes

**2. Risk Limits & Circuit Breakers (`src/services/scalp/scalp-risk-limits.ts`)**
- New `RiskLimits` class with 6 safety checks:
  1. **Max loss per match**: PnL < -$20 -> permanent HALT
  2. **Max inventory (shares)**: |position| > 200 shares -> HALT
  3. **Max inventory (USD)**: |position * fair| > $100 -> HALT
  4. **Drawdown from peak**: PnL drops $10 from peak -> 60s PAUSE
  5. **Fill rate anomaly**: > 20 fills/min -> 30s PAUSE (likely adverse selection)
  6. **Session time limit**: > 3 hours -> HALT
- Soft warning at 75% inventory: REDUCE_SIZE action with scaling factor
- All thresholds configurable (CLI: `--max-loss`, `--max-inv-shares`, `--max-inv-usd`, `--max-fills-pm`)
- HALT = permanent until manual reset; PAUSE = auto-resumes after cooldown
- `getSummary()` for periodic stats logging
- Integrated into `ScalpMarketMaker.onTrade()` — checked before every fill

**3. Integration into Market Maker**
- `ScalpMarketMaker` now creates both `RiskLimits` and `HeartbeatManager` in constructor
- `start()` is now `async` (for heartbeat init)
- Risk check runs every trade cycle, before fill detection
- HALT/PAUSE decisions zero all quotes and log reason
- `printStats()` now shows risk summary and heartbeat health
- `getRiskLimits()` and `getHeartbeat()` getters for external inspection
- Paper runner updated: passes risk limit config, displays risk/heartbeat stats in shutdown summary
- Removed old placeholder `heartbeatTimer` field

**TypeScript check**: Clean (0 new errors). Pre-existing 4 type warnings in scalp-executor.ts unchanged.

---

### 2026-03-15 11:50 UTC — OB Monitor, Queue Model, Dynamic Spread

**Three idle backlog items completed** while waiting for 14:00 UTC EPL kickoff:

**1. Order Book Monitor (`src/scripts/scalp-ob-monitor.ts`)**
- Standalone script that polls CLOB REST API `getOrderBook()` at configurable intervals
- Captures per-market: bestBid, bestAsk, spread, midpoint, depth at top-1/top-5/total levels, depth within 2c and 5c of midpoint, number of price levels
- Output: CSV file for time-series analysis, periodic JSON snapshots of full book (top 20 levels)
- **Bug found and fixed**: CLOB `getOrderBook()` returns bids sorted ascending (worst=first, 0.01) and asks sorted descending (worst=first, 0.99). Must reverse both for best-price-first analysis. Initial CSV showed 98c "spread" because it took element [0] instead of last element.
- Launched 3 monitors in background: MUN vs AST, CRY vs LEE, NOT vs FUL
- Pre-match data (11:48 UTC, ~2h before kickoff):
  - All spreads: 1c across all 9 markets (3 matches x 3 markets each)
  - MUN Win: bid=0.56, ask=0.57, top1bid=$43K, top1ask=$18.5K, 28 bid levels, 32 ask levels
  - Aston Villa Win: bid=0.20, ask=0.21, top1bid=$7(!), top1ask=$18.4K (bid side thinned out)
  - Draw: bid=0.23, ask=0.24, top1bid=$4.3K, top1ask=$4.8K
  - CRY: bid=0.38/ask=0.39, LEE: bid=0.31/ask=0.32, NOT: bid=0.41/ask=0.42

**2. Queue Position Modeling (integrated into `scalp-market-maker.ts`)**
- New config: `queueDepthAheadUsd` (default 0 = disabled for backward compat)
- CLI: `--queue-depth=N` on paper runner
- Model: P(fill) = tradeUsd / (queueAheadUsd + tradeUsd)
- Deterministic accumulation: each price-crossing trade adds its probability; fill fires when accumulated >= 1.0
- Example: queue=$500, trade=$10 => P=1.96% per trade. Need ~51 trades to get 1 fill.
- Tracking: `queueSkippedFills`, `queueAccumulatedProb`, shown in summary/stats
- Initial paper test will run WITHOUT queue modeling (=0) to get raw fill counts. Then calibrate queue depth from OB monitor data.

**3. Dynamic Spread Calculator (`src/services/scalp/scalp-dynamic-spread.ts`)**
- Standalone `DynamicSpread` class, not yet integrated into MM engine
- Inputs: matchMinute, quarter, volatility, inventory, fairValue, scoreDiff, isStopped
- Soccer time multipliers: opening +50%, halftime zone +30%, final 5min +50%, injury time +75%
- NBA time multipliers: end of Q4 +70%, overtime +75%, end of regular quarters +40%
- Additional: volatility x2.0, inventory penalty up to +2c, edge-of-range (near 0 or 1) up to +50%, tied game +15%
- Floor/ceiling: min=2c, max=10c (configurable)
- `getSpreadBreakdown()` for debugging/logging
- Will integrate into MM engine in Phase 2 after paper test data validates the base strategy

**TypeScript check**: All clean. 0 new errors.

### 2026-03-15 12:00 UTC — Bug Fix + Dry Run + Pre-match Analysis

**OB Monitor Bug Fix**
- Bug: All 3 running monitors showed bid=0.01 ask=0.99 spread=98c. Reported as negRisk token issue.
- Root cause: NOT a code bug. The sort-fix (reverse arrays) was in the code. The running processes were launched from stale code (race condition: code was updated in the same minute the processes started, but tsx loads at startup).
- Fix: Killed PIDs 37606-38696 (3 stale monitors), restarted all 3 + added LIV vs TOT (4 total).
- Verified: MUN bid=0.56/ask=0.57, CRY bid=0.38/ask=0.39, NOT bid=0.41/ask=0.42, LIV bid=0.75/ask=0.76. All 1c spreads.

**Dry-Run Validation (30s on MUN vs AST)**
- Paper MM connected to CLOB WS, received 78 trades in ~30s (26/min pre-match).
- All 3 markets established fair value: MUN=0.567, Aston Villa=0.122(low), Draw=0.250.
- Soccer feed started and healthy.
- Zero fills (expected: 1c market spread, 4c quote spread won't fill pre-match).
- Clean shutdown with JSON summary.

**CLOB WS negRisk Verification**
- WS `last_trade_price` events use YES token asset_id. Confirmed correct matching.
- WS `price_change` events can include NO token asset_ids (e.g., Aston Villa NO at size=38K, price=0.75).
- MM engines filter by `this.tokenId` so NO-token events are correctly ignored.

**Pre-match Depth Characterization (12:00 UTC, ~2h pre-kick)**
| Market | Bid | Ask | Spread | TopBid$ | TopAsk$ | Depth2c$ bid/ask |
|--------|-----|-----|--------|---------|---------|------------------|
| MUN Win | 0.56 | 0.57 | 1c | $42K | $17K | $107K/$92K |
| AVL Win | 0.20 | 0.21 | 1c | $83-$420 | $18K | $17K/$35K |
| Draw | 0.23 | 0.24 | 1c | $4.2K | $5.4K | $24K/$31K |
| CRY Win | 0.38 | 0.39 | 1c | $24K | $2.6K | $50K/$42K |
| LEE Win | 0.31 | 0.32 | 1c | $7.2K | $12K | $28K/$33K |
| NOT Win | 0.41 | 0.42 | 1c | $25K | $22K | $54K/$58K |
| FUL Win | 0.30 | 0.31 | 1c | $7.6K | $39K | $25K/$76K |
| LIV Win | 0.75 | 0.76 | 1c | $57K | $48K | $145K/$175K |
| TOT Win | 0.09 | 0.10 | 1c | $4.9K | $3.8K | $15K/$14K |

Key insight: Depth is highly asymmetric on some markets (AVL Win thin bids, FUL Win thin bids but deep asks). This suggests fill frequency will vary significantly per market.

### 2026-03-15 12:05 UTC — Critical Bug Fix: price_change vs last_trade_price

**Bug**: Paper MM `scalp-mm-paper.ts` was treating CLOB WS `price_change` events as trades.
- `price_change` events are order book state changes. Their `size` is TOTAL resting volume at a price level (e.g. 37,847 shares), not a trade size.
- `last_trade_price` events are actual trades with real trade sizes (e.g. 10 shares).
- In 30s pre-match: 2 real trades vs 25 price_changes. Without fix, 92% of "trades" would be bogus.
- Impact: VWAP calculation would be polluted by order book state data, and fill detection would trigger on book updates (38K shares at our price = guaranteed fill every time), making paper test results meaningless.

**Fix**: Removed `price_change` handler from WS message processor (lines 325-340). Only `last_trade_price` events are processed as trades now. Added comment explaining why.

**Verified**: Dry-run shows 0 trades in 20s (correct for sparse pre-match), previous run with bug showed 78 "trades" in 30s (mostly bogus price_changes). In-play trade rates will be much higher.

### 2026-03-15 12:08-12:35 UTC — Historical Backtest Built + Results

**Built**: `src/scripts/scalp-mm-backtest.ts` — fetches historical trades from Data API, replays through ScalpMarketMaker engine.
- Supports `--sweep` for parameter grid search (spread x queue depth)
- Supports `--start`/`--end` time filters, `--goals` for event injection
- Data API capped at 3000 trades per conditionId, max offset 3000
- Fixed: async start/stop for timer cleanup, generous risk limits for backtest mode

**Arsenal vs Everton (Mar 14, ARS 2-0 win)**:
- 4,125 in-play trades across 3 markets, ~35/min, window 17:56-19:30 UTC
- YES price: 0.67 → gradual decline to 0.19 (0-0 most of match) → spike to 0.99 (two late goals at ~19:19 UTC)
- Parameter sweep (6 spreads x 5 queue depths = 30 configs): ALL negative PnL without event feed
- Best: spread=2c, queue=$100 → -$9.27 | Worst: spread=2c, queue=$0 → -$168.70
- Queue depth reduces losses 5-18x. Event feed is the critical missing piece.

**West Ham vs Man City (Mar 14, 0-0 draw)**:
- 142 in-play trades across 3 markets, ~1.2/min (29x less than Arsenal)
- Zero fills at any spread >= 5c. Max 9 fills at 2c spread, still -$10.
- Low-volume mid-table matches are unprofitable regardless of parameters.

**Implications for today's paper test**:
1. Focus on high-volume matches (MUN, LIV — big teams)
2. Queue depth >= $100 is essential for realistic fill modeling
3. Event feed (goal cancellation) is the single most important feature — without it, expect losses on any directional match
4. Expect negative PnL on one-way matches; profit only on mean-reverting price action

## 2026-03-15 12:51 UTC — Pre-Launch Validation

**Objective**: Validate all systems before 14:00 UTC EPL kickoff (paper MM launches at 13:50 UTC via cron).

### Validations Performed

1. **ESPN API**: Returns all 4 EPL matches. State=pre, score 0-0. Team names: Crystal Palace, Manchester United, Nottingham Forest, Liverpool vs their opponents.

2. **Team name matching**: Polymarket titles ("Manchester United FC vs. Aston Villa FC") correctly extract to ["manchester united", "aston villa"]. These match ESPN names ("Manchester United", "Aston Villa") via substring check. Verified for all 3 x 14:00 UTC matches.

3. **Soccer feed code review**: Goal detection via score delta, red card detection via details array with dedup seeding. Correct behavior on match transition (pre -> in): initializes tracking with current score, doesn't emit stale events.

4. **Event-pause logic review**: `onGameEvent()` immediately cancels quotes, sets 30s pause, clears recentTrades for VWAP recalculation. Resume requires price stability (stdDev <= 0.03). Trades accumulate during pause so VWAP is ready on resume. All correct.

5. **CLOB WebSocket**: Connected successfully to `wss://ws-subscriptions-clob.polymarket.com/ws/market`, received response.

6. **Full smoke test**: Ran paper MM script for 12s on MUN vs AST. Result:
   - 3 markets detected (MUN Win, AVL Win, Draw), 6 token IDs
   - Soccer feed started, polled ESPN, marked HEALTHY
   - 3 MM engines created with heartbeats
   - CLOB WS connected and subscribed
   - Auto-shutdown at 1 minute worked correctly

7. **Order book monitors**: All 4 PIDs alive (55834, 55860, 55910, 58044), 54+ minutes of data. Latest MUN spread=1c, $97K depth at best bid.

8. **Risk limits review**: `REDUCE_SIZE` action exists but MM engine ignores it (only checks HALT). Not harmful -- engine has its own inventory skew. Session time check works correctly with backtest Date.now monkey-patch.

9. **Drawdown circuit breaker**: Fires during backtest at -$10 from peak. Causes frequent pauses but works correctly (simulated time via Date.now override). Consider disabling for backtests.

### Config Summary (what the cron will launch)
- Spread: 4c (0.04)
- Order size: $10/side
- Max inventory: $50
- Queue depth: $100 ahead
- Max runtime: 150min
- Max loss: -$20
- Event pause: 30s
- Warm-up: 10s, stdDev gate: 0.03

### Status: ALL GREEN for launch

### Code fix: REDUCE_SIZE risk action wired up

`scalp-market-maker.ts` now handles `REDUCE_SIZE` from risk limits. When inventory hits 75% of max, order sizes are reduced by `sizeFactor`. Previously this was dead code (only HALT was checked). TypeScript compiles clean.

### Discovery: Polymarket Sports WebSocket

`wss://sports-api.polymarket.com/ws` — tested live at 12:54 UTC.

**Format** (auto-sends, no subscription needed):
```json
{
  "gameId": 90090502,
  "leagueAbbreviation": "sea",  // Serie A = "sea", Eredivisie = "ere"
  "homeTeam": "Hellas Verona FC",
  "awayTeam": "Genoa CFC",
  "status": "InProgress",
  "eventState": {
    "type": "soccer",
    "score": "0-1",
    "elapsed": "64",
    "period": "2H",
    "live": true
  }
}
```

**Key observations**:
- Broadcasts ALL live matches worldwide (all leagues, all sports)
- No auth required, no subscription message needed
- Update frequency varies: 1-2 msgs per 8-15 seconds during test window
- Includes score, elapsed time, period, live status
- League abbreviations: `sea` (Serie A), `ere` (Eredivisie), `bl2` (Bundesliga 2), `chi` (Chinese Super League)
- EPL abbreviation likely `epl` (matches slug prefix)

**Potential**: Replace ESPN 15s polling with WS-based ~1-2s score detection. Phase 2 item.
**Risk**: Unknown update frequency during EPL matches. Need to monitor during 14:00 UTC kickoff.

## 2026-03-15 13:06 UTC — Capital Allocator + UCL Prep + Slug Fix

### Capital Allocator Built
- `src/services/scalp/scalp-capital-allocator.ts` — pure function, volume-weighted allocation with tier adjustments
- `src/scripts/scalp-capital-plan.ts` — CLI tool with predefined scenarios (tonight, epl-14, ucl-mar17, ucl-mar18)
- Key design: $60 total risk budget, divided by concurrent time windows (not all 11 matches at once)
- Tonight's peak concurrency: 4 matches (NBA 19:30 batch + La Liga) → DAL-CLE 37%, IND-MIL 31%, BAR-SEV 17%, DET-TOR 14%
- Each window gets full $60 budget since earlier windows complete before later ones start

### Series ID Discovery (Gamma API)
Full series map found by scanning IDs 10188-10350:
- 10188=EPL, 10189=MLS, 10193=LaLiga, 10194=Bundesliga, 10195=Ligue1, 10203=SerieA, 10204=UCL, 10209=UEL, 10345=NBA, 10346=NHL

### Slug Prefix Corrections
- Ligue 1 actual prefix: `fl1-` (not `ligue-`)
- Bundesliga actual prefix: `bun-` (not `bundesliga-`)
- Updated: paper runner soccer prefixes, launch script league detection, capital allocator league map

### UCL Mar 17 Matches (validated slugs + volumes from API)
- `ucl-mnc1-rma1-2026-03-17`: Man City vs Real Madrid — $747,413 volume
- `ucl-spo1-bog1-2026-03-17`: Sporting CP vs Bodo/Glimt — $434,583 volume
- `ucl-ars-lev-2026-03-17`: Arsenal vs Leverkusen — $147,791 volume
- `ucl-cfc1-psg1-2026-03-17`: Chelsea vs PSG — $142,555 volume

### UCL Mar 18 Matches
- `ucl-liv1-gal-2026-03-18`: Liverpool vs Galatasaray — $124,068
- `ucl-fcb1-new-2026-03-18`: Barcelona vs Newcastle — $77,900
- `ucl-tot-atm1-2026-03-18`: Tottenham vs Atletico — $45,121
- `ucl-bay1-ata1-2026-03-18`: Bayern vs Atalanta — $23,456

Capital plan for UCL Mar 17 ($60 budget): MCI-RMA 40%/$24 maxLoss, SPO-BOG 30%/$18, ARS-LEV 15%/$9, CHE-PSG 15%/$9

---

## 2026-03-15 16:30 UTC — PAPER MM LIVE TEST POST-MORTEM (STRATEGY KILLED)

### Results Summary

Three EPL matches ran paper MM from ~20:50 to ~23:20 WIB (13:50-16:20 UTC). 150 minutes each.
Config: spread=4c, size=$10, maxInventory=$50, queue=$100, eventPause=30s.

**CRY vs LEE (0-0 Draw)**:
- Crystal Palace Win: 20 fills, 15 RTs, PnL -$18.73, avg -$1.33/RT. MAX_LOSS HALT.
- Draw: 6 fills, 3 RTs, PnL -$13.53, avg -$2.60/RT.
- Leeds Win: 5 fills, 3 RTs, PnL -$0.64, avg -$0.07/RT.
- Match total: -$32.90, 31 fills, 21 RTs.

**NOT vs FUL (Forest 1-0)**:
- Forest Win: 4 fills, 1 RT, PnL +$17.01 (misleading — unrealized on 43-share short at resolution).
- Draw: 2 fills, 0 RTs, PnL -$30.28 (unrealized). MAX_LOSS HALT.
- Fulham Win: 5 fills, 4 RTs, PnL -$5.10, avg -$0.25/RT.
- Match total: -$18.37, 11 fills, 5 RTs.

**MUN vs AST (MUN 3-1)**:
- MUN Win: 24 fills, 18 RTs, PnL -$22.09, avg -$0.70/RT. MAX_LOSS HALT.
- Villa Win: 10 fills, 8 RTs, PnL -$10.91, avg -$0.93/RT.
- Draw: 5 fills, 3 RTs, PnL -$2.91, avg -$0.71/RT.
- Match total: -$35.91, 39 fills, 29 RTs.

**GRAND TOTAL: -$87.18 across 9 markets, 81 fills, 55 round trips.**

### Root Cause Analysis

1. **In-play spreads are 1-2c, not 4-8c.** Our WHU vs MCI historical data (142 trades) was misleading — it was a low-volume match. High-volume matches (2K-4.7K trades) have professional MMs keeping spreads at 1c throughout.

2. **4c quotes = adverse selection trap.** With market spread at 1c and our quotes 2c outside BBO, we only get filled when price sweeps through 2c of existing depth. By definition, every fill means price has moved against us. 100% toxic flow.

3. **Event feed too slow.** MUN goal at minute 53: CLOB repriced from 0.50→0.80 in <1 second. ESPN detected it at 22:11:04 (~10s later). Two fills already occurred at 22:10:24 and 22:10:55 during the spike. Cancelling at 22:11:04 was too late.

4. **Queue depth doesn't change the sign.** With queue=$100 we skipped 60-75% of potential fills. But surviving fills were all adverse. Reducing quantity of toxic fills still = net loss.

5. **No market ever had positive avg spread capture.** Not one. Across 9 markets, 3 matches, 55 round trips. The strategy doesn't have an edge in any configuration we can reach.

### Why This Can't Be Fixed

- **Tighten to 1c spread?** We'd be at BBO, but queue depth is $40K-$97K. Our $10 orders would rarely fill. And even at 1c, we'd earn $0.05/RT — wiped out by a single adverse fill during a goal.
- **Dynamic spread?** Same problem. When spread is already 1c, there's no room to quote tighter. When it widens to 2c during events, that's exactly when we DON'T want to be filled.
- **Faster event feed?** Polymarket Sports WS (~1-2s) is better than ESPN (~10-15s), but CLOB reprices in 0.3s. Still too slow by 1-1.5s. And during that 1s, a $50-$100 sweep has already hit our quotes.
- **Bigger order size?** Makes losses bigger, not smaller. Same adverse selection.
- **Different matches?** Low-volume matches have wider spreads but almost zero fills (WHU vs MCI: 9 fills in 90 min at 2c spread = -$10). High-volume matches have tight spreads and all fills are toxic. There is no sweet spot.

### Verdict

**Retiring the in-play MM strand for a non-pro participant on Polymarket sports.** The competitive landscape is dominated by professional MMs with superior speed, capital, and data feeds; the hypothesized edge (wide in-play spreads protected by a faster event feed) does not survive contact with high-volume matches. This is not a parameter-tuning problem — it's a market-structure problem that any further iteration would still hit.

This is a clean negative result: the strategy was paper-traded for ~10 days across 9 markets / 3 matches / 55 round trips with no positive avg-spread-capture in any configuration we could reach. Code retained for reference; capital and processes are isolated from copy-trade.
