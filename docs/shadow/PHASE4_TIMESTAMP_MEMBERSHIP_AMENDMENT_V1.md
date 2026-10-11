# Phase 4 timestamp membership amendment V1

Status: **implemented prospectively; timestamp-only independent review PASS** under receipt `deleg_37e63713`.
This amendment changes no prior result and grants no later-phase authority. Phase 4 fence work is separately authorized and documented in `PHASE4_AUTHORITATIVE_FENCE_RESUME.md` and `PHASE4_WRITER_INVENTORY_AND_CLOSURE_GATE.md`; the accepted writer boundary is the declared backend/bot application architecture.

## Authorization and reason

This is the separately authorized prelaunch correction to timestamp semantics,
not a historical rerun or a reinterpretation of a prior experiment verdict.
The earlier string interval and millisecond `Date.parse` authority disagreed with
native PostgreSQL's microsecond instants. The four reproduced counterexamples are
now regression tests for the approved rule; originals are never rounded or rewritten.

For `S=2026-01-01T00:00:00.000Z`, `E=2026-01-02T00:00:00.000Z`:

| Original source clock | Old string membership | V1 exact membership |
|---|---|---|
| `2026-01-01T00:00:00.000001Z` | OUT | IN |
| `2026-01-02T00:00:00.000001Z` | IN | OUT |
| `2026-01-02T00:00:00Z` | OUT | IN |
| `2026-01-02T00:00:00.000Z` (same instant as preceding) | IN | IN |

## Prospective contract

- Population membership is **`instant(S) <= instant(original clock) <= instant(E)`**.
  Both endpoints are inclusive; no grace interval, shifted window, changed cohort
  or altered insertion/commit population definition is introduced.
- Accepted grammar: `YYYY-MM-DDTHH:mm:ss[.fraction](Z|+HH:mm|-HH:mm)`, year
  `0001..9999`, valid Gregorian calendar, hours `00..23`, minutes/seconds `00..59`,
  offset hours `00..15` and minutes `00..59` (PostgreSQL-compatible numeric offset range). Offset normalization is for integer
  comparison only, never rewriting evidence. Uppercase `T`/`Z` are required.
- No fraction and **one through six** fractional digits are accepted, including
  native optional fractions, milliseconds, and full microseconds. More than six
  digits are **explicitly rejected**, even trailing zeroes: V1 is a microsecond
  contract aligned with PostgreSQL/Python, not silent nanosecond truncation.
- Naive timestamps, date-only/space-separated values, unknown offset `-00:00`,
  rollover dates, leap seconds, `24:00`, invalid zones, whitespace and alternate
  spellings are rejected. Leap-second support is not inferred from either runtime.
- Canonical authority is signed integer epoch microseconds: TS `BigInt`, Python
  integer arithmetic on validated calendar fields. Neither `Date.parse` nor
  `datetime.timestamp()`/floating epoch subtraction authorizes membership.
- JSON evidence keeps both `original` and decimal-string `epochMicros`. Original
  clock fields and source IDs remain unchanged. Canonical audit values are derived
  or verified against originals; they cannot replace them as independent authority.
- Earliest per-source raw arrival and earliest usable completion use exact instants.
  Equal instants retain the existing first encountered original representation.
  Reconciliation `FIRST` remains durable **commit order**, not earliest arrival.
- Latency subtraction and ordering occur at integer precision, with conversion to
  existing numeric seconds (or REST delay milliseconds) only at metric rendering.
  The existing 1-second advantage/tie, 120-second fallback, 300-second freshness,
  matching precedence, formulas, policy classifications and actionability rules
  remain unchanged. Exact operands prevent microsecond threshold/tie artifacts.
- Original traded-at clocks accompany numeric source-second display values, so
  matching uses the original exact source instant rather than a rounded epoch
  display number when that original is available.

## Trace of affected production boundaries

| Boundary | V1 authority / retained evidence |
|---|---|
| `phase4.ts` export validation and frozen-window equality | strict exact parser, inclusive membership, exact endpoint equality |
| Poly2 primary population exclusion | `inWindow(original ingestedUtc)`; cohort/exclusion ordering unchanged |
| Shadow array/streaming reducer | same `addShadowObservation` exact membership and earliest-arrival/completion reduction |
| Matching / raw and usable latency / freshness | exact differences and integer thresholds; numeric units unchanged |
| `poly2-snapshot.ts` | shared integer `utc` authority; original traded-at string plus canonical epoch retained |
| `poly2-archive.ts` | exact full-population membership and min/max order; retained originals with replay-checked clock audit |
| `poly2-prospective.ts` and its worker | exact trade/decision guards, original-ingestion filter, interval order and min/max; replay-checked original/canonical audit |
| Python checkpoint SQL adapter | PostgreSQL typed inclusive predicates; SQLite deterministic exact-integer UDF instead of text predicates; strict original serializer and integer cross-check |
| Python source hook and frozen drain | shared strict integer epoch guards (drain imports checkpoint); original-clock dual fact evidence |
| Racing publication/recovery and Shadow readers | original source clock fields retained; new source observations carry dual clock evidence, readers derive comparison from originals |
| Standalone multisource metrics | same integer parser; subtract/filter/order before rendering seconds/milliseconds |
| Runner seals and first-observation evidence | original CLI window spellings retained; exact duration/endpoint/readiness/observation guards; shared parser bytes retained and hash-bound with sealed runner |
| Status binding / capture diagnostic | strict parser and exact endpoint equality; original window and canonical evidence retained in output |

