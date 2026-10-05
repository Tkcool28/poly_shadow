# PROJECT_STATE — authoritative project handoff

> **Read this file first.** It is the single source of truth for where
> Poly-Shadow stands. A fresh chat/reviewer should need nothing else to
> understand the project. Updated at every merged milestone.

## Identity

- **Repository**: `Tkcool28/poly_shadow` (private research repo)
- **Forked from**: `mantotan/polymarket-copy-trade` @
  `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` (MIT, © Hermanto Tan — LICENSE)
- **Purpose**: test whether an independently designed **multi-source
  discovery system** can observe Polymarket wallet activity **faster and/or
  more completely** than Poly2's current discovery path.
- **Nature**: READ-ONLY research shadow. No trading, no signing, no keys, no
  capital, no Poly2 connection. Not a rewrite of Poly2.

## Current state (as of 2026-10-05)

- **Authoritative main**: `aa223757e9b477f23adc72f19e6bdf0e696f6f06`
  (merge of PR #2 — Phase 2 complete)
- **Current milestone**: **Phase 3 — multi-source discovery + source
  racing** (in progress, branch `feat/phase3-multisource-discovery`,
  DRAFT PR — do not merge)
- **Next milestone**: Phase 4 — offline comparison vs exported Poly2 records
  via `src/compare/poly2-adapter.ts`

## Milestones

| Phase | Status | PR | Head SHA |
|---|---|---|---|
| 1 — upstream/security assessment | ✅ merged | #1 | see PR #1 |
| 2 — execution excision + reliable V2 chain observer | ✅ merged | #2 | `aeca68e4cb8d…` (merge `aa223757…`) |
| 3 — multi-source discovery + racing | 🔨 in progress (draft) | TBD | TBD |
| 4 — Poly2 comparison (offline adapter) | planned | — | — |

## Architecture (text diagram)

```
                ┌────────────────────────────────────────────┐
                │              Poly-Shadow (read-only)        │
                │                                            │
 Polygon RPC ──►│ CHAIN watcher (wss + eth_getLogs backfill) │──┐
 (V2 exchange   │  decode, classify, dispositions, reorg     │  │
  events, both  │  recovery, dense checkpoints               │  │
  emitters)     │                                            │  │ append-only
                │ REST_TRADES poller  (/trades?takerOnly=F)  │  │ evidence per
 data-api ─────►│ REST_ACTIVITY poller(/activity)            │──┤ source +
                │  (per-wallet, bounded cadence, telemetry)  │  │ telemetry
                │                                            │  │
                │ Source racer / reconciler                  │◄─┘
                │  per-source first-seen; FIRST/CORROBORATOR │
                │  membership on economic-trade CANDIDATES   │
                │                                            │
                │ compare/poly2-adapter.ts (PHASE 4, offline │
                │  only — never imported by collectors)      │
                └────────────────────────────────────────────┘
```

## Source definitions

| Source | Identity (source-native) | Notes |
|---|---|---|
| CHAIN | `chainId:emitter:txHash:logIndex` (+blockHash variants) | Primary key; roles TAKER_AGGREGATE / MAKER_LEG / TAKER_LEG_REDUNDANT |
| REST_TRADES | `rest-trades:{tx}:{wallet}:{asset}:{size6}:{price4}:{ts}` | `/trades` exposes no logIndex or maker/taker label; role=UNKNOWN |
| REST_ACTIVITY | `rest-activity:{type}:{tx}:{wallet}:{asset}:{size6}:{ts}` | Separate population (TRADE/MERGE/SPLIT/REDEEM); non-TRADE stays ungrouped-visible |

Reconciliation groups economic-trade **candidates** by
`econ:{tx}:{asset}:{size6}` (price excluded — legs can differ gross/net).
Grouping is a hypothesis, never a storage primary key.

## Safety invariants (must never weaken)

1. No private keys / signing / order submission / relayer / redemption /
   bankroll / execution strategy anywhere in the repo.
2. Fail-closed credential guard: set-but-empty banned env vars refuse
   startup (`PRIVATE_KEY`, `CLOB_API_*`, `FUNDER_ADDRESS`, …).
3. Application-level egress boundary: only configured Polygon RPC +
   `data-api.polymarket.com` + `gamma-api.polymarket.com`; `fetch(` confined
   to `src/shadow/egress.ts`, `new WebSocket` confined to
   `src/shadow/watcher.ts`; enforced by `scripts/static-safety.mjs` in CI.
4. Append-only evidence; tombstones dominate PENDING (`REMOVED_INVALID`);
   reorg recovery requires a PROVED ancestor (dense checkpoints, spacing
   16 < lookback 128) else fail-closed `recoveryRequired` (no auto-resume).
5. GitHub Actions: test-only, `contents: read`. No deployment automation.
6. Poly2 is never contacted; Phase 4 uses exported read-only records only.

## Test state at Phase 2 merge

51 tests / 6 files (decimal 7, decoder 7, storage-config 9, compare 4,
watcher 10, exit-audit acceptance matrix 14), `tsc --noEmit` clean, static
safety gate OK, CI green (run 37260786289). Phase 3 adds `racing.test.ts`
(12 tests) → 63 total.

## Known limitations (Phase 3 honesty)

- NDJSON files on a single host; no replication/backup (research-grade).
- Dedup sets rebuilt from durable indexes at startup — restart is the
  rotation mechanism (restart ≥ daily on long runs).
- /trades and /activity role (maker/taker) is not labeled by the source;
  recorded as UNKNOWN rather than guessed.
- Reconciliation group keys are heuristic candidates, not proof of identity.
- WebSocket trade source: investigated, **rejected** — see WS_FEASIBILITY.md.
- This sandbox cannot reach `*.polymarket.com` (egress-filtered): REST
  sources are fixture-tested here; the live multi-source run must be
  (re)executed in an environment with normal egress (one command in README).

## Watched-wallet testing assumptions

- Default test wallet `0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029`
  (Poly2-approved wallet); configurable via `SHADOW_WATCHED_WALLETS` (csv).

## Historical findings that motivated the design

- Upstream Mantotan targets legacy V1 contracts with live capital —
  excised entirely; only watcher-lifecycle patterns retained.
- Polymarket V2 uses two exchange emitters (standard + neg-risk); both must
  be subscribed for completeness (Phase 1/2 verification).
- CDN caching may materially delay `/trades` (Poly2 feasibility work) —
  Phase 3 measures cache headers + source timestamps instead of assuming.
- `/trades` defaults to `takerOnly=true` — must pass `takerOnly=false` or
  the maker population is silently dropped.
- Poly2 applies a five-minute freshness rejection; Shadow must NOT — late
  records stay visible so Phase 4 can measure what rejection discards.

## Relationships

- **Poly2**: the comparison target. No code, data, or runtime dependency.
  Comparison happens offline in Phase 4 from exported records.
- **Mantotan upstream**: architectural reference only (watcher lifecycle,
  reconnect/backfill, source racing). Pinned, never auto-merged.
