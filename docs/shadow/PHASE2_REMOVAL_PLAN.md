# POLY-SHADOW — Phase 2: Execution-Capability Removal & Isolation Plan

**Principle:** an environment flag is not isolation. Every capability listed
below is **deleted from the tree**, and the surviving config makes their
presence a startup error. After this phase, the repository must contain no
reachable path to order submission, transaction signing, private-key access,
authenticated CLOB trading, capital movement, or automated redemption.

**Revision 2:** incorporates independent review corrections (PR #1 review).

## 1. Deletions (entire paths)

| Path | Why |
|---|---|
| `copier/` | Rust execution service: EIP-712 order signing, CLOB client, private-key config, V1 decoder. Nothing salvageable for a read-only V2 shadow. |
| `src/services/trade-executor.ts` | FAK/GTC order placement |
| `src/services/paper-executor.ts` | Paper order simulation (spec: no paper orders either) |
| `src/services/position-settlement.ts` | Settlement + on-chain redemption path |
| `src/services/position-claim.ts` | `redeemPositions` claiming |
| `src/services/pre-resolution-seller.ts` | Automated selling |
| `src/lib/capital-audit.ts` | Includes phantom-position auto-sell |
| `src/lib/relayer-client.ts` | Gasless on-chain ops (redeem/split/merge) |
| `src/services/unix-socket-bridge.ts` | IPC exists only to serve the copier |
| `src/services/arb/`, `src/jobs/arb-worker.ts` | Independent trading strategy |
| `src/services/scalp/`, `src/jobs/scalp-worker.ts` (if present) | Independent trading strategy |
| `src/cli/` | Operator CLI includes allocation/execution controls |
| `.github/workflows/` | **Neither original workflow may ever be enabled or dispatched** (`deploy.yml` = privileged self-hosted production deploy; `build.yml` = GHCR publishing + self-hosted copier build). Deleted here. Any future CI is a new, separately reviewed, GitHub-hosted, test-only workflow with `permissions: contents: read`, no publishing, no self-hosted labels. Actions stay disabled repo-wide until such a workflow lands. |
| `.server/`, `ecosystem.config.js`, `scripts/launch-paper-mm.sh` | Production deployment machinery |
| `prisma/` (as-is) | Production schema replaced by a minimal shadow schema (SQLite) — see §4 |

## 2. Dependency excision (`package.json`)

Remove: `@polymarket/clob-client`, `@prisma/*`, `pg`, `duckdb`,
proxy agents (`https-proxy-agent`, `socks-proxy-agent`), and anything only
the deleted workers used. Keep (pinned): `ws`, `axios` (or `fetch`),
`decimal.js`, `zod`, `winston`, `vitest` (dev), `tsx`/`typescript` (dev).
Re-evaluate `ethers@5`: acceptable only if reduced to stateless ABI/topic
decoding; otherwise replace with a ~100-line fixed-layout decoder (V2 events
are fixed-size — trivially decodable without a library). Run `npm audit` on
the final manifest. All installs with `--ignore-scripts`.

## 3. Fail-closed config and egress boundary

Rewrite `src/config/env.ts` (or its shadow replacement) so that:

- Presence of `PRIVATE_KEY`, `CLOB_API_KEY`, `CLOB_API_SECRET`,
  `CLOB_API_PASSPHRASE`, `FUNDER_ADDRESS`, `RELAYER_API_KEY`, or any
  `ARB_*`/`SCALP_*` credential variable → **process exits non-zero at
  startup** with a named error. (Detect-then-refuse, not ignore.)
- No config field can hold key material; no signing library remains in the
  dependency graph (CI check: `npm ls` must not contain
  `@polymarket/clob-client` or a wallet/signer package).
- **Egress policy (stated precisely):** all outbound traffic goes through one
  HTTP/WS client wrapper enforcing an allowlist — Polygon RPC endpoints
  (configurable) + `data-api.polymarket.com` + `gamma-api.polymarket.com`;
  no `clob.polymarket.com`, no relayer. This is an **application-level
  rule**, not a network-enforced boundary. It is backed by: (a) static
  checks/tests asserting the wrapper is the only network-client construction
  site in shadow source, and (b) the dependency excision in §2. Any future
  deployed shadow additionally requires real network/container egress
  restrictions (firewall or container-network allowlist) as a
  deployment-time control outside this repository.

## 4. Shadow storage (new, minimal) — with explicit reorg semantics

SQLite (default) or bounded append-only NDJSON. **Raw evidence is truly
append-only: no row is ever updated or deleted.** Current truth is a derived
projection, never an in-place mutation.

- `raw_logs` (**append-only**) — one row per log observation:
  `chainId, emitter, blockNumber, blockHash, txHash, logIndex, topic0,
  topics, data, firstSeenUtc`.
  Uniqueness key: `(chainId, emitter, txHash, logIndex, blockHash)` — the
  blockHash component means a re-included log at a different block hash is a
  **new row**, not an overwrite.
- `raw_log_tombstones` (**append-only**) — one row per removal/reorg event:
  same identity fields + `removedAtUtc`. A reorg never edits `raw_logs`; it
  appends a tombstone. If the log is later re-included, the new `raw_logs`
  row (new blockHash) coexists with the tombstone.
- `log_status` (**derived projection, rebuildable**) — current validity per
  `(chainId, emitter, txHash, logIndex)`: `CONFIRMED | REMOVED |
  REINCLUDED`, computed from `raw_logs` + `raw_log_tombstones`. Can be
  dropped and rebuilt from the append-only tables at any time; it is a
  cache, not evidence.
- `scan_cursor` — highest **fully scanned** `(blockNumber, blockHash)` per
  provider; advances only after raw evidence commits; empty blocks advance
  it too. **On reorg:** verify stored hash at the cursor; on mismatch, walk
  back to the common ancestor, append tombstones for orphaned rows, rewind
  the cursor, and rescan. First-seen timestamps of orphaned evidence are
  preserved forever in `raw_logs`; the rescan creates new rows with new
  first-seen values — both are retained, never reconciled by deletion.
- `observations` — decoded V2 fields (side, tokenId, gross amounts, fee,
  role: `TAKER_AGGREGATE` | `MAKER_LEG`), gross price (Decimal, 10-dp
  half-up), shares (6-dp), block timestamp, canonical key, source identity
  (`CHAIN` | `REST_TRADES` | `REST_ACTIVITY`), per-source first-seen
  timestamps. References raw evidence by identity key; a reorg changes its
  derived validity via `log_status`, not by editing observation rows.
- `quarantine` — rounding discrepancies, canonical-key collisions, unknown
  token→market mappings, ambiguous fills, reorg anomalies. Nothing here is
  ever silently repaired or discarded.

Canonical key formula unchanged from Poly2:
`data-api:{transactionHash}:{proxyWallet}:{asset}:{size}:{price}:{timestamp}`.
Collisions are stored and alerted, never "fixed" by appending fields.

## 5. What survives from upstream (ported, not imported)

- Watcher lifecycle patterns from `chain-trade-watcher.ts`: dual-provider
  WSS, heartbeat + event-staleness reconnect, `eth_getLogs` backfill and
  periodic verification, block-timestamp cache, race stats.
- Everything re-pointed to V2 emitters/topics and the Hermes normalization
  rules (aggregate-first, `OrdersMatched` as cross-check only, gross prices,
  Decimal math, 10-dp rounding, block timestamps, maker legs diagnostic-only).
- Subscription filters follow the completeness-first policy in
  `PHASE1_ASSESSMENT.md` §4: full emitter/topic0 subscriptions with
  post-decode wallet filtering by default; topic2 funded-owner filtering only
  after fixture proof against all 14 Hermes canonical records plus
  multi-fill receipts.

## 6. Phase 2 completion gate (explicit)

Phase 2 is complete only when **all** of the following hold. A grep alone is
not a security proof — the gate requires a buildable, test-passing artifact:

1. The shadow builds (`tsc --noEmit` clean) and its `vitest` suite passes,
   covering: V2 decode on both exchanges, aggregate vs maker-leg
   classification, `OrdersMatched` non-duplication, gross-price
   normalization, 10-dp rounding (including tie/extreme cases), and
   cursor/reorg logic replayed against retained Hermes evidence fixtures.
2. Static assertions in CI (or a local check script): no trading-capable or
   signing dependency in `npm ls`; no network-client construction outside
   the egress wrapper; the fail-closed credential guard fires on each banned
   variable (test with fixtures).
3. Repository contains no `.github/workflows` content capable of deployment
   or publishing, and repo-level Actions remain disabled until the reviewed
   test-only workflow is introduced.
4. Runtime smoke test of the built shadow: starts with zero credentials,
   connects only to allowlisted endpoints, and records bounded local
   observations — with no path exercised that submits, signs, or redeems.
5. Checklist confirmations: no reference to Poly2 hosts/paths (`/opt/poly2`),
   credentials, or database; watched-wallet list from a local shadow config
   (initial entry `0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029`, wallet 16).

## 7. Non-goals for Phase 2

No deployment, no VPS access, no Docker image publishing, no live RPC
subscription run longer than a bounded local test, no comparison against
Poly2 production (Phase 4, exported read-only records only), no enabling or
dispatching of any original upstream workflow.
