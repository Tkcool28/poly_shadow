# Phase 2 — operational sink failure acceptance matrix

## Contract and scope

An authoritative operational append failure or derived-index update failure latches the shared `OperationalEvidence` instance **BROKEN**. The first exception is retained and rethrown exactly; it is not relabeled as a provider failure. CHAIN, REST_TRADES and REST_ACTIVITY subscribe to the shared latch and stop their source timers/socket. Entry points and post-await request/publication boundaries also gate on that latch, including responses already in flight. No automatic reopen/recovery is permitted on that instance.

The scientific authority remains the existing append-only evidence. Existing cohort, comparator, window, source identity, matching and timing rules are unchanged. SQLite remains a disposable cache with `journal_mode=OFF` and `synchronous=OFF`.

`operational-failure.json` is a create-only, control-plane diagnostic, **not** scientific authority, a receipt, or recovery proof. It contains the original failure and `EVIDENCE_SINK_FAILURE`/`AT_RISK` state with the runtime process token. The status collector exposes only the narrow sink fields after verifying runtime identity, and overrides an earlier GREEN snapshot. An irreversible broken state is retained even if that verified token's diagnostic becomes stale.

Both the diagnostic file and stderr can fail on ENOSPC. Neither is guaranteed durable. Source retirement is independent of those writes; the entrypoint reserves exit **74** for an operational sink failure (including failed startup validation). The lifecycle runner checks the control marker before window completion and again after cleanup, and recognizes exit 74 when no marker could be written. Malformed/partial control markers cannot authorize success. Report persistence itself can also fail; no claim is made that a terminal report always survives a full filesystem.

A successful authoritative append followed by failed indexing is different from a failed authoritative append: restart reconstructs only facts actually appended. Missing RPC recovery or quarantine resolution records remain unresolved. Malformed/torn/missing-newline authority is checked before trusting or modifying the cache; startup fails visibly without repairing the source bytes.

## Deterministic regressions

Unless otherwise noted, test names below are in `tests/operational-sink-failure.test.ts`. Authoritative failures use `OperationalEvidenceOptions.write`, which either throws before writing or writes a 17-byte partial prefix then throws the exact exception. The existing `fault` hook separately exercises after-authoritative-append/index interruptions. All stores are disposable local fixtures, and all CHAIN/REST requests are mocked. One test also exercises a real filesystem append failure (`EISDIR`), without exhausting disk space.

