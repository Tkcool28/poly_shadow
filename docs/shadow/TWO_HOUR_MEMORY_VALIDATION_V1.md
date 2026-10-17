# Two-hour operational memory validation V1

Implementation-only handoff. No VPS access, installation or real test occurred.
Base main: `5d816ef9677c8378ecab788f6c424dbe5b975106` (merged Stage 1).
The implementation PR supplies the exact reviewed revision and CI evidence.

Every harness record and the root/observer-directory manifests are marked:
`MEMORY_VALIDATION_ONLY_NOT_SCIENTIFIC_COMPARISON`.
Original observer journal row schemas stay unchanged; the enclosing immutable
boundary applies to **every** byte under this exclusively created test directory.
No cohorts/scientific authority/export is generated. No current-run pointer is
read, published or changed. Historical runs/capture records are untouched. The
existing shared lifecycle owner lock is acquired for mutual exclusion only.

## Fixed phases and hard acquisition deadline

- [0,900): normal-host baseline; no Shadow observer.
- [900,1800): real merged observer startup/stabilization.
- [1800,7200): sustained acquisition and memory-growth measurement.

The test start freezes UTC and Linux monotonic clocks plus boot identity. The
minimum deadline of these two clocks is authoritative. Startup delay never moves
either boundary. A missed stabilization window refuses acquisition. A UTC/monotonic
divergence >=2 seconds aborts. No retry, restart, duration override or extension.
At the absolute end the guardian requests immediate SIGKILL containment; measured
shutdown times/deviations are reported. Bounded cleanup/report administrative work
can finish after that deadline (guardian service has at most 8s extra administrative
lifetime), **never additional acquisition**. This is not a hard real-time scheduling
promise: kernel/I/O stalls and manager failure can prevent punctual action; failure
or absent summary never certifies a completed test.

The observer runs the existing fixed `npm start`, CHAIN, legacy REST and supplemental
v2 with the reviewed exact five wallets and unchanged cadences/budgets. The fixed
child environment is reused from the unmodified scientific runner with isolated
HOME/TMP/data. It passes `SHADOW_V2_CURSOR=true`, no source/cadence overrides and no
trading credentials. The scientific runner itself remains byte-identical.

## Containment and independent ownership

The foreground launcher creates an exclusive `memory-validation/memory-<id>`
directory and starts one independent transient **user service** guardian. The
service uses Restart=no, KillMode=control-group and a bounded manager runtime.
It watches the launcher's PID/start/session token even after launcher SIGKILL.

At 900s the guardian creates an inert observer scope entry with:

- MemoryHigh=3221225472; MemoryMax=4294967296; MemorySwapMax=536870912.
- Reviewed own-leaf/ancestor verification; `memory.oom.group=1` written and read back.
- BindsTo + After the exact guardian service; KillMode=control-group,
  KillSignal=SIGKILL, TimeoutStopSec=2, with manager readback before GO.
- A conservative finite scope RuntimeMaxSec<=6330 as a **coarse** last-resort cap.
  Its launch-time bound is remaining acquisition time +30s, preventing a race
  with normal deadline cleanup. It never extends the absolute 7200s acquisition
  deadline enforced by the independent guardian. It is not represented as that deadline; the live guardian's frozen
  dual clocks/alarm enforce that, while guardian termination immediately stops the
  bound scope. An externally SIGSTOP-frozen guardian is not a claimed termination
  test; kernel/manager loss is not a recoverable certified result.

The inert entry verifies its membership and limits and writes a ready receipt.
The guardian independently checks the exact scope incarnation, own leaf inode,
ready process token and mandatory cgroup telemetry. Writable own-leaf `cgroup.kill`
is required before GO. Only the exclusive GO receipt permits the entry to exec
npm. Any safety failure before GO means **no acquisition launch**. Limits, inode,
manager binding/identity and resource properties are checked every 10s, without
silently repairing changed controls.

Normal abort/deadline cleanup first uses descriptor/inode-verified `cgroup.kill`,
then manager kill for the captured exact scope, and always the reviewed reserved
child/process-group cleanup independently of manager errors. The cgroup includes
new-session/reparented descendants. Empty cgroup + no live owned group are required;
cleanup control failures cannot certify completion. A manager kill error alone
may be benign only after readback proves the captured scope inactive (same
incarnation) or gone, the verified own cgroup empty/gone, the owned process group
gone and the direct child exited. This race proof is recorded in the summary;
unknown, replaced or active scope and missing ownership/empty proof fail closed. Guardian SIGKILL causes systemd
to terminate the bound observer scope independently; the surviving launcher records
a failed fallback summary if the guardian cannot report. No process-name kills.

## Telemetry, pressure policy and artifacts

A sample is due every 10s from test start. Missed slots are recorded and invalidate
completion. JSONL is exclusive, fsynced and capped at 721 rows x64 KiB. Each row
includes phase, actual UTC/elapsed time, observer tree RSS/PSS availability, cgroup
current/peak/swap/events and the six bounded memory.stat byte categories
active_file/inactive_file/file_mapped/shmem/file_dirty/file_writeback, host MemAvailable/swap/PSI/OOM counter, top12 readable
other processes >=64 MiB RSS (no argv/environment), filesystem free/capacity,
selected evidence/journal + SQLite WAL/SHM byte growth, acquisition/failure counters
from the existing runtime snapshot, and cached read-only Poly2 health with age.
PID/start/session identities are checked around RSS/PSS reads; partial PSS is null,
never represented as a complete tree sum. Process counts and read sizes are bounded.
Observer stdout/stderr is drained into a separate log capped at16 MiB.

