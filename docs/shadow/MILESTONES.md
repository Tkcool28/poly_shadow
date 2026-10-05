# MILESTONES

## Phase 1 — upstream/security assessment ✅ merged (PR #1)

Audited the Mantotan fork, identified the live-money execution surface and
legacy V1 assumptions, preserved useful watcher/reconnect/backfill concepts,
and produced the Phase 2 removal plan.

## Phase 2 — execution excision + reliable chain observer ✅ merged (PR #2)

- Merge commit / authoritative main:
  `aa223757e9b477f23adc72f19e6bdf0e696f6f06`
- Final reviewed head:
  `aeca68e4cb8d4f08cfa68951f3cf8c249b9a2aa7`
- Removed execution/signing/relayer/deploy capability.
- Added read-only V2 chain observation over both exchange emitters, durable
  dispositions, restart idempotence, reorg tombstones, proved-ancestor
  recovery, dense checkpoints, fail-closed `recoveryRequired`, and static
  safety CI.
- At merge: 51 tests / 6 files; 14-case exit-audit matrix.

## Phase 3 — multi-source discovery + source racing ✅ implementation + live acceptance complete; awaiting merge (PR #3)

Branch:

`feat/phase3-multisource-discovery`

Reviewed runtime head before docs-only cleanup:

`921db8f71ed27071da8b7a835bc3d2fcbc360848`

Phase 3 adds:

- REST `/trades` observer with `takerOnly=false`
- REST `/activity` observer as a separate source population
- independent source-native evidence preservation
- source racing / reconciliation with FIRST + CORROBORATOR memberships
- REST cache/freshness telemetry
- frozen metrics script
- WebSocket feasibility study (public wallet-trade WS rejected)
- provider-lag hardening for public Polygon RPC behavior
- project-context documentation for future reviewers/chats

Validation at the reviewed head:

- **84 tests / 7 files passed**
- TypeScript passed
- static safety passed
- exact-head GitHub CI passed

Provider-lag robustness:

- maximum 6 attempts
- backoffs: 100 / 200 / 400 / 800 / 1,600 ms
- null block responses are retryable, not hash conflicts
- invalid-range responses refresh and clamp to a confirmed provider head
- cursor never advances beyond committed evidence
- exhaustion remains visible

### Frozen 900-second VPS acceptance — PASSED

Run:

`/opt/poly-shadow/runs/phase3-provider-lag-live-20261005T072748Z-attempt1`

Results:

- CHAIN: 59,128 raw / 982 normalized
- REST_TRADES: 400 normalized; 180 polls / 0 errors
- REST_ACTIVITY: 1,056 normalized; 60 polls / 0 errors
- CHAIN↔REST corroborated groups: 950 overall
- 858 corroborated groups associated with in-window CHAIN observations
- all-source groups: 292
- quarantine: 0
- TRANSIENT_FAILURE: 0
- provider-lag failures: 0
- `recoveryRequired`: 0
- duplicate/malformed racer memberships: 0

Gate item 11 is satisfied.

**Known carry-forward to Phase 4:** `FIRST` currently reflects reconciliation
commit order, not guaranteed earliest raw arrival. Phase 4 must compare
preserved source-arrival timestamps directly before drawing source-speed
conclusions.

## Phase 4 — Poly2 comparison (planned, not started)

Offline comparison of Shadow evidence against exported, read-only Poly2
records via `src/compare/poly2-adapter.ts`.

Primary questions:

- which system saw each comparable trade first;
- what each system missed;
- maker/taker population differences;
- impact of Poly2 freshness rejection;
- whether Shadow provides a materially better discovery input.

No live Poly2 connection is approved.

## Later possibilities (NOT approved)

Production-grade rotation, replication, alerting, unattended deployment, or
feeding Shadow into Poly2 require separate design/review milestones.
