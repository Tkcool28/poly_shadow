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

## Phase 3 — multi-source discovery + source racing ✅ merged (PR #3)

- Merge commit / authoritative main: `f22f3acf2b1cd641580b9131a8ead3898183ad86`
- Adds: REST /trades observer, REST /activity observer, source racing +
  reconciliation (`racing.ts`), per-source normalized observation stream,
  poll telemetry (freshness measured, not assumed), metrics script.
- WS trade source investigated → rejected (WS_FEASIBILITY.md).
- Post-review fix: RPC head-lag handling (`invalid block range` clamp/retry +
  null-guards in `scanRange`/`blockRef`) after the bounded live run showed a
  load-balanced provider quarantine; CHAIN=0 in that window was correctly
  diagnosed (REST p50 latency ≈ 2.4 h → wallet traded historically).
- 77 tests total at handoff of Phase 4.

## Phase 4 — controlled Shadow-vs-Poly2 comparison + read-only dashboard 🔨 in progress (draft)

- Branch `feat/phase4-poly2-comparison-dashboard`; DRAFT PR; do not merge.
- Adds: `src/compare/phase4.ts` (comparison engine), `cli.ts` (frozen-window
  comparison runner), `dashboard.ts` (phone-friendly read-only HTML from
  artifacts — never queries Poly2), `docs/shadow/PHASE4_COMPARISON_CONTRACT.md`,
  `docs/shadow/DASHBOARD.md`, `docs/shadow/WALLET_DISCOVERY_FEASIBILITY.md`
  (research-only, isolated).
- Design: fixed-wallet apples-to-apples only (CONTROLLED_OVERLAP primary,
  SHADOW_EXPLORATORY reported separately); matching classes
  MATCHED_HIGH_CONFIDENCE / MATCHED_PROBABLE / SHADOW_ONLY / POLY2_ONLY /
  AMBIGUOUS; raw vs usable discovery distinguished via `sourceFirstSeenUtc`
  (never racer FIRST order); decision-relevance classification with Poly2's
  300 s freshness budget modeled.
- Gate: 14 handoff items; items requiring a real Poly2 export + frozen 24 h
  window are pending until that export exists.
- Review correction pass (six blockers): symmetric cohort + window
  enforcement on Poly2 rows (fail-closed, exclusions reported), frozen
  coverage-of-union formula, emitter/market population metrics, full
  trade-level dashboard fields + filters, test-count/doc reconciliation
  (suite is 84 + 18 = **102 tests**).

## Later possibilities (NOT approved)

- Production-grade storage rotation; multi-host evidence replication;
  alerting; long unattended canary. Each requires its own review before
  implementation.
