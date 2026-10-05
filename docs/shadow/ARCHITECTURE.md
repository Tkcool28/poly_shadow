# ARCHITECTURE — Phase 3 multi-source discovery

Status legend: **[implemented]** = code exists and is test-covered;
**[tested]** = fixture/unit tests; **[observed]** = verified against live
endpoints; **[planned]** / **[not validated]** = explicitly not yet.

## Components

### 1. Polygon V2 chain watcher — `src/shadow/watcher.ts` [implemented, tested, observed]

- WSS `eth_subscribe` logs over BOTH V2 exchange emitters (standard +
  neg-risk) and both V2 topic0s; watched-wallet filtering post-decode.
- `eth_getLogs` backfill gated on the subscription ack; 64-block first-start
  overlap; periodic verifier rescan.
- Provider-lag policy: only `invalid block range` and null block responses
  receive six total attempts, with 100/200/400/800/1600ms backoffs (3.1s
  cumulative wait, excluding RPC duration). Range retries re-read the head
  and only clamp downward; null blocks never establish a hash conflict.
  Exhaustion remains a visible transient failure; PENDING/raw arrival
  evidence survives, and unavailable evidence cannot advance the cursor.
  Startup cursor-validation exhaustion arms the existing verifier cadence
  to repeat validation and durable startup replay before scanning; real
  mismatches still require proved ancestry or fail closed. Scanned
  tombstoned/hash-conflicted identities stop cursor advancement before
  queued recovery can validate the pre-scan cursor.
- Durable dispositions (OBSERVED / COMPLETED_NO_OBSERVATION /
  TERMINAL_QUARANTINE / REMOVED_INVALID / PENDING) make restart delivery
  idempotent; tombstones (any reason) dominate PENDING forever.
- Reorg: dense checkpoints (spacing 16 < lookback 128) prove a common
  ancestor; no provable ancestor → fail-closed `recoveryRequired` (cursor
  unmoved, no automatic resume).
- Phase 3 extension: optional `onObservation` callback (constructor arg 5)
  feeds committed observations into the racer. Default no-op; Phase 2
  behavior unchanged.

### 2. REST /trades observer — `src/shadow/rest-poller.ts` [implemented, tested, live run pending normal egress]

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

### 3. REST /activity observer — same module [implemented, tested, live run pending normal egress]

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
  (`econ:{tx}:{asset}:{size6}`), the first source to commit reconciliation
  is `FIRST`; later sources are `CORROBORATOR`. Durable rows seed the
  in-memory winner set at startup, so the winner survives restarts and is
  never overwritten by later commits (even ones with earlier source timestamps).
  **Phase 4 caveat:** `FIRST` reflects reconciliation commit order, not
  necessarily earliest raw arrival. Chain block hydration/provider-lag
  retries can delay commit despite an earlier preserved `sourceFirstSeenUtc`.
  Compare raw/source arrival timestamps separately; racing semantics are
  unchanged in this provider-lag fix.
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

## Boundaries

- Network construction: `fetch(` only in `src/shadow/egress.ts`;
  `new WebSocket` only in `src/shadow/watcher.ts` (CI-enforced).
- Config (`config.ts`) fails closed on any credential material.
- Poly2: zero contact. Upstream: pinned reference only.
