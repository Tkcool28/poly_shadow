# Phase 4 fixed-window lifecycle runner

`python3 scripts/phase4-runner.py` is a **Linux, stdlib-only lifecycle helper**, not a scientific implementation, export pipeline, service, or approval to observe. It leaves approved Shadow/comparison/dashboard/watchers/metrics, polling cadence, wallet configuration, and Poly2 code unchanged.

**This correction does not seal/freeze a live cohort, start a live observer, query production, or modify existing run evidence.** Historical operations already happened: the prior authorized observer started at 06:55 UTC and its owned runner/observer were stopped at 07:00:32 UTC. Do not rewrite that history as “none started.” Existing `/opt/poly-shadow/runs` bytes must remain untouched. New authorization and a fresh future window are required for any later use.

## Operator interface (not executed by the correction)

Run from the repository helper, not the copied `runs/.../runner.py`. Supply the independently reviewed **new commit SHA explicitly**; the old pre-correction SHA is not hardcoded. No synthetic mode, arbitrary command, duration override, unsafe skip, or production test switch exists in the CLI.

```text
python3 scripts/phase4-runner.py preflight \
  --expected-shadow-sha <reviewed-full-40-character-sha> \
  --experiment /opt/poly-shadow/runs/phase4-<fresh-name>

python3 scripts/phase4-runner.py seal --approve-seal \
  --expected-shadow-sha <reviewed-full-40-character-sha> \
  --experiment /opt/poly-shadow/runs/phase4-<fresh-name> \
  --start-utc <fresh-future-UTC-start> --end-utc <exactly-24h-later-UTC-end>

python3 scripts/phase4-runner.py run \
  --expected-shadow-sha <same-reviewed-sha> \
  --experiment /opt/poly-shadow/runs/phase4-<same-name>
```

`preflight` is observational, including the dedicated Docker/PostgreSQL read-only adapter; it does not create an experiment or launch Shadow. Do not run it against production as part of this correction. Branch must be `feat/phase4-poly2-comparison-dashboard`; HEAD must equal the explicit expected SHA; all tracked files must be clean, including tracked `runs/` files (`git status --porcelain=v1 --untracked-files=no` must be empty). Only untracked `runs/` evidence is allowed; staged additions, modifications, deletions and renames under `runs/` are not exceptions. Credential guard matches the approved Shadow guard, including set-but-empty values and `ARB_`/`SCALP_` prefixes. Only variable **names**, never values, appear in refusals.

Before experiment creation, the seal checks:

- Explicit approval, strict direct-child `repo/runs/phase4-*` path, no symlink ancestors or overwrite, future UTC start, exactly 86,400 seconds.
- Actual branch/HEAD/clean status and credential absence; no existing Shadow runtime. `/proc` discovery examines command, cwd and `SHADOW_DATA_DIR` across processes, including npm/tsx/node descendants whose runner died and data directories elsewhere. It never kills discovered/unowned processes or matches unrelated Poly2 merely because it uses node. Unreadable process state fails closed.
- Poly2 HEAD `bd61efc90a4ff8bfc17b8a31abc4a40dd655f81f`, PAPER true/live trading false, stable running bot container, recent `bot_alive`/`bot_success`, and exactly the fixed five approved wallet addresses. PostgreSQL snapshot uses explicit `READ ONLY`, default read-only transaction options, finite statement timeout and `ROLLBACK`. The adapter inspects settings; it makes no database/config/container mutation.

The manifest contains the fixed five addresses, `exploratory: []`, absolute window, expected SHAs, helper/cohort/preflight hashes and the observed protected Poly2 baseline. No wallet selection is inferred. Run rechecks the baseline (settings, `.env` hash, SHA and container identity) and requires its new evidence directory to remain empty before launch; heartbeat times naturally advance and are checked for freshness, not byte equality. These snapshots are observational gates, **not proof of continuous unchanged production between snapshots**.

## Seal and ownership contract

A shared `flock` single-owner lock serializes seal/run. Files are exclusively created in a sibling staging directory, fsynced and made read-only before atomic Linux `renameat2(RENAME_NOREPLACE)` publication; the parent directory is fsynced. A partial failure gets an `INVALID` marker when writable; a final durability failure also attempts atomic retraction back to the unrunnable staging path. Unpublished staging directories, missing manifests, invalid markers, changed hashes, wrong window/cohort, existing start/launch/final receipts, or symlinked paths cannot run. Real tests prove retraction even when writing the invalid marker fails. If catastrophic storage failure prevents both invalidation and retraction, the operator must treat the seal error as unusable, not authorize retry; no program can promise durable error markers on a storage device rejecting every write. No existing experiment is overwritten or automatically restarted.

