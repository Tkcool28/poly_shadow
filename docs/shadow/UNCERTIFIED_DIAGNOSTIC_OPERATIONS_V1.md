# Separate diagnostic path — implementation and operator handoff

This is an **UNCERTIFIED_DIAGNOSTIC**, not a certified Stage 1 run. The existing
V5 CLI, approvals, authority rules and `COMPARISON_NOT_AUTHORIZED` fields are
unchanged. The controlling October 21 master plan is adjacent to this document.
No deployment or real observation was performed during implementation.

## Implementation

`scripts/uncertified-diagnostic-runner.py` starts the existing three-lane
collector with V2 enabled, under one exclusive diagnostic owner lock. It freezes
the five-wallet cohort, revisions and UTC interval in a unique persistent run
directory. A separately recorded partial observation interval never becomes a
completed 24-hour comparison. There is no resume/splice command: interruption
preserves evidence and an INCOMPLETE state; a new authorized run has a new ID and
window. Existing append-only journals and collector recovery indexes/checkpoints
are reused. The runner adds an atomic lifecycle manifest/checkpoint.

The runner requires pre-existing cgroup v2 controls: memory.max <= 4 GiB, swap
<= 512 MiB, CPU quota <= one core, pids.max <= 256. It never creates or changes a
cgroup itself. Evidence growth is checked every five seconds, including SQLite
WAL files, against 6 GiB and the existing disk reserve model. This is a monitored
disk ceiling, with up to a check interval of overshoot, not a filesystem quota.
The inherited request limits remain serial transport, >=500ms request spacing,
<=60 total starts/minute and <=20 supplemental V2 starts/minute. Each existing
V2 traversal retains its bounded pages/body/deadline controls.

An independent deadline timer stops the observer while a live report/export is
in progress. SIGTERM/SIGINT signal the entire collector group immediately;
cleanup escalates and verifies no live group members remain. A second signal
forces escalation. The outer systemd unit must use KillMode=control-group and a
bounded stop timeout to cover an uncatchable runner crash or SIGKILL. Source
outages, pagination limits, normalization failures and missing clocks remain
evidence, not zero counts or completeness proofs. Wall-clock discontinuities
fail the run rather than silently stretching the window.

`scripts/poly2-diagnostic-export.py` runs on the Shadow host using a dedicated
SELECT-only PostgreSQL role, a private <=4 KiB DSN file and the native asyncpg
driver. It does not import Poly2 runtime settings or require changing/restarting
a Poly2 container. The explicit read-only repeatable-read transaction is read
back and checked. Statement/lock/idle timeouts are 15s/250ms/30s. Keyset row caps,
SQL-side native identity bounds and 4 KiB/context, 512 KiB/page, 4 MiB retained
context limits apply before Python retains audit payloads. Exceeding row/output
caps fails closed; omitted contexts cannot prove an action.

The selection interval is `[start,end)`. Start primary-key marks are metadata,
not a lower selection fence: sequence allocation does not prove commit order.
The final snapshot includes visible lower IDs with in-window ingestion clocks.
The default 30-second lag horizon is separate from observation duration (CLI
allows 0..60s); post-window ingestion of in-window events is reported separately.
Evidence arriving after that snapshot is UNKNOWN. PostgreSQL visibility is not
continuous ingestion coverage. Actual decisions/actions are linked application
audit evidence, **not database-enforced immutable history**. Present-day signal,
order, settlement or eligibility status is never used to reconstruct history.

`src/compare/uncertified-diagnostic.ts` reuses `compareV2()`. Native IDs and
original clocks survive, matching confidence stays separate, recovery records
are excluded from prospective speed metrics, and absence remains INDETERMINATE.
High-confidence timing uses normalization completion for each Shadow lane and
its earliest union, with Poly2's original ingestion clock. Positive signed lead
means Shadow was earlier. p50/p90/p95 and threshold fractions are observed clock
differences; host clock offsets are unmeasured. Probable and ambiguous matches
do not enter confident timing samples. Duplicate confirmations do not add
economic groups or additional per-group lane latency samples.

The existing public page reads a separate diagnostic summary. The existing
`scripts/status/publisher.py` optionally mirrors a bounded private diagnostic
snapshot to a distinct public JSON file; it never retimestamps evidence or
changes certified fields. Reports include actual wallet IDs, unique/group
counts, per-wallet reconciliation, source health/failures, genuine examples,
linked audit action counts, unknown price evidence and final download links.
No contemporaneous paired executable quote/depth evidence was found in the
persisted schema. Existing book snapshots belong to Poly2 execution time only.
No quote sidecar was introduced: **PRICE_ADVANTAGE_UNKNOWN / UNRESOLVED**.

