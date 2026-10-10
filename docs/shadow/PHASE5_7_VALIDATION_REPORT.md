# Phases 5–7 final reconciliation / validation report

## Verdict

**READY_FOR_REREVIEW — independent review pending.** Both rereview blockers are corrected and fresh direct-tool validation passed: `npm test` **483/483 tests in 28 files**; `python3 -m unittest discover -s tests -p '*.py' -v` **199 discovered, 146 executed successfully, 53 skipped**. `npm run build`, `npm run safety` and `git diff --check` passed. Phase 4 smoke reruns: **19 TypeScript tests / 38 Python lifecycle tests passed**. Five new concrete blocker regressions passed independently and in the full TS suite. These totals supersede the pre-correction 478-test TS baseline below. Native PostgreSQL skips are not native proof. Earlier browser artifacts are unchanged historical dashboard proof, not a new render. No commit/push; fresh independent review remains required.

### Blocker correction and actual proof

- `OperationalEvidence.unresolvedQuarantineCount(source)` queries the whole-run validated index with exact source scope and resolution state. The CHAIN projection now exposes `unresolvedQuarantine` separately from existing unresolved RPC count `unresolved`; CHAIN health consumes both via distinct quarantine/RPC rules. The bounded collector retains both counts.
- `runtime-blockers.test.ts` exercises the actual watcher with mismatched OrderFilled/OrdersMatched ABI logs, verifies `rpcRequestId:null`, preserves the early unresolved mismatch behind 1,601 later resolved rows, and checks CHAIN degradation and exact terminal resolution. A separate REST-only case proves source isolation and a failed RPC proves distinct RPC labeling.
- Signal shutdown now calls `memoryPublisher.finish(...)`: clear cadence, stop source pollers and watcher (which appends terminal tail), make one synchronous final snapshot/archive attempt, then retire publisher before exit. Existing sink-failure exit 74 and control diagnostics remain unchanged; fatal archive errors do not publish successful terminal state.
- The shutdown regression invokes the real watcher stop, actual publisher and actual Python `operational_status` collector. It verifies the on-disk final projection equals the appended tail proof, remains readable as last-known evidence after 60 seconds while quality is stale/UNKNOWN, and makes zero upstream calls or newly armed timers. Mutable snapshot ENOSPC makes exactly one final attempt without retries. A fault at the actual tail-proof append boundary stays failclosed and preserves the prior snapshot bytes.
- An existing runtime-health exact-rule assertion was updated to require the newly correct `CHAIN: unresolved quarantine count >= 10` rule and source-level AT_RISK state. The first full TS run exposed that stale expectation (482 pass / 1 fail); after correction, the complete rerun passed 483/483.
- Validation was performed through ordinary direct terminal calls. A compound logging/readback command received `pending_approval` for its embedded `python3 -c` and was not executed or counted. No approval denial was returned. Ordinary requested test/build commands executed successfully; no tool-dispatch wrapper was used.

Current pass modifies only operational health/publisher/shutdown/collector code, the existing runtime-health regression, this report, and adds `tests/runtime-blockers.test.ts`. Frozen comparator and native capture/fence/drain/archive files are untouched by this correction.

## Identity and safety boundary

- Worktree: `/root/poly-shadow-comparison-ready-v2`.
- Branch: `feat/comparison-ready-instrumentation-v2`.
- HEAD remains `f41f21aaa850fa11b477709ba3b0e00025faf292`.
- Merge base with local `origin/main`: `f0296c9e0fa1a36c2a0d369021a5bbd8a8b5f477` (no fetch performed).
- All inherited dirty edits and baseline `__pycache__` paths preserved. Nothing staged, committed, pushed, merged, deployed or launched.
- No production configuration, scheduler, service, database, provider, trading or protected-run write. `/opt/poly-shadow` and its runs remain outside write scope.
- Tracked diff contains only runner/status/operational instrumentation and their tests. No shared native capture/fence/drain/archive scientific implementation or frozen comparator was altered; no new native PostgreSQL run is required by this pass. Existing skipped native tests are not native acceptance evidence.
- Binary tracked-diff preservation: `/root/.hermes/cache/scratch/phase5-7-reconciled-preserved.patch`, SHA-256 `fc820b348814ddfd2e5a39587c2127909d73d70b9a540ce5b1903c363511fbff` (captured before this report, which is untracked).

