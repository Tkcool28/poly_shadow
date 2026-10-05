# PROJECT_STATE — authoritative project handoff

> **Read this file first.** It is the single source of truth for where
> Poly-Shadow stands. A fresh chat/reviewer should need nothing else to
> understand the project. Update this file at every merged milestone.

## Identity

- **Repository**: `Tkcool28/poly_shadow`
- **Forked from**: `mantotan/polymarket-copy-trade` @
  `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` (MIT, © Hermanto Tan — LICENSE)
- **Purpose**: test whether an independently designed **multi-source
  discovery system** can observe Polymarket wallet activity **faster and/or
  more completely** than Poly2's current discovery path.
- **Nature**: READ-ONLY research shadow. No trading, signing, keys, capital,
  or live Poly2 dependency. It is not a rewrite of Poly2.

## Current state (2026-10-05)

- **Authoritative main**: `aa223757e9b477f23adc72f19e6bdf0e696f6f06`
  (merge of PR #2 — Phase 2 complete).
- **Current Phase 3 draft PR**: **#3**, branch
  `feat/phase3-multisource-discovery`.
- **Current reviewed Phase 3 head before docs-only cleanup**:
  `921db8f71ed27071da8b7a835bc3d2fcbc360848`.
- **Phase 3 status**: implementation + frozen live VPS acceptance complete;
  awaiting final merge review. Do not merge automatically.
- **Next milestone**: Phase 4 — offline comparison against exported,
  read-only Poly2 records via `src/compare/poly2-adapter.ts`.

## Milestones

| Phase | Status | PR | Key SHA |
|---|---|---|---|
| 1 — upstream/security assessment | ✅ merged | #1 | see PR #1 |
| 2 — execution excision + reliable V2 chain observer | ✅ merged | #2 | reviewed `aeca68e4cb8d…`; merge `aa223757…` |
| 3 — multi-source discovery + racing | ✅ implementation + live acceptance complete; awaiting merge | #3 | `921db8f71ed…` before docs-only cleanup |
| 4 — Poly2 comparison (offline adapter) | planned | — | — |

## Architecture

```
                ┌────────────────────────────────────────────┐
                │              Poly-Shadow (read-only)       │
 Polygon RPC ──►│ CHAIN watcher: WSS + eth_getLogs backfill │──┐
                │  V2 decode/classify, retry, reorg safety   │  │
 data-api ─────►│ REST_TRADES (/trades?takerOnly=false)     │──┤
 data-api ─────►│ REST_ACTIVITY (/activity)                 │──┤
                │                                            │  │
                │ Source racer / reconciler                 │◄─┘
                │ FIRST/CORROBORATOR on economic candidates │
                │                                            │
                │ compare/poly2-adapter.ts                  │
                │   Phase 4 offline-only comparison         │
                └────────────────────────────────────────────┘
```

## Source definitions

| Source | Source-native identity | Notes |
|---|---|---|
| CHAIN | `chainId:emitter:txHash:logIndex` (+blockHash variants) | Roles TAKER_AGGREGATE / MAKER_LEG / TAKER_LEG_REDUNDANT |
| REST_TRADES | `rest-trades:{tx}:{wallet}:{asset}:{size6}:{price4}:{ts}` | No maker/taker label; role recorded UNKNOWN |
| REST_ACTIVITY | `rest-activity:{type}:{tx}:{wallet}:{asset}:{size6}:{ts}` | Separate activity population; non-TRADE remains visible |

Reconciliation groups economic-trade **candidates** by
`econ:{tx}:{asset}:{size6}`. That key is a hypothesis for comparison, not
Shadow's storage primary key.

## Safety invariants

1. No private keys, signing, order submission, relayer, redemption, bankroll,
   or execution strategy.
2. Fail-closed credential guard: banned credential env vars refuse startup,
   including set-but-empty values.
3. Application egress is restricted to reviewed read-only endpoints; network
   construction sites are CI-guarded.
4. Append-only evidence; tombstones dominate PENDING; reorg recovery requires
   a proved ancestor or fails closed with `recoveryRequired`.
5. GitHub Actions are test-only with `contents: read`; no deployment workflow.
6. Poly2 is not contacted live. Phase 4 uses exported read-only records.

## Phase 3 verification state

At the reviewed Phase 3 head `921db8f71ed27071da8b7a835bc3d2fcbc360848`:

- **84 tests / 7 files passed**.
- `npx tsc --noEmit` passed.
- `node scripts/static-safety.mjs` passed.
- Exact-head GitHub CI passed.
- Provider-lag handling uses at most **6 attempts** with
  **100 / 200 / 400 / 800 / 1,600 ms** backoffs. Null block responses are
  retried, invalid log ranges refresh/clamp to a confirmed head, cursor
  advancement remains commit-safe, and retry exhaustion remains visible.

## Frozen live VPS acceptance — PASSED

Run directory:

`/opt/poly-shadow/runs/phase3-provider-lag-live-20261005T072748Z-attempt1`

Run window:

- start: `2026-10-05T07:27:48.468Z`
- end: `2026-10-05T07:42:48.486Z`
- fixed duration: 900 seconds
- bounded `timeout` exit: 124 (expected)
- metrics exit: 0

Watched wallets:

- baseline wallet:
  `0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029`
- active qualification wallet:
  `0x3e9ff2dbf2a6356ee47049e9f3c43a70cb55d57f`
- qualification snapshot: 27 trades in the prior 10 minutes at
  `2026-10-05T07:27:48.412Z`; selected only by recent activity.

Observed results:

- CHAIN: **59,128 raw**, **982 normalized** watched-wallet observations.
- 888 CHAIN observations had block timestamps within the fixed run window.
- REST_TRADES: **400 normalized**, 180 successful polls, 0 errors.
- REST_ACTIVITY: **1,056 normalized**, 60 successful polls, 0 errors.
- CHAIN↔REST corroborated groups: **950 overall**, including **858** tied to
  in-window CHAIN observations.
- All-source groups: 292.
- Source-only observations: CHAIN 32, REST_TRADES 14, REST_ACTIVITY 12.
- Quarantine: **0**.
- TRANSIENT_FAILURE: **0**.
- Provider-lag failures: **0**.
- `recoveryRequired`: **0**.
- Duplicate observations / malformed racer memberships: **0**.

The live Phase 3 gate is therefore satisfied.

## Known limitations / Phase 4 caveats

- NDJSON evidence is research-grade single-host storage; no replication or
  backup guarantee.
- REST endpoints do not provide a reliable maker/taker label; Shadow records
  role UNKNOWN rather than guessing.
- Reconciliation keys are candidate-grouping heuristics, not identity proof.
- Public authenticated/user WebSocket trade discovery was investigated and
  rejected; see `WS_FEASIBILITY.md`.
- **Important timing caveat**: current racer `FIRST` means first
  reconciliation commit, not necessarily earliest preserved raw
  `sourceFirstSeenUtc`. Phase 4 must compare source arrival timestamps
  directly before making source-speed claims.
- Frozen latency metrics include historical/startup populations and exclusions;
  they are not yet a definitive ranking of source speed.
- No claim that Shadow is faster or better than Poly2 is supported until
  Phase 4 comparison is complete.

## Relationships

- **Poly2**: comparison target only. No live runtime/database dependency.
- **Mantotan upstream**: pinned architectural reference for watcher/reconnect/
  backfill/source-racing patterns. Execution code was removed and upstream is
  never auto-merged.
