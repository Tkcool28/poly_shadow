# Pre-relaunch readiness (implementation only)

No observer has been started by this change. It does not authorize a seal,
launch, deployment, service start, production pointer publication, or historical
run inspection. Scientific manifests, wallet cohort, source timestamp semantics,
Poly2 PAPER/read-only gates, and the frozen 24-hour lifecycle remain unchanged.
The isolated implementation checkout is deliberately **not** launch-ready:
production launch requires the merged, approved exact revision on `main`.

## Revision and checkout gates

Future operator invocations must supply an explicit lowercase 40-hex
`--expected-shadow-sha`. The runner requires all of:

- current branch exactly `main`;
- `HEAD == origin/main == expected-shadow-sha`;
- `git rev-list --left-right --count HEAD...origin/main` exactly `0 0`;
- no staged or unstaged tracked changes, including tracked `runs/` files;
- no forbidden credential names, no discovered/uninspectable Shadow orphans,
  and the existing protected Poly2 preflight/baseline checks.

The runner does not fetch or silently update `origin/main`. An operator must
establish the approved remote-tracking revision before a future authorized run.
A branch name alone, abbreviated SHA, or one-sided divergence cannot pass.

Untracked paths are classified explicitly, using NUL-delimited Git status so
Git-quoted tabs, newlines, quotes and Unicode cannot alter path boundaries:

1. `runs/` files remain **evidence**, including historical evidence, not current
   authority. This exception never permits evidence elsewhere in the checkout.
   Preflight classifies paths without reading historical evidence contents.
2. Only direct `scripts/__pycache__/` regular nonsymlink `.pyc` files matching
   tracked `scripts/*.py` source may be **interpreterCache**. The tiny recognized
   tag/magic pairs are CPython 3.12 (`cpython-312`, `cb0d0d0a`) and 3.14
   (`cpython-314`, `2b0e0d0a`), plus the running interpreter's native pair.
   Optional `.opt-1`/`.opt-2` suffixes are accepted. Header flags must be 0, 1,
   or 3; file size must be greater than 16 bytes and at most 8 MiB. Native
   payloads additionally require one complete marshalled code object whose
   filename basename matches the tracked source, without trailing bytes.
   Foreign-version payloads are **opaque quarantine**: their body is not
   unmarshalled or validated as executable code. This is format classification,
   not proof of generator, freshness, contents, or source equivalence. Preserved
   3.12 and 3.14 caches can coexist under either interpreter. No cache is
   executed, used as runtime/CLI authority, refreshed, or deleted.
3. Symlinked paths/directories, mixed or nested cache directories, random
   `.pyc`, untracked source/configuration/evidence, and ignored extra cache
   entries fail closed. This is not a general `__pycache__` allowance.

## Enforceable observer memory scope

For a future authorized run, the **existing independent guardian** stays
outside the observer scope. Its Popen command is fixed:

```text
systemd-run --user --scope --quiet \
  --unit=poly-shadow-observer-<safe-runId> \
  --property=MemoryMax=4294967296 \
  --property=MemoryHigh=3221225472 \
  --property=MemorySwapMax=536870912 \
  python3 -B <actual-repository>/scripts/phase4-observer-entry.py \
  --run-id <safe-runId>
```

`runId` must be a direct `runs/phase4-[A-Za-z0-9_-]+` leaf. There is no shell,
arbitrary-command, repository, cgroup-root, or environment execution override.
The entry checks its own unified cgroup path is the exact named `.scope`, its
leaf max is 4 GiB, the smallest finite limit through its ancestors is exactly
4 GiB, and its leaf high/swap are exactly 3 GiB/512 MiB. Missing controller
files below the unconstrained hierarchy root, mismatches, unreadable controls,
or symlinks block execution. The entry writes **only its own exact verified
scope's** `memory.oom.group=1`, verifies readback, and checks controls again
before fixed `/usr/bin/npm start` with a minimal runtime environment. Directly
invoking the entry outside that scope cannot launch npm. `python3 -B` avoids
creating runtime interpreter caches but does not prevent cache reads. The entry
therefore bypasses import loaders/cache lookup: it reads only the exact
nonsymlink `scripts/phase4-runner.py` source bytes, compiles them, and executes
that source in a fresh module namespace. Even accepted stale unchecked-hash
caches cannot supply `runtime_env` or any other helper behavior.