OS sleeps, signal timers and diagnostic numeric durations still require numeric
seconds; these are scheduling/display adapters, not scientific membership
predicates. Other remaining `Date.parse` occurrences are the operational
180-second data-quality heartbeat and RPC deadline generation, not comparison
population, source-first ordering or scientific latency. No operational policy
threshold was retuned. Run/custody binding hashes deliberately remain sensitive
to original serialized bytes; instant equality does not normalize an identity.

### Source and SQL timezone trace

Read-only source inspection (no Poly2 import, DB query or edits) confirmed
`/opt/poly2/backend/src/polycopy/models.py:131-132` uses
`DateTime(timezone=True)` for `traded_at` and `ingested_at`; the latter defaults to
application `utcnow`. PaperOrder `t2_decided_at` at line 247 is also timezone-aware.
Native fixture readback reported `timestamp with time zone|6`, `TimeZone=UTC`,
and empty `listen_addresses`. PostgreSQL stores instants, not the original input
ISO zone spelling; the Python adapter preserves its actual aware source datetime
serialization, and preserves supplied string clocks verbatim. The matrix also
passes the original supplied ISO spellings independently to the production TS
comparator to prove representation invariance.

## Native inserted-row equivalence matrix

The actual production `SQLAdapter.scan()` ran in a restricted native PostgreSQL
session, not a handwritten capture membership stand-in. Its captured IDs were
compared with typed SQL and the actual `compare()` and `buildShadowGroups()` via
`tests/poly2_timestamp_matrix.ts`. The resumed timestamp-only pass also exercises
production archive sealing and replay using explicitly synthetic custody; native
inserted rows prove clock semantics, not source-boundary custody. SQL, capture,
comparator, Shadow and archive membership agree for every row. The four columns
below list the original native/comparison checks; archive agrees with each:

| Case | Original clock | SQL / Python capture / TS comparator / Shadow |
|---|---|---|
| S-1us | `2025-12-31T23:59:59.999999Z` | OUT / OUT / OUT / OUT |
| S | `2026-01-01T00:00:00Z` | IN / IN / IN / IN |
| S+1us | `2026-01-01T00:00:00.000001Z` | IN / IN / IN / IN |
| E-1us | `2026-01-01T23:59:59.999999Z` | IN / IN / IN / IN |
| E | `2026-01-02T00:00:00Z` | IN / IN / IN / IN |
| E+1us | `2026-01-02T00:00:00.000001Z` | OUT / OUT / OUT / OUT |
| E millis | `2026-01-02T00:00:00.000Z` | IN / IN / IN / IN |
| E micros | `2026-01-02T00:00:00.000000Z` | IN / IN / IN / IN |
| E positive offset | `2026-01-02T01:00:00+01:00` | IN / IN / IN / IN |
| E negative offset | `2026-01-01T19:00:00-05:00` | IN / IN / IN / IN |
| S offset +1us | `2026-01-01T05:30:00.000001+05:30` | IN / IN / IN / IN |
| E offset +1us | `2026-01-01T19:00:00.000001-05:00` | OUT / OUT / OUT / OUT |
| single fractional digit | `2026-01-01T12:00:00.1Z` | IN / IN / IN / IN |
| max positive numeric offset | `2026-01-02T15:59:00+15:59` | IN / IN / IN / IN |
| max negative numeric offset | `2026-01-01T08:01:00-15:59` | IN / IN / IN / IN |

The native test also checks every SQL integer epoch against the two production
parsers, the Python-captured original serialization through TS, retained canonical
fact evidence, and rejection of actual restricted-role DML. These tests prove
clock equivalence, not complete writer enrollment/admission or upstream coverage.

## Resumed timestamp-only reconciliation

The existing dirty amendment implementation was inspected rather than restarted.
Branch/HEAD remain `feat/comparison-ready-instrumentation-v2` /
`f0296c9e0fa1a36c2a0d369021a5bbd8a8b5f477`. The pre-existing fence, drain,
session-observer, fenced-archive and native fence-test paths also exist. Their
presence does not establish completed acceptance; this pass did not edit them,
activate them or execute their gated native fixture matrix. Fence work remains
behind the parent-dispatched independent timestamp review.

This resumed pass edited only this document and these existing tests:
`tests/poly2-ingestion-clock-contract.test.ts`,
`tests/poly2_ingestion_clock_postgres_test.py`, and
`tests/poly2_timestamp_matrix.ts`. No production source replacement was needed.
Six surrounding-whitespace rejection cases were added in both languages; all
were already rejected by the strict implementation. Every one of the 15 native
clocks now additionally runs actual archive seal/replay and verifies the original
string plus decimal canonical integer, including excluded rows. The 12 actual
Python-captured included rows also run through that bridge with retained evidence
checked against the native epoch values. Synthetic archive custody is not claimed
as enrollment or admission authority.

