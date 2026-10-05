# Poly-Shadow — Architectural Independence (Phase 2 review clarification)

Poly-Shadow exists to **independently test a competing trade-discovery
architecture against Poly2**. It is not a TypeScript reproduction of Poly2,
and it must not drift into one.

## Binding rules

1. **Retain the useful Mantotan concepts**: multiple discovery sources,
   independent observation, fast chain monitoring, source racing,
   reconnect/backfill.
2. **Native identities internally.** Shadow's primary storage and dedup key
   is the native blockchain event identity
   (`chainId:emitter:txHash:logIndex`). Poly2's canonical trade identity is
   NOT Shadow's primary key.
3. **Poly2 equivalence lives in a comparison adapter only**
   (`src/compare/poly2-adapter.ts`, Phase 4). A record that cannot be matched
   to Poly2 remains visible as an additional/unmatched observation — never
   discarded.
4. **Maker-side activity is a separately classified, first-class stored
   population** (`MAKER_LEG`). Investigating whether Poly2 misses useful
   wallet activity is a core purpose of the project.
5. **Do not reproduce** Poly2's collector scheduling, scoring, execution,
   database architecture, wallet approval logic, or trade filters.
6. **No dependency** on Poly2's availability, API, database, or runtime
   configuration.

## What the comparison milestone (Phase 4) measures

- Which system sees trades **first** (latency to observation).
- Which **identities** each system discovers.
- What each system **misses** (including maker-side activity).
- How their **source coverage** differs.

The objective is to determine whether **this system** provides superior
discovery — not to make its output artificially identical to Poly2.

## Scope honesty

**Phase 2 (chain-observer foundation) is complete and merged** (PR #2, merge
commit `aa223757e9b477f23adc72f19e6bdf0e696f6f06`). **Phase 3 adds the
multi-source layer** — REST /trades and /activity observers plus source
racing — on top of that foundation. The full head-to-head comparison against
Poly2 remains Phase 4 (offline, exported records). Neither phase should be
presented as proof of superior discovery before Phase 4 evidence exists.

## Correctness/safety findings (implemented and test-covered)

- **Removed-log handling**: removal notices bypass dedup entirely and are
  always tombstoned; re-inclusion in a different block is new evidence
  (dedup keys include blockHash). Covered by watcher tests.
- **Transient failure/retry**: `seenRaw` is marked only after full commit;
  failures are recorded in quarantine (`TRANSIENT_FAILURE`) and replayed
  from a retry queue. Covered by watcher tests.
- **Restart and reorg recovery**: startup + periodic cursor-hash validation,
  common-ancestor walk over append-only block-hash evidence,
  `tombstoneAboveBlock`, cursor rewind, rescan. A block-hash conflict never
  emits an observation with a conflicting timestamp. Covered by watcher tests.
- **Append-only evidence preserved**; first-seen rows are never edited or
  deleted.
- **Credential guard** is fail-closed on PRESENCE (a set-but-empty banned
  variable still refuses startup). **Egress** covers both HTTP RPC and the
  WSS endpoint; the WSS host must match the configured HTTP RPC host or the
  public allowlist. Both remain application-level controls that must be
  paired with deployment-time network restrictions.
- **Storage durability limits (Phase 2)**: evidence lives in append-only
  NDJSON files on a single host. There is no replication, fsync policy, or
  backup; host loss loses evidence. Acceptable for an independent research
  shadow at this phase; not a production durability claim.
- **Bounded-state limits (Phase 2)**: diagnostic maps (OrdersMatched /
  aggregate cross-check buffers, block cache) are FIFO-bounded. Dedup sets
  (`seenRaw`, `seenRemoved`, `rawCommitted`) scale with evidence volume and
  are rebuilt from the durable disposition index at startup — a restart is
  the rotation mechanism. Guidance: restart the observer at least daily
  during long research runs; production-grade rotation is a separate
  operational gate before any long unattended canary.
- **Recovery semantics**: scanning persists dense block-hash checkpoints
  (spacing 16, guaranteed < the 128-block reorg lookback), so a common
  ancestor within the supported depth is always PROVABLE against a genuinely
  stored hash. If no stored checkpoint matches inside the walk window,
  recovery fails closed: a hard `recoveryRequired` quarantine is recorded,
  the cursor is NOT advanced to an unverified provider hash, nothing is
  tombstoned, and automatic scanning does not resume — bounded manual
  recovery is a later operator action. A removal/reorg tombstone (any
  reason) dominates a PENDING disposition for that exact blockHash-aware
  identity forever (`REMOVED_INVALID`): only a new raw row under a NEW
  blockHash is new evidence, and the in-memory retry queue can never revive
  a removed identity. Raw identities whose block hash conflicts with the
  provider are invalidated terminally (`HASH_CONFLICT` tombstone).
- **Liveness vs freshness**: connection liveness counts any sign of life
  (subscription messages and pongs); event freshness is a Phase 3 concern.
- The application remains **incapable of trading** — no signing, no keys, no
  order paths exist in this repository.

Prefer the simplest reliable implementation appropriate for an independent
observer. No production-scale infrastructure for its own sake.
