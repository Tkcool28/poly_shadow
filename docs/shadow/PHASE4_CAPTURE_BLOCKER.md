# Phase 4 — fixed-ID drain tested; authoritative population unresolved

> **Prospective scope amendment:** the experiment's authorized comparator-writer
> architecture is the declared `backend` + `bot` service roster, not hypothetical
> direct-SQL/rogue writers. The `backend` role covers candidate-history ingestion;
> `bot` covers Trade ingestion/catch-up and initial decisions. `watchdog` and
> `frontend` are not comparator-relevant. Every declared instance must enroll and
> ACK the same fence generation; missing services/instances block closure. Any
> unlisted direct SQL activity is an out-of-contract operational violation, not
> a proof obligation for this experiment. The older counterexample and blocker
> discussion below are historical evidence under the former universal scope and
> are superseded for this authorized architecture by
> [`PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md`](PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md).
> This does not claim production installation or authorize deployment/launch.

> **Current: timestamp amendment independently PASS (`deleg_37e63713`).**
> Prospective fence/session-factory implementation has now executed against an
> owned PostgreSQL fixture, including real SQLAlchemy AsyncSession and offline
> seal/comparator replay. This is synthetic installation proof, not authenticated
> deployed source authority. See `PHASE4_AUTHORITATIVE_FENCE_RESUME.md` for the exact
> all-writer installation/retention/custody blocker and acceptance matrix.
> Observational production activation and seals still fail closed. No Phase 4 PASS.
> Every frozen ID requires DECISION_RECORDED; no no-decision terminal is allowed.
> Older execution/authorization descriptions below are historical.

## Latest authorized semantics

Freeze the exact five-wallet inclusive 24-hour original-ingestion ID population
once after the completed ingestion fence. Subsequently query only those IDs until
each has an original initial decision. No no-decision terminal is authorized. Original
decision timestamps after the end are allowed, without clamping. There is no
requirement that no more decisions ever occur globally, no grace-period scientific
cutoff, no PITR requirement, and no current-status hindsight. An operational timeout
is incomplete, not a scientific exclusion. Capture is separate from trading.

## Actual source trace (source reads only)

Inspected `/opt/poly2/backend/src/polycopy/{models.py,ingestion/service.py,
execution/service.py}`. These are source observations, not live DB observations or
an inventory of every possible direct/manual writer.

```text
canonical source identity
  -> ingest_trade_rows: Trade added/flushed within SAVEPOINT
     ingested_at = application utcnow default at insertion/flush
  -> outer wallet transaction commit (service.py:568)
  -> detect_signals: approved-wallet/time-boundary/NOT EXISTS bounded query
  -> Signal.source_trade_id = Trade.polymarket_trade_id; separate commit
  -> execute_signal
     -> deferred: no order, no terminal
     -> skip: original PaperOrder + signal_skipped DecisionLogEntry + commit
     -> fill: original PaperOrder + paper_order_executed DecisionLogEntry + commit
```

| Actual source path | Persistent original proof | Drain classification |
|---|---|---|
| Trade flush followed by outer commit | Trade.id, unique polymarket_trade_id, ingested_at; no commit-time admission fence | Ingestion fact only |
| Detection not selected (unapproved / approval boundary / bounded backlog) | No per-trade immutable suppression receipt in inspected path | PENDING; do not infer no-decision from today's wallet |
| Signal detected | Signal.id and unique source_trade_id | PENDING until decision evidence |
| Kill switch / review delay | Return None; no terminal order/audit event | PENDING |
| Stale source, wallet-not-approved, market closed and other skip gates | PaperOrder.signal_id, idempotency_key `paper:<source_trade_id>`, t2_decided_at, miss_reason; DecisionLogEntry(action=signal_skipped, context.signal_id/source_trade_id/reason) | DECISION_RECORDED, not no-decision |
| Filled/partial execution | Same order links/t2_decided_at; DecisionLogEntry(action=paper_order_executed, context.signal_id/source_trade_id and original fill facts) | DECISION_RECORDED |
| Quarantined before persisted Trade | trade_ingest_quarantined audit; failure may be throttled | Not proof for an already persisted frozen ID |

