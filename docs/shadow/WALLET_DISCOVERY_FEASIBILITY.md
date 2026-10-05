# SHADOW_WALLET_DISCOVERY_FEASIBILITY (research only — NOT part of the Phase 4 comparison)

Status: **investigation notes only.** This document is deliberately separate from the
Phase 4 controlled comparison. The primary comparison in
`PHASE4_COMPARISON_CONTRACT.md` is **apples-to-apples on a fixed wallet list** and
does **not** use, require, or rank anything described here.

## Why this exists

Poly2 copies a fixed, manually curated wallet list. A natural question is whether a
shadow system could *find* candidate wallets on its own. This document records what
is and is not feasible from public, read-only data, so the idea is not confused with
the controlled comparison.

## What public data offers

- `data-api /trades?takerOnly=false` can be queried without a wallet filter on some
  deployments (market-wide recent trades). Where allowed, this yields a stream of
  (wallet, market, size, price, ts) observations from which active wallets could be
  enumerated.
- `data-api /activity` per wallet gives historical behavior once a wallet is known —
  but requires the wallet up front, so it cannot *discover* wallets by itself.
- On-chain fills (the shadow CHAIN source) reveal taker/maker addresses per fill for
  the configured emitter contracts. Scanning fills over a lookback window can
  enumerate active trading wallets without any REST dependency.
- Gamma market metadata can weight candidates by market liquidity/volume.

## Hard constraints

1. **No outcome data = no quality ranking.** Public endpoints give activity, not
   realized PnL per wallet. A discovery mechanism can propose *active* wallets; it
   cannot prove they are *good* to copy. Any ranking by future copy performance
   would require a separate, long-horizon paper-trading study — explicitly out of
   scope here.
2. **Survivorship/selection bias.** Enumerating "active" wallets overweights noisy
   high-frequency accounts and bots; it does not surface consistently profitable
   discretionary traders.
3. **Rate limits and ToS.** Market-wide polling is heavier than per-wallet polling;
   cadence and volume caps must be respected. The shadow system remains read-only
   and well below limits by design.
4. **Contamination risk.** If discovered wallets ever leaked into the controlled
   cohort, the apples-to-apples comparison would be invalidated. The Phase 4 engine
   enforces this: cohorts come only from the frozen `cohorts.json`, and
   `buildShadowGroups` filters to `CONTROLLED_OVERLAP` before any matching.

## Feasibility verdict

- **Enumerating active wallets from public data: feasible** (on-chain fill scan is
  the most robust route; market-wide REST polling is a convenience where allowed).
- **Selecting *copyable* wallets automatically: not established.** That is a
  research question requiring its own protocol, its own frozen windows, and
  outcome tracking that this project does not yet have.
- **Recommendation:** keep wallet curation manual for now. If exploration is ever
  pursued, it must run as a separate SHADOW_EXPLORATORY program with its own
  written protocol — never mixed into CONTROLLED_OVERLAP.

## Non-goals (explicit)

- No auto wallet discovery in the Phase 4 comparison.
- No ranking of wallets by expected future outcomes.
- No changes to the reconciler, racing, or watcher motivated by this document.
