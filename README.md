# Poly-Shadow

**Independent, read-only trade-discovery shadow for the Poly2 system.**

Poly-Shadow watches approved Polymarket wallets through public, read-only
sources (Polygon V2 exchange events, Data API REST) and records what it sees,
when it saw it, and the native chain identity of each observed event —
so Poly2's discovery completeness and freshness can be measured against an
independent observer.

**It cannot trade.** There is no order submission, no transaction signing, no
private-key handling, no authenticated CLOB access, no capital movement, and
no redemption path anywhere in this repository. Credential material in the
environment is a startup error, not a configuration option.

## Provenance

Forked from [`mantotan/polymarket-copy-trade`](https://github.com/mantotan/polymarket-copy-trade)
@ `9f3e76ce7a8c9f6003cf356ac223870dec4ef56a` (MIT, © Hermanto Tan — see
`LICENSE`). Upstream is a live-money copy-trading system targeting the legacy
V1 exchange contracts; it is used here as an **architectural reference only**
(watcher lifecycle, reconnect/backfill, source racing). All execution code
has been removed; the V2 decoder and shadow pipeline are new code.

Audit trail and phase plans live in `docs/shadow/`:

- `UPSTREAM_PIN.md` — fork provenance and pin
- `PHASE1_ASSESSMENT.md` — security/architecture audit (PR #1)
- `PHASE2_REMOVAL_PLAN.md` — execution-capability excision plan and gate
- `INDEPENDENCE.md` — architectural independence rules (Phase 2 review)

## Layout

```
src/shadow/
  v2constants.ts  Verified V2 exchange addresses + event topics (Hermes-verified)
  decoder.ts      V2 OrderFilled/OrdersMatched decode, role classification,
                  gross normalization (BigInt only, no floats)
  decimal.ts      Exact 6-dp shares / 10-dp half-up gross price rendering
  storage.ts      Append-only NDJSON evidence store, reorg tombstones,
                  native event identity (chainId:emitter:txHash:logIndex)
  watcher.ts      Completeness-first WSS + eth_getLogs backfill watcher,
                  removed-log tombstones, retry queue, reorg rewind
  config.ts       Fail-closed config (presence-based credential guard)
  egress.ts       Application-level egress allowlist (HTTP RPC + WSS +
                  public data APIs only)
  main.ts         Entrypoint
src/compare/
  poly2-adapter.ts  Phase 4 ONLY: maps Shadow observations to candidate Poly2
                    canonical keys; unmatched records stay visible. Never
                    imported by the collector.
tests/
  fixtures/v2_fills.json  Real production receipts (5 trades, 3 wallets,
                          both exchanges, BUY+SELL, rounding + fee cases,
                          the 37-fill multi-fill transaction)
  watcher.test.ts         Failure/restart/reorg flows through the real watcher
```

## Run

```bash
npm ci --ignore-scripts
npm test        # vitest: fixtures from real Polygon receipts
npm run build   # tsc --noEmit

SHADOW_WATCHED_WALLETS=0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029 \
  npm start     # observation only; writes to ./shadow-data/
```

## Scope

Phase 2 (current) is the **chain-observer foundation**: the Polygon V2 event
watcher above. Fast REST discovery, validated WebSocket trade observation,
and independent source racing are Phase 3; comparison against Poly2 via
`src/compare/` is Phase 4. This is not yet a finished head-to-head
alternative to Poly2.

## Hard boundaries

- No deployment automation exists in this repo; GitHub Actions stay disabled
  until a reviewed, GitHub-hosted, test-only workflow is introduced.
- No connection to Poly2's production database, hosts, or credentials.
- Comparison against Poly2 uses exported, read-only records only (Phase 4).
- Upstream updates are never merged automatically.
