# Phase 4 ingestion-window remediation — historical acceptance matrix

> **Superseded status snapshot.** This file records an earlier fixed-set drain
> checkpoint. Its validation totals, remaining-property findings, “no Phase 4 PASS”
> statements, and pending fixture-cleanup status are historical, not current. The
> current implementation/validation/review gate is recorded in
> [PHASE4_AUTHORITATIVE_FENCE_RESUME.md](PHASE4_AUTHORITATIVE_FENCE_RESUME.md).
> The test descriptions below remain historical evidence for that earlier stage.

All execution was disposable synthetic storage/copy-only. Those implementation
tests did not authenticate production enrollment/closure or authorize Phase 5.
Frozen comparator/cohort/window/metrics remain unchanged.

## Executed end-to-end checkpoint evidence

`tests/poly2_checkpoint_test.py` uses actual SQLite transactions and the native
read-only SQL adapter, durable source producer, real locked worker, TS journal and
offline archive replay (not a handwritten JSON-only sealer).

| Exact test | Assertion |
|---|---|
| `test_missing_callback_and_source_downtime_recovered_restart_dedup_postend_decision` | DB insertion with no callback recovered; initial decision committed during observer downtime after E recovered on restart; duplicate scan no-op; mutable signal/order status ignored; valid synthetic certificate seals/replays exactly one row |
| `test_late_commit_after_final_read_no_max_or_repeated_scan_closure` | In-window insertion remains invisible through repeated scans after E; no-certificate worker seal fails without an archive; late commit then recovers; failed incomplete seal does not poison resumable journal; only later certified drain seals |
| `test_only_valid_pinned_certificate_after_drain_permits_seal` | Pending/failure/partial-writer/false-retention/future-population/wrong-pin/pre-E certificates rejected; final consistent scan includes trade; exact serialized checkpoint byte hash works even for six-decimal values serialized differently by Python/JS |
| `test_native_adapter_read_only_and_insertion_mutation_rejected` | Native connection rejects DML; required insertion-field changes fail reconciliation rather than using hindsight |
| `test_postgres_adapter_explicit_read_only_transaction_shape_without_connection` | DB-API structural seam proves explicit repeatable-read/read-only BEGIN, SELECT-only required fields/parameter bounds, no status/MAX/decision-at-E predicate and rollback; not native PostgreSQL execution proof |
| `test_append_before_position_crash_and_torn_spool_preservation` | Source frame durable before cursor advance; restart recovers exact fact after crash; duplicate scan no-op; torn spool preserved and rejected; failed constructor releases lock |
| `test_source_query_failure_resumable_without_phantom_cursor` | Unavailable source advances no frame; retry reads actual retained insertion, not phantom receipt |

## Executed frozen-semantics and certificate consumer checks

`tests/poly2-prospective.test.ts`:

- Actual Python source fixture → worker → sealed synthetic archive → unchanged
  scientific comparator, with raw/usable/coverage/policy assertions.
- Post-E committed original decision retained, including original clock before E;
  straddling decision response accepted; out-window irrelevant straddle harmless.
- Original cohort/ingestion interval, IDs and clocks preserved; unsupported mutable
  outcome/policy/normalization slots stay null.
- Missing/wrong-pin/false-retention/future-trade/future-decision/pre-E/hash/cursor/
  pre-closure-checkpoint certificate cases reject and cannot seal.
- Externally pinned whole binding/key plus modeled terminal authority required for
  signed observational test vector; serialization/key-pin test is not provenance.
- Journal replay/dedup/cache rebuild, source gaps, malformed source frames,
  conflicting identities/transactions, before/post/partial append faults,
  cursor-publication failure, archive/binding/torn-tail tampering remain covered.

## Preserved legacy evidence

`tests/poly2_prospective_capture_test.py` continues testing the disabled callback
hook's receipt durability/ACK crash cases, rollback, ownership, torn authority,
latched sink failures and observational activation denial. Those limitations are
specific to that hook, NOT a requirement for atomic callbacks or decision commit
visibility at E in the new read-only insertion reader. Legacy synthetic drains
model only enrolled synthetic transactions, never observational source closure.

`tests/poly2_capture_status_test.py` covers actual local status composition and
absent/stale/malformed/oversize/symlink/misbound/gap/failure health. Checkpoint health
explicitly reports `archiveState: INCOMPLETE` and the missing terminal property
until sealing. Capture data quality cannot authorize production closure.

## Historical validation snapshot (superseded)

- `npm run build`: passed (`tsc --noEmit`).
- `npm test`: **406 tests, 23 files passed**.
- `npm run safety`: passed (6 dependencies scanned, source clean).
- `python3 -m unittest discover -s tests -p '*.py'`: **119 tests passed**.
- `git diff --check`: passed; staged diff empty.
- Frozen `phase4.ts`, `poly2-adapter.ts`, `evidence.ts` and comparison contract:
  no diff against HEAD.
