# Quarantine accounting and proof-backed recovery V1

Repository-only correction from `71ddacf318cccb1c5bef1a2263ac6cb00ae75ed3`.
No production installation, ledger rewrite, capture restart or comparison launch.
Acquisition policy is unchanged and pagination stays disabled in runtime wiring.

## Cause and correction

The capped-page path in `RestPoller.pollWallet` wrote a random quarantine for
successful limited-coverage pages. Ten equivalent pages therefore produced ten
unresolved operational failures despite only 100 distinct published identities.
Raw trade publication recovery had no identity with which to resolve these rows.
`dataQuality` escalated at ten unresolved quarantines. That threshold is unchanged.

Every REST_PAGE/REST_POLL receipt remains authoritative, including response status,
page size, pagination setting, stop reason, publication result, identity-vector
hash, boundary identities and timestamps. Successful capped/unstable pages now
contribute coverage occurrences rather than operational quarantines. Failures
retain the existing quarantine paths. `UNKNOWN_UNPROVEN` and sticky completeness
uncertainty are unchanged; HTTP success never proves historical coverage.

Coverage groups use source, wallet, UTC-hour period, limit, stop reason, overlap
and pagination classification. Hourly groups preserve separated periods rather
than pretending one lifetime warning describes every interval. Occurrence counts,
first/latest clocks and first/latest receipt references are derived on disk.
All individual receipts remain reconstructible; `coveragePeriods` pages at most
100 groups. No lifetime in-memory deduplication set is introduced.

Historical quarantine rows are preserved byte-for-byte. Only OTHER rows with an
exact page receipt link, exact source/wallet/poll/reason, no event identity, HTTP
200, complete identity vector, successful outcome and successful publication can
be classified as historical coverage warnings. They remain scientifically
ambiguous, not RECOVERED. Unlinked, failed, malformed and partial publications
remain operational failures. The projection includes retained totals and separate
coverage-warning counts. The status collector/UI show persistent coverage and
unresolved operational failures separately.

## RPC proof contract

Transport RPC recovery and quarantine recovery are different. A successful RPC
range receipt alone cannot resolve a quarantine. The watcher emits a new
`rpc_publications.ndjson` proof only after the range response is validated, every
relevant log processed/published, no pending/removed/terminal-uncertain record
prevents proof, and block checkpoints plus the cursor are durably published.
The proof binds requestId, exact range, response hash, cursor hash and processing
clock. Original failed request IDs/parameters remain in the RPC ledger.

Reconciliation targets one explicit processed proof, compares complete failed
range containment and the same method/component/filter, and resolves only
non-event CHAIN failures linked to the original RPC request. Terminal and
identity-specific failures are not upgraded. Resolutions reference the retained
proof and are idempotent. Replay is proof-specific and capped at 1,000 pending
failures per invocation; repeat the same proof if that cap is reached. Normal
online reconciliation never rescans all retained publication proofs.

A crash after proof append but before resolution can be recovered by explicit
proof-specific reconciliation after index rebuild. Restart never invents
processed-range proof from old HTTP/RPC success. Historical transport-only
success therefore remains insufficient for quarantine recovery. This repository
change does not retroactively certify the stopped experiment.

The operational SQLite cache version changes from 6 to 7 and rebuilds by
streaming immutable journals. This is disposable cache schema, not a production
trading database migration or scientific authority rewrite. Storage telemetry
includes the new proof journal; existing resource thresholds are unchanged.

## Measured fixture reproduction

Same bounded offline fixture, original source versus corrected source:

| Metric | Original | Corrected |
|---|---:|---:|
| Successful REST page receipts | 10 | 10 |
| Poll receipts | 10 | 10 |
| Distinct published source identities | 100 | 100 |
| Independent unresolved operational failures | 10 | 0 |
| Coverage occurrences / periods | represented as 10 quarantines | 10 / 1 |
| Completeness | UNKNOWN_UNPROVEN | UNKNOWN_UNPROVEN |

Tests cover real poller receipts, actual HTTP/malformed/publication failures,
legacy receipt-linked warnings, separate periods/sources/wallets/mechanisms,
cache rebuild, actual empty/nonempty watcher range scans, failed cursor and event
publication, terminal malformed data, partial/different-filter proof denial,
duplicate resolution, restart, and current-proof-only resource behavior.

Source identity, gross normalization, chronological arrival clocks, comparison
eligibility, frozen comparator and authority files, cohort, cadences and trading
controls are unchanged. The repository has no trading/signing capability added.
CI results and independent review are recorded in the draft PR.
