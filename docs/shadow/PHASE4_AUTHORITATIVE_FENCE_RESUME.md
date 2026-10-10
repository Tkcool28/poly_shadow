# Phase 4 authorized fence resume — implementation checkpoint

Timestamp amendment independent PASS: parent receipt `deleg_37e63713`. The
prospective authorized writer set is `backend` + `bot`; watchdog/frontend are
excluded, and unlisted direct SQL is an out-of-contract violation rather than a
required absence proof. See `PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md`. The
worktree remains on `feat/comparison-ready-instrumentation-v2`, base/starting main
SHA `f0296c9e0fa1a36c2a0d369021a5bbd8a8b5f477`. Exact final independent review is
pending; this remains synthetic repository proof, not production installation.

## Inspected/preserved implementation and source boundary

Existing fence, drain, observer, TS archive validator and native tests were already
present at entry and were inspected rather than replaced. The actual source
`db.py:get_sessionmaker` supplies both bot sessions and API dependency sessions.
All inspected Trade constructors are in `ingestion/service.py:542`; bot ingestion,
approved catchup pages and candidate scoring/API history bootstrap call canonical
`ingest_trade_rows`. These domains are concurrent, not globally FIFO. Admission
must precede `begin_nested` autoflush/default execution; original `ingested_at` is
an application microsecond clock before the outer commit. See the source trace
for entry points, retries and source-decision paths. Checked-in callsite inventory
is not an authenticated inventory of deployed processes or external SQL writers.

Source bytes read (not imported, executed or modified):

- `db.py`: `4cd9d351a59cf735f3f2c1e91d300072fe1cce957a1335e00494bd139f76d73a`
- `ingestion/service.py`: `ea022e25626cc7661dc147a37bb6774239eb8cde894e4ddaff0b2c399bdc99e1`

## Changes in this resume

- `scripts/poly2-comparison-session-observer.py`: added `ObservedSessionFactory`,
  an opt-in wrapper around the real async_sessionmaker. Every future session gets
  its observer before being returned. Exact expected worker incarnation required;
  enrollment/observation errors latch experimental failure without denying the
  source session. No global registry retains session objects. Existing sessions,
  alternate makers and raw/manual SQL are explicitly **not** covered by wrapping
  one factory. This code is not installed in `/opt/poly2`.
- Fixed nested SAVEPOINT release bookkeeping: committed child facts are reassigned
  to the parent, so later parent rollback removes them. `after_commit` is used
  only for this bookkeeping, never as outer-commit authority.
- `tests/poly2_session_postgres_test.py`: actual AsyncSession + asyncpg native
  integration and lifecycle/sink-failure tests. Conditional dependency/owned-name
  gating prevents implicit source connections.
- `tests/poly2_fence_postgres_test.py`: switched execution to the newly owned
  resume fixture; restored the SELECT grant after the witness-table-drop fault;
  added a native unenrolled-held-transaction authority counterexample.
- Updated current headings in blocker/source-trace docs; historical receipts remain
  historical and are not reinterpreted.

## Executed acceptance matrix

All PASS entries below are **synthetic installation/protocol proof**, not proof of
production installation, key custody, source retention or universal enrollment.

| Requirement | Executed assertion | Result |
|---|---|---|
| Actual ORM admission before flush/default; begin_nested implicit autoflush | existing 8 Session tests plus native AsyncSession held-A test | PASS |
| Held A invisible at end; completed B cannot hide A | `test_real_asyncsession_held_A_B_C_freeze_drain_seal`; DB-API equivalent | PASS: fence waits for A |
| New-generation C continues while old generation drains | same native test | PASS: C uncommitted when fence/freeze succeeds; C excluded |
| Original exact inclusive ingestion membership, final full read-only SQL reconciliation | actual SQLAdapter freeze query and SQL snapshot receipt | PASS for enrolled fixture rows; timestamp matrix was already independently accepted |
| Immutable exact IDs/count/digest then fixed-ID decisions | freeze + FencedDrain + TS offline replay | PASS: IDs `[1,2]`, primary population 2 |
| Actual late decision clocks; normalizedUtc null | native seal → offline comparator | PASS: `2026-01-03T00:01:00.000001Z`, null normalization |
| Worker death/unknown outcome/missing ACK | native epoch death and missing-ACK tests | PASS: remains incomplete; absence not rollback |
| Confirmed outer rollback/retry/new identity | epoch retry and native ORM future-session tests | PASS |
| Child SAVEPOINT release then parent rollback | new actual AsyncSession regression | PASS: no phantom descendant fact |
| Commit crash before capture receipt; producer restart/duplicate ACK | native epoch recovery/idempotence tests | PASS: committed DB witness authority |
| Admission/witness sink failure remains observational | native AsyncSession 2 sink tests plus Session/epoch faults | PASS: source Trade commit succeeds; capture FAILED |
| Pending IDs/decision restart/conflicts/timeout/no invented terminal | epoch drain tests | PASS: explicit blocking IDs; seal refused |
| Duplicate initial orders/no earliest hindsight | native epoch duplicate-order test | PASS: refuses ambiguous original decision |
| Source retention drift/unenrolled already-visible row | native freeze mismatch and decision-conflict tests | PASS: incomplete/error |
| Offline seal/manifest/journal/hash validation | native ORM output fed to `tests/poly2_fence_e2e.ts` | PASS: 15 negative replay checks |
| Unenrolled direct-SQL writer outside the declared app architecture | native authority counterexample | OUT-OF-CONTRACT operational violation; not a required experiment proof under the narrowed backend/bot roster contract |
| Declared bot/backend writer inventory and per-instance generation ACKs | Python fence + TypeScript receipt replay and explicit roster/ACK regressions | PASS when the binding names every authorized runtime instance and all acknowledge; the exact native rerun is required for the current edits |
| Bounded whole-run memory under unbounded retries/ongoing post-end source work | fence materializes events/attempts; drain retains full frames; TS replay materializes evidence | NOT SATISFIED; no bounded-memory production claim |
| Authentic production worker → source-bound fence → authenticated seal | production is intentionally uninstalled/refused | NOT RUN; cannot be substituted by synthetic fixture |