| Acceptance item | Exact named regression / matrix | Assertion |
|---|---|---|
| Initial RPC lineage append fails on success/failure | `rpc_lineage initial write failure surfaces exact error (upstreamFails=%s)` | Original exception identity, no lineage bytes, BROKEN and no second request |
| Retry lineage append fails on success/failure | `rpc_lineage retry write failure never resolves failed request (upstreamFails=%s)` | Earlier failure bytes unchanged; failed request still unresolved on restart |
| RPC recovery append fails | `rpc_recoveries write failure preserves successful lineage but leaves failure unresolved on restart` | Failed and successful lineage each appear once; no recovery or contradictory failure |
| Authority succeeded / derived update failed vs authority failed | `authority vs index failure retains only the actual RPC outcome (%s)` | Restart trusts successful append only in the after-append case |
| Quarantine resolution fails | `resolution write failure remains unresolved after restart without false terminal/recovered state` | No phantom resolution, original quarantine bytes preserved |
| CHAIN timeout/malformed/reorg quarantine append fails | `CHAIN %s quarantine write failure stops before recovery or publication` | All three paths stop; no observation/publication/retry/recovery after latch |
| CHAIN terminal resolution fails | `CHAIN terminal resolution failure does not publish a terminal disposition` | No terminal completion; quarantine unresolved after restart |
| CHAIN recovered resolution fails | `CHAIN recovered-resolution write failure preserves earlier publication but leaves canonical disposition pending and quarantine unresolved on restart` | Earlier successful source publication is retained; failed resolution leaves PENDING disposition and unresolved quarantine on restart. No publication occurs after the latch. |
| Recovery waits for downstream success | `CHAIN failed downstream publication never resolves quarantine before successful canonical replay (breakSink=%s)` | Failed racer publication cannot create RECOVERED; canonical replay resolves only after successful publication. A simultaneous sink break retains its exact error and PENDING stage. |
| REST HTTP/timeout/parse/publication quarantine append fails | `REST %s quarantine write failure gates later polls` | Original sink exception, no successful receipt and no second fetch |
| Both REST source timer wrappers on quarantine failure | `%s timer stops when upstream-failure quarantine itself cannot append` | REST_TRADES and REST_ACTIVITY stop their timers without further requests or receipts |
| REST nonempty/empty/failed-poll receipt append fails | `REST %s receipt write failure stops the actual timer wrapper` | Timer wrapper consumes rejection only after BROKEN notification; no further fetches/restart |
| Telemetry/audit initial archive failure | `%s archive failure is fatal with earlier bytes preserved, including initial publication` | Controlled fatal callback receives original exception, no timer, previous archive bytes retained |
| Telemetry/audit periodic archive failure | `periodic %s archive failure stops publication with earlier archive bytes preserved` | Same contract on actual five-second publisher timer |
| Tail proof append fails | `tail proof failure always clears timers/socket before surfacing the exact error` | Cleanup occurs before append, old bytes retained and subsequent stop is safe |
| All sources / in-flight CHAIN and REST gate | `shared broken sink gates every source and already-inflight CHAIN/REST publication` | Both REST source entries and CHAIN gate; in-flight responses produce no later publication |
| REST async index-preflight race | `REST gates the request after an awaited index preflight yields to a shared sink failure` | No fetch begins after another source breaks the sink during preflight |
| REST streaming recovery before source publication | `REST startup recovery gates authoritative publication after a shared failure during streaming preflight` | Disposable index recovery can never append source/membership bytes after the sink latch |
| REST interrupted source/membership recovery | `REST recovery retains its earlier authoritative source append but stops the next membership publication after sink failure` | Earlier source bytes survive; the next membership append gates on the shared sink |
| CHAIN callbacks/reconnect cleanup | `CHAIN callback failure clears heartbeat/verifier/reconnect without recursive quarantine or tail writes` | Every source timer is cleared, no recursive append on broken sink |
| Ordinary upstream failures remain recoverable | `ordinary upstream %s remains recoverable` | 429/503/timeout RPC and REST failures can recover with usable sink |
| Diagnostics can both fail | `control retirement still runs when both diagnostic channels fail on ENOSPC` | Retirement still occurs once; exact sink failure is retained |
| Health is not liveness/GREEN | `health explicitly names EVIDENCE_SINK_FAILURE even while process is alive and progress fresh` | AT_RISK with explicit failure rule |
| Real filesystem write failure | `real authoritative filesystem append failure is latched and surfaced without another request` | EISDIR is visible and gates subsequent RPC |
| Actual torn authoritative writes, all eight families | `actual torn authoritative write %s (%s) preserves prefix, exact failure, no derived row and refuses restart repair` | Nineteen named paths cover initial/retry success/failure lineage, recovery, CHAIN timeout/malformed/reorg, REST HTTP/timeout/parse/publication, resolution, nonempty/empty/failure receipts, telemetry/audit/tail. Exactly 17 partial bytes remain; no failed-family `apply`, no later source bytes or calls, cache/source bytes unchanged by rejected restart. |
| Pending provider-lag timers cease | `CHAIN shared sink break cancels already-scheduled %s provider lag timer with exact error` | Null-block and invalid-range waits are canceled immediately without changing ordinary lag budgets; no subsequent RPC or recursive quarantine. |
| Publisher's quarantine reporter breaks | `publisher %s snapshot failure with broken quarantine reporter retires without rearming a timer` | Initial and periodic snapshot failure paths retain exact sink error and cannot install/reinstall publisher intervals. |
| No recursive quarantine on publication race | `%s broken sink during publication is not recursively quarantined and retains exact original failure` | Both REST sources preserve original error when downstream throws a secondary exception; no quarantine attempt or receipt. |
| Torn/truncated/malformed last rows, including same-sized cache marker | `startup rejects $kind in $name without repair or stale cache trust` | Eight authority files × torn JSON / missing final newline / same-size malformed JSON; source and cache bytes unchanged on refusal |
| Verified status control overrides earlier GREEN | `MemoryTests.test_sink_failure_control_overrides_green_while_process_alive` in `tests/status_memory_test.py` | Fresh/stale diagnostics, process alive, explicit failure, narrow field whitelist |
| Run end never becomes END_WINDOW_COMPLETE after sink failure | `Lifecycle.test_operational_sink_failure_never_completes_window` in `tests/phase4_runner_lifecycle.py` | Isolated dummy alive+marker, exit74+no marker, and late partial marker after cleanup all produce EVIDENCE_SINK_FAILURE and failed observation phase |

