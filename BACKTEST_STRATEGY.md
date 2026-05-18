# Backtest Strategy Reference

## Architecture

All three scripts share a common simulation engine (`src/scripts/lib/backtest-engine.ts`) and unified CLI flags (`src/scripts/lib/backtest-cli.ts`). DB connection is centralized in `src/scripts/lib/backtest-db.ts`.

## Available Scripts

| Script | Purpose | Scope |
|---|---|---|
| `backtest-single-trader.ts` | Backtest one trader over a time window | Single trader, configurable hours/days, per-prediction breakdown |
| `batch-backtest-traders.ts` | Backtest ALL completed traders in DB | All traders, ranking/scoring, CSV export |
| `batch-backtest-config-sweep.ts` | Find optimal config per trader | Named traders, sweeps 2000 config combos, Monte Carlo |

## Prerequisites

All scripts connect to the production DB via SSH tunnel on port 15438.

```bash
# Establish tunnel to production DB
ssh -f -N -L 15438:localhost:5438 $PROD_SSH_HOST

# Set DB password (required)
export PROD_PG_PASSWORD='...'
```

---

## CLI Flags

### Common Flags (all scripts)

| Flag | Type | Default | Description |
|---|---|---|---|
| `--copy-percent` | float | DB or `0.10` | Fraction of trader's trade to copy (0.10 = 10%) |
| `--max-trade` | float | DB or `8` | Max USD per single copy trade |
| `--max-pred` | float | DB or `30` | Max USD deployed per prediction (conditionId) |
| `--min-buy-price` | float | DB or `0.60` | Min entry price (0 = no filter) |
| `--gate` | int | `175` | Majority gate threshold in USD |
| `--exclude-slugs` | string | DB or `updown-5m,updown-15m` | Comma-separated slug patterns to exclude (`""` = none) |
| `--no-empirical-slippage` | bool | `false` | Use category-based slippage instead of empirical |
| `--no-capital-lockup` | bool | `false` | Instant PnL instead of locking capital until resolution |
| `--no-majority` | bool | `false` | Disable majority gate entirely |
| `--follow-all` | bool | `false` | Follow-all mode (no gate, copy sells, both sides) |
| `--starting-capital` | float | DB or `450` | Simulated starting capital |
| `--seed` | int | `42` | PRNG seed for reproducible results |
| `--verbose` | bool | `false` | Show per-prediction breakdown |
| `--output` | string | `""` | CSV output file path |
| `--hours` | int | `0` | Time window in hours (0 = full history) |
| `--days` | int | `0` | Time window in days (takes precedence over --hours) |

### Script-Specific Flags

#### backtest-single-trader.ts

| Flag | Type | Default | Description |
|---|---|---|---|
| `--trader` | string | `0x8dxd` | Trader wallet prefix, allocation ID substring, or userName |

Note: Defaults to `--hours 24` if no time window specified. Pulls allocation config from DB `FollowAllocation` table when available.

#### batch-backtest-traders.ts

| Flag | Type | Default | Description |
|---|---|---|---|
| `--trader` | string | `""` | Filter to single trader (wallet prefix or userName) |
| `--limit` | int | `1000` | Max traders to process |
| `--min-positions` | int | `20` | Min trade count to include trader |
| `--min-trader-roi` | float | `0` | Min trader ROI% to appear in profitable list |
| `--min-copy-buys` | int | `10` | Min copy buys to appear in profitable list |
| `--min-days` | int | `0` | Min active days to appear in profitable list |

#### batch-backtest-config-sweep.ts

| Flag | Type | Default | Description |
|---|---|---|---|
| `--trader` | string[] | `FloatyBoi,LampStore` | Trader names or wallets (repeatable: `--trader A --trader B`) |
| `--top` | int | `20` | Number of top configs to display |

**Sweep dimensions** (hardcoded, 2000 combinations):

| Parameter | Values swept |
|---|---|
| minBuyPrice | 0.20, 0.30, 0.40, 0.50, 0.60 |
| gate | 0, 50, 100, 175, 250 |
| maxTrade | 3, 5, 8, 12 |
| maxPred | 10, 20, 30, 50 |
| copyPercent | 0.05, 0.10, 0.15, 0.20 |

