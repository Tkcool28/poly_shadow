# Project: Polymarket Trading System

This repo contains multiple trading products sharing the same codebase:
- **Copy-Trade**: Copies trades from target traders on Polymarket (production, real money)
- **Scalp Trading**: In-play sports/esports event-driven trading
- **Arb Worker**: Arbitrage detection and execution
- **Data Collection**: Scraping and data pipelines

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
  - All services running (trade-monitor, backfiller, leaderboard, score-calculator)
- **Legacy server**: Hetzner Finland (Helsinki) — runner stopped, containers still running in parallel
  - SSH: `ssh hetzner_finland_dockerapps` (dockerapps)
- **COPY_TRADE_ENABLED=false** — copy-trader exits cleanly. Re-enable in `.env.prod` when ready to go live.
- Deploy: `gh workflow run deploy.yml` → runs on `ireland-runner`

## Cross-Product Safety

All products share the same DB, CLOB client, and some utilities. When modifying shared code:
- Check which products use it before changing (grep for imports)
- Scalp trading runs as its own process (`scalp-worker`) with separate capital tracking (`ScalpCapital`)
- Copy-trade runs in production with real money — test changes thoroughly
- Arb worker has its own wallet credentials (`ARB_*` env vars)