## Last reconciliation

`tests/status_instrumentation_test.py` now supplies `expectedWorkers=['backend:one','bot:one']` inside the hashed synthetic binding, matching the production diagnostic roster validation rather than weakening that validation. Executed:

```text
python3 -m unittest discover -s tests -p status_instrumentation_test.py -v
Ran 8 tests in 0.121s
OK
exit status 0
```

The test cases cover bound enrollment/ACK/population/drain, each missing ACK and enrollment, adversarial roster/ACK shapes, invalid drain fields, duplicate/nonfinite/oversize/symlink/misbound diagnostics, enrollment symlink/wrong binding, full-run stale quality and independent sink failure, and real collector disk projection without raw CHAIN reads.

`git diff --check` subsequently passed and was repeated after documentation writes with exit 0; final log: `/root/.hermes/cache/scratch/phase5-7-reconciled-diff.log` (empty success output). Staged path set was empty and branch/HEAD unchanged. This checks tracked edits only, not all untracked file whitespace.

## Acceptance reconciliation

The authoritative file/test mapping remains `PHASE5_7_ACCEPTANCE_MATRIX.md`, supplemented by the concrete blocker regressions above. Fresh broad validation passed; independent rereview is pending.

| Acceptance cluster | Reconciled implementation / proof boundary |
|---|---|
| Whole-run quarantine | Indexed whole-run SQL iteration retains early unresolved failures beyond 1,600 later facts; separate idempotent resolutions, terminal ambiguity, 5m/1h additions, oldest age, source/class and fixed class breakdown; missing-index restart equivalence is tested. Not inferred from a bounded tail. |
| CHAIN/RPC | Last request/success/progress, request/retry/unresolved totals, oldest age, recovery and terminal tail projected; semantic cache rebuild and missing cache covered in instrumentation/index regressions. |
| REST sources | Independently keyed receipts/summaries, success/failure streaks and sticky cap/cursor/publication/completeness uncertainty. Short successful traversal does not upgrade cross-poll `UNKNOWN_UNPROVEN`. |
| Quality versus liveness | GREEN/DEGRADED/AT_RISK/UNKNOWN use evidence, progress/staleness and sink state; liveness is a separate field. Sink failure remains AT_RISK after retirement or stale publication. Real runtime composition and collector projection tests exist. |
| Poly2 diagnostics | Bound roster includes backend and bot instances; read-only enrollment query, generation ACKs, frozen population/watermark, outstanding transactions, pending drain and last reconciliation are displayed. Synthetic final suite passes. Diagnostic readiness explicitly requires independent archive validation; cached diagnostics are not sealing authority. |
| Full-run telemetry | Authoritative append every 5s plus ten-minute audits, with bounded indexed aggregates; process/heap/external memory, governing cgroup usage/limit/high/swap/events, anon/file/kernel/slab/sock, PSI stall metrics, queues/caches/indexes, request lineage and stat-only storage. Tests simulate 93,600s and 18,721 samples, not a real elapsed production soak. |
| Storage | Eight-family expected/upper envelope, 25% margin, independent 10 GiB reserve, runner and observer startup gate, remaining-horizon runtime states, actual before/torn ENOSPC fail-closed tests. See `STORAGE_BUDGET_V2.md`; assumptions are engineering allowances, not observed source traffic. Runtime thresholds are diagnostics, not a deployed shutdown policy. |
| Independent publisher | Persistent loop without repetition limit, external status/cache state, atomic public writes, failure/recovery/restart tests, 1,562 publication cycles plus failures/restart and 1,601 loop iterations; missing observer/current pointer does not retire publication. Service example is uninstalled. |
| Mobile and staleness | Final HTML rendered in real browser at 390px; document scroll width 390px. Critical stale warning and EVIDENCE_SINK_FAILURE remain readable. Advancing client clock changes warning from 181s to 186s without a fresh snapshot; no horizontal overflow. |
| Full validation / Phase 4 | Fresh direct-tool full TS (483 in 28 files), Python (199 discovered / 146 executed / 53 skipped), build, safety and diff gates passed; Phase 4 reruns passed (19 TS / 38 Python). Independent rereview remains a separate gate. |