---

## Simulation Modes

### 1. Majority Gate Mode (default)

The production default. Only copies the majority side after the trader accumulates enough volume on a prediction.

**How it works:**
1. Accumulate trader BUY volume per conditionId per outcome
2. Wait until total volume on that conditionId exceeds `gate` USD
3. Require at least 2 outcomes with volume (prevents one-sided bias)
4. Only copy the outcome with >50% of total volume
5. Once committed to a side, never flip (committed side lock)
6. Self-exclusion: current trade's volume excluded from gate calculation

**When to use:** General-purpose — filters out noise, ensures we only copy high-conviction predictions.

### 2. Follow-All Mode (`--follow-all`)

Copies every qualifying trade regardless of majority. Also copies SELLs proportionally.

**How it works:**
1. No majority gate — every BUY passing price/size filters is copied
2. SELL trades trigger proportional exit (sells same fraction of our position)
3. Both sides can be bought on same conditionId
4. PnL from sells realized immediately; unsold positions resolved at market outcome

**When to use:** For traders who actively manage positions (buy/sell within same market) or trade both sides.

### 3. Capital Lockup Mode (default ON)

Capital is locked until market resolution (`Market.endDate`), not instantly recycled.

**How it works:**
- Each copy buy locks capital in a queue sorted by resolution date
- As simulation time advances, matured positions release capital + PnL
- Available capital = `startingCapital - currentlyLocked + releasedPnl`
- Fallback lockup: 7 days for markets missing `endDate`

**When disabled (`--no-capital-lockup`):**
- Instant PnL — capital recycled immediately after each trade
- Overstates available capital (unrealistic for live trading)

---

## Simulation Parameters (Fixed Constants)

| Constant | Value | Description |
|---|---|---|
| `FEE_RATE` | 0.25 | Polymarket taker fee coefficient |
| `FEE_EXPONENT` | 2 | Fee formula: `FEE_RATE * (p * (1-p))^FEE_EXPONENT` |
| `FALLBACK_FAK_FAILURE_RATE` | 12% | FAK order fill failure rate (if <50 empirical samples) |
| `BUY_FAILURE_COOLDOWN_SEC` | 15 | After FAK failure, skip same conditionId for 15s |
| `FALLBACK_LOCKUP_SEC` | 7 days | Default lockup for markets missing endDate |

---

## Empirical Calibration (auto from DB)

Both slippage and FAK failure rate are calibrated from production `CopyTrade` data at startup (requires >=50 samples).

### Slippage Model

| Source | Method |
|---|---|
| **Empirical** (default) | Right-skewed triangular distribution from `CopyTrade.slippageBps` (p50/p75/p90) |
| **Category-based** (`--no-empirical-slippage`) | Uniform random per market category: 5m=3-8%, 15m=2-6%, 1h=2-5%, other=1-3% |

Applied as: `fillPrice = min(tradePrice * (1 + slippagePct), 0.99)`

### FAK Failure Model

Empirical fill rate from `CopyTrade WHERE executionMethod='FAK'`. On failure, a 15s cooldown blocks retries on the same conditionId (matches production behavior).

---

## Trade Filters (Pipeline Order)

Each trader's BUY trade passes through these filters in order:

| # | Filter | Condition to pass | Skip counter |
|---|---|---|---|
| 1 | Slug exclusion | `eventSlug` does not contain any excluded pattern | `slug` |
| 2 | Outcome index | Outcome can be resolved to a numeric index | — |
| 3 | Price guard | `minBuyPrice <= price <= 0.95` | `price` |
| 4 | Min fill size | `size * price >= $1` | — |
| 5 | Majority gate | Accumulated volume >= gate, majority side, 2+ outcomes | `gate` |
| 6 | Committed side | Not flipping to opposite side on same conditionId | `gate` |
| 7 | Capital available | `available >= $1` | `capital` |
| 8 | Prediction cap | `predDeployed < maxPred` and remaining >= $1 | `pred` |
| 9 | Size floor | `copyAmount >= $1` after all caps applied | — |
| 10 | FAK cooldown | Not in 15s cooldown for this conditionId | `fak` |
| 11 | FAK failure | Random draw passes fill rate | `fak` |

