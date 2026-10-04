# POLY-SHADOW — Phase 1: Security & Architecture Assessment

**Date:** 2026-10-05 · **Auditor:** Kimi (for TK) · **Upstream pin:** `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a`
**Reference evidence:** `POLY2_ONCHAIN_SOURCE_FEASIBILITY_V1` (Hermes, verdict `ONCHAIN_SHADOW_FEASIBLE`)

Scope note: this is a static code review of the pinned upstream tree plus the
Hermes on-chain evidence bundle. No upstream application code was executed;
no install or deployment scripts were run; no CI runner was attached.

---

## 1. Executive summary

Upstream is a **live-money copy-trading system**: Node.js/TypeScript
orchestration (Prisma/PostgreSQL) plus a Rust execution service ("copier")
bridged over a Unix socket. It detects trades from the Polymarket Data API
(rapid polling), the CLOB market WebSocket, and a Polygon chain watcher, then
executes FAK/GTC orders with a real private key.

For Poly-Shadow's purpose (read-only trade discovery), the codebase is
**mostly liabilities with a few genuinely valuable parts**:

- **Keep as architectural reference:** the chain watcher's connection
  lifecycle (dual WSS, heartbeat/stale detection, reconnect backoff,
  eth_getLogs backfill + periodic verification, block-timestamp cache,
  txHash:logIndex dedup) and the detection-race instrumentation.
- **Must not be reused as-is:** the event decoder — in *both* the TypeScript
  watcher and the Rust service — targets **legacy V1 contracts and the V1
  event layout**. It cannot decode a single V2 production fill. This
  independently confirms Hermes' correction to the fork plan (§5).
- **Must be deleted, not disabled:** the entire execution surface — CLOB
  order placement, transaction signing, private-key handling, on-chain
  redemption, and three separate credential sets (§3, §6).

Recommendation: **do not adapt upstream incrementally.** Build the shadow as
a small new observation-only service inside this fork, porting the watcher
*patterns* (not the decoder), and delete the rest in one Phase 2 excision PR.

## 2. Architecture inventory

| Component | Path | Role | Shadow disposition |
|---|---|---|---|
| Trade monitor | `src/jobs/trade-monitor.ts` | Main orchestration loop | Reference only |
| Chain watcher (TS) | `src/services/chain-trade-watcher.ts` | WSS + backfill trade detection | **Patterns reusable; decoder is V1 — rewrite** |
| Trade detector | `src/services/trade-detector.ts` | Data API polling detection | Reference for REST source |
| Trade executor | `src/services/trade-executor.ts` | FAK/GTC order placement via `@polymarket/clob-client` | **Delete** |
| Position settlement / claim / pre-resolution seller | `src/services/position-settlement.ts`, `position-claim.ts`, `pre-resolution-seller.ts` | On-chain redemption, auto-sell | **Delete** |
| Capital audit / phantom cleanup | `src/lib/capital-audit.ts` | Can auto-sell dust positions | **Delete** |
| Relayer client | `src/lib/relayer-client.ts` | Gasless on-chain ops (redeem/split/merge) | **Delete** |
| IPC bridge | `src/services/unix-socket-bridge.ts` | JSONL over Unix socket to Rust copier | **Delete with copier** (shadow needs no IPC) |
| Rust copier | `copier/` | Signs & submits CLOB orders (EIP-712), V1 chain decoder | **Delete entire crate** |
| Arb / scalp workers | `src/services/arb/`, `src/services/scalp/`, jobs | Independent trading strategies | **Delete** |
| Midpoint cache, market resolver | `src/services/midpoint-cache.ts`, `market-resolver.ts` | Public market data | Possibly reusable (read-only) |
| Prisma schema / PostgreSQL | `prisma/` | Production data model | **Not reused** — shadow gets its own minimal SQLite schema |
| CI/CD | `.github/workflows/build.yml`, `deploy.yml` | Build images; deploy to self-hosted prod runner | **Delete before any CI is enabled** |
| Docker/systemd | `.server/`, `ecosystem.config.js`, `copier/Dockerfile` | Production deployment | **Delete** |

## 3. Security findings

### 3.1 Critical for the shadow context

