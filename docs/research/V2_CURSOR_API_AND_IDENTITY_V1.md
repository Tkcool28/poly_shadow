# V2 API and identity compatibility review

Verified 2026-10-14 against current official sources. Starting main:
`0a776fce2c2d01bd15f9f0a6cd733fc142393773`; contract source:
`e677e665512b2544a7d1a427ab7d8ef78c80bed6` (draft PR #13).
The isolated adapter is governed by the reviewed contract and its explicit addendum.

## Authoritative references

- [OpenAPI](https://data-api.polymarket.com/v2/openapi.json): API 0.1.0,
  `Trade`, `Activity`, `Pagination`; downloaded response retained by the campaign.
- [Overview](https://docs.polymarket.com/api-reference/data-api/overview):
  envelopes, opaque cursors, fixed filters, units, public access, errors.
- [Trades](https://docs.polymarket.com/api-reference/feeds/list-trades):
  user filter, maker+taker selection, size floor and window rules.
- [Activity](https://docs.polymarket.com/api-reference/feeds/list-account-activity):
  user feed, type/side/window and timestamp sort controls.
- [Legacy trades](https://docs.polymarket.com/api-reference/core/get-trades-for-a-user-or-markets):
  paired population settings and legacy field schema.
- [Rate limits](https://docs.polymarket.com/api-reference/rate-limits):
  v2 general 800/10s, trades 300/10s, activity 200/10s. Our 60/min ceiling is lower.
- [Migration](https://docs.polymarket.com/migrate/data-api-v1-to-v2):
  retirement date reverified as **2026-10-24**; envelope/casing/cursor changes.

## API contract and known uncertainties

GET `/v2/trades` and `/v2/activity` require no credentials. Envelopes contain
`data` arrays and `pagination`; `has_more` and explicit `next_cursor` must agree.
Cursor strings are never decoded or fabricated. Page size max1000 upstream;
this adapter requires100. Response offset is cosmetic, never sent as a query.
Resend exact filters, including user/start/end; trade `taker_only=false` includes
maker rows. REST role remains UNKNOWN: selecting both roles is not proof of a
particular row's chain role. Activity retains its default types, with TIP opt-in
unused, default deposit/withdrawal exclusion explicit, TIMESTAMP/DESC explicit.
Window bounds are inclusive epoch seconds; source numeric amounts are shares.

Provider docs describe keyset stability under concurrent writes; this is not a
snapshot or indexing-completeness guarantee. Sequence tie anchors are opaque and
not exposed in row schemas. Timestamp-order checks can detect inversions but cannot
prove equal-time stability. Delayed indexing, source cache lag and omissions remain
UNKNOWN. Feed-specific cache TTL is not promised in inspected documentation;
retain Date/Age/Cache-Control/ETag and `/v2/status`, without inventing a TTL.
429/503 may include Retry-After; this campaign does not retry. Stop data host on
403/429/503. One separately bounded public CHAIN receipt, no provider rotation.

OpenAPI has two internal documentation inconsistencies: activity `user` is marked
`required:false` despite text/error contract requiring it, and `next_cursor` is
not in Pagination.required despite documented explicit-null termination. The
adapter always supplies user and rejects missing next_cursor. These stricter
checks preserve uncertainty; they do not loosen the scientific contract.

## Frozen identity mapping

Supporting fixtures: `tests/v2-cursor-research.test.ts` C6/C12 (documented-schema
fixtures with synthetic values); actual paired raw pages and normalization replay
in the campaign artifact. PASS below means explicit field transformation and
frozen-function preservation, not complete equivalence of provider populations.

| Legacy | V2 | Transformation | Semantics | Fixture / result |
|---|---|---|---|---|
| proxyWallet | proxy_wallet | rename; frozen identity lowercases | wallet exact approved address | C12 PASS |
| transactionHash | transaction_hash | rename; require full hash; frozen lowercase | transaction, not log identity | C12 PASS |
| asset | token_id | rename string, no Number coercion | outcome asset ID | C12 PASS |
| conditionId | condition_id | rename; never substitute Gamma ID | on-chain market condition | C12 PASS |
| size | size | finite number; existing toFixed(6) | share size, not USD | C12 PASS |
| price | price | finite number; existing toFixed(4) | existing numeric normalization | C12 PASS |
| timestamp | timestamp | safe integer, epoch seconds | source block time, not arrival | C12 PASS |
| side | side | require BUY/SELL for trades | wallet perspective, not maker/taker role | C12 PASS |
| type | type | require explicit activity type; existing uppercase identity | TRADE versus other activity retained | C12 PASS |
| title | title | rename unchanged string | existing hydration with conditionId | C12 PASS |
| no row role | no row role | UNKNOWN unchanged; request both trade roles | no manufactured observed role | C12 PASS |
| source response arrival | source response arrival | persist actual responseUtc; immutable on replay | point-in-time evidence | C7/C10/C12 PASS |
| economic candidate | economic candidate | existing tx+asset+size6 function, never storage key | coarse hypothesis only | C12 PASS |
| no exposed sequence_id | no exposed sequence_id | no invented tie-breaker | total tie-order verification | C8 UNKNOWN |
| unspecified default size floor | default 0.01 shares | no silent filter replacement | full population parity | UNKNOWN |

Missing/ambiguous identity fields and unsupported combo rows fail publication.
Explicit empty nontrade asset/condition/side strings are retained, not fabricated;
normalization preserves ungrouped evidence where applicable. Enrichment-only
profile fields are retained in raw bytes and are not invented identity inputs.
No frozen identity, comparator, CHAIN decoder or eligibility function is modified.