- Branch `feat/comparison-ready-instrumentation-v2`; HEAD remains
  `f0296c9e0fa1a36c2a0d369021a5bbd8a8b5f477`. Existing dirty repairs preserved.

## Remaining actual-source property (supersedes older unbounded closure wording)

`AT_END_SOURCE_ADMISSION_BARRIER_UNPROVEN`

Prospective frozen-ID drain does not require proving no future decisions globally.
It requires that the one immutable ID population at end actually covers the exact
original inclusive ingestion-window population. Trade.ingested_at clocks at flush,
before outer COMMIT; a pre-end insertion can commit after an end snapshot and be
invisible at freeze. Source-read inspection and a native PostgreSQL counterexample
establish this missing property. A current source snapshot proves visible rows,
not all in-window original insertions. Repeated scans/MAX, caller certificates,
signatures and arbitrary grace do not create admission authority. No proven
per-trade no-initial-decision terminal was found; unselected/deferred IDs remain
PENDING. See [PHASE4_CAPTURE_BLOCKER.md](PHASE4_CAPTURE_BLOCKER.md) for lifecycle
trace, original DecisionLogEntry linkage and exact scope.

## Latest native fixed-set drain execution

`tests/poly2_drain_postgres_test.py` executed against a new isolated PostgreSQL 15
container `poly-shadow-phase4-drain-authority-fixture`, no network/mounts/published
ports, tmpfs data, TCP disabled, private Unix socket/port 55439. The existing
fixture and production containers were not queried or changed.

| Matrix | Named native assertion |
|---|---|
| A | `test_A_all_before_end_native_read_only_and_equation`: exact terminal count equation and real SELECT-only role / read-only transaction refusal |
| B | `test_B_late_initial_decision_preserves_clock`: later committed initial decision, original unclamped post-end clock |
| C | `test_C_multi_late_no_grace_and_oldest`: multiple latent decisions, fixed population, oldest pending |
| D | `test_D_no_decision_not_applicable_no_terminal_source_path`: no invented source terminal; still pending |
| E | `test_E_permanent_pending_timeout_is_failed_incomplete`: repeated pending / operational timeout never eligible |
| F | `test_F_restart_late_decision_cursor_idempotence`: restart and exact terminal idempotence |
| G | `test_G_post_end_and_new_inwindow_ids_excluded`: frozen population unchanged after post-end and late invisible admission |
| H | `test_H_duplicate_query_retains_ids_and_decisions_once`: replay dedup/counts |
| I | `test_I_decision_conflict_retains_all_ids_failed_incomplete`: conflicting original decision latches incomplete |
| Admission | `test_native_delayed_commit_population_barrier_counterexample`: old ingestion invisible at freeze, real subsequent COMMIT, still cannot silently expand frozen population |
| Isolation | `test_native_repeatable_read_snapshot_and_later_transaction_visibility`: unchanged rows within snapshot, later committed decision visible in next adapter transaction |
| DB faults | `test_source_failure_no_phantom_cursor_and_retention_loss_failed`: DB failure no phantom cursor; original row loss fails incomplete |
| Join ambiguity | `test_duplicate_original_orders_reject_without_advancing_cursor`: duplicate original order linkage rejected |
| Writer faults | `test_writer_before_append_fault_no_phantom_population`, `test_actual_partial_append_fault_preserves_bytes_restart_rejects`: actual append/torn-write injection, preserved authority |
| Cursor fault | `test_durable_receipt_before_health_cursor_fault_restart_recovers_fixed_set`: fsynced frame survives failed health publication, restart does not add IDs |
| Torn restart | `test_torn_authority_preserved_restart_refuses`: malformed append authority preserved/rejected |

Earlier fixed-set drain validation snapshot (superseded):

- Native: **17 tests passed**, 3.675s; `/root/.hermes/cache/scratch/phase4-authority-native.log`.
- Build: passed, `tsc --noEmit`.
- Full TypeScript: **406 tests / 23 files passed**.
- Safety: **OK, 6 dependencies, src clean**.
- Full Python: **136 discovered, OK (skipped=17)**; native 17 executed separately,
  not silently reported as full-suite executed tests. Log:
  `/root/.hermes/cache/scratch/phase4-authority-python.log`.

At the time of this earlier checkpoint, these tests validated the incomplete
fixed-set drain and did not establish the later producer -> drain -> seal ->
comparator protocol. The “no Phase 4 PASS” and fixture-cleanup-pending statements
above describe that historical stage only; later implementation, validation and
owned-fixture cleanup are recorded in
[PHASE4_AUTHORITATIVE_FENCE_RESUME.md](PHASE4_AUTHORITATIVE_FENCE_RESUME.md).
Those later repository checks still do not authorize production installation,
launch, deployment or Phase 5.