## Sizing Logic

```
copyAmount = min(tradeUsd * copyPercent, maxTrade)
copyAmount = min(copyAmount, maxPred - predDeployed[conditionId])
copyAmount = min(copyAmount, availableCapital)
if copyAmount < $1 → skip
```

---

## Scoring Formula

```
samplePenalty = min(1, ln(1 + copyBuys) / ln(51))    # reaches 1.0 at ~50 buys
score = copyROI * (1 - scalpPct/100) * samplePenalty * (1 / (1 + maxDdPct/20))
```

- Penalizes high scalp% (sell-heavy traders)
- Penalizes small sample sizes (logarithmic ramp)
- Penalizes high drawdown (hyperbolic decay)
- Negative PnL → score = -1
- Config sweep additionally requires `copyBuys >= 10` for ranking

---

## Output Metrics

| Metric | Description |
|---|---|
| `copyPnl` | Total simulated copy-trade PnL in USD |
| `copyDeployed` | Total USD deployed across all copy buys |
| `copyRoi` | `copyPnl / copyDeployed * 100` |
| `copyWr` / `holdWr` | Win rate across individual positions |
| `copyBuys` | Number of copy buys executed |
| `maxDd` / `maxDdPct` | Maximum drawdown in USD / as % of starting capital |
| `copySharpe` | Sharpe ratio on daily returns (PnL/deployed per day) |
| `dayWr` | % of days with positive PnL |
| `scalpPct` | `sellCount / totalBuyCount * 100` (trader's sell activity) |
| `pnlPerDay` | `copyPnl / calendarDays` |
| `cryptoPct` | % of buys in crypto updown markets (5m+15m+1h) |

---

## Example Commands

```bash
# Single trader, 24h, prod config from DB
npx tsx src/scripts/backtest-single-trader.ts --trader 0x8dxd --hours 24

# Single trader, 7 days, custom config
npx tsx src/scripts/backtest-single-trader.ts --trader LampStore --days 7 \
  --exclude-slugs "" --min-buy-price 0.40 --gate 100

# Single trader with CSV export
npx tsx src/scripts/backtest-single-trader.ts --trader 0x8dxd --hours 48 --output results.csv

# All traders, full history, default filters
npx tsx src/scripts/batch-backtest-traders.ts

# All traders with time window
npx tsx src/scripts/batch-backtest-traders.ts --hours 24

# Single trader via batch (with ranking context)
npx tsx src/scripts/batch-backtest-traders.ts --trader LampStore --hours 24 --verbose

# All traders, no slug exclusion, no capital lockup (legacy mode)
npx tsx src/scripts/batch-backtest-traders.ts --exclude-slugs "" --no-capital-lockup

# Config sweep for specific traders
npx tsx src/scripts/batch-backtest-config-sweep.ts --trader FloatyBoi --trader LampStore

# Config sweep with time window
npx tsx src/scripts/batch-backtest-config-sweep.ts --trader LampStore --hours 24

# Config sweep, follow-all mode
npx tsx src/scripts/batch-backtest-config-sweep.ts --trader 0x8dxd --follow-all
```

---

## Binary Market Math: Why High WR Can Lose Money

On binary markets (crypto updown), the payoff is asymmetric:
- **Win**: profit = `(1 - entryPrice) / entryPrice` minus fees/slippage
- **Lose**: loss = 100% of deployed capital

Breakeven win rate by entry price (after ~5% fees+slippage):

| Entry Price | Win Profit | Breakeven WR |
|---|---|---|
| $0.30 | ~220% | ~31% |
| $0.40 | ~140% | ~42% |
| $0.50 | ~90% | ~53% |
| $0.60 | ~58% | ~63% |
| $0.70 | ~35% | ~74% |
| $0.80 | ~19% | ~84% |
| $0.85 | ~12% | ~89% |
| $0.90 | ~6% | ~94% |

At `minBuyPrice=0.60`, most fills land at 0.70-0.85, requiring 74-89% WR just to break even.
