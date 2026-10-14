# REST evidence acquisition feasibility V1

**Recommendation:** do not repeat a full-day first-page-only comparison. There is
measurable additional approved-wallet evidence, but offset-boundary drift, source
cache freshness and unverified CHAIN corroboration need a shorter controlled proof
first. Prefer a separately governed v2 cursor adapter over expanding investment
in legacy offsets, subject to frozen identity compatibility tests.

## Scope and reproducibility

Workstream B is isolated from accounting fix PR #12. Starting source is GitHub
`Tkcool28/poly_shadow` main `71ddacf318cccb1c5bef1a2263ac6cb00ae75ed3`.
`219ad2c66442632b5e41506ba485062420a27c15` is the user-supplied historical Poly2
experiment revision, not a current-main assumption. This research changes no
collector runtime, protocol, cohort, comparison rule or trading control.
No further VPS access occurred after the user clarified repository-only scope.
Historical incident counts are supplied incident evidence, not replayed here.

One bounded public CI sample ran on 2026-10-14, 19:22:22–19:22:43 UTC:

- Research source: `061a3a8a394bbf0c837e3afed9d86752c4bfc558`.
- Actions run: https://github.com/Tkcool28/poly_shadow/actions/runs/38623083221
- Artifact: `bounded-rest-evidence-v1`, ID `11923025619`.
- ZIP SHA-256: `bf3ebdc62fdf6fa5bf61e96473556c0dd25808c724fd34cbfec3f83a7c1fdebb`.
- 40 REST GET requests: two endpoints × five wallets × offsets 0, 98, 196,
  followed by an immediate repeated offset 0. `limit=100`; trades retained
  `takerOnly=false`. These are current unanchored queries matching existing
  population settings, not a reconstruction of the stopped experiment.
- One public `eth_getTransactionReceipt` read returned 403; the harness stopped
  that host and made none of the remaining five budgeted receipt requests.
- Total observed wall time 21.65 seconds. All response bytes, status/headers,
  request/response clocks and SHA-256 values are retained. Every original
  artifact-manifest hash was independently checked after download (42 entries).
- Offline `supplement.mts` reproduces timestamp/candidate support analysis with
  the frozen repository identity/group functions; it makes no network requests.
- The sample workflow only runs when a research PR is opened. Later report-only
  revisions do not silently make another sample. No scheduled polling is added.

The existing source-native identity functions—not transactionHash-only dedup—
count additional identities. A coarse economic candidate group is the existing
`tx + asset + size6` hypothesis; it is neither a primary key nor proof of a unique
real-world trade. Identity collisions and cross-source population differences
remain part of the comparison contract.

## Verified API capabilities and limits

Authoritative pages inspected on 2026-10-14:

1. [Legacy trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets):
   offset pagination; limit up to 10,000 and offset up to 10,000; start/end epoch
   second filters. Existing identity fields and taker filter must be preserved.