The runner waits for the sealed start. It must be ready **before** start; the final launch guard allows at most one second of scheduling/Popen lateness and never launches at/after end. A missed start is terminal, not a shifted 24-hour duration. The observer command is exactly `npm start` from the repository. The allowlisted environment carries watched wallets/data directory plus infrastructure `PATH`, `LANG`, scratch `TMPDIR` and a fresh empty `HOME`; receipts disclose only experiment environment values, not PATH/secrets/inherited app settings. No polling or endpoints are overridden.

A forked guardian independently owns the observer's new session/process group and inherits the owner lock. It records Linux `/proc` start ticks, PID, PGID and session identity. If Popen succeeds but `/proc` identity capture fails, it still records the actual launch timestamp, marks `OBSERVER_START_FAILED`, and cleans up through an independent reserved-child proof: `waitid(WNOWAIT)` verifies the unreaped direct child while `getpgid`/`getsid` must equal its PID. This fallback never reaps before group signalling. If that proof also fails, only the directly owned Popen child is killed/waited and group cleanup remains failed; no unproven group is signalled. The unreaped leader reserves its identity while TERM/KILL are sent; reused tokens fail closed. At the frozen UTC end the guardian immediately sends **SIGKILL**, with **no deliberate TERM grace**. Early exit or interruption may use a bounded 0.2-second TERM grace before KILL, capped by the authoritative frozen UTC end. Cleanup independently rechecks UTC on every grace iteration even after the alarm is cancelled, sleeps for at most the lesser of the remaining monotonic grace and UTC-to-end budget, and switches to SIGKILL when UTC reaches end. If end has already passed before signalling, TERM is skipped. KILL observation is bounded at 2 seconds, leader wait at 1 second and adopted-descendant reap at 1 second; never broad `pkill`/`killall`. Receipts record `stopSignalPolicy` and `firstStopSignal` separately from measured scheduling/cleanup deviations. A Linux subreaper collects npm/tsx/node descendants. Receipts distinguish **no live group members** (`observerLiveGroupGone`), **no group members at all** (`observerGroupGone`) and any residual zombies; transient zombies are not reported as live orphans.

SIGINT/SIGTERM are forwarded only to the token-owned guardian, which stops its owned observer group and returns immediately. Early child exit is terminal immediately, not a wait until tomorrow. On runner SIGKILL, the independent guardian detects runner disappearance **or zombie state** and stops the owned group; real dummy-tree tests prove this. Signal masking covers the fork/handler-install race. Absolute UTC end is enforced by guardian polling plus a nonzero `ITIMER_REAL` alarm independent of heartbeat scheduling. Neither launch lateness nor clock elapsed duration extends the frozen UTC window.

This is not hard real-time scheduling. Receipts measure process launch, stop request and observed cleanup UTC/deviations; kernel/filesystem stalls, suspended processes, clock steps, machine loss or simultaneous guardian kill can defeat punctual enforcement/reporting. No Python finally can execute after its own SIGKILL. Do not claim exact boundary delivery or an unbroken scientific observation window.

## Evidence and receipts

- `runner-start.json`: attempted runner PID/start token.
- `launch-receipt.json`: real process launch UTC, command/cwd, runner/guardian/child IDs, owned token/PGID, experiment environment, lateness and remaining launch budget.
- `observer.log`: actual child stdout/stderr, not a fabricated startup receipt.
- `heartbeat.ndjson`: UTC, experiment ID, zero restart count, runner/child-alive status, evidence-directory existence, elapsed/remaining seconds and evidence filename sizes. Live monitoring uses stat only, no full evidence parsing.
- `execution-receipt.json`, `execution-receipt.sha256.json`, and `REPORT_COMMITTED.json`: terminal classification, measured stop request/cleanup UTC, exit code, ownership cleanup, observation provenance and a post-stop artifact size/hash inventory. Hashing is streamed once per inventoried file; neither existing evidence bytes nor permissions are rewritten. Final report files are excluded from the inventory to avoid circularity.

Final reporting is a transaction: exclusive staging files are serialized, hashed and fsynced **before** any root receipt publication; root names are published with NOREPLACE, the directory is fsynced, and an atomically published commit marker binds the same receipt digest. Readers must require `report_valid(target)` (both matching hashes plus the commit marker and no failure marker), not merely the receipt's classification. Any publication/durability error retracts only this transaction's root names into its unusable `.report-stage-*` audit directory. A writable target gets `REPORT_FAILED.json` and an uncommitted failure receipt; no successful root receipt is deliberately left after an error. This is report rollback, not evidence repair or cohort rewriting. A failed report never authorizes restarting the experiment. As with sealing, catastrophic storage failure that prevents retraction and all failure writes cannot be guaranteed recoverable: treat the error or any uncommitted bundle as unusable. Tests inject final digest, detached-hash write, detached-hash rename, commit-marker write, pre/post-marker directory fsync, and failure-marker failures; they verify source-artifact hashes are unchanged.