## Finite scheduler root cause (read-only observation)

The actual `/root/.hermes/cron/jobs.json` entry `623fe451901f` names `poly-shadow-live-status.py`, interval `minutes: 1`, repeat `times: 1500`, `completed: 1500`, `enabled: false`, `state: completed`, and `next_run_at: null`. Its last recorded run was `2026-10-08T12:00:06.158073+00:00`, with `last_status: ok` and no last error. This is evidence of finite repetition exhaustion, not an inference from the dashboard's 20s refresh interval. The scheduler artifact was not changed. Repository publisher replacement does not mean production installation occurred.

## Real browser artifacts

Final artifacts (synthetic operational fixture, not a protected-run snapshot):

- `/root/.hermes/cache/scratch/phase5-7-reconciled-mobile/proof.json`.
- `/root/.hermes/cache/scratch/phase5-7-reconciled-mobile/top.png`.
- `/root/.hermes/cache/scratch/phase5-7-reconciled-mobile/quality.png`.
- `/root/.hermes/cache/scratch/phase5-7-reconciled-mobile/telemetry.png`.

Screenshots were visually inspected. Values absent from the synthetic fixture remain `unknown`, not fabricated telemetry. Long quality identifiers wrap within their row; critical banner and new telemetry labels are visible without horizontal clipping.

## Prior green baseline — explicitly not final validation

Preserved logs were read directly. They precede the final diagnostic schema/binding reconciliation:

| Log | Recorded outcome |
|---|---|
| `/root/.hermes/cache/scratch/phase5-7-ts-final.log` | 27 test files, 478 tests passed. |
| `/root/.hermes/cache/scratch/phase5-7-python-final.log` | 161 discovered, 108 executed, 53 skipped; OK. Native tests skipped; SQLite ResourceWarnings also appear. |
| `/root/.hermes/cache/scratch/phase5-7-focused.log` | 3 files, 131 tests passed. |
| `/root/.hermes/cache/scratch/phase5-7-build-final.log` | `tsc --noEmit`, prior worker reported exit 0. |
| `/root/.hermes/cache/scratch/phase5-7-safety-final.log` | `static safety gate: OK (6 deps scanned, src/ clean)`. |

## Superseded blocked batch — historical record

The earlier parallel execution request was intercepted before any tool call ran (`tool_calls_made: 0`). It was not counted as success. Parent-controlled execution subsequently completed the gates listed in the verdict; the following inventory records the earlier planned commands only:

| Command | Intended log (not yet produced by this pass) |
|---|---|
| `npm test` | `/root/.hermes/cache/scratch/phase5-7-reconciled-ts.log` |
| `python3 -m unittest discover -s tests -p '*.py' -v` | `/root/.hermes/cache/scratch/phase5-7-reconciled-python.log` |
| `npm run build` | `/root/.hermes/cache/scratch/phase5-7-reconciled-build.log` |
| `npm run safety` | `/root/.hermes/cache/scratch/phase5-7-reconciled-safety.log` |
| `npx vitest run tests/phase4-compare.test.ts tests/phase4-runner.test.ts` | `/root/.hermes/cache/scratch/phase5-7-reconciled-phase4-ts.log` |
| `python3 -m unittest discover -s tests -p phase4_runner_lifecycle.py -v` | `/root/.hermes/cache/scratch/phase5-7-reconciled-phase4-python.log` |

## Remaining boundaries

1. Final validation has passed as recorded above. Independent review must complete against the final inventory before staging or committing.
2. Independent review has not occurred. No final integrated fault matrix is claimed.
3. Production installation/enrollment, live source coverage, observed traffic sizing and an actual 24h soak are not authorized or claimed. REST coverage and missing source-closure/archive proof remain UNKNOWN_UNPROVEN where appropriate, not scientific readiness.
