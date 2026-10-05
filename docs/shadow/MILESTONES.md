# MILESTONES

## Phase 1 — upstream/security assessment ✅ merged (PR #1)

Audited the Mantotan fork: live-money copy-trading system on legacy V1
contracts. Catalogued execution surfaces, credential handling, and watcher
patterns worth retaining. Produced `PHASE1_ASSESSMENT.md` and the Phase 2
removal plan.

## Phase 2 — execution excision + reliable chain observer ✅ merged (PR #2)

- Merge commit / authoritative main: `aa223757e9b477f23adc72f19e6bdf0e696f6f06`
- Final reviewed head: `aeca68e4cb8d4f08cfa68951f3cf8c249b9a2aa7`
- Removed ALL execution capability (Rust copier, executor, relayer, server,
  deploy workflows); fail-closed credential guard; egress boundary; static
  safety gate in CI.
- Built the read-only V2 chain observer: both exchange emitters, durable
  dispositions, restart idempotence, reorg tombstones + proved-ancestor
  recovery + fail-closed `recoveryRequired`, dense checkpoints, first-seen
  vs completion timestamps, bounded state.
- Review loop: consolidated exit audit → one remediation pass → final finite
  blocker list (2 blockers + smoke evidence) → one correction pass →
  **merged** after CI green (run 37260786289) and bounded live smoke.
- At merge: 51 tests (6 files), 14-case exit-audit acceptance matrix.

## Phase 3 — multi-source discovery + source racing 🔨 in progress (draft)

- Branch `feat/phase3-multisource-discovery`; DRAFT PR; do not merge.
- Adds: REST /trades observer, REST /activity observer, source racing +
  reconciliation (`racing.ts`), per-source normalized observation stream,
  poll telemetry (freshness measured, not assumed), metrics script.
- WS trade source investigated → rejected (WS_FEASIBILITY.md).
- Adds `racing.test.ts` (12 tests) → 63 total. Phase 2 tests unchanged
  (only the documented `ShadowConfig`/`ChainWatcher` interface extensions).
- Gate: all 14 handoff §16 items, incl. a bounded real multi-source run in
  an environment with normal egress + independent review.

## Phase 4 — Poly2 comparison (planned, not started)

Offline comparison of Shadow evidence vs exported, read-only Poly2 records
via `src/compare/poly2-adapter.ts`. Measures: who saw what first, what each
missed, maker/taker coverage differences. No live Poly2 connection.

## Later possibilities (NOT approved)

- Production-grade storage rotation; multi-host evidence replication;
  alerting; long unattended canary. Each requires its own review before
  implementation.