1. **`deploy.yml` operates a production host.** It runs on a self-hosted
   runner (`[self-hosted, polymarket-copytrade]`), writes `ENV_FILE` and
   `PG_PASSWORD` secrets to disk, runs migrations, and restarts live
   containers. **Do not attach a self-hosted runner to this fork, ever.**
   Forks get Actions disabled by default — keep that until `.github/` is
   deleted in Phase 2. The fork's protected-branch/runner settings should be
   verified in repo Settings as a manual checklist item.
2. **Three independent credential paths** exist in config
   (`src/config/env.ts`): copy-trade (`PRIVATE_KEY`, `CLOB_API_*`,
   `FUNDER_ADDRESS`), arb (`ARB_PRIVATE_KEY`, …), scalp (`SCALP_PRIVATE_KEY`,
   …), plus a relayer key (`RELAYER_API_KEY`) for gasless on-chain
   redemption. The shadow must not merely leave these unset — the config
   schema must be rewritten so the process **refuses to start if any key
   material is present** (fail-closed).
3. **IPC socket is world-writable.** `unix-socket-bridge.ts` does
   `fs.chmodSync(SOCKET_PATH, 0o666)`. Any local process could inject
   `copy_trade_result` messages and mutate capital accounting. Irrelevant
   after Phase 2 deletion, but noted as an upstream design flaw.

### 3.2 Positive observations (credit where due)

- `trade-executor.ts` installs an axios interceptor that strips
  `POLY_API_KEY`/`POLY_PASSPHRASE`/`POLY_SIGNATURE` headers from error
  objects before logging — upstream was aware of credential-leak risk via
  the CLOB client's error serialization.
- Rust copier defaults `PAPER_ONLY=true`; live mode requires explicit
  opt-out. GTC fallback defaults off. Good instincts — but an env flag is
  exactly the isolation the shadow spec rejects, so deletion still applies.
- No install-time code execution observed: `package.json` has no
  `postinstall`/`preinstall` hooks. Still, any future `npm ci` in the shadow
  should use `--ignore-scripts` as policy.

### 3.3 Network destinations (upstream)

Outbound: `data-api.polymarket.com`, `gamma-api.polymarket.com`,
`clob.polymarket.com` (authenticated trading), `ws-subscriptions-clob.polymarket.com`,
`relayer-v2.polymarket.com`, Polygon RPC (default publicnode, WSS+HTTP),
esports/sports feeds (HLTV, Steam, LoL, ESPN), optional user proxies.
Shadow egress policy: **allowlist only** Polygon RPC endpoints and the public
Polymarket data/gamma REST endpoints. No CLOB trading host, no relayer.

### 3.4 Dependencies

`@polymarket/clob-client` (order signing — remove), `ethers@5` (used for ABI
decode in the watcher; replace with a minimal decoder or keep pinned for
read-only ABI decoding only), Prisma/Postgres (replace with SQLite/bounded
files for the shadow), `duckdb`, proxy agents, `ws`, `axios`, `winston`.
Full lockfile review deferred to the Phase 2 PR that rewrites
`package.json`; a `npm audit` pass should run on the final shadow manifest.

### 3.5 Tests

Upstream ships `vitest` tests (`npm test`) and a `build.yml` quality gate
(`npm ci` → `prisma generate` → `tsc --noEmit` → `npm test`). **Not run
here**: this audit environment has no package-registry egress, and running
upstream's suite meaningfully requires dependency install. The suite should
be run once on GitHub-hosted CI (ubuntu-latest, never self-hosted) purely as
a baseline characterization, then deleted with the rest of the execution
codebase in Phase 2.

## 4. Minimum components for trade observation (shadow target)

Everything the shadow needs, nothing it doesn't:

1. **Polygon log watcher** — WSS `eth_subscribe` filtered by emitter + topic2
   funded-owner; HTTP `eth_getLogs` backfill/verification; dual-provider
   failover; durable `(blockNumber, blockHash)` scan cursor advanced only
   after commit; reorg rewind to common ancestor. *Pattern ported from
   `chain-trade-watcher.ts`; all contract constants and decoding replaced
   per §5.*
2. **V2 decoder + canonical normalizer** — new code (§5).
3. **REST discovery racer** — Data API `/trades` rapid poll and `/activity`
   as independent sources, each with own first-seen timestamps.
