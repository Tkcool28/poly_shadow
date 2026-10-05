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

## Correctness/safety findings (still binding)

- Removed-log handling, transient failure/retry, restart and reorg recovery
  — implemented via append-only raw evidence, tombstones + derived status,
  cursor rewind to common ancestor.
- Append-only evidence preserved; first-seen rows are never edited or deleted.
- Credential guard is fail-closed; egress allowlist is application-level and
  must be paired with deployment-time network controls.
- The application remains **incapable of trading** — no signing, no keys, no
  order paths exist in this repository.

Prefer the simplest reliable implementation appropriate for an independent
observer. No production-scale infrastructure for its own sake.
