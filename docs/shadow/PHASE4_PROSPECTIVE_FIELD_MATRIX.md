# Phase 4 comparator-only prospective field trace

Source inspected read-only: `/opt/poly2/backend/src/polycopy/{models.py,ingestion/service.py,ingestion/identity.py,execution/service.py}`. No Poly2 import, execution, DB query or mutation. Scientific files `phase4.ts`, `poly2-adapter.ts`, `evidence.ts` and `PHASE4_COMPARISON_CONTRACT.md` stay frozen.

Required means required to preserve an observed fact, NOT permission to fabricate a missing value. Nullable fields remain explicit null when absent. The comparator consumes the following fields; the other schema slots are mechanically populated with null, not sampled from later mutable rows.

| FIELD | metric/consumer | required/optional | immutable/mutable in inspected path | Poly2 source | point-time capture needed |
|---|---|---|---|---|---|
| wallet | symmetric cohort, matching, coverage | required | original identity; inspected paths do not mutate required joins | Wallet.address + Trade.wallet_id at ingestion/service.py:534-554 | retain original wallet identity; read-only insertion-fact join, no approval state |
| txHash | high confidence / probable branch | optional nullable | original identity | Trade.polymarket_trade_id; identity.py:40-64 | no later state; retain original ID, parse only known data-api format |
| asset | matching/display | optional nullable | ingestion fact | Trade.asset_id | no later state |
| conditionId | market display only | optional nullable | market identity join | Market.condition_id + Trade.market_id at ingestion | retain identity join; no market outcome/version history |
| side | matching/conflict/display | optional nullable | ingestion fact | Trade.side | no later state |
| size | matching 6dp/display | optional nullable | ingestion fact | Trade.size (Numeric(20,6)) | no later state |
| price | export schema only (not read by compare) | optional nullable | ingestion fact | Trade.price | no; nullable schema slot, not a required capture fact |
| sourceTs | probable matching | optional nullable | ingestion fact | Trade.traded_at | no later state; original representation retained |
| ingestedUtc | raw latency, inclusive window, probable fallback | required | first ingestion fact | Trade.ingested_at default utcnow; ingestion flush before commit | yes, original first-ingest clock, never capture clock |
| normalizedUtc | usable latency preferred | optional nullable | not persisted in inspected source | none | no: MUST be null, not signal.created_at |
| decisionUtc | usable latency fallback | optional nullable | written at order creation, preserve first committed decision | PaperOrder.t2_decided_at; execution/service.py:177-213,438-534 | original insertion fact, including post-E visibility; no decision commit-at-E filter |
| freshnessRejection | stale count, decision relevance | optional nullable | decision fact; not infer current status | PaperOrder.miss_reason == stale_signal | original insertion fact; no commit-at-E filter |
| policyEligible | decision relevance | optional nullable | no persisted general eligibility boolean | none | no: MUST be null; do not infer approval/config |
| rejectionReason | policy rejection breakdown | optional nullable | decision fact | PaperOrder.miss_reason | original insertion fact; no commit-at-E filter |
| signalUtc | schema only | optional nullable | unused | Signal.created_at | no: null; no signal capture necessary |
| source | schema only | required string slot | original identity namespace | Trade.polymarket_trade_id prefix | no later state |
| freshnessAgeSec | schema only | optional nullable | unused | none required | no: null |
| copyabilityOutcome | schema only | optional nullable | Signal.status mutable and UNUSED | deliberately not read | NO: null; do not retain whole signals table |
| paperOutcome | schema only | optional nullable | PaperOrder.status mutable and UNUSED | deliberately not read | NO: null; no fill/settlement/position outcomes |
| sourceRecordId/sourceEventId | custody, idempotence, replay | required capture metadata | original identities | Trade.id/polymarket_trade_id | yes, retain both, never rewrite |
| paperRecordId/source transaction cursor | decision linkage, completeness | required when decision observed | original identity/linkage | PaperOrder.id + Signal.source_trade_id | preserve original linkage; checkpoint recovery can replace callback receipt |

Shadow-side trace: `evidence.ts:61-67` streams source observations into `phase4.ts:addShadowObservation` without Poly2 identity mapping. Only CONTROLLED_OVERLAP and inclusive original `sourceFirstSeenUtc` interval enter groups. Group-first metadata is asset/size/side/sourceTs/tx from economic group key; raw=min sourceFirstSeenUtc, usable=min completedUtc where wallet/side/asset/size/price are truthy and hydration FULL. roles/sources/emitter drive population and maker-only relevance. `readMarketMetadata` uses first REST title/conditionId. None requires Poly2 outcomes. `poly2-adapter.ts` canonical mapping is a separate unchanged one-way utility; Phase4 matches wallet/asset/size/side/tx/time, not by replacing native IDs.

Minimum journal: committed original trade-ingestion facts plus linked initial decision facts, original identity/clocks/decimal text, wallet/condition identity, durable read checkpoints, activation and terminal authority. No five-table copy, outcomes, wallet approval history, fills, positions or settlement data. These required insertion fields are not updated/deleted in inspected code; this is not a DB-enforced guarantee. A retention/immutability violation fails recovery, and independently verified retention is needed for completeness.

## Boundary semantics / limits

Trade inclusion uses original **ingestedUtc**, not traded_at, capture arrival, source MAX or source persistence time. Frozen contract §8 and phase4.ts filter original ingestion clock and wallet; there is NO decision commit-visibility-at-E rule. Post-E committed initial decisions and straddling response intervals are not scientific exclusions. `normalizedUtc ?? decisionUtc` supplies usable latency, and original miss_reason supplies policy counts. In-window ingestions committing after a final read remain eligible and must be recovered. No new grace or decision cutoff is introduced.

The executable isolated SQL checkpoint reader recovers retained immutable insertion facts after missed callbacks and downtime. It scans the complete frozen ingestion population and linked orders in one read-only consistent transaction, not a high-ID/MAX watermark. Terminal closure remains unavailable: no supplied authority proves that every possible writer has drained transactions with old ingestion clocks and cannot later insert an in-window trade or a relevant initial decision. Source labels, repeated scans and signatures do not establish that property. Without independently pinned retention and visibility/drain authority plus a final read after its closure point, archive remains INCOMPLETE. No trading admission freeze, callback atomicity mandate or PITR is imposed.