4. **Storage** — fresh SQLite (or bounded append-only NDJSON) with:
   raw evidence (chainId, emitter, blockNumber/hash, txHash, logIndex,
   removed flag), decoded fields, per-source identity and first-seen
   timestamps, canonical key, role label (taker-aggregate vs maker-only),
   and a mismatch/quarantine table. **No connection to Poly2's database.**
5. **Comparison module (Phase 4)** — reads Poly2's *exported* read-only
   records; computes exact canonical matches, omissions, extras, duplicates,
   and discovery-time deltas. Preserves every mismatch.

## 5. V1 vs V2 decoder — the decisive finding

Hermes' warning is confirmed in both upstream decoders:

| | Upstream (V1) | Required for shadow (V2, per Hermes evidence) |
|---|---|---|
| Exchange addresses | `0x4bFb41d5…8982E`, `0xC5d563A3…0f80a` | `0xE111180000d2663C0091e4f400237545B87B996B` (standard), `0xe2222d279d744050d28e00520010520000310F59` (neg-risk) |
| `OrderFilled` topic0 | `0xd0a08e8c…fec0f6` | `0xd543adfd…84d8ee` |
| Data words | 5 × uint256 (assetIds + amounts + fee) | 7 words: `side, tokenId, makerAmountFilled, takerAmountFilled, fee, builder, metadata` |
| Side/tokenId | inferred from which assetId is USDC | explicit fields |
| `OrdersMatched` | not handled | must be consumed as cross-check only — **never** a second trade (topic0 `0x174b3811…cab7c`) |
| Active taker aggregate | **not representable** (indexed taker = exchange address; wallet appears as *maker*) | **must be kept** — all 14/14 reconstructed production trades are this form |
| Amount math | float64 (`parseFloat`/`f64` in TS and Rust) | integer/Decimal only; 6-decimal units; gross price; **Decimal half-up rounding to 10 dp** before keying |
| Timestamps | block timestamp cache (good pattern) | block timestamp only; V2 order timestamp is order *creation* ms — never use it |

Additional upstream behaviors that must **not** be ported:

- **Phantom-fill suppression** (`TAKER_DEBOUNCE_MS`, maker-preference
  override, `emittedTxSides` per `txHash:wallet`): a V1 NegRisk heuristic
  keyed at tx:wallet granularity. Hermes showed a single V2 tx can contain
  37 fills and that tx/wallet-level dedup loses legitimate fills. Shadow
  dedups raw logs strictly by `txHash:logIndex` and lets canonical keys
  resolve identity.
- **Maker-fill skipping** (`SKIP_CHAIN_MAKER_FILLS=true`): upstream silently
  drops maker legs. Shadow instead *stores* maker-only records with a
  diagnostic label — never expanded into the taker-equivalence set without a
  separate policy decision (Poly2 source-trade policy stays unchanged).
- Third Envio-configured exchange address `0xe2222d002000ba0053cef3375333610f64600036`:
  role unverified — **not** added to the shadow emitter set.

The reusable core from upstream is genuinely small: connection lifecycle,
stale/event-stale detection, subscription bookkeeping, backfill/verify loop,
block-timestamp cache, and the race-stats instrumentation. That is worth
porting; everything decode- or money-related is not.

## 6. Phase 1 checklist status

| Task | Status |
|---|---|
| Fork + pin exact upstream commit | ✅ `9f3e76ce…` on fork `main` (see `UPSTREAM_PIN.md`) |
| Review deps / install scripts / workflows / creds / network | ✅ §3 |
| Inspect Rust service + Node IPC bridge | ✅ §2, §3.1(3); Rust crate is execution + V1 decoder — delete |
| Minimum observation components | ✅ §4 |
| Decoder, maker/taker, phantom suppression review | ✅ §5 |
| Verify deployed V2 contracts + ABIs | ✅ via Hermes bundle (verified PolygonScan source byte-identical to pinned official repo; two RPC providers agreed) — not re-executed here |
| Run upstream tests isolated | ⚠️ Not possible in this audit sandbox (no registry egress); recommended as one GitHub-hosted CI baseline run before Phase 2 deletion |

## 7. Verdict

**Proceed to Phase 2 as an excision + greenfield-normalizer build, not an
adaptation.** Upstream gives us proven watcher plumbing patterns and nothing
else we should keep executing. The draft PR accompanying this document
contains no runtime code changes; Phase 2 (see
`PHASE2_REMOVAL_PLAN.md`) is the first code-changing step and likewise
deploys nothing.
