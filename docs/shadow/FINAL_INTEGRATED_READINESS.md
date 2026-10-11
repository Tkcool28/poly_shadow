# Final integrated repository readiness reconciliation

## Verdict and scope

**Repository-side native/full/focused/build/safety validation completed; independent review returned PASS with no blocking findings for the four-file inventory.** Review reference: `deleg_c5bef39a`. This report records precommit evidence; the readiness checkpoint is the Git commit containing this report, with direct parent `ed64333e09827a55bed90f52815ed4b17e78f078`. Publication is verified separately by exact remote SHA readback. The successful current 390px mobile evidence is reused unchanged.

Worktree `/root/poly-shadow-comparison-ready-v2`, branch `feat/comparison-ready-instrumentation-v2`, HEAD `ed64333e09827a55bed90f52815ed4b17e78f078`. The completed review preceding **that existing checkpoint** and its **483 TypeScript / 28 files; 199 Python discovered / 146 passed / 53 skipped** are historical checkpoint evidence, not review of these dirty edits.

This pass changes docs/tests only. Existing edits were inspected and preserved; four observer-startup regression cases close the previous wiring-inspection-only gap. No scientific implementation, source definition, cohort, matching, threshold, exclusion or timing rule changed. Instrumentation implementation acceptance is not scientific comparison readiness, capacity approval, production installation or launch permission. REST coverage remains UNKNOWN_UNPROVEN. No production secrets, existing containers, production database, deployment, scheduler, provider, live trading, experiment, merge or PR action was used.

## Fresh execution evidence