### Runtime health and retired-observer status integration

The entrypoint and `tests/runtime-health.test.ts` share `runtimeHealthSnapshot`, exercised through the real memory publisher. The narrow `failureClass` distinguishes `EVIDENCE_SINK_FAILURE` from `SOURCE_FAILURE` (unresolved source quarantine/recovery); successful resolution clears only the latter. Quarantine health comes from the indexed whole-run unresolved count, not bounded tails. REST health uses a single derived aggregate row rebuilt from immutable poll receipts: an earlier page limit remains visible after later shorter polls, and completeness remains unproven because the current REST contract supports no pagination/overlap proof. These operational flags do not alter source or comparator rules. Broken sinks skip closed-index queries and remain explicitly AT_RISK.

The disposable index schema is version 4. The REST aggregate participates in cache semantic validation. Digests stream indexed rows with bounded retained state; geometric cache checkpoints avoid quadratic recurring whole-index digest work. Clean close still seals the cache; an interrupted checkpoint causes restart to rebuild from unchanged authority.

| Acceptance item | Exact named regression | Assertion |
|---|---|---|
| Persisted quarantine runtime integration | `shared runtime publisher uses persisted unresolved quarantine and resolution counts after rebuild` | Ten old unresolved rows yield AT_RISK; indexed resolutions remove that risk |
| Whole-run REST limits/completeness | `shared runtime publisher retains indexed REST page-limit and unproven completeness across later polls and restart` | Earlier limit survives later receipts and missing-cache rebuild; DEGRADED, not GREEN |
| Actual REST poller receipt integration | `actual REST poll receipts feed shared runtime health for both sources without completeness inference` | Both real pollers with mocked empty responses feed the shared published health |
| Bounded aggregate and digest cost | `REST health cache remains constant size and digest checkpoints grow geometrically` | One cache row after 2048 receipts; at most five streamed digest checkpoints |
| REST aggregate append interruption | `REST health rebuild reflects only committed receipt after %s fault` | Before/after authoritative append faults reconstruct only committed flags |
| Semantic cache validation | `REST health semantic cache corruption is discarded without changing authoritative receipts` | False cached flags are rejected and rebuilt; source bytes unchanged |
| Closed-index health | `shared runtime publisher exposes broken sink without querying its closed index` | Explicit sink-failure AT_RISK snapshot remains publishable |
| Committed receipt after observer retirement | `BindingTests.test_committed_sink_failure_survives_observer_exit_without_live_control` in `tests/status_binding_test.py` | Real runner report publisher's verified committed receipt retains EVIDENCE_SINK_FAILURE classification/reason while live control is unavailable; no lifecycle completion |

Existing `tests/operational-evidence.test.ts` additionally covers interrupted derived updates for quarantine, resolution, RPC and recovery, long-history rebuilds, absent/corrupt/semantically stale caches, idempotent rebuilds and pre-authoritative faults for all eight writers. Its invalid-writer assertion now requires the original injected exception rather than a generic replacement error.

## Validation / safety boundary

Run `npm run build`, the operational evidence/archive/sink regressions and watcher/REST publication suites, Python status and lifecycle tests, and `git diff --check`. Full `npm test` also exercises the existing decoder/storage/source/comparator safety contracts.

Verified in this Phase 2 pass (local existing dependencies, no install):
- `npm run build`: exit 0.
- `npm test`: 20 test files / 319 tests passed.
- `npm test -- tests/operational-sink-failure.test.ts tests/runtime-health.test.ts`: 2 files / 106 tests passed.
- `python -B tests/status_memory_test.py`: 9 passed.
- `python -B tests/status_binding_test.py`: 16 passed.
- `python -B tests/phase4_runner_lifecycle.py`: 38 passed, including `test_operational_sink_failure_never_completes_window`.
- `git diff --check`: exit 0.

Independent review remains the parent agent's gate. Phase 3 has not been advanced.

These tests do not start a real observer, create a real run/current-run pointer, change historical evidence, query/write production Poly2, deploy, commit, push or open a PR. The lifecycle cases use only the existing isolated dummy-process test harness. No physical disk-full or live provider probe is required or claimed.