Relevant source positions: models.py:115-132 (Trade), :181-208 (Signal),
:230-247/:277 (PaperOrder), :311-317 (DecisionLogEntry);
ingestion/service.py:530-568 (flush versus outer commit);
execution/service.py:120-173 (detection), :177-213 (skip insertion), :244-259
(stale decision versus deferral), :263-281 (approval recheck), :438-448/:517-534
(fill and audit insertion).

**No genuine persistently proven NO_INITIAL_DECISION_EXPECTED condition was found
for a retained Trade ID.** Absence of Signal/order/audit is not terminal proof.
Approval changes and source policy configuration must not fabricate one.
DecisionLogEntry.created_at is an audit insertion clock, not a substitute for
PaperOrder.t2_decided_at. For recorded decisions, the current PostgreSQL adapter
and v5 archive replay require the exact DecisionLogEntry audit linkage/action and
retain its audit timestamp alongside the original PaperOrder clock. An absent
decision is still not synthesized from today's mutable approval/policy state.

## Historical universal-scope blocker (superseded for the declared backend/bot roster)

The counterexample below deliberately bypasses the declared application writer
wrappers. It remains valid evidence that an unauthorized direct-SQL transaction
would breach the operational contract, but it is not a required proof that the
experiment cryptographically disprove the existence of such a writer.

`AT_END_SOURCE_ADMISSION_BARRIER_UNPROVEN`

The freeze reader's PostgreSQL repeatable-read snapshot proves exactly the rows
visible to that transaction. It does not prove the complete population of all
trades whose original ingested_at is in the inclusive interval. The source clocks
at flush, before outer transaction COMMIT. A transaction can flush before the end,
remain invisible at the freeze, and commit afterward. Restart correctly cannot add
this ID to an already immutable population. Repeated scans, MAX, sequence IDs,
quiet periods, an observer's signature or caller completion Boolean do not resolve
that difference.

The native regression `test_native_delayed_commit_population_barrier_counterexample`
executes precisely this schedule: uncommitted in-window ID 99, empty end freeze,
COMMIT, subsequent full query sees ID 99, immutable drain still empty and comparison
eligibility false. This is the missing property even when every frozen ID has a
recorded decision; decision-drain closure itself does not require global no-future-
decision guarantees.

That requirement described the former universal-writer scope. Under the current
authorized architecture, every declared `backend`/`bot` instance enrolls before
comparator-relevant work, acknowledges the closed generation, and must resolve all
pre-close transactions through a committed witness or confirmed rollback before
the synthetic frozen population is accepted. The direct-SQL counterexample remains
out-of-contract; no database-wide denial, cryptographic rogue-process absence
proof, production lock/configuration/service change, or trading-availability
change is required or authorized. This scope clarification changes no prior result.

## What is implemented and what is not

`scripts/poly2-comparison-drain.py` preserves a durably journaled observed ID set,
per-ID states and original clocks/digests across restart, and queries only that
set on later steps. Decision/fact conflicts fail incomplete rather than shrinking
population. A local fixed-set drain COMPLETE state alone is not comparison
eligibility: the population receipt, DecisionLogEntry-backed decision receipt,
writer roster/ACKs, archive seal and offline replay must also validate. The current
v5 synthetic terminal receipts are validated by Python and TypeScript readers;
legacy caller-Boolean certificate fixtures are not source-closure evidence. The
producer -> fenced drain -> seal -> offline comparator handoff passed the native
test suite. This is not production installation or authorization to launch. Frozen
comparator formulas, scientific evidence contract and `normalUtc=null` remain
unchanged.

## Earlier native execution record (historical)

The prior `poly-shadow-phase4-drain-authority-fixture` note above this checkpoint
was not a fixture created or operated by the current roster-validation task. This
task's exact owned fixtures and verified cleanup are recorded in
`PHASE4_AUTHORITATIVE_FENCE_RESUME.md`; pre-existing fixtures and all Poly2
containers were left untouched. No production queries/imports/edits, configuration,
network/provider access, deploy, historical/current-pointer changes or trading
occurred.

No Phase 5, deployment, experiment launch or merge. The user authorizes checkpoint commit/push only after fresh independent review; this document does not authorize production installation or launch.