Queued requests not yet flushed cannot acquire pre-end membership from source
`traded_at`. Nevertheless clock rollback, explicit backdated ingestion values,
alternate DML and missed factory installation require independently controlled
source installation/clock/retention rules; journal generations alone cannot prove
those conditions. Unknown terminal outcomes remain outstanding forever unless a
real committed witness or confirmed driver rollback resolves them. This is safe
incompleteness, not a crash-restart guarantee that all crashes eventually close.

## Prospective authority-scope amendment — declared application writers

The user-authorized Phase 4 boundary is the checked-in/deployed application
architecture, not hypothetical unregistered SQL activity. The only authorized
comparator-relevant writer services are `bot` (Trade ingestion, catch-up, initial
decisions) and `backend` (candidate-history Trade bootstrap). `watchdog` and
`frontend` are not comparator-relevant writers. Every authorized instance is
declared in `expectedWorkers` using a strict `service:instance-id` value and the
run-bound source/component revisions. The fence requires both services, enrolls
only declared instances, persists each generation ACK, and refuses terminal
closure until every declared instance has acknowledged and pre-close work is
resolved. The terminal receipt repeats required services, roster, and ACKs; the
offline TypeScript validator independently checks them. Identical ACK replay is
idempotent; a wrong-generation or malformed ACK fails visibly.

The counterexample above remains valid evidence that an unauthorized raw SQL
writer would violate the operational contract. It is deliberately not promoted
to an acceptance requirement to cryptographically prove the absence of such
activity. No broad database denial, PKI, or infrastructure change is required.
This prospective scope clarification does not alter timestamp membership,
scientific formulas, comparator rules, or any prior experiment result.

The capture/observer remains synthetic and is not installed in production Poly2.
This checkpoint authorizes repository validation/review and code checkpointing
only; it does not authorize production installation, deployment, or experiment
launch. DecisionLogEntry corroboration is implemented in the PostgreSQL adapter
and archive replay and passed the final native rerun.

## Fresh validation outputs for the current Phase 4 diff

- Full TypeScript suite: **26 files, 453 passed**, exit 0.
- Python discovery: **181 total; 128 passed, 53 skipped**, exit 0.
  The skips are optional native fixtures and optional SQLAlchemy/asyncpg adapters;
  separate native runs below are not counted as discovery executions. The suite
  includes a regression proving fence/capture/status exact-clock consumers bypass
  timestamp-based `.pyc` loading.
- Explicit native PostgreSQL fence/file-handoff suite: **23 passed, 0 skipped**
  (21 source-fence/PostgreSQL tests and 2 writer-roster unit tests). Decision audit,
  restart-preserved partial ACK state, closure refusal, archive/file replay and
  comparator handoff all executed. The array/file comparator proofs reported 15
  and 10 negative replay checks respectively.
- Explicit timestamp membership suite: **4 passed, 0 skipped**, including 15
  inserted PostgreSQL boundary/representation cases agreeing with Python capture,
  TypeScript comparator, Shadow membership and archive replay.
- Focused archive/prospective/bounded TypeScript suites: **4 files, 62 passed**.
- Bounded Python history tests: **3 passed**.
- `npm run build`, `npm run safety`, and `git diff --check` all exit 0; safety
  reports **OK (6 deps scanned, src/ clean)**.

The latest independent review found a v3 synthetic-comparator archive could pass
through the normal CLI. The CLI now accepts v3 only when both the manifest and
captured snapshot identify `historical-table-copy`; a regression verifies that a
synthetic fixture is rejected without overwriting comparison output.
Checkpointing remains conditional on an independent PASS; this document records
no deployment or experiment-launch authorization.

Native fence fixture used: `poly-shadow-phase4-epoch-resume-f0296c9-20261009`;
timestamp fixture used: `poly-shadow-timestamp-amendment-v1-f0296c9-run3`. Both were
network-none, had no host mounts or published ports, and used tmpfs PostgreSQL data.
The failed timestamp setup attempts (`...-f0296c9` and `...-run2`) had the same
isolation. All four exact owned names were stopped/removed after tests and verified
absent. The pre-existing bounded/epoch/drain fixtures remained unchanged. Read-only
container listing confirmed the Poly2 containers remained running; none were stopped,
removed, queried or modified.

No production Poly2 mutation/import/database query, provider call, service change,
trading deploy, experiment launch, historical result change, merge or Phase 5 work
occurred. The fresh independent review gates the explicitly authorized checkpoint
commit and optional push; no deployment or experiment action follows this checkpoint.
