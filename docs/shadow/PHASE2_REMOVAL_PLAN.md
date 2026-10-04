# POLY-SHADOW — Phase 2: Execution-Capability Removal & Isolation Plan

**Principle:** an environment flag is not isolation. Every capability listed
below is **deleted from the tree**, and the surviving config makes their
presence a startup error. After this phase, the repository must contain no
reachable path to order submission, transaction signing, private-key access,
authenticated CLOB trading, capital movement, or automated redemption.

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
| `.github/workflows/` | `deploy.yml` drives a production self-hosted runner; `build.yml` publishes images. Shadow gets a new minimal CI later (lint+test, GitHub-hosted only). |
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

## 3. Fail-closed config

Rewrite `src/config/env.ts` (or its shadow replacement) so that:

- Presence of `PRIVATE_KEY`, `CLOB_API_KEY`, `CLOB_API_SECRET`,
  `CLOB_API_PASSPHRASE`, `FUNDER_ADDRESS`, `RELAYER_API_KEY`, or any
  `ARB_*`/`SCALP_*` credential variable → **process exits non-zero at
  startup** with a named error. (Detect-then-refuse, not ignore.)
- No config field can hold key material; no signing library remains in the
  dependency graph (CI check: `npm ls` must not contain
  `@polymarket/clob-client` or a wallet/signer package).
- Egress allowlist enforced in one HTTP/WS client wrapper: Polygon RPC
  endpoints (configurable) + `data-api.polymarket.com` +
  `gamma-api.polymarket.com`. Everything else refused. No `clob.polymarket.com`,
  no relayer. (CLOB *public* market metadata, if ever needed, comes via
  Gamma.)

## 4. Shadow storage (new, minimal)

SQLite (default) or bounded append-only NDJSON. Tables/files:

- `raw_logs` — chainId, emitter, blockNumber, blockHash, txHash, logIndex,
  topic0, full topics+data, `removed`, first-seen UTC. Immutable, insert-only.
- `scan_cursor` — highest **fully scanned** block number + hash per provider;
  advances only after raw evidence commits; empty blocks advance it too.
- `observations` — decoded V2 fields (side, tokenId, gross amounts, fee,
  role: `TAKER_AGGREGATE` | `MAKER_LEG`), gross price (Decimal, 10-dp
  half-up), shares (6-dp), block timestamp, canonical key, source identity
  (`CHAIN` | `REST_TRADES` | `REST_ACTIVITY`), per-source first-seen
  timestamps.
- `quarantine` — rounding discrepancies, canonical-key collisions, unknown
  token→market mappings, ambiguous fills. Nothing here is ever silently
  repaired or discarded.

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

## 6. Isolation guarantees (restated as acceptance criteria)

- [ ] `grep -ri "private_key\|PRIVATE_KEY" src/ package.json` → only the fail-closed guard.
- [ ] No signer/order/redemption dependency in `npm ls` output.
- [ ] No `.github/workflows` capable of deployment; Actions stay disabled until reviewed replacement CI lands.
- [ ] No reference to Poly2 hosts, paths (`/opt/poly2`), credentials, or database.
- [ ] No write-capable API client for any Polymarket authenticated route.
- [ ] Watched-wallet list sourced from a local shadow config file; initial entry: `0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029` (wallet 16).
- [ ] `vitest` suite covers: V2 decode of both exchanges, aggregate vs maker-leg classification, `OrdersMatched` non-duplication, gross-price normalization, 10-dp rounding (incl. tie/extreme cases), cursor/reorg logic against retained Hermes evidence fixtures.

## 7. Non-goals for Phase 2

No deployment, no VPS access, no Docker image publishing, no live RPC
subscription run longer than a bounded local test, no comparison against
Poly2 production (Phase 4, exported read-only records only).