2. [Legacy activity](https://docs.polymarket.com/api-reference/core/get-user-activity):
   limit up to 500, offset up to 5,000; start/end and sort controls. Documentation
   states stable ordering for identical queries, including direction. This does
   not establish a cross-request snapshot under delayed indexing or mutations.
3. [Rate limits](https://docs.polymarket.com/api-reference/rate-limits):
   v1 general 1,000/10s, trades 200/10s; no activity-specific v1 row. v2 general
   800/10s, trades 300/10s and activity 200/10s. These advertised ceilings are not
   reserved capacity or a reliability promise. No rate-limit stress test was run.
4. [v2 contract](https://docs.polymarket.com/api-reference/data-api/overview):
   cursor-only pagination, shared data envelope, exact has_more/next_cursor
   traversal signals, with unchanged feed filters required across pages. These
   are documented capabilities, not measured v2 compatibility in this sample.
5. [Migration notice](https://docs.polymarket.com/migrate/data-api-v1-to-v2):
   v1 retirement is scheduled for **2026-10-24**; v2 changes response casing and
   pagination. A v2 migration must be a separately reviewed adapter/identity
   compatibility task. Do not substitute endpoints in Workstream A.

No snapshot token, immutable historical population or provider-indexing
completeness guarantee was established for the legacy queries. Returned pages
were descending by timestamp in this sample, but equal-timestamp tie behavior,
concurrent movement, server-side cache age and late indexing still matter.

## Measured incremental evidence

All 40 REST responses were HTTP 200. All 20 offset-zero requests, including the
ten repeats, returned 100 rows: 20/20 sample saturation. This is a short current
sample, not an estimate of the incident's entire poll distribution. The supplied
incident separately reports saturation on 2,310 successful requests.

| Approved wallet | TRADES distinct beyond first page | ACTIVITY distinct beyond first page |
|---|---:|---:|
| 0x82cf2b31d18fca19830e216b98cffa5dbc6c0998 | 196 | 193 |
| 0x924379a79c64b77ad5816ad362122a5f6228658e | 196 | 196 |
| 0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029 | 196 | 196 |
| 0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b | 195 | 196 |
| 0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227 | 196 | 196 |
| Total source-native identities | **979** | **977** |

The 20 deeper pages returned 2,000 rows: 1,956 distinct additional identities
and 44 repeated rows under repository identities, including planned overlap.
All 1,956 involved the controlled wallets. Of these, 1,884 were trade-source or
TRADE activity identities; 72 were other activity populations. They must not
be counted as 1,956 recovered missed trades.

The trade identities represented 1,036 coarse candidate groups. Of those, 979
were absent from the union of sampled first pages; 57 already had first-page
support and gained additional source evidence. These are candidate/support
counts, not verified counts of new economic events. CHAIN verification remains
**UNKNOWN / BLOCKED_HTTP_403**, not zero matches or proof that REST was wrong.

## Ordering, timeliness and reconciliation risks

Nineteen of twenty two-row overlap boundaries matched exactly. The first trades
boundary for wallet `0xf528…7e5b` did not. All ten repeated first-page identity
vectors nevertheless matched. Therefore an unchanged first-page hash cannot
prove interior page stability. Offset traversal must stop/record instability,
retain the pages and avoid claiming gap-free coverage.

No within-page descending timestamp violation was observed. All additional
beyond-first-page rows were older than five minutes, with none within either
30 or 300 seconds. They mainly extend historical support in this sample, not
measured low-latency discovery. Across wallets, deeper trades reached roughly
5.8 hours to 67 days back. This says nothing about future burst behavior.

All 20 trades responses advertised `public, max-age=300`; all 20 activity
responses advertised `public, max-age=15`. Age headers were absent in the
recorded sample. These headers do not measure actual index delay, but mean a
10-second trades cadence cannot be assumed to deliver 10-second data freshness.
Keep the current cadences unchanged in A; justify any future timing change with
request/cache/first-arrival measurements, not source timestamps alone.

No stopped-run CHAIN history was read. The one allowed public receipt probe
failed with HTTP 403, and the host was stopped rather than retried or rotated.
No beyond-page identity is certified as an incident miss or a new CHAIN economic
event. A smaller follow-up proof must compare exact role-aware decoded fills,
redundant-leg exclusions, source-native identities and frozen candidate groups.

## Proposed bounded collection design — not enabled

Separate cold historical acquisition from the fast newest-page path. Suggested
initial engineering limits for the next independently reviewed implementation:

| Control | Proposed bound |
|---|---|
| Cohort | Exact existing five wallets |
| Fast polls | Keep 10s TRADES / 30s ACTIVITY pending cache-latency evidence |
| Traversal | At most 3 pages × 100 records per wallet/source; at most 300 returned / 300 distinct hard cap; at most 296 distinct only when both two-row overlap boundaries match |
| Tail refresh | At most two extra pages per wallet/source per minute, not on every fast poll |
| Shared REST budget | 60 requests/minute total, 2 requests/second, burst 2; no hidden retry expansion |
| Concurrency | One active request globally initially; one in-flight poll per wallet/source |
| Time | 8s traversal wall budget; at most 3s/request; do not start a request that cannot fit |
| Retry | Zero inline retries; next scheduled attempt consumes the same global budget |
| Response memory | 1 MiB/body; page size 100; bounded vectors and disk-backed identity membership |
| Appended REST evidence | Initial explicit cap 8 GiB/24h plus existing whole-system disk gate and reserve; never silently delete evidence to stay under budget |
| Backpressure | Defer tails before newest pages; bounded pending work, no catch-up queue growth |
| Checkpoint | Persist query/filter/source-version, original arrival clocks, page/cursor evidence and receipts; resume only exact valid binding |
| Outage/budget end | Stop traversal, retain failure/stop reason and UNKNOWN_UNPROVEN; no invented exhaustion or completeness |

The tail budget adds at most 20 requests/minute to the existing 40/minute across
both sources/cohort. Maximum demand is 60/minute, not 120/minute from paging every
fast poll. If all such pages resembled measured bodies, raw response traffic
would be about 6.64 GB/day (6.18 GiB/day). This is engineering extrapolation, not
measured append growth: production already deduplicates raw identities, while
page/poll receipts, indexes, CHAIN and operational journals have separate costs.
The measured 41 requests totaled 3,073,492 bytes; the largest body was 84,932 bytes.
A 1 MiB body guard alone is not a daily disk bound, so an explicit byte/admission
budget remains necessary. Do not weaken existing reserve or memory thresholds.

For v2, replace offset/overlap mechanics only in a separately approved contract:
fixed filters/window, bounded opaque cursor chain, repeated-cursor detection,
explicit has_more/null exhaustion checks, the same budgets, and source identity
compatibility fixtures. Cursor exhaustion proves only exhaustion of the defined
provider query at that traversal; it does not certify provider history or the
complete multi-source scientific population. Handle expired/invalid cursor as
visible uncertainty, without broadening filters or restarting unbounded history.

## Completeness vocabulary

- Page success: valid HTTP/body plus successful publication of returned records.
- Bounded traversal: all pages actually attempted within budgets succeeded.
- Query exhaustion: documented endpoint-specific exhaustion signal was observed.
- Budget-limited traversal: more pages may exist; explicit stop, not exhaustion.
- Unknown source completeness: provider population/indexing gaps remain unproved.
- Demonstrated scientific completeness: requires the separately frozen full
  source/window/role/publication and comparison proof obligations. None of the
  first five states alone supplies that proof.

Keep `UNKNOWN_UNPROVEN` unless the approved evidence contract proves more.
Neither a short page nor matched overlap alone satisfies that contract.

## Next milestone and remaining blockers

Review A independently. Before authorizing another 24-hour comparison, freeze a
bounded acquisition adapter contract (prefer v2 given retirement), prove
source-identity compatibility and a reproducible traversal under concurrent
updates, and obtain bounded role-aware CHAIN corroboration from an authorized
working read-only source. Then run a separately approved short instrumented proof
that measures incremental identity yield, cache/discovery latency, request/disk
budgets, restart and failure behavior. Do not launch that proof in this task.

Remaining unknowns: CHAIN corroboration (403), v2 live cursor/identity behavior,
longer-duration saturation and source delay, stopped-run gap attribution and true
provider completeness. These prevent a recommendation to launch another full-day
comparison now. They do not prevent reviewing the accounting correction.

Independent offline review: PASS, no blocking counting/scientific flaws. The
reviewer independently recomputed all incremental identity/candidate counts and
verified all 42 original manifest hashes. The 296-versus-300 identity-bound
wording was corrected before final delivery. CHAIN corroboration stays unknown.
