# Prospective acquisition readiness correction V1

Starting Shadow main: ab95290e82c2501fa9fc77d511b975f89f2f744d.
Read-only baseline main: 219ad2c66442632b5e41506ba485062420a27c15.

Work in progress. This draft does not authorize deployment or any runtime experiment.
Scope: diagnostic fresh discovery and bounded durable continuation, CHAIN coverage
evidence, host clock health, and the existing diagnostic report/panel. Certified
matching, authorization, wallet approvals and Poly2 remain unchanged.

## Diagnostic REST scheduling correction (requires PR review)

Only the separate diagnostic runner supplies `SHADOW_DIAGNOSTIC_START_UTC`.
Certified launchers and default configuration retain their existing schedules.
The diagnostic uses the same V2 endpoints/native identities, but removes its
duplicate legacy requests. Each existing sequential 60-second cohort cycle gives
all five wallets/both endpoints one FRESH_DISCOVERY page before giving each one
HISTORICAL_CONTINUATION page. Cohort rotation and alternating endpoint priority
remain. A busy cycle is skipped. Discovery may wait for bounded work from the
prior cycle; it never waits for an unbounded history walk.

This is an explicit diagnostic scheduling amendment for review: legacy 10s/30s
requests are replaced by prioritized 60s V2 cohort turns, at most twenty starts
per rolling minute rather than sixty legacy+V2 starts. No increase in provider
load. Shared serial transport, >=500ms spacing, 20 V2/60 total rolling-minute
ceilings, 403 refusal, 429/503 cooldown/backoff/single recovery probe, 100 rows,
1 MiB body, 3s request/8s turn limits and storage gates remain. A turn is one page,
so fresh discovery cannot spend its allocation traversing historical pages.

Fresh queries cover the frozen diagnostic start minus 120 seconds through the
current poll's inclusive end. This overlap is recovery opportunity, NOT a lateness
bound or complete-coverage assertion. Old events in that overlap remain old.
A busy wallet with >100 recent rows can still have unvisited pages; receipts
retain the actual next-cursor availability and UNKNOWN_UNPROVEN. There is no claim
that the fresh query recovers every delayed-indexed event or that a 60s poll is
low-latency enough for adoption.

History starts with existing three-year filters and freezes its inclusive end
and complete parameter set across keyset turns. A checkpoint contains endpoint,
wallet, exact filters/order/page configuration digest, next opaque cursor, prior
cursor, cumulative pages, last timestamp and the successfully published page's
identity vector. Publication/receipt journals are fsynced before a FULL fsync +
atomic rename + directory fsync checkpoint. A crash before advancement replays
the prior page, retaining first publication clocks via existing exact indexes.
The last page's identities must still be published before resume. State is only
10 bounded files; no lifetime cursor/identity set is retained in RAM.

Query mismatch, corrupt state, absent publication boundary, >1h local retention
age, >1s future checkpoint, rejected/expired cursor (400/410), repeated cursor or
ordering anomaly is explicit invalidation + UNKNOWN coverage. The next recovery
turn reanchors safely. One hour is a conservative LOCAL validity policy, not a
provider TTL. API exhaustion rotates to a new bounded history pass on the next
turn; it is never a source-completeness proof. HTTP/transport failures and quota
skips do not advance checkpoints. Late inserts behind a seek anchor may be
unseen until reanchoring; that range remains unknown.

Official contracts rechecked 2026-10-22 (documentation reads only, no cohort API
or RPC requests):
- https://docs.polymarket.com/api-reference/feeds/list-trades
- https://docs.polymarket.com/api-reference/feeds/list-account-activity
- https://data-api.polymarket.com/v2/docs

These describe keyset timestamp/sequence anchors, opaque cursors, fixed filters,
activity direction binding and explicit next_cursor. They provide no verified
snapshot/indexing-completeness guarantee or cursor lifetime. We never decode a
cursor or manufacture a sequence tie-breaker.

## CHAIN evidence

