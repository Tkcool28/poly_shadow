# Bounded-memory implementation and operational handoff

## Scope and deployment boundary

This branch is an uncommitted implementation handoff, not a deployment. No
observer was launched, live API called, Poly2 changed, or controlled run mutated.
Do not install this into an active/frozen experiment: changing its observer or
operational assets would invalidate the frozen implementation identity. Deploy
only after review and explicit authorization, into a separately identified run.
Keep existing live collector/UI assets untouched until separately approved.

For a future authorized deployment:

1. Record the approved commit, target Node version, frozen configuration and run
   receipts. The gates here ran on Node **26.7.0** and Python **3.14.7**. The code
   uses `node:sqlite` `DatabaseSync`; verify it on the actual target Node version
   rather than assuming the old runtime supports it. No new npm dependency.
2. Ensure exactly **one writer per data directory**. Stop its owned process by
   the existing authorized lifecycle mechanism before replacing code. Never
   start a second observer over the same evidence/index directory.
3. Reserve disk for the original append-only NDJSON plus both derived SQLite
   indexes. There is no retention horizon: disk usage scales with history while
   reader buffers, SQLite caches and JS queues are bounded. Do not delete,
   truncate, rewrite or sample scientific NDJSON to make startup faster.
4. Run the offline gates below in the target checkout. Start only through the
   approved runner after its normal configuration, egress and lifecycle gates.
   Neither this document nor the monitor authorizes starting an experiment.
5. Observe startup index progress before expecting network/source activity.
   CHAIN and racing indexes rebuild before any subscription or REST poll starts.
   Both yield to the event loop every 256 parsed rows; synchronous per-row I/O
   remains, so this is cooperative responsiveness, not a hard latency deadline.
   A reconnect reuses completed indexes and streams replay with 256-row yields.
6. After any separately authorized installation of `scripts/status/index.html`
   and `collector.py`, read back exact installed files and public status output.
   This standalone collector defaults to one historical controlled experiment;
   `--run` changes its input path, **not** its frozen START/END/SHA constants.
   A new experiment requires separately reviewed constants/receipt bindings.
   Do not advertise a new run using the old window or SHA.

## Evidence/recovery contract

- `recovery-index.sqlite` and `racing-index.sqlite` are disposable derived state,
  never scientific evidence. Each new store/process rebuilds them from NDJSON;
  a partial append/index update cannot forget committed evidence on restart.
  Do not remove indexes from a running writer. Their journal/synchronous modes
  are OFF because reconstruction, not SQLite durability, is authoritative.
- If an authoritative append succeeds but a cache update fails (including a
  group insert followed by a failed position insert), the affected store closes
  its disposable cache and latches invalid. All evidence queries/writes, cursor
  writes and initialization attempts on that object fail closed, even after
  `close()`. CHAIN publication failures also invalidate its canonical store;
  they never become repeated quarantine/PENDING appends or transient retries.
  REST polling checks validity before another request. Operational snapshots
  retain bounded `indexInvalid` / `racingIndexInvalid` flags; the verified status
  collector exports those flags and a fixed fail-stop warning, not error history.
  Recovery requires new store objects and a successful authoritative streaming
  rebuild of identities, canonical rows, groups and positions before delivery.
  Do not automatically restart or alter a frozen run to clear this condition.
- REST raw existence is not terminal publication. Raw payloads and normalized
  source rows have separate disk indexes; duplicate polling requires both the
  source observation and its reconciliation membership. New raw rows freeze
  `completedUtc` before publication, so source-stage failure cannot replace the
  original arrival/completion clocks with a restart clock. Existing source rows
  remain authoritative. Legacy raw-only rows without `completedUtc` fail closed:
  arrival, response, request, provider time and restart time are never completion
  substitutes. A legacy raw row can use its existing normalized source row's
  actual completion evidence; no historical values are invented or rewritten.
- Racing startup prevalidates **all** recovery candidates before any scientific
  append, then completes unambiguous REST raw/source/membership stages before
  `initializeIndex()` resolves, hence before new CHAIN or REST delivery. Recovery
  is from durable evidence, not provider retention/repoll. Candidates and group
  checks live in disposable SQLite tables with disk temporary storage and bounded
  cache; keyset scans yield every 256 rows, without lifetime JS maps or arrays.
- **FIRST means actual reconciliation commit order, not earliest arrival.**
  Existing FIRST/membership rows are authoritative and preserved. With an existing
  FIRST, missing memberships can be repaired as CORROBORATOR even if their arrival
  was earlier. Without a FIRST, a single identity with no existing group membership
  can safely resume normal partial publication. Competing identities in the same
  economic group (raw-only, source-only, or CHAIN source evidence) have unknown
  historical commit order and fail closed; raw-file order, source-file order and
  distinct arrival/completion timestamps cannot manufacture a winner. A group
  containing only CORROBORATOR membership also cannot authorize a new FIRST.
  This deliberately conservative contract can block recoverable-looking legacy
  evidence; resolve provenance separately, never alter a frozen run automatically.
- Timestamp/prevalidation/ambiguity failure leaves all scientific NDJSON byte
  unchanged, including otherwise repairable earlier candidates; only disposable
  indexes change. The store latches invalid before any delivery. Recovery appends
  only missing stages; completed reopen and same-item repoll are byte-stable.
  An actual recovery append/index I/O failure can leave partial durable stages,
  latches invalid, and requires a new store object. Existing FIRST permits their
  idempotent corroborator repair on reopen; historical FIRST rows are not rewritten.
- Each SQLite cache is 2 MiB, mmap is disabled, temporary sorts use disk.
  NDJSON reads use a 64 KiB buffer with a 1 MiB physical-line limit and a frozen
  file-length snapshot. Malformed or oversized rows fail explicitly; no skip.
