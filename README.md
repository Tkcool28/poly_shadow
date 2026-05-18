# Polymarket Copy-Trade

Production copy-trading system for [Polymarket](https://polymarket.com) prediction markets.
Watches a curated set of traders, detects their fills within sub-second latency,
runs each candidate through a 21-step filter chain, and copies surviving trades
at a fraction of size via the Polymarket CLOB.

Built as a polyglot system: **TypeScript** for discovery / scoring / orchestration,
**Rust** for the latency-critical execution path. Running on live capital since
March 2026.

---

## Why this repo is interesting

- **Polyglot, one trading path.** A Rust microservice (`copier/`, ~8.2k LoC)
  owns the hot path — WSS decoding, filter chain, manual EIP-712 order signing,
  HMAC-SHA256 CLOB authentication — with **zero database reads** while running;
  all state is in-memory and seeded over IPC by the Node bridge. The Node side
  (`src/`, ~30k LoC) handles trader discovery, scoring, settlement, audit, and
  durable persistence.

- **Three independent trade-detection signal sources**, with the slowest used
  only as a verification fallback. Rapid REST poll (~500 ms) is primary,
  Polymarket trade WSS is secondary, and on-chain Polygon `OrderFilled` events
  via **dual-WSS RPC providers** form independent failure domains.

- **21-step filter chain** before any order is placed: signal age, conflict
  guard against active positions, per-trader and per-prediction caps, daily-loss
  backstop, majority-side accumulator, dust prevention, cool-down after losses,
  slippage upside-fraction model, phantom-fill debounce, and more.

- **WSS resilience patterns**: dual-layer keepalive, configurable staleness
  threshold (force-reconnect when no events arrive), pre-emptive backfill on
  reconnect, dual-WSS instances with independent providers.

- **Backtest pipeline** with train/test split, survivorship-bias correction,
  median selection across 2,000-config Monte Carlo sweeps, and DuckDB-backed
  Parquet price-record analytics.

---

## Architecture

```mermaid
flowchart LR
    PM["Polymarket<br/>Data API · Gamma · Trade WSS · CLOB"]
    POLY["Polygon<br/>dual-WSS RPC providers"]

    subgraph Rust["Rust copier (copier/)"]
        COP["WSS decode → phantom debounce<br/>→ 21-step filter chain<br/>→ EIP-712 sign → CLOB FAK/GTC"]
    end

    subgraph Node["Node services (src/jobs/)"]
        BR["ipc-bridge<br/>seeds copier · persists results<br/>capital audit · settlement sweeps"]
        MON["trade-monitor<br/>chain watcher + rapid-poll fallback"]
        DISC["leaderboard-scanner · history-backfiller<br/>score-calculator"]
    end

    DB[("Postgres<br/>Prisma · 22 migrations")]

    PM -.->|trade events| COP
    PM <-.->|order placement| COP
    PM -.->|trader leaderboards + history| DISC
    POLY -.->|OrderFilled events| MON
    MON -.->|verification signal| COP

    COP <-->|IPC| BR
    BR --> DB
    DISC --> DB
    MON --> DB
```

### Process map (PM2 / Docker)

| Process | Language | Role |
|---|---|---|
| `copier` | Rust | Sole trade executor. WSS detect → filter → sign → CLOB. Zero DB reads on hot path. |
| `ipc-bridge` | Node | Seeds copier on connect; persists results; runs settlement, capital audit, balance reconcile, pre-resolution sells. |
| `trade-monitor` | Node | On-chain Polygon `OrderFilled` watcher with dual-WSS; rapid-poll fallback. |
| `leaderboard-scanner` | Node | Cron (12h). Discovers candidate traders from Polymarket leaderboards. |
| `history-backfiller` | Node | Backfills trade history for newly-discovered traders. |
| `score-calculator` | Node | Cron (6h). Composite scoring + pre-screen thresholds. |
| `arb-worker` | Node | Independent strategy — BTC up/down last-minute arbitrage on Polymarket crypto markets. |
| `scalp-worker` / `scalp-observer` | Node | Esports-event-driven trades; paper-mode feed for observation. |

For the full architecture write-up — including the IPC protocol, the rationale
for the Rust split, and cross-product safety notes — see [`ARCHITECTURE.md`](ARCHITECTURE.md).

### Tech stack

- **Languages:** TypeScript (Node.js 22), Rust 2024 edition
- **Database:** PostgreSQL 16 via Prisma 7
- **Analytics:** DuckDB + Parquet (`parquet`, `arrow` crates) for price recording
- **Ethereum:** `alloy-primitives`, `alloy-sol-types`, `ethers` (manual EIP-712)
- **Async:** `tokio` (Rust), `p-limit` + `async-mutex` (Node)
- **WSS:** `tokio-tungstenite` (Rust), `ws` (Node)
- **Concurrent state:** `dashmap`, `parking_lot`, `lru` (Rust)
- **Deploy:** Docker images via GHCR + GitHub Actions self-hosted runner
- **Process supervision:** PM2 (local), Docker Compose (prod)

---

## Repository map

```
.
├── copier/                          Rust copier microservice (~8.2k LoC)
│   └── src/
│       ├── wss/                     WSS decoder, phantom-fill debouncer
│       ├── filter/                  21-step filter chain
│       ├── clob/                    CLOB HTTP client + HMAC-SHA256 auth
│       ├── clob_ws/                 CLOB user-fills WSS
│       ├── ipc/                     Unix socket IPC protocol with Node
│       ├── state/                   In-memory allocation + position state
│       ├── recovery/                Crash-recovery from last persisted state
│       └── market_scanner.rs        Tick-size + market metadata lookup
│
├── src/                             Node services (~30k LoC)
│   ├── jobs/                        PM2-managed long-running processes
│   ├── services/                    Domain services (scalp/, copy-trade/, …)
│   ├── scoring/                     Composite scoring + pre-screen logic
│   ├── scripts/                     Backtest, monitoring, ops tooling
│   ├── cli/                         setup-wallet, add-wallet, etc.
│   ├── lib/                         Shared utilities (pg listen, signing, …)
│   ├── api/                         Internal HTTP endpoints
│   └── config/                      Zod-validated env config
│
├── prisma/                          22 migrations, Prisma schema
├── scripts/                         Operational shell + monitoring scripts
├── .server/                         Docker Compose, deploy docs, health checks
├── .github/workflows/               CI/CD (Docker build + manual deploy)
├── ecosystem.config.js              PM2 process definitions
├── ARCHITECTURE.md                  Deeper architecture + cross-product notes
└── BACKTEST_STRATEGY.md             Backtest CLI reference
```

---

## Getting Started

> Personal research / production system, not a turn-key product. The default
> safe path is **paper mode** (`PAPER_ONLY=true`) — no real CLOB orders are
> placed; the system runs end-to-end but every fill is simulated. Do not flip
> to live trading without auditing the filter chain against your own risk
> tolerance.

**Prerequisites:** Node.js 22+, Rust 1.85+ (2024 edition), Docker, Postgres 16.

### Quickstart (paper mode)

```bash
# 1. Clone + install
git clone https://github.com/mantotan/polymarket-copy-trade.git
cd polymarket-copy-trade
npm install
(cd copier && cargo build --release)

# 2. Postgres
docker run -d --name pmpg -p 5432:5432 \
  -e POSTGRES_PASSWORD=devpass \
  -e POSTGRES_DB=polymarket_copytrade \
  postgres:16

# 3. Env — paper-mode-only minimal config
cp .env.example .env
cat >> .env <<'EOF'
DATABASE_URL=postgresql://postgres:devpass@localhost:5432/polymarket_copytrade
PAPER_ONLY=true
COPY_TRADE_ENABLED=false
EOF

# 4. Migrate + verify the install with the test suites
npx prisma migrate deploy
npm test                              # Vitest TypeScript suites
(cd copier && cargo test)             # 106 Rust unit + integration tests

# 5. Populate the trader pool (first run — long-running; ^C is safe to resume)
npm run scanner
npm run backfiller
npm run scorer

# 6. Boot the paper-mode pipeline
pm2 start ecosystem.config.js
(cd copier && ./target/release/polymarket-copier &)
```

### Verifying it's running

After step 6, expect these:

```bash
pm2 status                            # all jobs "online"
pm2 logs ipc-bridge --lines 20        # "seeded copier with N allocations"
pm2 logs trade-monitor --lines 20     # "chain-watcher-A heartbeat"
psql "$DATABASE_URL" -c \
  'SELECT COUNT(*) FROM "Trader" WHERE "isCompleted"=true;'   # > 0 once scorer ran
```

Paper-mode fills appear in the `CopyTrade` table with `isPaper = true`.

### Going live

To execute real CLOB orders, set the following in `.env` and restart:

```
PAPER_ONLY=false
COPY_TRADE_ENABLED=true
PRIVATE_KEY=0x...                     # Polymarket signing key
CLOB_API_KEY=...                      # derive via @polymarket/clob-client setup
CLOB_API_SECRET=...
CLOB_API_PASSPHRASE=...
FUNDER_ADDRESS=0x...                  # GNOSIS_SAFE / POLY_PROXY funder address
```

For the production deploy path (Docker Compose on a self-hosted runner, GHCR
image registry, automated DB backup) see [`.server/docs/DEPLOY.md`](.server/docs/DEPLOY.md).

### Common commands

| Command | Purpose |
|---|---|
| `npm test` | Vitest TypeScript suites |
| `cd copier && cargo test` | All 106 Rust tests |
| `npm run dev` | `trade-monitor` with `tsx watch` (auto-reload) |
| `npm run scanner` | One-shot leaderboard discovery |
| `npm run backfiller` | Backfill trade history for newly-discovered traders |
| `npm run scorer` | Recompute composite scores |
| `npm run cli -- setup-wallet` | Derive CLOB API key/secret/passphrase for a wallet |
| `pm2 start ecosystem.config.js` | Boot all jobs locally |
| `pm2 logs <process>` | Tail logs of a specific job |
| `gh workflow run deploy.yml -f profiles=copier` | Manual production deploy |

---

## Backtest

The backtest pipeline replays historical trades through the same filter chain
the live copier uses, with full slippage / fee / settlement modelling. See
[`BACKTEST_STRATEGY.md`](BACKTEST_STRATEGY.md) for the three entry points:

- `backtest-single-trader.ts` — one trader over a window, per-prediction breakdown
- `batch-backtest-traders.ts` — all completed traders, ranked, CSV-exported
- `batch-backtest-config-sweep.ts` — Monte Carlo 2,000-config sweep per trader

---

## Tests

- **106 Rust unit + integration tests** under `copier/src/` covering the filter
  chain, WSS decoder, phantom-fill debouncer, CLOB HMAC signing, and EIP-712
  order construction.
- **Vitest TypeScript suites** under `src/` covering scoring, settlement, and
  IPC bridge behaviour.
- **CI gate**: every push to `main` runs `tsc --noEmit` + `npm test` before
  building and pushing the Docker images to GHCR. See [`.github/workflows/build.yml`](.github/workflows/build.yml).

---

## Status

Active personal production system, public for portfolio purposes. Not packaged
as a library, not maintained for external users, no support promised.
**Trading is risky; this code can lose money. Read the [LICENSE](LICENSE)
before using.**

---

## License

[MIT](LICENSE).