Existing head RPCs now retain initial/latest observed head and UTC. Successful
selected-topic scan chunks retain actual boundaries/hash and a contiguous range;
nonadjacent chunks increment a sticky gap counter. Reorg recovery invalidates
prior contiguous height before replay; existing proved-ancestor/tombstone behavior
is unchanged. RPC success without a successful published scan is not coverage.
Startup head/scan failure now retains periodic startup retry rather than losing
its verifier. No new RPC cadence or shutdown RPC is introduced.

Shutdown drains existing local work for at most 3s, then records the LAST observed
head (explicitly not a new shutdown observation), final scan/cursor and tail gap.
Unavailable head and interrupted drain yield null final head and UNKNOWN tail.
A crash/SIGKILL cannot create a terminal proof. Journals and runtime telemetry
remain evidence of what was actually retained; incomplete ranges stay unknown.
Positive eligible OrderFilled and OrdersMatched-only replay are offline tests;
no positive live fill is claimed by this PR.

## Clock and report

At diagnostic start, every 60s and termination, bounded local chronyc tracking /
timedatectl reads retain UTC, monotonic reference, synchronization, host offset,
root distance, source, duration and failure reason in clock_health.ndjson.
Chrony root distance is abs(root delay)/2 + root dispersion; timesyncd uses its
reported measured Root distance. Each command has a 1s timeout and bounded accepted
output. No settings are changed and no provider clock is queried/inferred.

Host quality requires synchronized state, abs(offset)<=100ms and root distance
<=100ms. These conservative bounds qualify host observations, not submillisecond
accuracy. >250ms wall/monotonic disagreement, missing evidence, excessive offset /
uncertainty or >120s sampling gaps make conclusions uncertain. Existing >2s runner
wall-discontinuity failure and exact timestamp/matching math remain unchanged.
Raw detection clocks are never adjusted. Provider-event clock offsets remain
UNKNOWN even with a healthy host. Existing observed timing samples are retained
with explicit matched-event support and provider-event uncertainty fields.

The existing diagnostic report/panel adds unique prospective/recovery/unknown
origin counts, latest event timestamp, traversal/budget/unvisited state, CHAIN
head/scan/gaps and bounded latest clock measurements. Transport success is kept
separate from coverage sufficiency. Explicit history acquisitions cannot enter
prospective timing even when an event timestamp is inside the run window.
Certified Stage 1 fields, compareV2(), event semantics and trading safeguards
are unchanged.

## Review / deployment prerequisites

Tests/CI and independent final-head review are recorded in the draft PR. No
runtime experiment was performed. After review and user-controlled merge,
separate authorization is required for deployment and a 60-minute validation.
Verify exact merged revision, fixed cohort, healthy existing Poly2 ingestion,
PAPER/live/V5 controls, current host headroom and bounded clock commands. Validate
fresh discovery, checkpoint restart, final scan/head/clock evidence and real
matched events or NO_MATCHED_EVENT_OBSERVED. A 24-hour launch requires a separate
user decision after that evidence review. No past smoke evidence is rewritten.

## Independent review corrections

The first source review found false interval union for disjoint backward scans,
stale-head qualification, old-fork scan metadata after reorg, interrupted-drain
qualification and recovery corroboration suppressing a valid prospective match.
Corrections retain only actual contiguous intervals, invalidate head quality after
120s, clear superseded scan metadata at rewind, and separate recovery members
from independently prospective groups. The diagnostic adapter retains original
native identities/group references; certified matching is unchanged. Host clock
wording now distinguishes measured synchronization from unknown provider offsets.

A subsequent reviewer-confirmed adapter defect allowed explicitly typed nontrade
activity with an asset to become an economic trade candidate. The diagnostic now
retains those native observations, latest event clocks and transport metrics in a
separate nonTradeActivities count, excluding them from trade groups and timing.
REDEEM with the same transaction/asset/size as a baseline trade cannot manufacture
a match; an explicit TRADE fixture still matches. The frozen normalizer and
certified comparator are unchanged.
