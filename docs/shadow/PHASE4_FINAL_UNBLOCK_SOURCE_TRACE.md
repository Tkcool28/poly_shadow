# Phase 4 FINAL UNBLOCK source trace — timestamp amendment independently PASS

Current status: **TIMESTAMP AMENDMENT V1 INDEPENDENTLY ACCEPTED; DECLARED-WRITER
FENCE IMPLEMENTATION NATIVE-TESTED; PRODUCTION NOT MODIFIED**. Parent acceptance
receipt `deleg_37e63713` authorized resuming prospective Phase 4 work. The final
Phase 4 review separately covers the backend/bot roster, per-instance generation
ACKs and native close/replay evidence. See `PHASE4_AUTHORITATIVE_FENCE_RESUME.md`
and `PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md` for the current scope. Unlisted
direct SQL is an out-of-contract operational violation, not a required proof that
this experiment must disprove. No production installation or experiment launch is authorized here.

The conflict analysis and execution receipts below are historical pre-amendment
evidence, not the current membership rule and not a reinterpretation of old runs.

## Source lifecycle and known writer inventory (source-only evidence)

Read `/opt/poly2/backend/src/polycopy/` without importing Poly2, contacting its
DB/providers, or modifying its checkout:

| Entry/concurrency domain | Trade writer / commit boundary | Recovery behavior |
|---|---|---|
| `bot/daemon.py:117-134` bot process | `run_bot_cycle` ingestion then settlement/execution; later separate session for hourly candidate scoring | One sequential loop within this process does not serialize API processes |
| `ingestion/service.py:580-636` wallet cycle | approved wallets use `catchup.ingest_approved_wallet`; others use `ingest_wallet_trades`; both reach `ingest_trade_rows` | Wallet exception rolls outer session back, refreshes wallet identities, later wallets proceed; future cycles may retry |
| `ingestion/catchup.py:29-160` approved tail/recovery | latest page and bounded older pages each call canonical `ingest_trade_rows`; separate progress commits | Prior anchor/end/offset retained; interrupted page replay relies on canonical trade-key dedup; source timestamp is old, ingestion clock is new |
| `scoring/service.py:242-281` candidate scoring | `bootstrap_wallet_history` calls same canonical `ingest_trade_rows` for each history page | Request budget/progress commits before requests and after page commit; failed scoring rolls back; bounded later pass resumes |
| `api/routes.py:215-228` operator scoring API | independent request `AsyncSession` -> `score_all_wallets` -> bootstrap -> canonical writer | Concurrent requests and bot/API workers may overlap; no global FIFO or all-writer admission facility was found |

`ingestion/service.py:530-568`: each new canonical key is added within an
`AsyncSession.begin_nested()` SAVEPOINT; market acquisition may await network/DB
work; `Trade` is constructed without explicit `ingested_at`; `session.flush()`
executes defaults and inserts; row failures roll back the SAVEPOINT and quarantine
before continuing. The outer wallet/page transaction commits only after the loop.
A flushed original in-window insertion therefore can remain invisible past the
end and commit later. Commit failure/connection ambiguity cannot be converted into
an observational terminal by a callback. A new retry must have a new transaction
identity, and a rolled-back attempted insertion is not a committed population row.

`models.py:32-33,132`: default is **application** `datetime.now(UTC)` at insertion,
not DB commit time, source event time, epoch enrollment time or queue time. It
preserves microseconds. `Trade.polymarket_trade_id` is uniquely constrained.
`ingestion/client.py` HTTP semaphore only bounds requests; it is not a transaction
serialization or source-admission fence.

This is a known checked-in writer inventory, **not** proof of deployed process
count, worker identities, external/manual writers or complete source enrollment.
An implementation must bind all actual worker incarnations prospectively, across
bot and API/scoring sessions, and enroll before the first possible Trade flush.
Labels `ingestion`/`execution` cannot substitute for that inventory. Catch-up after
the end must never acquire membership merely from old `traded_at`.

Execution separately detects approved/time-eligible bounded signals and inserts
original PaperOrders at actual decision time. Deferrals and missing signals are
PENDING, not lifecycle terminals. The new user instruction requires **every**
frozen ID to reach DECISION_RECORDED; NO_INITIAL_DECISION_EXPECTED is prohibited.
This supersedes older speculative no-decision prose, without changing the old
code during the prerequisite STOP.

## Exact scientific conflict

Frozen `src/compare/phase4.ts:350` filters `ingestedUtc` as a **string**. The actual
source clocks serialize through Python `isoformat()` with optional six-digit
fractions (`scripts/poly2-comparison-checkpoint.py:38-49`, source hook equivalent).
SQL reader population uses PostgreSQL timestamp comparisons (`:83,91`). For a
valid frozen millisecond window:

```text
start = 2026-01-01T00:00:00.000Z
end   = 2026-01-02T00:00:00.000Z
```

Native PostgreSQL and the unchanged comparator disagree:

| Original persisted ingestion clock | Native inclusive SQL membership | Frozen comparator membership |
|---|---|---|
| `2026-01-01T00:00:00.000001Z` | IN | OUT |
| `2026-01-02T00:00:00.000001Z` | OUT (strictly after end) | IN |
| `2026-01-02T00:00:00Z` | IN (exact end) | OUT |
| `2026-01-02T00:00:00.000Z` (same instant as preceding row) | IN | IN |

This is not fixed by an admission fence: freezing the correct SQL population still
loses the first row in the unchanged comparator. Expanding SQL to string membership
instead admits post-end ingestions, violating the required original ingestion-clock
population. Rounding/canonicalizing originals changes recorded raw discovery
clocks. `Date.parse` alone also truncates the second row to end milliseconds and
therefore cannot enforce exact microsecond membership. The existing Python
numeric-versus-lexical guard detects some selected-row disagreement, but SQL has
already omitted the post-end row; the JS guard uses millisecond Date.parse and
cannot detect that sub-millisecond case. Neither guard establishes compatibility.

The counterexample uses a valid window representation, not a claim about a
specific production run: no frozen production window or production rows were
queried. A general deployable implementation must fail closed for this valid
binding unless the contract first resolves it.

### Historical adjudication request — superseded by authorized V1

Authorize a precise representation/precision rule for interval membership and raw
latency, including inclusive endpoint behavior, then authorize any required edits
to the currently frozen comparator/contract. Options are exact instant comparison
while retaining original clock strings, or an explicitly agreed canonical
serialization that does not silently redefine source clocks/metrics. The current
scope explicitly preserves `phase4.ts`; implementation cannot pick an option.

Only after independent timestamp-amendment review, the parent may resume the authorized epoch/inflight + all-worker ACK design
(or a genuinely ordered source boundary), with durable pre-flush registration,
commit-coupled facts, rollback/retry recovery and observational fail-containment.
No design was promoted to authority here. Worker-death/outstanding, restart,
duplicate-ACK, sinkfailure, held pre-end commit, post-fence exclusion, freeze,
late-decision drain, seal and comparator E2E remain **unimplemented/unverified**
for the newly requested fence, not waived by green regression suites.

## Executed evidence and cleanup

New counterexample tests:

- `tests/poly2-ingestion-clock-contract.test.ts`: **4 passed**, invokes the actual
  unchanged `compare()`; also proves representation-only primary population
  change and JS precision truncation.
- `tests/poly2_ingestion_clock_postgres_test.py`: **4 passed native**; invokes actual
  PostgreSQL timestamp expressions and the actual checkpoint serializer. Extracts
  only the source `utcnow` AST function and runs it with a deterministic datetime
  seam, without importing the production package. No handwritten completeness
  certificates or fence Boolean receipts are used.

Native fixture: new exact owned name `poly-shadow-phase4-clock-conflict-f0296c9`,
container `98e840060508430fd76be27fe099a513c50224a8a1d840e45a188a659aea19b0`,
installed `postgres:15-alpine` image, `--pull=never`, `--network none`,
`HostConfig.Binds=null`, `PortBindings={}`, tmpfs PGDATA
`rw,noexec,nosuid,size=128m`; TCP disabled with `listen_addresses=''`, socket port
55441. Readiness verified by actual `pg_isready`. `docker stop` and `docker rm`
both returned the exact fixture name; exact-name `docker ps -a` returned no rows.
The pre-existing `poly-shadow-phase4-drain-fixture` and all eight named Poly2
containers remained listed and were never operated on. The previously removed
`poly-shadow-phase4-drain-authority-fixture` was not recreated or reused.

Validation after adding regressions: `npm run build` passed; full TypeScript
**24 files / 410 tests passed**; static safety **OK (6 deps scanned, src/ clean)**;
Python discovery **140 tests, OK, 21 skipped** (119 executed; all 17 legacy native
drain tests and four new native clock tests intentionally skip without an explicit
fixture; the four new native tests passed separately above); `git diff --check`
passed. These are counterexample and regression outputs, not Phase 4 PASS.

Handoff: independently inspect/reproduce the clock matrix before authorizing a
scientific contract repair. Worktree stays dirty on
`feat/comparison-ready-instrumentation-v2`, HEAD
`f0296c9e0fa1a36c2a0d369021a5bbd8a8b5f477`. Previous implementation files preserved.
No stage, commit, reset, stash, push, PR, merge, production state change, actual
experiment launch, current pointer, or trading action. No fence receipt/seal exists.
