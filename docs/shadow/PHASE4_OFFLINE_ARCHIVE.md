# Phase 4 minimal prospective archive

> **Current format/scope note:** the v4 description below is a historical design
> snapshot. The current executable fenced archive is v5 and retains the complete
> authorized `backend`/`bot` writer roster, generation ACKs, original PostgreSQL
> decision audit corroboration, and offline archive replay. Direct SQL outside
> that declared application architecture is an out-of-contract operational
> violation, not a required negative-proof gate. See
> [`PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md`](PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md).

## Frozen semantics

The v4 path captures original committed trade insertion fields and linked initial
paper-order facts. Frozen cohort/window population is inclusive original
`ingestedUtc`, not commit visibility at E. Post-E decisions and straddling commit
responses are not silently dropped. `normalizedUtc` is null; original
`decisionUtc` is the frozen usable-latency fallback and original `miss_reason`
supplies rejection counts. No mutable signal/order status, approval, fill,
settlement, outcome or current policy is sampled. No PITR or full-table rescue.
Scientific engine/contract/identity mapping remain unchanged.

See [field trace](PHASE4_PROSPECTIVE_FIELD_MATRIX.md) and
[terminal property and authorization gate](PHASE4_CAPTURE_BLOCKER.md).
This captures committed Poly2 ingestion evidence, not upstream REST completeness;
Phase 3 remains `UNKNOWN_UNPROVEN`.

## Executable isolated components

- `scripts/poly2-comparison-checkpoint.py`: read-only native SQL adapter and durable
  minimal reconciliation producer. PostgreSQL DB-API repeatable-read/read-only
  transaction support; SQLite copy mode=ro/query_only. No default/live DSN or
  Poly2 import. CLI deliberately limited to explicit synthetic/copy fixtures.
- `scripts/poly2-comparison-capture-worker.py`: locked explicit source-spool worker.
- `src/compare/poly2-prospective.ts`: chained journal, mechanical mapping,
  cache/health publication, terminal certificate checks and offline replay.
- `scripts/poly2-comparison-source-hook.py`: legacy disabled observational hook
  fixture; callback atomicity is not a reader requirement or production solution.

```sh
# Only isolated synthetic/copy fixtures; not production permission.
python3 scripts/poly2-comparison-checkpoint.py \
  frozen-binding.json isolated-copy.sqlite isolated-source-spool
python3 scripts/poly2-comparison-capture-worker.py \
  frozen-binding.json retained-source-spool isolated-capture-dir
```

Without terminal authority, checkpoint invocation returns `INCOMPLETE`; spool
processing without `--archive` preserves recoverable evidence. `--archive` fails
without a valid terminal receipt and does not create a ready archive. Existing
sealed artifacts are never overwritten. The official comparator rejects synthetic
archives. Observational archives require independently pinned whole binding/key
and terminal authority, not an embedded self-signed key or producer writer labels.

## Recovery and terminal boundary

Every reconciliation reads complete frozen-cohort insertion population and linked
orders in one consistent snapshot. No high-ID/timestamp watermark suppresses a
late commit. Missing callbacks, observer downtime and source-query failure recover
by rescan; exact facts deduplicate from durable spool. Original fields/joins must
be retained immutable; change/disappearance/ambiguous linkage fails visibly. No
DB-enforced guarantee is assumed. Torn authority is preserved, not truncated.
Append/fsync precedes source cursor advancement; sink failure requires restart.

The fence orders closure after the declared `backend` and `bot` instances have
acknowledged the next generation and every pre-close transaction has a committed
witness or confirmed rollback. The receipt binds the fixed service-role set, the
run's exact declared instance identities and their ACKs before the final consistent
checkpoint. Identical ACK replay is idempotent; conflicting generation/identity
ACKs fail. The separate out-of-contract rogue SQL counterexample remains true but
is not a required proof that the authorized experiment must satisfy. The synthetic
integration does not install these hooks into production Poly2.

## Acceptance evidence

- `tests/poly2_checkpoint_test.py`: native SQL schema/transactions and actual
  read-only adapter; callback omitted; facts committed during observer downtime;
  restart/dedup; post-E decision recovery; mutable status exclusion; source-query
  failure/retry; native write denial; insertion mutation rejection; late invisible
  commit after repeated/final reads; no-certificate archive failure; pinned valid
  synthetic drain → final checkpoint → actual worker/journal → sealed offline
  artifact, replay and restart.
- `tests/poly2-prospective.test.ts`: unchanged scientific comparator end-to-end;
  original-ingestion population; post-E and straddling decision inclusion;
  irrelevant out-window straddle harmless; journal/cache/append fault recovery;
  certificate, binding and archive tampering; external key pinning.
- Legacy `tests/poly2_prospective_capture_test.py`: callback fixture failure and
  receipt-spool durability cases only, not a production capture prerequisite.
- `tests/poly2_capture_status_test.py`: local health composition and fail-closed
  absent/stale/malformed/misbound evidence. Status cannot authorize source closure.

All executed storage is disposable synthetic/copy-only. No production source,
network, DB, service, configuration, installation, run or deploy. No Phase 5 before
independent Phase 4 pass; green implementation tests do not resolve source closure.
