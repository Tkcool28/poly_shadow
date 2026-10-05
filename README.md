# Poly-Shadow

**Independent, read-only, multi-source trade-discovery shadow for the Poly2 system.**

Poly-Shadow watches approved Polymarket wallets through several independent
public sources — Polygon V2 exchange events, the Data API `/trades` and
`/activity` endpoints — records what each source saw and when, and races the
sources against each other. The question it exists to answer:

> Can an independently designed multi-source observer detect relevant wallet
> activity faster and/or more completely than Poly2's current discovery path?

**It cannot trade.** No order submission, no transaction signing, no
private-key handling, no authenticated CLOB access, no capital movement, no
redemption path — anywhere in this repository. Credential material in the
environment is a startup error, not a configuration option.

**It is not a Poly2 rewrite.** It keeps Poly2's discoveries scientifically
testable: Shadow applies no freshness rejection, no scoring, no scheduling,
and never discards an observation Poly2 would ignore. Comparison happens
offline (Phase 4) from exported, read-only Poly2 records.

## Provenance

Forked from [`mantotan/polymarket-copy-trade`](https://github.com/mantotan/polymarket-copy-trade)
@ `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` (MIT, © Hermanto Tan — `LICENSE`).
Upstream is a live-money copy-trading system on legacy V1 contracts; used
here as an **architectural reference only** (watcher lifecycle,
reconnect/backfill, source racing). All execution code has been removed.

## Status

| Phase | State |
|---|---|
| 1 — upstream/security assessment | ✅ merged (PR #1) |
| 2 — execution excision + reliable V2 chain observer | ✅ merged (PR #2, merge `aa223757…`) |
| 3 — multi-source discovery + source racing | ✅ merged (PR #3, merge `f22f3acf…`) |
| 4 — controlled Poly2 comparison + read-only dashboard | 🔨 current (draft PR) |

**Start at [`docs/shadow/PROJECT_STATE.md`](docs/shadow/PROJECT_STATE.md)** —
the authoritative handoff (exact SHAs, invariants, limitations).

## Architecture (Phase 3)

Three independent sources feed one append-only evidence store; a racer
records which source saw each economic-trade candidate first. No source
validates another; unmatched records stay visible.

```
Polygon RPC ─► CHAIN watcher (WSS + backfill, reorg-safe) ─┐
data-api ────► REST_TRADES poller  (/trades takerOnly=F)   ├─► source racer ─► NDJSON evidence
data-api ────► REST_ACTIVITY poller(/activity)            ─┘   (FIRST/CORROBORATOR)
```

Full detail: [`docs/shadow/ARCHITECTURE.md`](docs/shadow/ARCHITECTURE.md).
WS trade source: investigated and rejected —
[`docs/shadow/WS_FEASIBILITY.md`](docs/shadow/WS_FEASIBILITY.md).

## Run

```bash
npm ci --ignore-scripts
npm test          # 63 tests: fixtures, watcher, exit-audit matrix, source racing
npm run build     # tsc --noEmit
npm run safety    # static no-trading safety gate

# Bounded observation run (read-only, zero credentials):
SHADOW_WATCHED_WALLETS=0x<wallet1>[,0x<wallet2>…] \
SHADOW_DATA_DIR=./shadow-data \
  timeout 300 npm start

# Frozen-run metrics afterwards:
node scripts/multisource-metrics.mjs ./shadow-data
```

## Compare (Phase 4, offline)

Apples-to-apples on a fixed wallet list only — no auto wallet discovery.
Both exports are sealed over a frozen window before comparison
(`docs/shadow/PHASE4_COMPARISON_CONTRACT.md`):

```bash
npm run compare -- ./shadow-data poly2-export.json cohorts.json ./compare-out
npm run dashboard -- ./compare-out ./shadow-data
```

Produces `comparison.json` (matching classes, raw/usable latency deltas,
coverage, decision relevance) and a phone-friendly read-only
`dashboard.html` (`docs/shadow/DASHBOARD.md`). Wallet-discovery feasibility
is documented as research-only in
[`docs/shadow/WALLET_DISCOVERY_FEASIBILITY.md`](docs/shadow/WALLET_DISCOVERY_FEASIBILITY.md).

Cadences (independently chosen, overridable): `SHADOW_TRADES_POLL_MS`
(default 10 000), `SHADOW_ACTIVITY_POLL_MS` (default 30 000).

## Explicitly NOT implemented

Trading, signing, keys, relayer, redemption, bankroll, strategy, scoring,
Poly2's scheduling/canonical identity/freshness rejection, deployment
automation, any Poly2 connection, any authenticated CLOB client. The
WebSocket wallet-trade source is rejected with evidence (WS_FEASIBILITY.md).

## Hard boundaries

- GitHub Actions are test-only (`contents: read`): typecheck, tests, static
  safety gate, bounded startup smokes.
- No connection to Poly2's database, hosts, or credentials — ever.
- Upstream updates are never merged automatically.
