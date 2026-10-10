# Comparison-ready instrumentation v2 operator guide

## Diagnostic visibility is allowed

During a controlled run, operators may inspect append-only RPC lineage, retry/recovery records, quarantine and resolution records, REST poll receipts, memory/recovery telemetry, periodic audit snapshots, disk capacity, source freshness, Poly2 archive capture-evidence status, and the dashboard data-quality state. This is diagnostic visibility, not a change to the experiment.

## Scientific rules remain frozen

Do **not** change the five-wallet cohort, 24-hour window, source definitions, matching, source-first timing, comparator metrics, exclusions, or thresholds. Do not enable trading. The comparator contract in `PHASE4_COMPARISON_CONTRACT.md` remains authoritative.

## New run artifacts

All files are append-only under `shadow-data/`:

- `rpc_lineage.ndjson`: one record for every instrumented CHAIN RPC request, with exact parameters, range/block, purpose, attempt, timestamps, result count, and classified result.
- `rpc_recoveries.ndjson`: explicit failed-request → successful-request coverage links. Missing link means unresolved.
- `quarantine_v2.ndjson` and `quarantine_resolutions.ndjson`: durable reason/state and later linked recovery or terminal disposition. Original quarantine rows are never edited.
- `rest_poll_receipts.ndjson`: linked page and poll receipts, including exact params/cache headers, returned identity-vector digest, cap/overlap/stop diagnostics, publication outcome, quarantine links and successful-new/seen counts. SKIPPED polls are explicit.
- `runtime_telemetry.ndjson`: full 5-second memory/recovery/index/queue telemetry archive.
- `audit_snapshots.ndjson`: periodic operational summary (at most once per 10 minutes).
- `chain_tail_proofs.ndjson`: observer-stop tail/cursor/recovery proof. A non-null unresolved tail is not coverage.

Legacy offset pagination is implemented behind an explicitly disabled-by-default option, not a silent v2 source switch. Coverage remains `UNKNOWN_UNPROVEN`: observed overlap and a later short page cannot prove immutable snapshot/cross-poll coverage. The prospective acquisition amendment, public API citations, budgets and deterministic acceptance cases are in [Phase 3 REST pagination protocol](PHASE3_REST_PAGINATION_PROTOCOL.md). Prior `UNSUPPORTED_UNPROVEN` receipts remain immutable.

## Data-quality state (not process health)

Process health asks whether the observer is alive and bounded. Data quality asks whether evidence can support the comparison:

- **GREEN**: known source progress with no pending recovery/quarantine/capped REST evidence.
- **DEGRADED**: pending retry, unresolved quarantine, or REST page at configured limit.
- **AT_RISK**: `EVIDENCE_SINK_FAILURE`, invalid evidence index, recovery-required CHAIN state, 10+ unresolved quarantines, or source progress stale for more than 180 seconds.
- **UNKNOWN**: source progress has not yet been observed.

These are operational rules only; they do not alter comparator performance thresholds.

## Alert/manual-decision conditions

Alert and decide manually if RPC lineage, receipt, quarantine-resolution, or Poly2 archive capture-evidence status stops advancing; data quality remains `AT_RISK` for 10 minutes; observer progress is stale for 180 seconds; cgroup memory is unsafe; disk free space is below 10 GiB; or the status publisher is stale. A single recoverable RPC/REST error is not an automatic abort.

Operational sink failure is different: the shared writer latches BROKEN, stops/gates all CHAIN/REST sources and in-flight publication, and retains the original failure. `operational-failure.json` is a separate create-only control diagnostic, never scientific authority. ENOSPC may prevent that file and stderr too; source retirement does not depend on either diagnostic succeeding. Observer exit 74 and the lifecycle failure-marker check prevent an `END_WINDOW_COMPLETE` classification after a detected sink failure. Restart does not repair torn authority or invent missing recovery/resolution records. See [the Phase 2 acceptance matrix](PHASE2_OPERATIONAL_SINK_FAILURE_MATRIX.md) for exact deterministic tests and persistence limitations.

## Poly2 archive and offline comparator

The current input is a sealed **v5 fenced prospective** archive: committed original trade facts and fixed-ID initial decision facts, including exact DecisionLogEntry corroboration, with immutable source positions, generation-bound writer acknowledgements, activation/drain receipts and chained journals. Mutable outcomes and unsupported normalization/eligibility are null. The old v3/v4 mappers remain historical offline compatibility, not the current prospective contract. The CLI has no Poly2 DB/network path and rejects synthetic archives as production authority. This repository task validates the synthetic, isolated implementation; production installation remains separately unauthorized.

**Phase 4 implementation scope:** the current v5 fenced archive closes the declared application-writer set: `backend` (candidate-history ingestion) and `bot` (Trade ingestion/catch-up and initial decisions). Every declared `service:instance-id` must enroll and ACK the fence generation; the receipt and offline validator require both services and exact per-instance ACK coverage. An unlisted direct-SQL writer is an out-of-contract operational violation, not a hypothesis this experiment must cryptographically disprove. See [writer inventory/closure contract](PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md), [minimal prospective archive semantics](PHASE4_OFFLINE_ARCHIVE.md), and the historical scope amendment in [capture notes](PHASE4_CAPTURE_BLOCKER.md). This is repository/synthetic implementation evidence only: no production capture was installed, and this checkpoint does not authorize launch or live trading.

## No-launch boundary

This change does not seal a window, create a current-run pointer, start an observer, query production Poly2, produce a real archive, run the official comparator on historical evidence, deploy, or change trading state.
