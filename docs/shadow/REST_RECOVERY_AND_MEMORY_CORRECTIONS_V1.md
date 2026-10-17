# REST recovery and memory corrections V1

Starting main: `3f6da4aed23445f6373f251ce6c70e0edd5a70ce`.
These are prospective code corrections. The preserved failed classification and
artifacts of `memory-2932458470ba` are unchanged. No VPS access, deployment, capture
activation, real memory test or scientific comparison is part of implementation.

## Shared REST egress

HTTP 403 remains terminal. HTTP 429 and 503 enter shared cooldown. Valid
Retry-After delta seconds or HTTP-date is honored, including server-directed
waits beyond five minutes. Without a valid value, exponential backoff starts at
30 seconds with +/-20% jitter and is capped at 300 seconds. Successful recovery
resets backoff; failed recovery continues cooldown. No immediate retry loop exists.
Only one fresh caller may make a recovery request after cooldown. Calls already
queued when throttling was observed are invalidated; cooldown/in-flight recovery
calls are receipted as skips rather than accumulated. CHAIN RPC is independent.
Serial transport, minimum 500ms start spacing, 60 total starts per rolling minute
and maximum 20 v2 starts are unchanged; recovery has no extra request allowance.
Wallets, polling cadence and comparator formulas are unchanged.

REST_PAGE and REST_POLL retain HTTP failures and their quarantine evidence.
`scheduling.state=THROTTLED` exposes gaps; `recoveryAttempt` distinguishes probes.
Scheduling denial stays SKIPPED, with null request/response/status and no invented
raw evidence or quarantine recovery. After an earlier successful page, the linked
`skippedRequest` records the denied page without mislabeling the earlier request.
All completeness classifications remain UNKNOWN_UNPROVEN. An empty recovery poll
cannot resolve a publication quarantine.

Legacy and v2 receipts use transport-sampled requestStartUtc, retaining separate
queueIntentUtc. Fetch rejection also carries the actual start. Existing injected
fetch adapters without transport metadata retain an explicitly labeled
FETCH_BOUNDARY_FALLBACK; this fallback is not a transport timing proof. Production
restGet supplies the transport timestamp. Rate-limit headers are a fixed nine-name
allowlist capped at 256 characters each; arbitrary response headers are excluded.

## Memory harness

The independent guardian's frozen 7200s deadline and 15/15/90-minute phases remain
unchanged. Scope RuntimeMaxSec now has a 30s coarse fallback offset, maximum 6330s
from observer launch, so it does not expire concurrently with the guardian's
normal deadline cleanup. BindsTo still independently stops the scope if the
guardian terminates. This offset never authorizes additional acquisition time.

A manager kill failure is benign only with independent stop proof: the exact
scope is inactive with the captured invocation or gone; the retained verified
cgroup is empty or gone; the owned process group is gone; and the direct child
has exited. Missing/unsafe proof, any other cleanup error or live process fails
closed. The summary preserves the manager error plus benign-race proof.

Every observer telemetry sample adds only active_file, inactive_file, file_mapped,
shmem, file_dirty and file_writeback from a bounded 16KiB memory.stat read. Existing
RSS/PSS, memory current/peak, swap, PSI, OOM, JSONL and log bounds remain intact.
Deployment and any new real test require separate authorization after PR review.
