# ARCHITECTURE — Phase 3 multi-source discovery + Phase 4 comparison

Status legend: **[implemented]** = code exists and is test-covered;
**[tested]** = fixture/unit tests; **[observed]** = verified against live
endpoints; **[planned]** / **[not validated]** = explicitly not yet.

## Components

### 1. Polygon V2 chain watcher — `src/shadow/watcher.ts` [implemented, tested, observed]

- WSS `eth_subscribe` logs over BOTH V2 exchange emitters (standard +
  neg-risk) and both V2 topic0s; watched-wallet filtering post-decode.
- `eth_getLogs` backfill gated on the subscription ack; 64-block first-start
  overlap; periodic verifier rescan.
- Durable dispositions (OBSERVED / COMPLETED_NO_OBSERVATION /
  TERMINAL_QUARANTINE / REMOVED_INVALID / PENDING) make restart delivery
  idempotent; tombstones (any reason) dominate PENDING forever.
- Reorg: dense checkpoints (spacing 16 < lookback 128) prove a common
  ancestor; no provable ancestor → fail-closed `recoveryRequired` (cursor
  unmoved, no automatic resume).
- Phase 3 extension: optional `onObservation` callback (constructor arg 5)
  feeds committed observations into the racer. Default no-op; Phase 2
  behavior unchanged.

### 2. REST /trades observer — `src/shadow/rest-poller.ts` [implemented, tested, observed — VPS live acceptance run passed in Phase 3]

- Polls `GET {dataApi}/trades?user={wallet}&limit=100&takerOnly=false` per
  watched wallet on a bounded cadence (default 10s — independently chosen,
  6 req/min/wallet; NOT Poly2's cadence).
- `takerOnly=false` is load-bearing: the endpoint defaults to taker-only,
  which would silently drop the maker population.
- No freshness rejection: late trades are recorded; lateness is measured
  (`sourceTs` vs `sourceFirstSeenUtc`), never used to discard.
- Raw payload + per-request telemetry (request/response times, HTTP status,
  `age`/`cache-control` headers, newest source timestamp, new/duplicate
  counts, errors) preserved per poll.

### 3. REST /activity observer — same module [implemented, tested, observed — VPS live acceptance run passed in Phase 3]

- Polls `GET {dataApi}/activity?user={wallet}&limit=100` (default 30s —
  secondary population, lower discovery priority).
- Treated as a SEPARATE population: the activity `type` (TRADE / MERGE /
  SPLIT / REDEEM / …) is part of the source-native identity. Non-TRADE
  activity has no economic-trade group key and stays visible as
  `ungrouped:{identity}` — never discarded.

### 4. WebSocket trade source — [investigated, REJECTED]

See `docs/shadow/WS_FEASIBILITY.md`. Summary: the public CLOB market channel
carries order-book events with no wallet identity; the user channel requires
banned CLOB credentials; RTDS carries price/comment streams. None provides a
valid watched-wallet trade signal. The Polygon logs WSS already supplies
low-latency chain discovery.

### 5. Source racer / reconciliation — `src/shadow/racing.ts` [implemented, tested]

- `RacingStore`: append-only `rest_raw`, `poll_telemetry`,
  `source_observations`, `reconciliation` NDJSON.
- `Reconciler`: per economic-trade candidate group
  (`econ:{tx}:{asset}:{size6}`), the first source to arrive is `FIRST`;
  later sources are `CORROBORATOR`. Durable rows seed the in-memory winner
  set at startup, so the winner survives restarts and is never overwritten
  by later arrivals (even ones with earlier source timestamps — arrival
  order at this observer is the recorded fact).
- Sources never validate/canonicalize each other. A chain observation and a
  REST observation of the same trade coexist independently; the racer only
  records that they appear to describe the same economic trade.

### 6. Metrics — `scripts/multisource-metrics.mjs` [implemented]

Computes the handoff §10 report from a data directory: per-source raw and
unique counts, source-only / pairwise / all-source groups, first-source
winners, maker/taker and BUY/SELL splits, latency vs source timestamps,
REST response delay + CDN `age` header stats, hydration, errors, quarantine.

### 7. Phase 4 adapter — `src/compare/poly2-adapter.ts` [implemented stub, offline only]

Maps Shadow observations to candidate Poly2 canonical keys at comparison
time. Never imported by any collector. UNMATCHED is a first-class outcome.

### 8. Phase 4 comparison engine — `src/compare/phase4.ts` [implemented, fixture-tested]

- `validatePoly2Export`: fail-closed schema check on the read-only Poly2
  export (window + wallet + ingest timestamp mandatory per contract §3).
- `assertExportWindowMatches`: the sealed export window must EXACTLY equal
  the frozen comparison window, else the comparison aborts (contract §8).
- `buildShadowGroups`: reads the shadow evidence NDJSON, filters to the
  CONTROLLED_OVERLAP cohort and frozen window, groups economic-trade
  candidates; computes per-group **raw discovery** (min
  `sourceFirstSeenUtc` across independent source observations — never racer
  FIRST order), **usable discovery** (earliest completion with full
  decision fields + FULL hydration), and emitter classes from CHAIN member
  identities (standard vs negRisk).
- `compare`: enforces cohort AND window **symmetrically** — non-cohort and
  out-of-window Poly2 rows are sealed out of primary metrics and reported
  separately (`excluded`); `matchEvents` classifies group-level matches →
  MATCHED_HIGH_CONFIDENCE (tx+asset+size6+side) / MATCHED_PROBABLE
  (no txHash, ≤120 s proximity) / SHADOW_ONLY / POLY2_ONLY / AMBIGUOUS
  (multi-candidate, side-conflict, multi-claim). Metrics: coverage of union
  (frozen formula, contract §7), raw/usable latency deltas (positive =
  Shadow earlier; ties < 1 s), policy impact, decision relevance with
  Poly2's 300 s freshness budget modeled, population breakdowns (sources,
  maker/taker, BUY/SELL, emitter, markets where metadata exists).

### 9. Phase 4 CLI + dashboard — `src/compare/cli.ts`, `src/compare/dashboard.ts` [implemented, smoke-tested on fixtures]

- `cli.ts`: `shadowDataDir + poly2-export.json + cohorts.json →
  comparison.json`; rebuilds a groupKey→market lookup from `rest_raw`
  payloads (title/conditionId) for the market breakdown. Artifacts in,
  dataset out — no live queries.
- `dashboard.ts`: `comparison.json → dashboard.html`, a self-contained
  phone-friendly read-only page (overview, live source health from embedded
  telemetry, per-wallet table with latest activity, fully auditable trade
  table with per-trade evidence fields + source/maker-taker/side/
  actionable filters, coverage incl. exclusions, latency, population,
  policy impact). Never queries Poly2 or any network.

## Boundaries

- Network construction: `fetch(` only in `src/shadow/egress.ts`;
  `new WebSocket` only in `src/shadow/watcher.ts` (CI-enforced).
- Config (`config.ts`) fails closed on any credential material.
- Poly2: zero contact. Upstream: pinned reference only.
