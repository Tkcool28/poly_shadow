# PHASE4_COMPARISON_CONTRACT — controlled Shadow vs Poly2 comparison

Status: **[implemented]** contracts + matching engine + metrics;
**[not validated]** against real Poly2 exports until the frozen run happens.
This document is the frozen protocol. Comparison code MUST implement these
definitions exactly; changes require editing this file first.

## 1. Scientific question

For the SAME watched-wallet activity: which system discovers it sooner
(raw), which observes more of it (coverage), and which reaches a
usable/copyable representation sooner (usable)? Policy rejections are
measured, never "corrected".

## 2. Cohorts (handoff §3 — kept separate everywhere)

- `CONTROLLED_OVERLAP` — the exact wallet set Poly2 follows during the
  window. **All primary metrics use this cohort only.**
- `SHADOW_EXPLORATORY` — extra Shadow-observed wallets; reported separately,
  never in primary denominators.

Cohort membership is declared in the run config (`cohorts.json`), frozen
before the window starts, and embedded in every comparison artifact.

## 3. Poly2 export contract (read-only, export→compare)

One JSON file per window: `{ "window": {...}, "rows": [ Poly2ExportRow ] }`.
Export only existing evidence; never infer missing timestamps (use `null`).

```
Poly2ExportRow {
  wallet: string            // lowercase 0x…
  txHash: string | null
  asset: string | null      // tokenId decimal string
  conditionId: string | null
  side: "BUY" | "SELL" | null
  size: number | null       // shares
  price: number | null      // gross price
  sourceTs: number | null   // epoch seconds, event time per Poly2's source
  ingestedUtc: string       // ISO — Poly2 first ingestion (RAW discovery)
  normalizedUtc: string | null // ISO — normalization complete (USABLE proxy)
  decisionUtc: string | null
  signalUtc: string | null
  source: string            // e.g. "data-api"
  freshnessAgeSec: number | null
  freshnessRejection: string | null  // reason if stale-rejected
  policyEligible: boolean | null
  copyabilityOutcome: string | null
  rejectionReason: string | null
  paperOutcome: string | null
}
```

## 4. Shadow export contract

Shadow's existing append-only evidence IS the export
(`source_observations.ndjson` per source: identity, wallet, side, asset,
size, price, sourceTs, sourceFirstSeenUtc, completedUtc, role, groupKey,
hydration). `scripts/phase4-compare.mjs` reads the data directory directly.
No transformation, no canonicalization to Poly2's key.

## 5. Timing definitions (handoff §9 — mandatory)

**RAW DISCOVERY**
- Shadow raw = `min(sourceFirstSeenUtc)` over the matched group's member
  observations (per-source arrival evidence — explicitly NOT the racer's
  FIRST row, which is reconciliation-commit order).
- Poly2 raw = `ingestedUtc`.

**USABLE DISCOVERY** — defined here, before any run:
- A Shadow observation is USABLE when it has: wallet, side, asset, size,
  price AND `hydration === 'FULL'` (market metadata present). Shadow usable
  for a group = `min(completedUtc)` over usable members; `null` if no member
  is usable. (Chain observations are FULL by construction; REST PARTIAL rows
  are not usable until a later FULL observation of the same group exists.)
- Poly2 usable = `normalizedUtc` (fallback `decisionUtc` if normalization
  timestamp is absent; the fallback is recorded in the artifact).

Delta convention: `deltaSec = poly2Time − shadowTime`; **positive = Shadow
earlier**. Ties: |delta| < 1s.

## 6. Matching (deterministic; neither identity mutated)

Match at the EVENT level: one Poly2 row ↔ one Shadow economic group
(`groupKey`), never row-to-row.

- **MATCHED_HIGH_CONFIDENCE**: same wallet AND same asset AND a group
  member's tx equals `txHash` AND size equal at 6dp AND (side equal or
  either side null).
- **MATCHED_PROBABLE**: `txHash` missing on the Poly2 row, but wallet +
  asset + size(6dp) + side match AND `|sourceTs − group.sourceTs| ≤ 120s`
  (or `|ingestedUtc − group raw| ≤ 120s` when sourceTs is null).
- **AMBIGUOUS**: more than one group satisfies HIGH for the same row; or
  size/asset match with a DIRECT side conflict; or one group claimed by two
  Poly2 rows. Ambiguity stays visible and is excluded from latency winners
  but included in coverage.
- **SHADOW_ONLY**: cohort-A group in-window with no Poly2 row candidate.
- **POLY2_ONLY**: cohort-A row with no group candidate.

## 7. Metrics (handoff §10/§11)

COVERAGE: matched / shadow-only / poly2-only / ambiguous counts; coverage%
= matched / (matched + only) per system (ambiguous excluded from
denominator, reported).

RAW and USABLE: winner counts (shadowEarlier / poly2Earlier / tie),
median/P50/P90/P95 of signed deltas over matched events.

POLICY IMPACT: poly2 stale-rejected count; of those, how many Shadow
observed within Poly2's 300s freshness budget
(`shadowRaw − sourceTs ≤ 300`); other rejectionReason breakdown.

DECISION RELEVANCE (for each matched event where Shadow raw is earlier,
first applicable rule wins):
1. `EARLIER_BUT_POLICY_INELIGIBLE` — Poly2 row has freshnessRejection or
   policyEligible=false.
2. `EARLIER_BUT_NOT_HYDRATED` — Shadow group has no usable member.
3. `EARLIER_MAKER_ONLY` — all chain members of the group are MAKER_LEG and
   no REST member exists.
4. `EARLIER_BUT_TOO_LATE` — Shadow raw earlier but Shadow usable ≥ Poly2
   usable (speed did not convert to usability).
5. `EARLIER_AND_USABLE` — Shadow usable < Poly2 usable.
Otherwise `NO_MEANINGFUL_ADVANTAGE` (ties / not earlier).

POPULATION: maker/taker (chain roles), BUY/SELL, standard vs neg-risk
emitter (chain), Shadow source usage, market breakdown when metadata
exists.

## 8. Frozen window protocol (handoff §12)

`cohorts.json` + window start/duration fixed BEFORE the run; no cohort
swaps; all raw evidence preserved; anything shorter than the declared
window is labeled a **smoke run** and cannot support conclusions. First
target: 24 h if operationally practical.

## 9. Anti-contamination rules

- No autonomous wallet discovery in the primary comparison (see
  WALLET_DISCOVERY_FEASIBILITY.md — research-only, separate).
- No Poly2 writes, no schema/scoring/freshness changes, no live DB queries.
  Artifacts → comparison dataset → dashboard. The dashboard never queries
  Poly2.
