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

## Implementation review addendum (2026-10-14)

The draft at `e677e665512b2544a7d1a427ab7d8ef78c80bed6` governs the isolated
implementation. The following clarifications do not alter frozen comparison rules:

- “Authenticated termination” means a valid HTTPS provider response with mutually
  consistent `has_more=false` and explicit `next_cursor=null`. This public client
  has no provider cursor signing key and cannot independently verify its signature.
  Scientific completeness remains `UNKNOWN_UNPROVEN` on every exit.
- The documented feed order is `(block_timestamp, sequence_id)`. Response schemas
  expose `timestamp`, but not `sequence_id`. The adapter can reject timestamp
  inversions; equal-time ordering and delayed-indexing completeness remain UNKNOWN.
  It does not invent a tie-breaker or change chronological comparison ordering.
- v2 TRADES documents a default 0.01-share floor (zero means the same floor).
  The legacy default floor is unspecified. Field identity compatibility is testable;
  total population equivalence, including sub-centishare fills, is not established.
  The research evidence cannot authorize a production source replacement. A proved
  incompatible required identity stops publication; population uncertainty remains
  explicit and must be resolved before a governed collector migration.
- “First-arrival latency” cannot be measured by a one-time historical API sample.
  The campaign records actual response arrival, HTTP latency and event timestamp
  age. A future separately authorized live CHAIN-correlated test is required.
- Explicit identical start/end bounds pin this sample's event-time query, not a
  provider indexing snapshot. No whole-history scan is authorized.

- Superseding clock gate: response arrival and normalization completion are distinct
  events even when wall-clock resolution gives equal values. The initial campaign
  did not separately measure completion and therefore does not pass the point-in-time
  compatibility gate. Evidence version2 records normalization clocks independently;
  replay rejects version1 timing and never backfills it. A new public test requires
  separate authorization. See V2_CLOCK_COMPATIBILITY_REVIEW_V1.md.
