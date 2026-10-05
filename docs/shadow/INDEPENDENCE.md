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

**Phase 2 is a chain-observer foundation, not the finished multi-source
system.** The current entrypoint runs only the Polygon V2 watcher. The
intended final architecture — fast REST trade discovery, validated WebSocket
trade observation, independent source racing with first-seen timestamps — is
Phase 3. This PR must not be presented as a finished head-to-head
alternative to Poly2.

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
- **Recovery semantics**: reorg recovery requires a PROVED common ancestor
  (stored checkpoint hash matching the provider). When no checkpoint matches
  within the 128-block lookback, the watcher fails closed: it quarantines an
  explicitly labeled *unverified bounded rewind* rather than claiming an
  ancestor it cannot prove. Raw identities whose block hash conflicts with
  the provider are invalidated terminally (`HASH_CONFLICT` tombstone) so
  replay can never revive them.
- **Liveness vs freshness**: connection liveness counts any sign of life
  (subscription messages and pongs); event freshness is a Phase 3 concern.
- The application remains **incapable of trading** — no signing, no keys, no
  order paths exist in this repository.

Prefer the simplest reliable implementation appropriate for an independent
observer. No production-scale infrastructure for its own sake.