`actualProcessLaunchUtc`, `firstEvidenceSeenUtc` and `actualObservationStartUtc` mean **different things**. The approved `[poly-shadow] starting ...` log occurs before source start calls and cannot establish actual observation start. After stopping, only the first complete bounded line (maximum 64 KiB) of existing REST telemetry/raw evidence is inspected for its stored `requestStartUtc`. The receipt calls this **REST observation-start evidence**, not proof of earliest/all-source startup: the first completed poll is not necessarily the first concurrent request. Missing, partial, oversized, malformed or out-of-window evidence stays null with a reason. `perSourceObservationStartUtc` keeps missing sources null; a first CHAIN raw `firstSeenUtc` can be exposed only with explicit **raw-evidence arrival, not subscription startup** provenance. No timestamp is synthesized from process launch, file creation, source trade time or the pre-start log.

Terminal `classification` and `canonicalFailureReason` use the canonical mapping below; `lifecycleCode` retains the detailed internal code. Success has a null failure reason. Refusals use the same metadata on stderr; only a verified fresh seal owned by the invocation gets a report. Invalid/historical/duplicate paths receive no writes.

| Internal lifecycle code | Canonical classification |
| --- | --- |
| `COMPLETE` | `END_WINDOW_COMPLETE` |
| `MISSED_START` | `MISSED_START` |
| `PREFLIGHT_FAILED`, `DUPLICATE_RUN`, `ORPHAN_DETECTED` | `PRESTART_GATE_FAILED` |
| `SEAL_INVALID` | `WINDOW_SEAL_FAILED` |
| `LAUNCH_FAILED`, `LAUNCH_LATE` | `OBSERVER_START_FAILED` |
| `EARLY_EXIT` | `OBSERVER_EXITED_EARLY` |
| `INTERRUPTED`, `RUNNER_LOST` | `SIGNAL_TERMINATION` |
| `CLEANUP_FAILED`, `EVIDENCE_MISSING`, `REPORT_FAILED`, `INTERNAL_ERROR` | Same-named operational extensions |

`POSTRUN_EXPORT_FAILED`, `COMPARATOR_FAILED`, and `DASHBOARD_FAILED` are defined for the separate optional postrun contracts, never emitted here because those commands are not run. In particular report publication failure remains `REPORT_FAILED`, **not** a fictitious export failure.

Receipts include `experimentId`, `restartCount: 0`, `restartEvents: []`, and `outageGaps: []` with `outageGapAssessment: UNKNOWN`: the gap array contains no measured source outages and is **not proof of no gaps**. Actual process launch/stop deviations remain measured numeric fields, not source-start or source-gap claims. `observationPhase: COMPLETE` means successful fixed-window lifecycle with nonempty evidence presence, not scientific completion; all non-success terminals, including `EVIDENCE_MISSING`, use `FAILED`. Missing evidence produces exit status 1 and a committed non-success receipt without altering source artifacts. Every `postrun` component is explicitly `NOT_RUN`.

`END_WINDOW_COMPLETE` (`lifecycleCode: COMPLETE`) covers **fixed-window lifecycle and nonempty evidence presence only**. It does not mean every source was continuously healthy, observation began exactly at the boundary, Poly2 had no interruption, or scientific export/comparison/dashboard is complete. Those optional post-commands are not run automatically. Existing approved export/validation/comparison/dashboard contracts remain separate; do not redesign them here or label their absent artifacts successful.

## Isolated verification

```text
python3 tests/phase4_runner_lifecycle.py
npm run build
npm test
npm run safety
```

Python creates isolated fixture repos under configured `TMPDIR` (fallback Hermes scratch), never inside production `runs/`. Dummy fixture dispatch is confined to the test module, which imports the lifecycle core and runs harmless Python subprocesses. Regression-first tests reproduced all five independent-review blockers before correction. Tests exercise strict tracked/untracked Git status in a disposable scratch index (no commit), transactional final-report fault injection, required canonical metadata, real future waiting, absolute deadline with a TERM-ignoring child and measured 0.18-second scheduling tolerance, missing `/proc` child-capture fallback, regression-first missing-evidence FAILED metadata/exit-1/source-preservation proof, real SIGINT/SIGTERM about 50 ms before end with a TERM-ignoring owned tree and independently measured TERM/KILL times (0.18-second external scheduling tolerance, not scientific delay), dynamic UTC forward-step and already-at-end cleanup regressions with no alarm dependency, unrelated-child survival, source timestamp receipts, real child trees, early exit, SIGINT/SIGTERM, SIGKILL of the runner with independent guardian cleanup, duplicate ownership, missed start, PID-reuse refusal, orphan discovery without killing, partial fsync/rename failures, no overwrite, symlink/path/hash guards and credential names/no secret echo. Production adapter contracts are mocked only in explicit observational gate tests; no production Docker/DB/settings commands are executed. The Vitest wrapper runs the Python suite as part of existing npm-test CI without package/workflow changes; Linux and `python3` are required.
