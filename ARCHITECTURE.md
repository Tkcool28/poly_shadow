# Architecture

This repo hosts several trading products that share a single codebase, database,
and CLOB client:

- **Copy-Trade** — Copies trades from target traders on Polymarket. The primary
  product. Runs on real capital in production.
- **Arb Worker** — Independent strategy: BTC up/down last-minute arbitrage on
  Polymarket crypto markets. Separate budget, separate wallet (optional).
- **Scalp Trading** — Research strand: in-play sports/esports event-driven
  trades. See "Scalp" below for the research outcome.
- **Data Collection** — Scraping + score-calculation pipelines feeding the
  copy-trade discovery layer.

---

## Copy-Trade (V2 — Rust copier)

The copy-trade system uses a **Rust copier** as the sole trade executor, with
Node.js providing supporting services around it.

| Process | Language | Role |
|---|---|---|
| **`copier`** (`copier/`) | Rust | WSS trade detection → phantom-fill debouncer → 21-step filter chain → EIP-712 signing → CLOB FAK/GTC → IPC result. |
| **`ipc-bridge`** (`src/jobs/ipc-bridge.ts`) | Node | IPC hub. Seeds copier with allocation + position state on connect. Persists `CopyTrade` records. Drives all background sweeps: settlement, balance reconcile, capital audit, pre-resolution sells, on-chain CTF redemption. |
| **`trade-monitor`** (`src/jobs/trade-monitor.ts`) | Node | On-chain `OrderFilled` event watcher (dual-WSS, dual-provider) with rapid-poll fallback. Independent of the copier's own WSS path — used for verification + redundancy. |

Key invariants:

- The Rust copier operates with **zero DB reads** on the hot path. All state is
  in-memory, seeded via IPC on connect, and updated incrementally by IPC
  messages from the Node bridge.
- `ipc-bridge` is the critical Node.js process. If it dies, the copier can
  still execute trades but results will not persist to the database. Recovery
  re-seeds state on next bridge reconnect.
- The bridge and the copier run as separate Docker containers, supervised
  independently.

### Trade detection: three independent signal sources

Listed in detection-latency order:

1. **Rapid REST poll** (~500 ms cycles) on a watched-trader fills endpoint.
   Primary signal source for live-allocation traders.
2. **Polymarket trade WSS** — secondary, low-latency channel for trade events.
3. **On-chain Polygon `OrderFilled` events** via dual-WSS RPC providers
   (~2–3 s latency). Used as verification and as a fallback when the higher
   layers are degraded. Dual-WSS = two independent providers form independent
   failure domains; on staleness, the connection force-reconnects and triggers
   a pre-emptive backfill.

### Filter chain

Every detected trade passes through ~21 sequential checks before any order is
placed: signal age, price/size sanity, conflict guard against active positions,
per-trader cap, per-prediction cap, daily-loss backstop, majority-side
accumulator (for traders that both buy and sell the same side), order-pool
deduplication, dust prevention, slippage upside-fraction model, BUY cool-down,
phantom-fill debounce, anti-cycle token cool-down, and several CLOB-side
sanity gates. See `copier/src/filter/`.

---

## Scalp Trading

Research strand that explored real-time market-making on Polymarket in-play
sports markets. See `.claude/SCALP_MEMORY.md` and `.claude/SCALP_LOG.md` for
the experimental notes — including the conclusion that on Polymarket's current
microstructure the MM strategy is **structurally unviable for a non-pro
participant** (queue position dominated by professional MMs with superior
speed / capital / data feeds, and the in-play spread does not compensate).

The scalp code is retained for reference:

- `src/services/scalp/`, `src/jobs/scalp-worker.ts`, `src/services/scalp/feeds/`
- Config: `SCALP_*` vars in `src/config/env.ts`

Capital tracking is fully isolated from copy-trade (`ScalpCapital`), so the
scalp processes can stay deployed without affecting copy-trade operations.

---

## Cross-product safety

All products share the same DB, CLOB client, and some utilities. When modifying
shared code:

- Grep for imports to see which products use a given module before changing it.
- Copy-trade runs on real money in production — assume any shared-utility
  change has live blast radius and test under paper mode first.
- Scalp-worker runs as its own process with separate capital tracking.
- Arb-worker has its own optional wallet credentials (`ARB_*` env vars). If
  unset, it shares the copy-trade wallet.

---

## Production deploy

Build / deploy uses a self-hosted GitHub Actions runner against a single
production host. All secrets (`.env`, Postgres password, GHCR creds) are
stored as GitHub Actions secrets and materialized into the deploy host at
deploy time. See `.server/docs/DEPLOY.md` for the runbook.

The deploy workflow takes a `profiles` input that selects which Docker
Compose profile to bring up. **The `copier` profile must always be included
on copy-trade deploys** — without it, the `copier` + `ipc-bridge` containers
are destroyed by Compose's profile filter.

```bash
gh workflow run deploy.yml -f profiles="copier"
```

Active container set on a copy-trade deploy: `copier`, `ipc-bridge`,
`trade-monitor`, `history-backfiller`, `leaderboard-scanner`,
`score-calculator`.

---

## Database

- 22 Prisma migrations under `prisma/migrations/`.
- Notable tables: `FollowAllocation`, `CopyTrade`, `DetectedTrade`, `Market`,
  `Trader`, `Prediction`, `ScalpCapital`, plus a Postgres `LISTEN/NOTIFY`
  trigger on `DetectedTrade` insertions.
- Settlement values are backfilled by a one-off migration
  (`20260307000001_backfill_settlement_values`) rather than computed lazily, so
  historical PnL is queryable without re-running the engine.

---

## Backtest

The backtest pipeline replays historical trades through the same filter chain
the live copier uses, with full slippage / fee / settlement modelling. See
`BACKTEST_STRATEGY.md` for usage. Key design choices:

- Train/test split + survivorship-bias correction
- Median selection across 2,000-config Monte Carlo sweeps per trader
- DuckDB + Parquet for price-record analytics (recorded by the Rust copier)
