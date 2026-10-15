# Corrected V2 evidence campaign V1.1

Status: offline preflight; public campaign not executed.

Starting main: `1f911ad00d2e98bfd553a0de7dd101746221e531`.
PR13 merge74c32db… and PR14 merge1f911ad…/reconciled48d530… are ancestors.
Merged adapter/replay blobs are identical to reviewed19d31e6…:

- adapter.ts: `f7a3fcaabdd5277efb53a528d5626d49127dc32d`
- replay.ts: `f4b1539296c25ab649dbc19a176c04b4b8d2633c`

Those files, production collectors, frozen comparison rules and approved cohort
are unchanged. The original V1 evidence remains immutable and TIMING_UNVERIFIED.

## Explicit execution and offline gates

The connector supports an explicit PR label action, but not workflow_dispatch.
The narrow trigger change uses label `authorize-v2-evidence-v1-1`, applied once
only after the exact draft-PR head passes standard full CI and independent review.
Opening/updating/merging a PR does not acquire data. No schedule is configured.
The workflow checks exact branch/base/head/frozen blobs and first run attempt,
serializes the authorization, and refuses any previous non-skipped authorized
run. A failed campaign cannot be retried by relabeling or rerunning it.
GitHub's read-only workflow token reads run history; no production secrets are used.

The labeled workflow repeats all existing offline gates before its sample job:
full Vitest, Python3.12/3.14, TypeScript, static safety and startup refusal checks.
Acquisition uses the unchanged merged adapter through the existing campaign
harness. Only its authorization, output path and campaign metadata are changed.
New output is research/v2-corrected-v1-1/evidence; old evidence is never deleted.
The same bounds, disk reserve and at-most-one public CHAIN receipt policy apply.

## Mandatory independent evidence gate

Merged replay validates response/normalization clocks but does not independently
check request initiation<=response. The V1.1 auditor therefore mandates all three
measured timestamps, exact UTC validity and request<=response<=normalization on
every record. It is an acceptance gate, not an optional report or escape hatch.
SQLite research publication alone is not acceptance into a scientific comparison.

The audit verifies exact manifest inventory/hashes, response bytes, query/cursor
bindings, durable SQLite versus exported receipts/publications, frozen identities,
normalization vectors, checkpoint seals, budgets and deterministic merged replay.
It reads a hash-verified temporary SQLite copy so no evidence/sidecar is mutated.
Output goes to a disjoint audit-output directory. It emits per-record timing and
publication references plus all five required timing metrics; source age is not
claimed as true indexing or first-discovery latency.

Negative tests include missing/malformed/early clocks, legacy timing, forbidden
current-clock reconstruction, receipt mutations, publication disagreement,
duplicates, transaction failure, restart, request ordering, budget violations and
unlisted evidence. Equal genuinely measured millisecond values remain valid.

No VPS access, deployment, merge, observer startup, Poly2 change or24hcomparison.
Results and the final independent review will be recorded after the single run.


## Explicit preflight correction and retry authorization

The first V1.1 authorization stopped offline in run38670127513: the sink-failure fixture scheduled sealing only300ms before start. Production correctly refused MISSED_START. The sample job was skipped and no artifact or public campaign existed; the failure diagnostic manifest remains62f0c7309adbf6a56f5fb5177aa275b884dbf48a3c1f14afd3a2eced74d5edc7.

Only that synthetic sink scenario now allows2s for sealing and10s for subprocess completion, retaining its1s observation window and failure assertions. Its enclosing Vitest watchdog becomes70s/75s. A deterministic clock negative separately proves expiration during sealing yields MISSED_START, an INVALID staging directory and no publication. Five predeclared repetitions of both tests run per supported Python interpreter before full suites in native GitHub CI and the acquisition preflight. The local execution host reported inconsistent process-session identity between os.getsid and /proc, so it cannot validate these native process-group fixtures; that diagnostic is not counted as passing.

The new explicit label authorize-v2-evidence-v1-1-retry-1 is distinct from the consumed initial label. Reservation permits exactly the prior failed run38670127513 only after live GitHub metadata proves its sample job skipped without steps and artifact count zero. Any other prior authorized run blocks; rerun attempts, PR-open events and old labels cannot acquire. No acquisition algorithm, guard, cohort, clock, replay or scientific rule changes accompany this test correction.