This host's systemd v249 does **not** support the `MemoryOOMGroup` unit property;
that property must not be added to the launch command. Group OOM is enforced
by the cgroup-v2 kernel flag, not a new service or parallel guardian. Scope
mode has no restart policy. Kernel group OOM exits the observer group; the
existing outside guardian detects early child exit and stops/reaps only its
owned session/group. Runner death and frozen end retain the existing guardian
cleanup guarantees. No automatic restart or shifted observation window exists.

The proposed 4 GiB hard cap uses the supplied host readiness measurements:
7.754 GiB total RAM and approximately 4.94 GiB available at that assessment.
Those figures are context, not a fresh capacity guarantee. Bounded retained
observer state is expected to remain low. The 3 GiB high threshold introduces
pressure before the hard cap; the 512 MiB swap limit is deliberately small.
Neither a large swap allowance nor restart loops should hide a leak. Recheck
host capacity separately before any future authorized launch. Synthetic tests
prove command construction and entry fail-closed checks; a separate harmless
scope probe by the parent operator is the real-host control proof, not a live
observer test.

## Explicit current-run authority

The future `run` CLI additionally requires an absolute
`--current-run-pointer` outside the checkout (therefore outside `runs/`). The
documented deployment path is `/var/lib/poly-shadow/current-run.json`; its
parent directory must already exist and no component may be a symlink.
Nothing in this implementation publishes that real pointer.

The exact pointer schema is:

```json
{
  "schemaVersion": 1,
  "runDirectory": "/absolute/repository/runs/phase4-operator-approved-id",
  "runId": "phase4-operator-approved-id",
  "approvedShadowSha": "<explicit lowercase 40-hex approved revision>",
  "startUtc": "<frozen UTC ISO start>",
  "endUtc": "<frozen UTC ISO end>",
  "lifecycleState": "AUTHORIZED"
}
```

Publication occurs only after fresh seal validation, revision/cleanliness and
protected preflight, with the frozen start still in the future. A per-pointer
external lock serializes transitions; staged JSON is fsynced, atomically
replaced in the same directory, directory-fsynced, and read back before the
lifecycle starts. Existing/readback JSON is bounded to 128 KiB; duplicate keys,
nonfinite constants, malformed bytes, and unknown schema fields fail closed.
A malformed pointer or a previous pointer whose end has not
passed is never overwritten. A well-formed ended historical pointer may be
replaced only after the new run's gates pass. Publication/durability failure
prevents lifecycle and preserves/restores prior pointer bytes where possible.
The lock file is operational control state, not scientific evidence.

`AUTHORIZED` binds a specific future experiment; it is not proof of process
launch, observation startup, or scientific completion. Collectors must validate
run ID, manifest SHA and exact window against this pointer and reject ended
historical runs as current. The collector requires exactly the seven pointer
fields shown above: missing/extra fields, duplicate JSON keys, malformed values,
and mismatched identity/window fail closed as `INVALID_BINDING`, with current
telemetry unknown. No pointer extras are silently accepted or exported.
The scientific manifest format is not changed.
There is no newest-directory inference and no readiness preflight write to
real current-run state.

## Synthetic validation boundary

`tests/readiness_runner_test.py` covers revision/divergence, actual generated
3.12/3.14 caches under both interpreters and Git-quoted evidence paths,
invalid-header/mixed/symlink cache rejection, accepted stale unchecked-hash
cache isolation from source-only entry loading,
fixed scope command, mocked cgroup limits/group-OOM readback, direct-entry
blocking, current-pointer schema/stale/active/path/durability failures, and
actual CLI gate/publication order on copied synthetic seals. All filesystem
fixtures live under disposable scratch directories. No test contacts Poly2 or
starts npm/systemd/observers. `tests/phase4_runner_lifecycle.py` retains real
harmless dummy process-tree deadline, signals, runner-SIGKILL guardian cleanup,
unrelated-process preservation and transactional report failure proofs.

Run the two Python families with `python3 -B`; test logs (including initial RED
regressions) belong outside the repository. Full deployment/readiness remains
a separate authorized step after exact-head review and merged-main approval.
