# ARCHITECTURE — Phase 3 multi-source discovery

Status legend: **[implemented]** = code exists; **[tested]** = covered by
automated tests; **[observed]** = verified against live endpoints;
**[planned]** = intentionally deferred.

## Components

### 1. Polygon V2 chain watcher — `src/shadow/watcher.ts` [implemented, tested, observed]

- WSS `eth_subscribe` over both current V2 exchange emitters (standard +
  neg-risk) and both V2 event topics.
- `eth_getLogs` backfill begins only after subscription acknowledgement,
  with a first-start overlap and periodic verifier.
- Watched-wallet filtering happens post-decode; source evidence is preserved
  independently of later reconciliation.

Provider-lag policy:

- only null block responses and invalid log-range responses receive the
  bounded lag retry treatment;
- maximum **6 attempts**;
- backoffs: **100 / 200 / 400 / 800 / 1,600 ms**;
- invalid ranges refresh the provider head and clamp only downward;
- null blocks are retryable and never treated as hash conflicts;
- if the confirmed head is below the next chunk start, scanning stops at the
  last committed cursor and resumes on a later verifier cycle;
- exhaustion remains visible as a transient failure;
- cursor advancement remains evidence/commit safe.

Reorg/evidence guarantees remain those established in Phase 2:

- append-only raw evidence;
- durable dispositions;
- tombstones dominate PENDING;
- dense hash checkpoints;
- proved common ancestor required for automatic reorg recovery;
- otherwise fail closed with `recoveryRequired`.

Phase 3 adds an optional observation callback that forwards committed CHAIN
observations to the racer without changing the underlying chain identity or
Phase 2 safety behavior.

### 2. REST `/trades` observer — `src/shadow/rest-poller.ts` [implemented, tested, observed]

- Polls
  `GET {dataApi}/trades?user={wallet}&limit=100&takerOnly=false`.
- Default cadence: 10 seconds per watched wallet.
- `takerOnly=false` is required because the endpoint otherwise omits part
  of the maker-side population.
- No freshness rejection is applied.
- Raw payload and per-poll telemetry are preserved:
  request/response times, HTTP status, CDN `age` / `cache-control`,
  newest source timestamp, new/duplicate counts, and errors.

Live validation from the frozen Phase 3 VPS run:

- 180 successful polls / 0 errors;
- 400 normalized REST_TRADES observations;
- CDN age p50 99s / p95 279s in that run;
- response delay p50 26ms / p95 308ms.

### 3. REST `/activity` observer — `src/shadow/rest-poller.ts` [implemented, tested, observed]

- Polls `GET {dataApi}/activity?user={wallet}&limit=100`.
- Default cadence: 30 seconds.
- Treated as a distinct source population.
- Activity type is part of the source-native identity.
- Non-TRADE activity remains visible and is not forced into trade groups.

Live validation from the frozen Phase 3 VPS run:

- 60 successful polls / 0 errors;
- 1,056 normalized REST_ACTIVITY observations.

### 4. WebSocket wallet-trade source — [investigated, rejected]

See `docs/shadow/WS_FEASIBILITY.md`.

The public CLOB market channel lacks wallet identity; the authenticated user
channel requires credentials that are intentionally banned; RTDS does not
provide a suitable watched-wallet trade stream. Polygon logs WSS remains the
live chain source.

### 5. Source racer / reconciliation — `src/shadow/racing.ts` [implemented, tested, observed]

- Source observations remain independently stored.
- Candidate economic groups use:
  `econ:{tx}:{asset}:{size6}`.
- The first reconciliation commit for a group is labeled `FIRST`;
  subsequent source memberships are `CORROBORATOR`.
- Winner state is durable across restarts.
- Unmatched/source-only observations remain first-class evidence.

Frozen live acceptance produced:

- 950 CHAIN↔REST corroborated groups overall;
- 858 corroborated groups associated with in-window CHAIN observations;
- 292 groups seen by all sources;
- source-only counts: CHAIN 32, REST_TRADES 14, REST_ACTIVITY 12;
- duplicate observations / malformed candidate memberships: 0.

**Phase 4 timing caveat:** `FIRST` is commit order, not guaranteed earliest
raw arrival. Preserved `sourceFirstSeenUtc` timestamps must be compared
directly before any source-speed claim.

### 6. Metrics — `scripts/multisource-metrics.mjs` [implemented, tested/used]

Produces the frozen-run report from one evidence directory:

- raw/normalized counts by source;
- source-only / matched / all-source groups;
- FIRST counts;
- maker/taker and BUY/SELL splits;
- latency vs source timestamps;
- REST response/CDN-age statistics;
- hydration;
- quarantine/errors.

### 7. Phase 4 adapter — `src/compare/poly2-adapter.ts` [implemented stub, planned use]

Maps Shadow observations to candidate Poly2 canonical keys during offline
comparison. It is not imported by collectors. UNMATCHED remains a valid
comparison outcome.

## Phase 3 live acceptance

Reviewed runtime head:

`921db8f71ed27071da8b7a835bc3d2fcbc360848`

Evidence directory:

`/opt/poly-shadow/runs/phase3-provider-lag-live-20261005T072748Z-attempt1`

Fixed run:

- 900 seconds
- CHAIN: 59,128 raw / 982 normalized
- REST_TRADES: 400 normalized
- REST_ACTIVITY: 1,056 normalized
- quarantine: 0
- TRANSIENT_FAILURE: 0
- provider-lag failure: 0
- `recoveryRequired`: 0

Phase 3 live acceptance passed.

## Boundaries

- `fetch(` construction remains confined to `src/shadow/egress.ts`.
- `new WebSocket` remains confined to `src/shadow/watcher.ts`.
- configuration fails closed on credential material.
- Poly2 has zero live dependency/contact.
- no execution/signing path exists.
- deployment is not part of Phase 3.