- Array evidence helpers are compatibility views limited to 10,000 rows and
  throw beyond that limit. Production dedup/replay uses disk/streaming paths.
- Full blockHash-aware identity and durable disposition determine recovery.
  Tombstones dominate PENDING; original arrival survives spill/replay; only
  latest eligible legacy rows replay; observations and FIRST/CORROBORATOR
  membership survive restart without a bounded identity horizon.
- In-flight work and retry queues are capped at 256. Overflow persists raw and
  PENDING evidence for streaming replay. Exclusive transitions coalesce to
  running plus one follow-up. Diagnostic caches are bounded separately.
- Only ABI-valid, positive-amount, demonstrably unwatched OrderFilled events
  not already retained are filtered before raw retention. Unknown/malformed
  events, OrdersMatched, removals and previously retained identities remain
  evidence. This intentionally reduces irrelevant raw population; it must not
  be described as retention of every subscribed log. Watched observations,
  arrival timestamps, fork-aware dedup and fail-closed recovery remain intact.

## Monitor contract

`runtime-memory.json` is an atomic operational snapshot every five seconds,
mode 0600, separate from scientific/arrival evidence. The status collector
exports an allowlisted reduction only after verifying the launch/runtime PID,
Linux start ticks, session/process group and bounded ancestry. Missing, stale
(>30s), dead or mismatched runtime snapshots produce unknown memory fields.
It never reads environment, command lines, credentials, arbitrary PIDs or
CHAIN raw contents. Evidence tails and receipts are capped at 128 KiB each.
Poly2 health deliberately remains unknown without a separately authorized
read-only provider. The UI is operational-only, not a scientific comparison.

Relevant fields:

- `rssBytes`, `heapUsedBytes`, `heapTotalBytes`, `externalBytes`: actual process
  measurements, not a synthetic memory-limit estimate.
- `cgroupUsageBytes` / `cgroupLimitBytes`: actual usage and smallest visible
  finite cgroup-v2 ancestor limit, measured in the same governing group. Usage
  includes other members/cache; this is **not heap pressure**. Missing/unlimited
  limits mean pressure unknown. Warnings trigger at 85% and 95%.
- `indexRows`, `indexRebuildActive`, `indexFile`, `indexLastProgressUtc`: CHAIN
  rebuild processed-row count, activity, file, and progress timestamp.
  `racingIndex*` fields have the same meaning for source racing. Counts are
  rows processed in the latest rebuild, **not live identity cardinality**;
  subsequent appends do not increase them. Progress stall warnings apply only
  during an active rebuild with last progress older than 90 seconds.
- `replayRows`, `replayActive`, `lastProgressUtc`: cumulative raw rows examined
  and replay/processing progress, not observations or scientific coverage.
- `inflight`, `retryQueue`, `exclusiveDepth` and diagnostic cache counts expose
  bounded operational state. Queue warnings begin at 230 of capacity 256.

If pressure increases or progress stalls, inspect operational snapshots and
available disk using the authorized read-only process. Do not infer coverage,
restart automatically, extend the frozen window or alter evidence. Reorg
`recoveryRequired` remains a manual, fail-closed boundary.

## Reproducible offline validation

From an isolated checkout, with TMPDIR pointing to a scratch directory:

```sh
npm test -- --reporter=dot
npm run build                    # project's build is tsc --noEmit
npm run safety
python -m unittest discover -s tests -p '*test.py' -v
git diff --check
node --expose-gc --max-old-space-size=128 --import tsx scripts/memory-stress.ts 30000
```

The synthetic stress command caps rows at 15,000–50,000, uses production stores,
watcher and reconciler without starting them, and asserts post-warmup RSS growth
<32 MiB and heap growth <8 MiB. It verifies terminal reconnect replay, tombstone/
re-inclusion behavior, restart dedup and FIRST membership. Its scratch evidence
is removed after execution. This is **not a multi-gigabyte or live soak proof**.

Final measured 30,000-row offline stress after the fail-closed review corrections:
raw bytes: 5,767,780; CHAIN index bytes: 10,792,960. RSS samples: 82.660, 84.305,
85.180, 85.410, 85.410, 85.660 MiB. Compared with the 10,000-row warm sample,
tail maximum growth was 1,421,312 RSS bytes and 20,616 heap bytes.
No finite visible cgroup limit was available; pressure was unknown. All four
reconnect/reorg/restart/FIRST assertions passed, with zero network calls. These
measurements are synthetic, not production memory or a bounded RSS guarantee
for arbitrary payloads, provider responses, SQLite/OS cache behavior or
multi-gigabyte history.

Final gates after corrections: 165 TypeScript tests across 15 files;
`npm run build` typecheck; static safety OK (6 dependencies scanned);
8 Python collector tests; `git diff --check`; 30,000-row offline stress.
All exited 0. Eight cache-failure regressions retain real SQLite triggers after
authoritative NDJSON appends at canonical, source, group and position stages.
The 23 REST regressions cover both sources at raw/source/group/position real-trigger
stages, byte-stable in-process fail-stop, no-provider unambiguous startup repair,
second-reopen idempotence, actual frozen completion, legacy raw rejection,
legacy raw with authoritative saved source, distinct-timestamp raw/source
ambiguity in both arrival directions, raw/raw and CHAIN contenders, missing-FIRST
corroborators, missing source completion, whole-repair prevalidation nonmutation,
two recovery trigger failures with an authoritative FIRST, and cooperative
10,001-row recovery beyond array limits. The focused publication/index fault
matrix contains 39 tests across three files.
