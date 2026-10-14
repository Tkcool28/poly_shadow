# V2 cursor compatibility and bounded proof contract (draft V1)

Status: **DRAFT — contract and test setup only, not implementation or deployment**.

## Purpose
Validate Polymarket Data API v2 cursor-based REST_TRADES and REST_ACTIVITY collection for the same five approved wallets and frozen identity/observation semantics. The acquisition objective is *additional trustworthy evidence*, not lower warning counts. This contract follows merged quarantine accounting PR #12 and acquisition audit PR #11. It does not authorize a 24-hour comparison or production source switch.

## Phase 0: Read-only repository and provider contract verification
- Verify both v2 endpoint URL paths, request filters, response envelope, casing, cursor and terminal signals against official documentation **as of execution**; specifically verify any advertised v1 retirement date. Do not assume a matching v1 field is unchanged.
- Freeze the existing five-wallet cohort and source-native identities, trading roles, event population, timestamps, filter semantics and comparator contract before changing adapters.
- Prepare raw v1/v2 fixture pairs with deterministic hashes and request/response metadata. Mark unavailable fields and unproved mappings as blockers, never silently synthesize values.
- No production keys, paper backend modification, live-money execution, source publication into a production run or host manipulation.

## Phase 1: Deterministic offline tests
- Decode v2 TRADES and ACTIVITY into frozen identity and normalization functions; demonstrate field-by-field semantic compatibility including maker/taker, transaction hash, outcome/asset, amount, price, event type and timestamps.
- Exercise single, multiple, empty and final pages; explicit has_more/next_cursor combinations; repeated/expired/invalid cursors; malformed envelopes and partial bodies; mid-traversal API errors; duplicates across pages; out-of-order updates; source cache delay.
- Fail closed on ambiguous identity, unknown completeness, incompatible source population or invalid cursor. A traversal exhausted according to the API does not establish scientific source completeness.
- Use bounded/disk-backed dedup and deterministic replay. No unbounded in-memory history or retry queue.

## Phase 2: One bounded GitHub Actions public probe
- Manual workflow dispatch or explicitly approved one-shot CI only: no scheduled jobs and no automatic probe on every PR update.
- Use no production credentials; host/network allowlist; preserve exact raw response bytes, bounded receipt metadata, response hash, cursor chain and stop reasons.
- Maximum three pages of 100 records per wallet/source traversal; one global in-flight request; shared <=60 requests/minute, <=2 requests/second, burst <=2; traversal <=8 seconds, per-request <=3 seconds; response body <=1 MiB; no inline retries. Budget exhaustion remains UNKNOWN_UNPROVEN.
- Do not assume caps are reachable simultaneously: skip/defer requests when deadline/budget would be exceeded.
- Demonstrate added unique identities beyond first page, matched/mismatched v1/v2 identities, economic candidate support, unstable cursors, server response/caching and first-arrival latency. Do not call additional identities proven missed economic trades.
- Preserve existing disk reserve gates; proposed REST append cap 8 GiB/24h is a ceiling needing stress simulation, not a measured production estimate.

## Phase 3: Decision gate
Provide exact CI run/artifact, SHA-256 manifest, pass/fail table, v2 identity compatibility, bounded traversal and resource results, scientific unknowns, and explicit GO/NO_GO for a *short* future CHAIN-correlated test. If public CHAIN receipt access gives 403, mark corroboration UNKNOWN, not zero; do not rotate providers to evade restriction.

Only after review of this separate contract/implementation should an authorized short VPS run be considered to test live observer-to-CHAIN correlation, restart/checkpoints, end-to-end evidence integrity, memory and disk pressure. Keep the stopped comparison stopped; do not create real authority, merge automatically, deploy, switch source or start a 24-hour comparison.

## Required PR outputs
Separate draft implementation PR and offline/CI probe evidence; source identity fixtures and hashes; negative tests for cursor anomalies and mutation/race conditions; explicit proof of baseline invariants; independent code review; and a recommendation for the next *short* validation stage.
