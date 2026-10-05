# Poly-Shadow

**Independent, read-only, multi-source trade-discovery shadow for the Poly2 system.**

Poly-Shadow watches approved Polymarket wallets through several independent
public sources — Polygon V2 exchange events, Data API `/trades`, and Data
API `/activity` — preserves what each source saw and when, and reconciles
candidate economic trades without making one source authoritative.

The question it exists to answer is:

> Can an independently designed multi-source observer detect relevant wallet
> activity faster and/or more completely than Poly2's current discovery path?

**It cannot trade.** No order submission, transaction signing, private-key
handling, authenticated CLOB access, capital movement, or redemption exists
in this repository.

**It is not a Poly2 rewrite.** Shadow deliberately avoids Poly2 scoring,
scheduling, freshness rejection, and execution logic. Comparison is deferred
to Phase 4 and uses exported, read-only records.

## Provenance

Forked from `mantotan/polymarket-copy-trade` @
`9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` (MIT, © Hermanto Tan; see
`LICENSE`). Upstream is a live-money copy-trading system on legacy V1
contracts and is used only as an architectural reference for watcher,
reconnect/backfill, and source-racing patterns. Its execution surface was
removed.

## Status

| Phase | State |
|---|---|
| 1 — upstream/security assessment | ✅ merged (PR #1) |
| 2 — execution excision + reliable V2 chain observer | ✅ merged (PR #2, merge `aa223757…`) |
| 3 — multi-source discovery + source racing | ✅ implementation + live acceptance complete; awaiting merge (PR #3) |
| 4 — offline Poly2 comparison | planned |

**Read `docs/shadow/PROJECT_STATE.md` first.** It is the authoritative
handoff for exact SHAs, safety invariants, live-validation evidence, known
limitations, and what comes next.

## Architecture

```
Polygon RPC ─► CHAIN watcher (WSS + backfill, reorg/provider-lag safe) ─┐
data-api ────► REST_TRADES (/trades?takerOnly=false)                   ├─► source racer ─► NDJSON evidence
data-api ────► REST_ACTIVITY (/activity)                              ─┘   FIRST/CORROBORATOR
```

No source validates or overwrites another. Unmatched records remain visible.

Full architecture:
`docs/shadow/ARCHITECTURE.md`

WebSocket wallet-trade feasibility:
`docs/shadow/WS_FEASIBILITY.md`

## Verification

At reviewed Phase 3 runtime head
`921db8f71ed27071da8b7a835bc3d2fcbc360848`:

- **84 tests / 7 files passed**
- TypeScript passed
- static safety gate passed
- exact-head GitHub CI passed

A frozen **900-second live VPS acceptance run** also passed:

- CHAIN: 59,128 raw / 982 normalized watched-wallet observations
- REST_TRADES: 400 normalized; 180 successful polls / 0 errors
- REST_ACTIVITY: 1,056 normalized; 60 successful polls / 0 errors
- 950 CHAIN↔REST corroborated groups
- quarantine: 0
- TRANSIENT_FAILURE: 0
- `recoveryRequired`: 0

Evidence directory:

`/opt/poly-shadow/runs/phase3-provider-lag-live-20261005T072748Z-attempt1`

This proves the Phase 3 multi-source path can operate live and reconcile the
same watched-wallet activity across independent sources. It does **not** yet
prove that Shadow is faster or better than Poly2.

## Run

```bash
npm ci --ignore-scripts
npm test          # 84 tests
npm run build     # tsc --noEmit
npm run safety    # static no-trading safety gate

# Bounded observation run (read-only, zero credentials):
SHADOW_WATCHED_WALLETS=0x<wallet1>[,0x<wallet2>…] \
SHADOW_DATA_DIR=./shadow-data \
  timeout 300 npm start

# Frozen-run metrics:
node scripts/multisource-metrics.mjs ./shadow-data
```

Default cadences are independently chosen and configurable:

- `SHADOW_TRADES_POLL_MS=10000`
- `SHADOW_ACTIVITY_POLL_MS=30000`

## Important timing caveat

The racer label `FIRST` currently means **first reconciliation commit**.
It does not guarantee that source had the earliest preserved raw
`sourceFirstSeenUtc`. Provider hydration/retry timing can reorder commit
time relative to observation time.

Phase 4 must therefore compare preserved source-arrival timestamps directly
before making any source-speed claim.

## Explicitly not implemented

- trading/signing/keys
- relayer/redemption
- bankroll or strategy
- Poly2 scoring/scheduling/freshness rejection
- deployment automation
- live Poly2 database/runtime connection
- authenticated CLOB client

## Hard boundaries

- GitHub Actions are test-only with `contents: read`.
- No Poly2 database, host, or credential access.
- Upstream updates are never auto-merged.
- Any future deployment or Shadow→Poly2 integration requires a separate
  reviewed milestone.