Summary includes measured startup/GO/exec attempt/shutdown times, stop reason and
terminal local host/disk/cgroup-event and early-exit checks before intentional kill,
cleanup proof, phase sample counts/spans, first/last memory values and growth,
peaks, minimum host MemAvailable and evidence growth. A request to exec is not proof
of first source observation; acquisition activity retains its own existing clocks.
No fixture output is a production memory measurement or scientific comparison.

Fixed abort conditions:

- Host MemAvailable <1 GiB; swap free <256 MiB while MemAvailable <2 GiB.
- Memory PSI full avg10>=10% or some avg10>=50% for two consecutive samples.
- Any increase in host oom_kill, or observer memory.events max/oom/oom_kill.
  memory.high events alone are reported, not called an OOM.
- Free capacity below10 GiB+32 MiB reserve, unsafe control/identity changes,
  unavailable mandatory telemetry, stale/broken observer runtime/evidence,
  observer early exit, late/missing GO, ownership or cleanup failure.
- Poly2 service stopped/restarted/OOM/unhealthy, baseline config/revision changed,
  capture enabled, non-PAPER/live/kill-switch deviation, or either bot_alive/
  bot_success heartbeat >=180s stale. These are operational stop proxies, not a
  causal claim that Shadow caused the change.

Poly2 is probed every30s using only fixed container state fields, six allowlisted
settings and a read-only heartbeat transaction with statement timeout and ROLLBACK.
The same monitoring overhead is present during baseline. No SQL writes, capture
activation, orders, configuration changes or service restarts are performed.

## Exact deployment prerequisites — separate authorization

1. Review/merge this PR; deploy its approved **merge SHA** into a clean main checkout
   with HEAD==origin/main. Do not run the unmerged branch or copy loose scripts into
   an older checkout. Preserve all current/historical evidence and capture inputs.
2. Linux cgroup v2 with memory.current/peak/events/swap, memory.oom.group and writable
   own-leaf cgroup.kill; effective ancestors must permit exactly4 GiB observer cap.
   systemd>=249 user manager/bus must support transient services/scopes and the
   documented properties; scope binding/readback must work. Python3.12+ at
   `/usr/bin/python3`, npm/node22+ at `/usr/bin/npm`, reviewed npm dependencies and
   existing Python authority requirements installed. No credential-shaped env names.
3. Approve the shared-host capacity/workload inventory. Existing startup disk gate
   is retained: >=27,096,358,240 bytes free; runtime reserve is stricter than10 GiB.
   This PR does not measure available VPS RAM/disk or authorize stopping workloads.
4. No existing Shadow observer/test; no overlapping scheduled Shadow launch.
   Shared owner lock/orphan checks must pass. Approved Poly2 remains normal PAPER,
   live disabled, PAPER order kill switch **false**, capture disabled. The intended
   settings are `POLYCOPY_PAPER_MODE=true`, `POLYCOPY_ALLOW_LIVE_TRADING=false`,
   `POLYCOPY_ORDER_KILL_SWITCH=false`, and `POLYCOPY_SHADOW_CAPTURE_ENABLED=false`.
   The false kill switch permits autonomous PAPER BUYs and SELLs; live trading
   remains independently disabled. A true kill switch fails preflight.
   No capture installation or
   scientific authority is needed or permitted for this memory test.
5. Local Docker socket read access to the existing fixed Poly2 backend/bot/Postgres/
   Redis containers and read-only heartbeat probe is required. Baseline service,
   heartbeat and host pressure checks must pass. No permissions/safety bypasses.

After separate authorization for exactly one real memory test, choose a fresh
lowercase ID and use the reviewed merge SHA (no timestamps/duration parameters):

```sh
cd /opt/poly-shadow
python3 -B scripts/memory_validation.py preflight \
  --expected-sha '<reviewed-merge-sha>' \
  --directory '/opt/poly-shadow/memory-validation/memory-<fresh-id>'
python3 -B scripts/memory_validation.py run --approve-memory-validation \
  --expected-sha '<same-reviewed-merge-sha>' \
  --directory '/opt/poly-shadow/memory-validation/memory-<same-fresh-id>'
```

Preflight is read-only except acquiring/creating the shared lifecycle lock. Run
creates one exclusive directory and manager units; it never publishes a Phase4 run.
Keep the foreground launcher attached. Killing the launcher aborts this attempt;
reconnecting/retrying is not a restart authorization. Inspect memory.jsonl,
manifest.json, guardian.json, observer-ready/go/exec receipts, observer.log and
summary.json. Missing/FAILED summary, OOM or incomplete cleanup means failed test;
retain evidence and report the concrete component. Never clear a failed directory
or resume it. A future rerun needs fresh authorization and a new ID.

## Verification scope

Focused tests cover boundaries, pressure/OOM, bounded writes, readback and no-GO
failures, fixed environment/isolation, cleanup fallbacks and immutable scientific
runner. Real Linux dummy-process fixtures exercise guardian/launcher signals,
escaped-session descendants and all phases; their systemd control plane is explicitly
synthetic. Actual systemd properties are fail-closed deployment/startup readbacks,
not claimed as an actual VPS test. Existing Python/TypeScript/typecheck/safety CI
and independent final review are required before READY.