**C/** below means `/root/.hermes/cache/scratch/final-readiness-current/completed-final-pass/`; **M/** means `/root/.hermes/cache/scratch/final-readiness-current/mobile/`. C results were newly executed after the final test repair, not reused earlier logs. Native source/test hashes are retained in C/source-hashes.json; final test hashes and every broad/focused command and exit are in C/validation-exits.json. Native fixture inspection, commands, individual exits and cleanup are in C/native-orchestration.log, C/native-exits.json, C/{epoch,drain,timestamp}-inspect.json and C/cleanup.json. Test totals overlap and must not be added.

| Execution | Fresh evidence | Actual result |
|---|---|---|
| Native PostgreSQL fence/capture/restart/drain/archive/comparator, `python3 -B -m unittest discover -s tests -p poly2_fence_postgres_test.py -v` | C/native-fence.log | 23 passed, zero skips; 21 PostgreSQL-dependent cases plus 2 disk-only roster cases; exit 0 |
| Native fixed-ID drain, same command with `poly2_drain_postgres_test.py` | C/native-drain.log; C/native-four-instance.log | **18 passed**, zero skips; new four-instance test also passed independently (1 test, eight negative subcases and four populated successful closures); exits 0 |
| Native timestamp matrix, same command with `poly2_ingestion_clock_postgres_test.py` | C/native-timestamp.log | 4 passed, zero skips; 1 native inserted-row test enumerating 15 clock representations plus 3 parser/source-loading cases; exit 0 |
| Actual SQLAlchemy AsyncSession + asyncpg, copied exact current scripts/test, installed-image dependency runtime, Unix socket inside owned fixture | C/native-session.log; C/session-imports.log | 6 passed, zero skips; exit 0 |
| `node --import tsx tests/poly2_fence_e2e.ts C/native-session-seal.json` | C/native-array-replay.log | IDs [1,2], primary 2, original late decision clocks, normalized null, 15 negative replay checks; exit 0 |
| `node --import tsx tests/poly2_fence_file_e2e.ts C/native-file-journals` | C/native-file-replay.log | FILE_JOURNALS, same IDs/clocks/manifest, primary 2, 10 negative replay checks; exit 0 |
| `npx vitest run` operational-evidence, operational-sink-failure, runtime-health, instrumentation-v2, runtime-blockers, poly2-ingestion-clock-contract, rest-pagination, bounded-memory, pending-replay, watcher; `--reporter=verbose` | C/focused-ts.log | **299 passed / 10 files**, exit 0, including four new observer-startup cases |
| `npm test -- --reporter=verbose` | C/full-ts.log | **492 passed / 28 files**, exit 0 |
| `python3 -B -m unittest discover -s tests -p '*.py' -v` | C/full-python.log | **200 discovered / 146 executed successfully / 54 skipped**, exit 0; fixture-disabled discovery skips are not native proof |
| `python3 -B -m unittest discover -s tests -p storage_budget_test.py -v` | C/storage.log | 5 passed; exit 0 |
| Same discovery with `status_publisher_test.py` | C/publisher.log | 5 passed; exit 0 |
| Same discovery with `phase4_runner_lifecycle.py` | C/runner-lifecycle.log | 38 passed; exit 0 |
| Same discovery with `status_instrumentation_test.py` | C/status-instrumentation.log | 8 passed, zero skips; exit 0 |
| `npx vitest run tests/phase4-compare.test.ts tests/phase4-runner.test.ts --reporter=verbose` | C/phase4-smoke.log | 19 passed / 2 files; exit 0 |
| `npm run build` | C/build.log | `tsc --noEmit`; exit 0 |
| `npm run safety` | C/safety.log | static safety gate OK, 6 dependencies scanned, src clean; exit 0 |
| Reused successful actual 390px browser render of unchanged `scripts/status/index.html` | M/proof.json; M/{top,quality,poly2,quarantine}.png | viewport 390, scrollWidth 390, overflow []; critical sections previously visually inspected; owned server stopped |
| Scientific frozen-path comparison against `f41f21aaa850fa11b477709ba3b0e00025faf292` | C/scientific-frozen-diff.log | empty diff; exit 0 |

Earlier focused runs (295 before the four startup cases and then 299) are superseded by C/focused-ts.log and C/full-ts.log. The unavailable-stat startup case requires the original error, operational close and zero downstream work; production behavior was not weakened.

The four-instance regression originally failed all four missing-ACK subcases at successful freeze. Inspection found the test had not enabled `SQLAdapter(..., checkpoint=True)`; this—not an empty population alone—prevented native consistency metadata. The repaired fixture admits and commits one actual trade through `TransactionDriver`, persists its same-transaction native witness, restarts with each missing enrollment/ACK, rejects closure and freeze until all declared ACKs exist, and checks duplicate ACK idempotence/conflicting generation rejection. Each missing-ACK case then verifies populated native read-only repeatable-read freeze and legitimate fenced decision-drain completion with immutable audit evidence. No adapter/fence production checks changed. An initial local attempt still omitted the checkpoint flag and failed; `/root/.hermes/cache/scratch/final-readiness-current/completed-final/{native-four-instance.log,cleanup.json}` preserves that failure and successful cleanup. All native suites and both path-based handoffs were subsequently rerun against exact final test bytes in newly owned fixtures, with every C/native-exits.json entry zero; no test/source edit followed.

Historical logs remain preserved but **are not fresh acceptance evidence here**. Earlier 199-Python/488-TS totals predate final additions and are not final proof. Fresh complete results are 200 discovered Python and 492 passing TypeScript, with separate native execution rather than discovery skips.

## A–K acceptance-by-item audit

All TypeScript assertions below in the ten named focused files executed freshly in **299/10**, and the complete suite passed **492/28**. Python/native assertions use the individual executions above; status diagnostics and Phase4 comparison/lifecycle smoke were rerun separately. No discovery skip proves native behavior. Controlled clocks, fault injection, synthetic custody and native database timing have distinct proof boundaries. This audits repository acceptance only, not production installation or scientific launch readiness.

### A — bounded memory, recovery and authority

| Item | Named assertion / proof |
|---|---|
| Bounded dedup, retry, caches, queues and concurrent delivery | `bounded-memory.test.ts`: `durable identity is exact beyond bounded cache horizon, tombstones dominate pending`; `exclusive transitions coalesce repeated ticks at capacity two`; `concurrent delivery spills durably beyond 256 and replays exactly once with original arrival`. |
| Streaming startup and pending-only replay without recurring whole-history arrays | Same file: `all source restart callers stream and source FIRST membership survives cache horizon`; `recovery uses no array evidence views and restart redelivery is duplicate-safe`; `index rebuild yields observable bounded progress and concurrent delivery waits for complete membership`. `pending-replay.test.ts`: `periodic replay examines only two incomplete identities among 12000 terminal rows; tombstones dominate`; `one pass does not chase new pending identities appended during an await`. |
| Bounded RPC parent linkage with visible eviction | `watcher.test.ts`: `bounds RPC retry-parent cache while preserving recent lineage and exposing eviction`. |
| Missing, corrupt and readable semantically stale disposable index rebuild | `operational-evidence.test.ts`: `rebuilds when index is entirely missing and then serves normal queries from the index`; `rejects a readable semantically stale derived index and rebuilds it from NDJSON`; `discards a corrupt index and rebuilds exact indexed state without mutating evidence`; `is idempotent across build then repeated rebuilds without NDJSON mutation`. |
| Malformed/torn authority fails closed without repair | `operational-sink-failure.test.ts`: `startup rejects '%s' in '%s' without repair or stale cache trust`, enumerating torn JSON, missing newline and same-size malformed content across eight streams. `bounded-memory.test.ts`: `rejects oversized physical lines explicitly instead of growing an unbounded string`. |
| Append-only telemetry and bounded derived state | `runtime-blockers.test.ts`: `26h real append-only telemetry and ten-minute audits retain bounded derived state and survive restart`; independently counted disk rows, index restart equality and bounded SQLite/meta state. |

### B — evidence-sink fault matrix and fail-closed lifecycle

| Item | Named assertion / proof |
|---|---|
| Before append, all eight operational streams | `operational-evidence.test.ts`: `fails closed before authoritative %s append without phantom state`, enumerating RPC lineage/recovery, quarantine/resolution, REST receipt, telemetry, audit and tail. Sink-failure file: `real authoritative filesystem append failure is latched and surfaced without another request`. |
| Actual partial/torn writes, each required family | Sink-failure file: `actual torn authoritative write %s (%s) preserves prefix, exact failure, no derived row and refuses restart repair`: initial/retry RPC success/failure; recovery; CHAIN timeout/malformed/reorg; REST HTTP/timeout/parse/publication quarantines; resolution; nonempty/empty/failure receipts; telemetry; audit; tail. These inject partial persistence at the actual write seam, not only corrupt startup fixtures. |
| After append/before index: RPC/recovery/quarantine/resolution | Evidence file: `recovers authoritative %s append after an interrupted derived update`; sink-failure `authority vs index failure retains only the actual RPC outcome`. |
| After append/before index: REST receipts | `runtime-health.test.ts`: `REST health rebuild reflects only committed receipt after after-authoritative-append fault`; before-append companion refuses phantom state. |
| After append/before index: telemetry/audit/tail | `runtime-blockers.test.ts`: `actual %s append survives before-index interruption exactly once; shared sink gates later work`, three streams. Exact original exception identity, BROKEN, immutable surviving bytes, two complete rows, zero later RPC calls, rejected later receipt/quarantine writes and repeated restart counts exactly two. |
| Fatal shared latch blocks requests, inflight publication and post-await continuations | Sink-failure file: `shared broken sink gates every source and already-inflight CHAIN/REST publication`; `REST gates the request after an awaited index preflight yields to a shared sink failure`; `CHAIN scan gates checkpoint/head writes after successful RPC lineage before continuation`; cursor head/ancestor/target continuations and completed-backfill verifier rearming. |
| Initial/periodic telemetry and audit append failure | Sink-failure file: `%s archive failure is fatal with earlier bytes preserved, including initial publication`; `periodic %s archive failure stops publication with earlier archive bytes preserved`. |
| Tail shutdown never publishes false successful terminal state | Sink-failure `tail proof failure always clears timers/socket before surfacing the exact error`; runtime-blockers `terminal tail sink failure stays failclosed and does not publish a successful terminal snapshot`; `actual watcher shutdown publishes terminal tail to real collector even after runtime snapshot becomes stale`. |
| ENOSPC and no END_WINDOW_COMPLETE | `instrumentation-v2.test.ts`: `actual ENOSPC telemetry %s write latches failclosed and never starts later upstream request`, before/torn. Sink-failure `control retirement still runs when both diagnostic channels fail on ENOSPC`. Fresh Python `test_operational_sink_failure_never_completes_window` checks sink-broken-alive, reserved non-success exit without diagnostic and sink-at-end-control: nonzero, EVIDENCE_SINK_FAILURE, FAILED observation, never END_WINDOW_COMPLETE. Stream write-fault tests prove the shared latch; runner tests separately prove lifecycle reduction, not every cross-product spawned process. |
| Ordinary upstream errors remain recoverable | Sink-failure `ordinary upstream HTTP 429 remains recoverable`, HTTP 503 companion, RPC timeout companion. |

### C — whole-run quarantine through the real collector

`runtime-blockers.test.ts::real publisher and Python collector retain every quarantine class and old unresolved counts after index rebuild` runs actual operational writer → publisher → disk snapshot → Python collector, missing-index restart and stale readback. Exact total **1608**, unresolved **6**, recovered **1601**, terminal **1**; additions 5m/1h **1602/1602**; oldest unresolved **10800s**; latest source/class CHAIN/503; class breakdown timeout 1602, 429 1, 503 2, malformed 1, publication 1, reorg 1. CHAIN unresolved quarantine remains source-scoped at 2. Stale counts persist while quality becomes UNKNOWN. This projection fixture is not falsely labeled production fault provenance.

Actual production-boundary regressions execute separately: watcher malformed payload, transient RPC failure/replay and restart; cursor-hash mismatch/common ancestor/tombstones and `null then a real hash mismatch still tombstones as a reorg`; REST truthful 429/503 and thrown Error/SyntaxError receipts and exact publication recovery. `real OrdersMatched mismatch with null RPC ID reaches CHAIN health from whole-run source quarantine` keeps a real mismatch behind 1601 resolved facts; the REST-only companion proves source isolation and distinct RPC labeling.

Instrumentation `resolution idempotence rejects conflicts and unknown IDs without changing whole-run aggregates or authority` and `whole-run operational projection retains old unresolved failures behind large history and rebuilds identical counters` prove 1604 total / 1 unresolved / 1601 recovered / 2 terminal / 2 ambiguous. Absent ambiguity in the collector fixture stays unknown.

### D — both REST sources, sticky uncertainty

`rest-pagination.test.ts` executes REST_TRADES and REST_ACTIVITY `capped100 continuation, exact overlap and linked complete receipts stay UNPROVEN`; default wiring retains one-page acquisition. Missing overlap, moving/empty companions, activity offset cap and request-budget exhaustion stop traversal without fabricated coverage. Budget failure remains durable through empty later pages/restart.

Named receipt cases include truthful 429/503, nonarray/null/empty, thrown Error/SyntaxError, body-read timeout retaining status/cache metadata and malformed items. `publication failure receipt links quarantine; only later exact committed identity resolves it` and restart-repaired publication preserve first clocks; unrelated empty success is not recovery.

Instrumentation `per-source REST summaries retain sticky cap/cursor/completeness/publication uncertainty across short success and semantic-cache rebuild`; runtime-health `shared runtime publisher retains indexed REST page-limit and unproven completeness across later polls and restart`; `actual REST poll receipts feed shared runtime health for both sources without completeness inference` prove the real reader composition. Returned-page traversal is not upstream/cross-poll coverage. UNKNOWN_UNPROVEN remains sticky; offset acquisition remains disabled by default.

### E — exact inclusive timestamps and retained originals

Fresh native `test_inserted_native_rows_sql_python_capture_ts_identical` executes **15 actual inserted representations** through PostgreSQL SQL → Python capture → Shadow export → archive seal/replay → actual TypeScript comparator. All six boundaries agree: start−1µs excluded, start included, start+1µs included, end−1µs included, end included, end+1µs excluded. Equivalent optional/millisecond/microsecond end strings, positive/negative offsets, offset start+1µs/end+1µs, one-digit fraction and maximal accepted ±15:59 offsets are enumerated in C/native-timestamp.log. Original strings and decimal integer microseconds survive archive evidence, including excluded cases.

`poly2-ingestion-clock-contract.test.ts` covers the six endpoints, old counterexamples, representation invariance, malformed calendar/zone/precision/whitespace rejection, one-microsecond freshness and `Shadow exact earliest arrival/completion and submillisecond latency retain originals`. Native parser/source-loading companions also execute. The previously authorized timestamp amendment is already in the frozen Phase4 baseline; this pass introduces no scientific timing change.

### F — declared writers, population, fixed-ID drain and handoff

| Item | Named native/offline proof |
|---|---|
| Backend+bot multiple instances, missing roles, malformed/duplicate IDs | Fence `test_only_full_backend_bot_roster_can_arm_and_every_instance_is_explicit`; the bounded-history TS assertion executes in the fresh full suite. |
| Enrollment, every generation ACK, missing ACK, partial restart | Fence `test_dead_worker_no_ack_blocks_even_zero_outstanding`; `test_restart_preserves_partial_writer_enrollment_and_ack_state`; drain `test_four_writer_instances_each_missing_enrollment_or_ack_blocks_restart_closure`: backend:one/backend:two/bot:one/bot:two each absent enrollment and each absent ACK through restart; all eight block closure/freeze; each ACK repair reaches populated native freeze and completed fenced drain. Missing-enrollment cases are disk roster proof; missing-ACK positive paths execute native transactional witnesses and SQL. |
| Duplicate ACK idempotence and conflicting generation rejection | Fence `test_identical_generation_ack_is_idempotent_conflict_is_visible_and_closure_requires_both`; `test_restart_duplicate_ack_and_recover_are_idempotent`. |
| Held/delayed transaction, concurrent closure, post-fence transactions | Fence `test_held_A_fast_B_postepoch_C_late_decision_seal_compare`; `test_concurrent_admission_close_race_is_serialized_and_restart_stable`; `test_perpetual_postepoch_work_does_not_starve_fence`; `test_postepoch_old_clock_fails_without_redefining_window`. |
| Actual AsyncSession integration | Session `test_real_asyncsession_held_A_B_C_freeze_drain_seal`; outer rollback/new-attempt/future factory; nested parent rollback; unexpected incarnation; admission/witness sink failures preserving source commits: 6 passed using real SQLAlchemy/asyncpg. |
| Producer restart/unknown outcome/worker death/witness loss | Native fence commit-crash witness recovery, worker death/unknown outcome, witness-sink failure, source row mismatch and unenrolled old-clock tests. Unproven closure blocks capture sealing, not source/trading availability. |
| Fixed population and per-ID decision drain | Drain A all-before-end, B/C late/multiple-late original clocks, F restart/idempotence, G excluded IDs, H duplicate query, I decision conflict; E pending timeout and D no fabricated terminal; native delayed-commit and repeatable-read/later-transaction counterexamples preserve population-admission distinctions. 18 passed, zero skips. |
| Immutable unique DecisionLogEntry provenance, original PaperOrder clock | Fence `test_decision_requires_exact_source_audit_linkage_and_captures_it`; `test_duplicate_initial_order_rejected_no_earliest_hindsight`; `test_decision_restart_duplicates_conflict_and_blocking_health`; drain B/F retain original late decision clocks. Required audit inserts repair only the native fixture, not adapter requirements. |
| Restarted disk journals, seal/replay and actual comparator; array parity | Native held-A/B/C emits both NATIVE_FENCE_E2E and NATIVE_FENCE_FILE_E2E. Fresh AsyncSession emits C/native-session-seal.json and C/native-file-journals; independent path-based array/file executables return primary 2, [1,2], original late clocks/null normalized, matching manifests and 15/10 negative checks. |

Declared backend/bot participation is the authorized architecture. Out-of-contract direct SQL/rogue writers are operational violations, not a promise to cryptographically disprove arbitrary writers. Native timing retains synthetic run/custody bindings; it is not production enrollment or installation proof.

### G — evidence quality is not process liveness

Instrumentation `quality %s derives from evidence not process liveness` enumerates GREEN/DEGRADED/AT_RISK/UNKNOWN; `actual indexed source reducer elevates persistent REST failures and remains independent of liveness`. Runtime-health `shared runtime publisher exposes broken sink without querying its closed index`; sink-failure `health explicitly names EVIDENCE_SINK_FAILURE even while process is alive and progress fresh` prevent false GREEN.

Fresh Python status instrumentation suite (8 passed separately and in full discovery) covers stale whole-run counts, sink state separate from dead process, roster/ACK/enrollment, malformed/misbound/symlink diagnostics and drain fields. Even complete diagnostics state DIAGNOSTIC_READY_REQUIRES_ARCHIVE_VALIDATION. Missing/stale evidence remains unknown; fresh terminal-tail collector regression exposes last-known proof after retirement without calling it current health.

### H — five-second telemetry and ten-minute audit over simulated 26h

Fresh runtime-blockers controlled-clock test advances **93,600,000ms** with actual append writers: **18,721** telemetry rows and **157** audit rows including initial samples. Independent streaming count, first/last horizon, rebuild equality, no remaining timers, meta rows <20, quiet-fixture q rows 0, SQLite cache_size −2048 KiB and process RSS/heap/external/cgroup/disk fields are asserted.

Instrumentation governing-cgroup test asserts ancestor usage/limit/high/swap/events, file/kernel and PSI values; its supplied anon/slab/sock values are not each independently asserted. Bounded-memory tests prove actual cgroup composition, queue/cache telemetry and no heap-for-cgroup substitution. Runtime-health cache test proves constant-sized REST aggregate state and geometric digest checkpoints. This proves cadence, authority and bounded derived state under simulated time, **not an elapsed 26h production RSS/cgroup soak**.

### I — authoritative disk budget and startup/runtime gates

Storage plan is unchanged: expected **13,087,152,000**, upper **86,657,126,400**, margin **21,664,281,600**, independent reserve **10,737,418,240**, required startup **119,058,826,240 bytes**. Fresh Python `test_language_parity_24h_drain_and_remaining` executes both language functions at 0/86,400/93,600s across eight families; `test_exact_thresholds` and TS storage gate assert exact threshold, one byte below, reserve floor, below 10GiB AT_RISK and unavailable UNKNOWN.

Fresh Python `test_prelaunch_nearest_parent_and_fail_closed`, `test_runner_gate_before_production_side_effect`, `test_missing_budget_source_fails_as_blocked` prove runner preflight and zero production-adapter/orphan effects on denial.

**New concrete gap repair:** `runtime-blockers.test.ts::actual observer entrypoint startup gates available=%s before scientific stores or sources` executes transpiled **actual current main.ts** in an isolated VM with mocked startup collaborators and the real disk gate. Four values: unavailable stat, 119058826239, 10737418239, and exact 119058826240. Denials close operational evidence, set non-success and reach no scientific store/source; exact boundary reaches only a deliberate scientific-store sentinel. The required value is independently asserted numerically. This is actual entrypoint control-flow with mock collaborators, not a real observer/provider launch or an observed free-space claim. No installed automatic deletion/shutdown policy is implied by runtime diagnostic thresholds. Actual ENOSPC is covered in B; no evidence deletion, rotation or budget change occurred.

### J — persistent independent publisher, >1500 cycles

Fresh publisher suite **5 passed**: `test_horizon_unlimited_24h_plus_drain` at 1/60/120s, no exhaustion; `test_more_than_1500_real_atomic_cycles_restart_failure_recovery` performs **1562** atomic writes, preserves public bytes on failure, records collector failure, restarts at 1564 and succeeds at 1565 with failures 2/consecutive 0/exact UTCs; `test_real_collector_independent_missing_observer_pointer` publishes NO_ACTIVE_RUN without retirement; `test_fixed_loop_skips_missed_slots_and_stops_only_by_signal` exercises **1601** attempts; invalid cadence is rejected.

Instrumentation `full-run telemetry cadence survives over 1500 cycles and archives during snapshot failure without finite lifecycle` retains 18,721 cycles despite mutable publication failure then recovers. Service example is uninstalled; production scheduler untouched.

### K — successful current 390px real render, reused unchanged

Reused M/proof.json records **390px** viewport and document scroll width, overflow **[]**, AT_RISK · EVIDENCE_SINK_FAILURE, BROKEN, advancing client-side stale warning, whole-run quarantine and four-instance Poly2 roster with two missing ACKs. Current screenshots top/quality/poly2/quarantine were visually inspected in the preceding worker: critical sink/stale warnings, wrapped roster/UNKNOWN_UNPROVEN closure and old quarantine/class counts are readable without horizontal clipping. Synthetic fixture values are explicitly labeled; unsupported telemetry stays unknown. HTML has not changed in this repair, so that successful current render is reused, not represented as a new browser session or live protected-run status. The owned loopback server was stopped; preceding readback connection refused (curl exit 7); browser navigated away to about:blank. No production page was published.

## Scientific drift and inventory

`git diff --exit-code f41f21aaa850fa11b477709ba3b0e00025faf292 -- src/compare scripts/poly2* docs/shadow/PHASE4*` plus source config/constants/decoder/decimal/reconcile/rest-poller/watcher/storage/racing paths returned 0 (C/scientific-frozen-diff.log). Operational entrypoint changes from that baseline are pre-existing checkpoint disk gating/telemetry/shutdown integration, not new changes in this pass. Frozen comparator/source/cohort/threshold/timing semantics remain unchanged; no real experiment result is asserted.

Exactly four intended non-cache paths remain unstaged relative to checkpoint HEAD:

1. `docs/shadow/FINAL_INTEGRATED_READINESS.md` — accurate current evidence/matrix and completed independent-review boundary.
2. `docs/shadow/PHASE5_7_VALIDATION_REPORT.md` — historical checkpoint versus completed readiness review.
3. `tests/poly2_drain_postgres_test.py` — inherited fixture reset/immutable original-decision audit inserts plus four-instance restart enrollment/ACK negatives and populated native successful freeze/drain regression.
4. `tests/runtime-blockers.test.ts` — inherited collector/26h/after-append regressions plus four actual entrypoint startup cases.

Protected untracked `scripts/__pycache__/`, `scripts/status/__pycache__/`, `tests/__pycache__/` remain preserved. Preservation patch: `/root/.hermes/cache/scratch/final-readiness-current-preserved.patch`. The inventory was unstaged at validation and initial independent-review time. Review returned PASS; publication requires unchanged reviewed bytes, a staged scope check and exact remote SHA readback. Full-suite execution has completed above.

## Owned fixtures and verified cleanup

The successful final run used these **newly created** network-none/tmpfs PostgreSQL fixtures (the failed intermediate attempt's separately owned cleanup is also recorded below):

| Name | Verified full ID |
|---|---|
| poly-shadow-completed-final-pass-epoch | 3de65866ce5daac755ef8fb7163fdc7e0ba2b22175aa94c2081ed82f909d31ef |
| poly-shadow-completed-final-pass-drain | 14d43603abdb45e923e6eb7282a9ae6f8a7936fde91ca8144f08a03b9390c953 |
| poly-shadow-completed-final-pass-timestamp | 7a29417ebf3b99642ad0f5f62dc97f7f89caa7a361e2aca360f969f5faaaa2a8 |

Each had its own exact `poly-shadow-owner=completed-final-pass-{epoch,drain,timestamp}` label; inspected full ID/name, network none, tmpfs PGDATA 256MiB, no bind mounts, no published ports and empty listen_addresses. Epoch/drain schemas and restricted readers were provisioned and smoke-tested; reader writes were denied. Timestamp suite provisions its own schema and also asserts denied reader write. The AsyncSession dependency runtime was copied, not mounted; test/scripts were copied freshly from current repository source, not earlier fixture source. The failed intermediate attempt also created three new owned fixtures, removed in finally: epoch `1637c3cfdfa1aa624ba3200c71586c79517b41fa16036df1674c9dd600131777`, drain `848d58cd8869b41fe22ac438a5af64de1b983b9302f9e8bdcf2d8fd2c17c1396`, timestamp `dff010c592d8c65c8448e54999f9b3163acb6a750f2b760d15d281e113cecf01`; their exact names/labels/verified cleanup are retained in the sibling completed-final/cleanup.json. No preexisting fixture was reused.

The native tests retain historical fixture-name guards. A scratch docker transport shim maps **only** those three hard-coded test aliases to the freshly verified owned full IDs. The shim does not rewrite tested source bytes, and no old alias container was executed against. The wrapper rejects unowned exec targets. Existing containers, including the three older Phase4 fixtures and production poly2, were never operated on.

Before cleanup each full ID/owner was reverified; removal used those IDs only, exit 0. Exact-name/owner-label inventories were empty afterwards and full-ID inspect returned expected absence exit 1. C/cleanup.json records cleanupVerified=true for all three; C/native-orchestration.log records the individual removal/readback exits. Historical fixtures and pycache remain protected. Full browser-daemon retirement is not claimed; the owned HTTP listener is gone and the current page is about:blank.
