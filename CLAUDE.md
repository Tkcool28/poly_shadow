# Project: Polymarket Trading System

This repo contains multiple trading products sharing the same codebase:
- **Copy-Trade**: Copies trades from target traders on Polymarket (production, real money)
- **Scalp Trading**: In-play sports/esports event-driven trading
- **Arb Worker**: Arbitrage detection and execution
- **Data Collection**: Scraping and data pipelines

## Copy-Trade Architecture (V2 — Rust Copier)

The copy-trade system uses a **Rust copier** as the sole trade executor, with Node.js providing supporting services:

| Process | Role |
|---------|------|
| **Rust copier** (`copier/`) | WSS trade detection → 21-step filter chain → FAK/GTC execution → IPC result |
| **ipc-bridge** (`src/jobs/ipc-bridge.ts`) | IPC hub: seeds Rust on connect, persists CopyTrade records to DB, capital adjustment, all background sweeps (settlement, reconciliation, capital audit, balance monitor, pre-resolution sells) |
| **trade-monitor** | Chain watcher for on-chain OrderFilled events, rapid-poll fallback |

- The Rust copier operates with **zero DB reads** on the hot path — all state is in-memory, seeded via IPC
- `ipc-bridge` is the critical Node.js process — if it goes down, Rust can still execute but results won't persist to DB
- Always deploy with `--profile copier` to include both `ipc-bridge` and `copier` containers

## Scalp Trading Agent

For ALL scalp trading work, use the dedicated agent: `.claude/agents/scalp-agent.md`
- Memory: `.claude/SCALP_MEMORY.md` (strategy, data sources, progress, results, decisions)
- Code: `src/services/scalp/`, `src/jobs/scalp-worker.ts`, `src/services/scalp/feeds/`
- Config: `SCALP_*` vars in `src/config/env.ts`

## Production Infrastructure

- **Primary server**: AWS Ireland (eu-west-1), m6g.large ARM64, 2 vCPU, 8GB RAM, 100GB gp3
  - SSH: `ssh aws_ireland` (ubuntu), `ssh aws_ireland_dockerapps` (dockerapps)
  - Runner: `ireland-runner` (label: `polymarket-copytrade`)
  - CLOB latency: ~64ms (1.9x faster than Helsinki)
  - Active containers: Rust copier, ipc-bridge, trade-monitor, backfiller, leaderboard, score-calculator
- **Legacy server**: Hetzner Finland (Helsinki) — runner stopped, containers still running in parallel
  - SSH: `ssh hetzner_finland_dockerapps` (dockerapps)
- Deploy: `gh workflow run deploy.yml -f profiles="copier"` → runs on `ireland-runner`
  - **Always include `profiles="copier"`** — without it, copier + ipc-bridge containers are destroyed

## Cross-Product Safety

All products share the same DB, CLOB client, and some utilities. When modifying shared code:
- Check which products use it before changing (grep for imports)
- Scalp trading runs as its own process (`scalp-worker`) with separate capital tracking (`ScalpCapital`)
- Copy-trade runs in production with real money — test changes thoroughly
- Arb worker has its own wallet credentials (`ARB_*` env vars)