## Verification and cleanup

Executed commands:

- `npm run build`: passed.
- Focused command: `npx vitest run tests/poly2-ingestion-clock-contract.test.ts tests/poly2-archive.test.ts tests/poly2-prospective.test.ts tests/phase4-compare.test.ts tests/streaming.test.ts`: **5 files, 114 tests passed**.
- `npm test`: **24 files, 441 tests passed**.
- `python -m unittest discover -s tests -p '*.py'`: **166 discovered, OK, 44 skipped**
  (122 executed). Skips: 17 legacy native-drain, 18 already-present native fence,
  8 optional SQLAlchemy session-observer, and 1 native timestamp matrix without
  its explicit fixture variable. The timestamp native gate was separately run
  after the final bridge/test edits; other skipped families are not claimed passed.
- `POLY2_TIMESTAMP_AMENDMENT_FIXTURE=poly-shadow-timestamp-amendment-v1-f0296c9 python tests/poly2_ingestion_clock_postgres_test.py`:
  native inserted-row matrix plus strict/parser parity tests, **3 tests passed, zero skipped**; 15 inserted cases, all five membership boundaries agree, 21 invalid-format cases rejected in each language.
- `npm run safety`: **OK (6 deps scanned, src/ clean)**.
- `git diff --check`: passed.
- Standalone metrics CLI exercised under local Node v26.7.0; it directly imports
  the shared TypeScript parser through Node's supported type stripping.

Only our exact fixture `poly-shadow-timestamp-amendment-v1-f0296c9` was operated
on: installed `postgres:15-alpine`, `--pull=never`, network `none`, no host binds,
no published ports, tmpfs PGDATA `rw,noexec,nosuid,size=128m`, TCP disabled, private
socket port 55443. Readiness used actual `pg_isready`. The fixture was stopped,
removed and exact-name absence verified; prior fixtures and production containers
were not touched. No production DB queries/imports, provider/trading operations,
deployment, launch/pointer changes, staging, commits, history edits, pushes or PRs.
Synthetic lifecycle tests are not experiment launches.

## Remaining timestamp acceptance matrix

| Requirement | Evidence / remaining gate |
|---|---|
| Four prior counterexamples and six inclusive endpoint cases | Named TS tests plus native 15-row matrix; passed |
| UTC/offset/fraction representation equivalence | Native SQL, capture, comparator, Shadow reducer and archive replay agree; passed |
| Strict invalid-format rejection | 21 invalid values per language, including six whitespace spellings; passed |
| Original strings and canonical decimal integers retained | Comparator records, capture facts and archive audit/replay assertions; passed |
| Exact raw/usable ordering and latency, unchanged scientific budgets | Submillisecond ordering and 1us threshold regressions plus full comparison suite; passed |
| Prospective-only amendment and changed-path record | This document; no prior result reinterpretation |
| Timestamp-only independent review of the final dirty source/test surface | **PASS**; parent review receipt `deleg_37e63713` |
| Admission fence and dependent work | Separately authorized Phase 4 scope; see the current writer-inventory and authoritative-fence documents. Not part of the timestamp-only review |

## Exact amendment path scope

Only these repository paths were authored/edited by this amendment, on top of the
protected pre-existing dirty tree:

```text
docs/shadow/PHASE4_CAPTURE_BLOCKER.md
docs/shadow/PHASE4_FINAL_UNBLOCK_SOURCE_TRACE.md
docs/shadow/PHASE4_TIMESTAMP_MEMBERSHIP_AMENDMENT_V1.md
scripts/exact_clock.py
scripts/multisource-metrics.mjs
scripts/phase4-runner.py
scripts/poly2-comparison-checkpoint.py
scripts/poly2-comparison-source-hook.py
scripts/status/collector.py
src/compare/exact-clock.ts
src/compare/phase4.ts
src/compare/poly2-archive.ts
src/compare/poly2-prospective.ts
src/compare/poly2-snapshot.ts
src/shadow/racing.ts
tests/poly2-archive.test.ts
tests/poly2-ingestion-clock-contract.test.ts
tests/poly2-prospective.test.ts
tests/poly2_ingestion_clock_postgres_test.py
tests/poly2_timestamp_matrix.ts
tests/readiness_runner_test.py
tests/status_binding_test.py
tests/streaming.test.ts
```

Python interpreter caches are generated test artifacts, not authored source.
`poly2-comparison-drain.py`, capture-worker wrappers and streaming reader wrappers
inherit the shared production authority without separate scientific-rule edits.
The two superseded blocker/source-trace documents previously stated amendment review is
pending, while retaining the historical counterexample and cleanup evidence.

**Review barrier:** the parent must independently review timestamp implementation
and verification before resuming any admission fence or later work. There is no
Phase 4 PASS, authoritative fence receipt, production seal or launch approval here.