## Separate deployment and short smoke-test prerequisites

Do not execute this handoff until the user reviews the exact PR head and
separately authorizes deployment/smoke. Do not launch 24 hours as a side effect.

1. Verify merged Shadow main and current Poly2 main/runtime independently.
   The current baseline guard expects Poly2
   `219ad2c66442632b5e41506ba485062420a27c15`; if it advanced, inspect that change
   and update the guard through review instead of forging a runtime label.
2. Read and freeze the actual five approved wallets during that authorized
   preflight. Existing collectors require the historical exact five-wallet set;
   a cohort difference stops launch and requires an explicit compatibility
   change. No approval list is changed by this implementation.
3. Verify existing baseline ingestion is healthy. Confirm PAPER=true,
   ALLOW_LIVE_TRADING=false, ORDER_KILL_SWITCH=false, SHADOW_CAPTURE_ENABLED=false
   for all relevant Poly2 services, without changing any setting. The runner
   inspects the backend revision/config; independent bot/ingestion health remains
   an operator preflight requirement.
4. Provide a dedicated existing SELECT-only DB role and private reader DSN file
   outside artifacts/webroot. If no role exists, credential provisioning requires
   separate authorization; the exporter never creates roles or grants. Verify
   an existing private Docker bridge/local DB route; no port/firewall relaxation
   or Poly2 worker/container restart is part of this handoff.
5. Install a separate Shadow Python environment with SQLAlchemy 2.x and asyncpg
   (native CI pins 2.0.46 / 0.31.0), Node >=22 with the repository lockfile, and
   the reviewed diagnostic code. Measure current host/service RSS, CPU, pressure,
   disk reserve and expected evidence growth. The 4 GiB ceiling is an engineering
   bound, not demonstrated 24-hour headroom. Do not launch if co-running services
   cannot safely accommodate it.
6. Provision `/var/lib/poly-shadow/diagnostics` and the distinct diagnostic web
   directory. Give the existing status publisher read/traverse access to only
   the sanitized private snapshot and write access to its separate output.
   Keep reader credentials and raw evidence private. Configure the publisher's
   optional `--diagnostic-snapshot` and `--diagnostic-output` paths; default
   publisher behavior remains unchanged if these are absent.

Example **template for the later explicitly authorized 60-second smoke only**
(replace paths/container names and verify all values first):

```sh
systemd-run --unit=poly-shadow-diagnostic-smoke --collect \
  --property=MemoryMax=4G --property=MemorySwapMax=512M \
  --property=CPUQuota=100% --property=TasksMax=256 \
  --property=KillMode=control-group --property=TimeoutStopSec=20s \
  --property=RuntimeMaxSec=900s \
  /var/lib/poly-shadow/diagnostic-venv/bin/python \
  /opt/poly-shadow/scripts/uncertified-diagnostic-runner.py run \
  --repo /opt/poly-shadow --poly2-repo /opt/poly2 \
  --poly2-container VERIFIED_BACKEND_CONTAINER \
  --poly2-dsn-file /etc/poly-shadow/diagnostic-reader.dsn \
  --duration-seconds 60 --late-arrival-grace-seconds 30 \
  --publish-dashboard \
  --publisher-snapshot /var/lib/poly-shadow/diagnostics/diagnostic-comparison/snapshot.json
```

Publisher optional flags for that same sanitized snapshot:

```text
--diagnostic-snapshot /var/lib/poly-shadow/diagnostics/diagnostic-comparison/snapshot.json
--diagnostic-output /var/www/poly-shadow-status/diagnostic-comparison/summary.json
```

Validate all three lanes, V2 request receipts, original normalized clocks, genuine
cohort identity, bounded read-only export, actual dashboard freshness/downloads,
measured CPU/RSS/disk/request use, and no surviving process group. If no matched
event occurs, record `NO_MATCHED_EVENT_OBSERVED`; fixtures prove wiring only.
Preserve manifests, journals, source checkpoints, final export/report and hashes.
Review smoke evidence with the user. A fresh prospective 24-hour window requires
another explicit authorization, adequate measured headroom, and a unit deadline
that also covers bounded finalization. Smoke duration never counts toward it.
