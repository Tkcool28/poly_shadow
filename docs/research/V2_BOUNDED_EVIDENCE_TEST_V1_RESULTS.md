# V2 bounded evidence test V1 — results

**Repository-side verdict: PASS. GO for a separately authorized short CHAIN-correlated
validation only. No production source switch or new 24-hour comparison.**

## Source and execution identity

- Repository: `Tkcool28/poly_shadow`; verified starting/current main before edits:
  `0a776fce2c2d01bd15f9f0a6cd733fc142393773`.
- Branch: `feat/v2-cursor-bounded-evidence-test-v1`.
- Draft [PR #14](https://github.com/Tkcool28/poly_shadow/pull/14), left open/unmerged.
- Public campaign PR head: `34ef59cdc4bd71704ad277fcba67f7fb56243c9f`.
- Actions checkout used its synthetic merge SHA:
  `05ad9ba19c9fdb637471d09b4165620c3fbd77cb`, recorded in campaign.json.
  This is not the PR branch head; the research files match the PR implementation.
- Campaign: 2026-10-14 20:22:54.409–20:23:17 UTC, 22.808s including analysis.
- [One-shot public Actions run](https://github.com/Tkcool28/poly_shadow/actions/runs/38631531073):
  PASS, including offline gates, acquisition and full offline evidence replay.
- Artifact `v2-bounded-evidence-v1`, ID11925734422, expires2026-11-13.
  The exact ZIP was downloaded and preserved separately for review.
- ZIP SHA-256: `11a5ab64c1bc8f075da8b9f057ead4de9e497deb63ba163eb6f2e5affe940290`.
- Manifest SHA-256: `caca65cb03524f2cb68f26cd62a16d1391ec47ca3ac24e30039a45bd89261f95`.
- Replay publication digest:
  `222a3218723c015bbfc8652792df77afd947839730d339ca601b74e61a66da23`.

The exact raw bundle contains 49 manifest-listed files plus manifest.json:
43 original bounded responses, receipts, checkpoints, 3,000 normalized publications,
SQLite durable evidence and summaries. Repository evidence/ contains the original
five metadata/index files; response bodies/database remain in the exact artifact ZIP.
To reproduce, extract the ZIP into an isolated directory, then run:

```sh
node --max-old-space-size=128 --import tsx research/v2-cursor-v1/replay.mts /absolute/extracted-directory
```

Replay checks every raw hash, all published rows against frozen normalization,
all manifest files and the exact deterministic summary. It makes no network calls.
Do not point replay or acquisition at production evidence.

## Reviewed provider and identity contract

[API/identity matrix](V2_CURSOR_API_AND_IDENTITY_V1.md) and
[reviewed governing contract](V2_CURSOR_COMPATIBILITY_TEST_CONTRACT_V1.md) contain
primary documentation references, verification date and explicit inconsistencies.
Current official migration notice still specifies v1 retirement2026-10-24.
Public `/v2/trades` and `/v2/activity` actually returned the documented snake_case
rows and `data`/`pagination` envelopes. All cursors were followed verbatim with
identical source/wallet/filters/event-time window. No offset query, credentials,
provider rotation, retries, fabricated fields or historical-arrival inference.
The request end was fixed at campaign start; no incoming indexing snapshot is implied.

1,000 actual paired v1/v2 fixture rows (100 per source/wallet) matched frozen
identities and normalized economic fields, with **zero identity mismatches and zero
normalization mismatches**. Raw response003 is the first legacy trades fixture,
response004 its v2 counterpart; subsequent pairs are indexed by requests.ndjson.
The unchanged functions in src/shadow/racing.ts govern tx/wallet casing, token and
condition identity, numerical precision, source-type distinctions, UNKNOWN REST
role, arrival constraints and coarse candidate grouping. Same transaction hash
alone is never a storage identity. Profile enrichment is not fabricated.

Population equivalence remains UNKNOWN: documented v2 TRADES default floor is
0.01 shares (zero means the same floor), while the legacy default is unspecified.
This sample has not established equivalence below that floor. Equal-timestamp
sequence order is also unverified because response rows expose no sequence_id.
Neither uncertainty was compensated by changing frozen science.

## Measured incremental evidence

Exactly five approved wallets, both sources. All30 v2 pages contained100 records.
Every traversal added two pages and stopped PAGE_BUDGET while has_more remainedtrue.
All ten first pages were saturated. No cursor loops, inconsistent envelopes,
timestamp inversions, publication failures or cross-page identity duplicates occurred.
There was no live terminal-page traversal; its behavior is covered offline only.

| Wallet | Source | First page | Extra pages / raw rows | Extra distinct IDs | Duplicates | New candidate groups* | Known groups gaining support* | HTTP ms | Source age seconds (newest–oldest) |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 0x82cf2b31d18fca19830e216b98cffa5dbc6c0998 | trades | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 207–220 | 201059.1–5794158.1 |
| 0x924379a79c64b77ad5816ad362122a5f6228658e | trades | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 203–213 | 15649.3–24620.3 |
| 0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029 | trades | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 197–256 | 60940.3–233461.4 |
| 0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b | trades | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 221–241 | 23.4–36424.4 |
| 0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227 | trades | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 199–210 | 1515.3–91429.3 |
| 0x82cf2b31d18fca19830e216b98cffa5dbc6c0998 | activity | 100 | 2 / 200 | 200 | 0 | 129 | 25 | 276–301 | 157078.4–4430346.4 |
| 0x924379a79c64b77ad5816ad362122a5f6228658e | activity | 100 | 2 / 200 | 200 | 0 | 199 | 1 | 284–327 | 5051.5–24630.4 |
| 0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029 | activity | 100 | 2 / 200 | 200 | 0 | 148 | 30 | 269–289 | 59939.4–233297.4 |
| 0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b | activity | 100 | 2 / 200 | 200 | 0 | 200 | 0 | 296–365 | 33.4–36434.4 |
| 0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227 | activity | 100 | 2 / 200 | 200 | 0 | 195 | 0 | 283–336 | 1525.4–91439.5 |

*Candidate columns compare against the union of all sampled first pages; rows
across REST sources overlap and must not be summed as unique economic trades.
The machine summary's per-source group columns instead use that source's own
first page; global totals agree. Union totals are:

- **2,000 additional distinct source identities**, all approved-wallet relevant:
  1,000 TRADES +1,000 ACTIVITY.
- 1,927 are TRADES-source or TRADE-activity identities;73 are other activity.
- **1,000 new coarse economic candidate groups** absent from all first pages.
- **56 existing candidate groups** gained supporting evidence beyond pageone.
- **One candidate** was corroborated by the one sampled CHAIN receipt.

These are not2,000 missed trades or1,000 proven new economic events. A coarse
tx+asset+size6 candidate is a reconciliation hypothesis, not an event primary key.

## Freshness and resource measurements

V2 newest event timestamp equaled legacy's newest timestamp in all10 pairs.
This sample demonstrates deeper history, not materially fresher observation.
Newest returned evidence ranged from23.35s to201,059.13s old; sparse-wallet
history extended to5,794,158s old. Event age does not distinguish wallet inactivity
from source indexing lag. No true event-to-first-discovery latency was measured.
V2 HTTP latency:197–365ms, median262.5ms; maximum of all43 requests452ms.
Date/Age/Cache-Control/ETag and status response are preserved, without assuming
that successful response freshness proves the feed's population completeness.

| Control | Measured result |
|---|---|
| REST requests |42:30v2 +10legacy pair pages +OpenAPI +status; shared60 total/min ceiling |
| CHAIN requests |1public eth_getTransactionReceipt; no retry or alternate host |
| Concurrency |1, no overlapping REST requests |
| Rate |2/sec+burst2 token-bucket envelope independently verified; minimum tokens0.998 |
| Dispatch timing |Mostly500ms; three499ms gaps; six3-dispatch spans999ms |
| Traversal ceiling |All original-deadline traversals <8s; all requests <3s |
| Response body |Max156,547B <1MiB;3,286,403B all raw responses |
| Memory |166,776,832B complete-process peak RSS (159.05MiB) <256MiB;128MiB V8 heap cap |
| Evidence disk |18,648,863B unpacked;2,122,878B ZIP;logical append charge21,791,463B |
| Disk reserve |91,264,249,856B available;unchanged full prelaunch gate27,096,358,240B passed |
| Append ceilings |64MiB one-campaign cap, stricter than8GiB/day;negative exhaustion tests |
| Pending state |Sequential ten traversals;at most100decoded rows/page;SQLite cache2MiB;no whole-history replay |

The raw499ms timing is disclosed, not rounded into a strict500ms claim. It did
not exceed the authorized token-bucket envelope. A reviewed follow-up rechecks
remaining spacing after early timer wakeups; its deterministic regression passes.
**No second public campaign was run.** Byte/memory/disk/deadline/cursor budgets
have negative offline tests. One short run is not a steady-state growth forecast.

## CHAIN corroboration

The previously used public host polygon-bor-rpc.publicnode.com returnedHTTP200
for exactly one receipt, not403. No VPS credentials or provider rotation were used.
Transaction:
`0x00387edfa28aa2ace8c67ae4e354e3bd76f15f518454eab468f73b2af08b38df`.
The successful receipt's26logs had matching transaction/block linkage. Frozen
allowed-emitter decoder/role classification yielded one approved-wallet MAKER_LEG,
7.843138shares, matching both third-page (zero-based page 2) TRADES and ACTIVITY evidence for
walletfea31bc…. This supports one candidate only. All unsampled candidates have
UNKNOWN CHAIN corroboration; receipt success alone was not counted as a trade.

## Offline, CI and independent review

Final focused suite:50 tests coverC1–C15, including terminal/empty/multipage,
loops/invalid cursors, malformed/partial responses, duplicates/population movement,
publication rollback, checkpoint mutation/crash/replay, real mocked transport
limits/cancellation/early wake, bounded disk/memory, frozen identities, UNKNOWN
completeness, approved cohort and production isolation. TypeScript includes all
research TS/MTS files. Static safety passes. PR12 regression preserves ten
successful limited receipts/ten occurrences and zero unresolved operational failures;
normal completeness remainsUNKNOWN. Adapter publishes auditable receipt failures,
and adds no production quarantine path.

Local broad runs are not claimed green: missing Pythonrfc8785 and denied local
tsx IPC caused authority/lifecycle failures. The supported CI installs pinned
Python dependencies and runs Node22 plus Python3.12/3.14. Its final results are
recorded in the PR and final review status below.

Independent agent review inspected implementation and actual raw evidence. It
independently verified all49 manifest files,43 response hashes,10fixed-filter
cursor chains,3,000normalized rows,1,000actual version pairs,CHAIN proof and
resource measurements. Blocking findings were corrected before acquisition;
the timing follow-up has a passing offline test. Verdict:PASS/no blocking findings,
subject to final CI. This is independent agent review; human PR approval remains
outstanding. No production access or additional public probes occurred in review.

## Recommendation and next scientific milestone

**GO only for a separately authorized short CHAIN-correlated validation**, with
same wallets/identities, explicit duration/request/disk ceilings and honest
UNKNOWN_UNPROVEN. Measure real-time first arrival, delayed observations, CHAIN
matching, restart/checkpoints, quarantine classification, memory, disk and hashes.
This assignment does not execute that future test.

Keep three pages as a ceiling, not a per-poll entitlement. Existing10sTRADES /
30sACTIVITY across5wallets already consume40first-page requests/min; maximum
depth every poll would consume120/min, exceeding60. A future design needs one
shared60/min scheduler, bounded work slots (one per wallet/source), and a maximum
20/min remaining continuation budget under those cadences, or a separately
reviewed slower schedule. Never expand queues or request budgets automatically.

Before a production migration or new24h decision, resolve the v2size-floor
population question, unexposed tie order/indexing/cache limitations and operational
restart/disk behavior under a short test. No repository-side execution blocker
remains after green CI; scientific completeness and production suitability remain
unproved. No VPS was accessed; no Poly2, production collector, trading control,
authority, wallet approval, frozen protocol, schema or comparison rule changed.
Nothing was merged, deployed, restarted or launched as a24hcomparison.
