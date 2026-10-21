# POLY SHADOW vs POLY2 — 24-Hour Trade Discovery & Copyability Comparison

**Master project plan — October 21, 2026**  
**Status:** Planning baseline; NOT authorization to deploy, restart workers, activate capture, or launch a run.  
**Purpose:** Establish one durable plan for finishing a useful, visible 24-hour diagnostic comparison without reintroducing unnecessary V5 governance.

---

## 0. THE MISSION — READ THIS FIRST

**We want to know whether the faster/multiple trade-discovery paths in the forked Poly Shadow repository allow Poly2 to discover approved-wallet trades faster, miss fewer trades, and potentially copy at more favorable prices.**

Run Poly2 **as it already operates** and independently observe the *same five currently approved wallets* using Shadow's three collection lanes for one prospective 24-hour interval. Compare genuine wallet-trade events, first-observation delays, data coverage, actual Poly2 signal/action records, and defensible price-opportunity proxies. Make the information accessible on a working dashboard, then produce a final report with both improvements and limitations.

**Success is evidence answering that question.** It is not a new attestation regime, a scientific approval workflow, a redesigned trading engine, or an extra month of preflight ceremonies.

**Do not confuse the old `Polycopy` specialist-paper-trading plan with this project.** This plan targets the **`Tkcool28/poly_shadow` vs `Tkcool28/Poly2`** comparison only. The prior specialist plan is context, not a specification for this experiment.

## 1. Hard scope and non-goals

### In scope

- Preserve the forked Shadow project's V2-compatible Polymarket Data API acquisition path.
- Compare the three Shadow evidence lanes **CHAIN**, **REST_TRADES**, and **REST_ACTIVITY** against Poly2's existing wallet-trade ingestion.
- Freeze and observe the same five *currently approved* wallets in stable canonical order.
- Measure incremental unique trades, cross-source confirmations, observed discovery latency, interval coverage, and ambiguity.
- Show whether earlier observation creates potential *paper-copyability* benefits, including a carefully defined price-at-observation analysis when contemporaneous price evidence exists.
- Display live progress and an end-of-run report on a separate **UNCERTIFIED_DIAGNOSTIC** dashboard surface.
- Reuse proven collectors, V2 trade-identity logic and `compareV2()` rather than rebuild collection or matching.
- Preserve evidence with bounded memory, disk usage, failure reporting, and restart-safe state.

### Explicitly out of scope

- Real-money trading or live broker execution.
- Changes to Poly2 wallet approvals, strategy, scoring, sizing, risk limits, signal selection, fees, execution, settlement, or current paper positions.
- Claiming a Shadow-only trade would necessarily have been a successful, eligible, or profitable copy.
- Requiring V5 certificates, signed installation attestations, named data custodians, authority pins, signed enrollment, or owner-assignment ceremonies **for this diagnostic**.
- Disabling, bypassing, or relabeling existing **certified V5** protections. They remain intact but are not a dependency of the separate diagnostic path.
- Re-running October 13's incomplete session and treating its partial capture as a completed comparison.
- Unrelated repository refactors, wallet discovery/scoring, or new data-pipeline architecture.

## 2. Known history, evidence and current truth

The following is historical evidence **reported in the project conversation and Hermes handoffs**, not a fresh verification of October 21 runtime state. Recheck it at implementation and again at launch.

| Area | Last verified/reported state | Implication |
| --- | --- | --- |
| Shadow repository | `Tkcool28/poly_shadow`, previously observed `29c0ff181dba212a56c50402766873afcd344ad2` | Verify remote `main` and production checkout independently. Never assume SHA is current. |
| Poly2 repository | `Tkcool28/Poly2`, observed `219ad2c66442632b5e41506ba485062420a27c15` | Verify live version at actual run start. |
| Shadow deployment | `/opt/poly-shadow` | Reuse existing collector and dashboard infrastructure when safe. |
| Poly2 deployment | `/opt/poly2` | Treat as baseline; no trading-path changes. |
| Cohort | Five approved wallets in database | Read and freeze actual ordered wallet IDs; do not invent or expand the cohort. |
| Shadow methods | CHAIN, REST_TRADES, REST_ACTIVITY; V2 cursor compatibility work exists | Check actual V2 runtime and correctness; avoid obsolete V1 calls. |
| Prior controlled run | October 13; approximately 57 minutes; incomplete acknowledgements/transactions; no final comparison | Not admissible as proof of missed trades or price advantage. |
| V5 official Stage 1 | `COMPARISON_NOT_AUTHORIZED` when V5 authority missing | Preserve this truthful state; add separate diagnostic UI. |
| Poly2 capture | `shadow_capture_enabled=false` in reported live setup | Diagnostic should not require enabling capture or restarting Poly2 workers. |
| Poly2 safety | `PAPER_MODE=true`, `ALLOW_LIVE_TRADING=false`, `ORDER_KILL_SWITCH=false` reported | Reconfirm exact controls; keep unchanged. Do not infer live trading from kill-switch alone. |
| Diagnostic implementation attempt | Existing branch `feat/uncertified-diagnostic-comparison-v1` pointed at old `main` | Branch name alone **does not** prove implementation survived. |
| Lost worktree | `/root/.hermes/cache/scratch/poly-shadow-diagnostic-v1` disappeared; Git worktree entry prunable; unfinished changes reportedly uncommitted | **Recover before rebuilding**; never use transient scratch as the sole copy of code. |
| Tests reached before loss | Exporter: 16 passed; runner: 10 passed/1 failed, new signal tests syntax error; earlier offline integration 1 passed | Historical progress only; **all tests must be rerun on recovered/new durable code**. |
| Known risk findings | Oversized decision contexts before materialization; SIGTERM/child-process cleanup | Verify SQL/driver-side bounds and fully test termination. |

**Important limitation:** A previously discussed two-hour bounded run is valuable operational evidence, but its artifacts, exact duration, resource ceilings and findings have not been independently reverified for this plan. Do not label 24-hour operation proven from a shorter run; use an updated preflight with measured headroom.

## 3. Recovery-first rule: avoid losing weeks of work again

Before doing any new coding:

1. Inspect the Git repository, worktree metadata, remote branches, PRs, reflogs, dangling objects, Hermes cached logs/artifacts, and any other known working locations **read-only**.
2. Determine whether the vanished worktree's uncommitted exporter/runner/reporter/tests can be recovered. Git normally cannot retrieve changes that were never committed, so **do not claim recoverability without file/object evidence**.
3. If recovered, copy into a stable, version-controlled working directory and record checksums. If not, explicitly mark files **LOST** and reconstruct the *smallest necessary* implementation from verified main plus recorded specs/test contracts.
4. Do not use `/root/.hermes/cache/scratch` as the only implementation location. Use a persistent repository worktree or separate safe clone, e.g. under `/opt` or another intentionally durable developer workspace **without modifying production checkout or process**.
5. Commit small, reviewed, bounded increments and push a **draft PR early** so progress is recoverable. A draft PR **does not mean deployment authorization or review approval**. Do not wait for all tests to pass before creating a recoverable draft PR; label tests/incomplete parts honestly.
6. Before each work session, `git status` + branch + full SHA + remote main comparison; after each session verify remote branch/PR head and actual files. Track existing untracked source; never casually clean/delete it.
7. If remote main advanced, inspect differences and rebase/merge only after resolving conflicts and rerunning affected checks. No destructive resets to preserve appearances.

**Success at this stage:** An actual durable branch/PR containing recovered or freshly reconstructed code, with an explicit list of what survived and what was lost.

## 4. Comparison design — keep it simple and defensible

### 4.1 Run topology

```text
Approved-wallet cohort (frozen 5, stable order)
                |
        +-------+--------+
        |                |
  Poly2 existing     Shadow observer
  ingestion &        (V2-compatible)
  paper decisions      |     |     |
        |            CHAIN REST  REST
        |                  TRADES ACTIVITY
  read-only bounded        |
  evidence exporter   timestamped raw records
        |                |
        +-------+--------+
                |
           compareV2()
                |
         diagnostic report
                |
    separate dashboard + archive
     UNCERTIFIED_DIAGNOSTIC
```

Keep original Poly2 bot/backend running as configured. The observer is a separate bounded process, read-only relative to Poly2, and never sends orders. **No V5 capture activation is necessary for this diagnostic.**

### 4.2 Run window

- One prospective **24-hour wall-clock window**; both systems assessed over the identical UTC `[start, end)` interval.
- Freeze **cohort ordering, wallet identifiers, source configurations, repository SHAs, runtime parameters, and UTC time base** before launch.
- Record both **trade/event time** and **first local observation/ingestion time**; never substitute HTTP response arrival for completed normalization.
- Preflight verifies both systems are healthy and that the Poly2 baseline is actually ingesting; otherwise either postpone launch or explicitly label any compromised interval.
- Record source outages, retry episodes, 429s, cursor gaps, rollback/reorg ambiguity, and clock quality. Don't hide unusable intervals inside totals.
- Explicit statuses: `READY`, `RUNNING`, `INCOMPLETE`, `FAILED`, `COMPLETE`; separate report classification `UNCERTIFIED_DIAGNOSTIC`. Only a complete closed 24-hour window can count as a completed 24-hour comparison.

### 4.3 Identity, matching, and uncertainty

Reuse Shadow V2 matching logic (`compareV2()`) and existing ambiguity classifications. De-duplicate with source-appropriate stable IDs plus validated wallet, token/condition, side, size, price and timestamps where the established contract requires them.

Preserve cross-source identities, original raw references, source identity, first-observed timestamps, clock uncertainty and any provider backfill indicators. **A historical trade found after the fact is not a fast real-time detection.** Separate retroactive backfill from prospective discovery.

Report matched, Shadow-only, Poly2-only, ambiguous, duplicate, invalid and **INDETERMINATE** observations. When the other system lacked proved coverage, never translate "one-sided" directly into "missed." Differentiate *a novel candidate* from *a proven collection miss*.

### 4.4 What counts as a faster discovery?

For each confidently matched underlying wallet trade with both observation clocks:

- `Poly2 detection latency = poly2_ingested_at - source_trade_event_at`.
- `Shadow lane detection latency = shadow_normalized_observed_at - source_trade_event_at`.
- `Shadow lead = Poly2 first observed - Shadow first observed` (positive means Shadow saw it earlier).

Label these **observed timings**, with clock offset uncertainty. Calculate counts, p50, p90, p95, max, and percentages ahead by at least 1s/5s/10s/30s/60s (only where precision justifies it). Separate CHAIN / REST_TRADES / REST_ACTIVITY, earliest-Shadow union and Poly2 baseline. Never compare a provider event clock to a local observation clock as if they were equivalent.

For Shadow-only candidates, report the Shadow latency but not an invented Poly2 timestamp. Prefer directly observable *detection difference* over ambiguous "speed" claims.

### 4.5 Does speed improve copyability or price?

**Two separate questions:**

**A. Discovery improvement:** How often does Shadow observe a genuine wallet trade sooner or capture an otherwise unseen valid candidate?

**B. Potential execution improvement:** At that earlier observation, was a copyable quote/orderbook available, and how did the executable price/spread/liquidity compare with the price available at Poly2's later observation?

For B, use timestamped **contemporaneous** Polymarket market/quote evidence for the actual side and token if already available or safe to sample prospectively during the experiment. Specify bid/ask, relevant depth, effective price including fees and slippage assumptions, and data timestamp/staleness. Merely using the copied wallet's execution price or later historical midquote **does not prove** what Poly2 could have filled at.

If quote/depth evidence is missing, display `PRICE_ADVANTAGE_UNKNOWN`. If baseline observation never occurs, display `POLY2_PRICE_UNKNOWN`. Do **not** manufacture savings, improve-looking prices, or profitability. If no valid quote sidecar exists, the 24-hour run may still answer discovery/latency; label the price question **UNRESOLVED** and make a bounded subsequent pricing test a separate decision.

For trade eligibility: use original, time-bound Poly2 immutable decision/audit data if available. A Shadow-only observation is **NOT EVALUATED BY POLY2**, not "eligible", "rejected", or "would fill." Keep actual PAPER order outcomes distinct from exploratory counterfactual price opportunities.

## 5. Smallest technical implementation

### 5.1 Reuse before writing

Inventory and reuse existing:

- Three working Shadow collectors and bounded V2 cursor adapter.
- `compareV2()` and its stable identity/ambiguity rules.
- Shadow status publisher and public HTML (separate diagnostic panel only).
- Poly2 persisted source-trade, signal, decision-audit and PAPER-order evidence (read-only).
- Existing deterministic integration fixtures/tests where recoverable.

Only add genuinely missing adapters: isolated runner, bounded exporter, reporter, diagnostic publication, and optionally a strictly bounded quote/price sampler if there is no current reliable quote evidence. **Do not modify the original certified Stage 1 CLI or fake its authorization.**

### 5.2 Durable run store and runner

- Dedicated run directory outside the certified `current-run.json` tree; unique ID, machine-readable manifest and append-only raw/normalized streams.
- Atomic manifests; bounded NDJSON lines; source checkpoint/cursor plus resume rules; deterministic readback and reporting.
- Disk quota, page sizes, row caps, request concurrency, CPU/RSS boundaries and source-specific rate limits; measured values chosen from existing proven configuration and current VPS headroom, not guessed constants.
- SIGTERM/SIGINT handler, terminate **full child process group**, bounded escalation and reap; leave preserved evidence plus truthful `INCOMPLETE` manifest on interruption.
- Real-process tests, including repeated signals and unresponsive children. Avoid ghost observers after interruption.
- Unknown/partial source failure never converted into zero trades.

### 5.3 Bounded Poly2 exporter

- Read-only PostgreSQL connection/credentials, explicit `READ ONLY REPEATABLE READ`, verified transaction flags, no locks that disrupt normal ingestion.
- Freeze start/end high-water marks and reconcile with timestamp-window semantics; row-capped keyset paging, deterministic order, total bytes caps, no mutable historical-state inference.
- Preserve wallet/source-trade IDs, actual trade/event time, ingestion time, original audit identifiers and immutable decision/action events where linked.
- Context bounds enforced **in SQL/driver path before Python retains large values**. The lost implementation reportedly used 4 KiB/context, 512 KiB/page, 4 MiB retained total; treat these as historical proposed parameters requiring test confirmation, not proven production thresholds.
- Explicit truncation/missing-audit status; truncated evidence cannot prove an action.
- Test with an isolated PostgreSQL instance and real driver for context bounds and transaction semantics; **do not write production DB**.
- Export only necessary evidence for the interval; ensure end-window finalization does not silently miss late ingests. Classify late-arriving evidence separately and disclose lag horizon.

### 5.4 Diagnostic report and dashboard

Publish a **separate** read-only `UNCERTIFIED_DIAGNOSTIC` panel/file within the established status-page architecture; never overwrite certified Stage 1 fields. Show:

1. Run ID, UTC interval, elapsed/remaining time, current state, source and repository revisions.
2. Cohort-level and per-wallet counts: unique matches, Shadow-only candidates, Poly2-only, ambiguous, duplicates, invalids and indeterminate/coverage gaps.
3. Side-by-side observed latencies for Poly2 and each Shadow method; p50/p90/p95 plus head-to-head lead distribution.
4. Source health: last successfully normalized record, gaps, 429s/errors, stale intervals, V2 cursor progress and source throughput.
5. Poly2 actual signals, policy/audit decisions and PAPER actions **only where supported by linked immutable evidence**; explicit unknown/unlinked counts.
6. Price opportunity: executable quote comparison **only when time-aligned quote/depth exists**; otherwise visible `PRICE_ADVANTAGE_UNKNOWN` / `UNRESOLVED`.
7. Recent verified examples with wallet, trade identity, trade time, source observations, Poly2 observation, observed lead, match certainty, and decision/quote-evidence status.
8. Downloadable end-of-run summary and raw manifest/checksum references, with no secrets or private keys in public output.

The certified panel can continue to show `COMPARISON_NOT_AUTHORIZED`. That is **not a failure of the separate diagnostic**. The dashboard must distinguish not-running, collecting, degraded, complete and stale report states; do not show generic 'stale/unavailable' in place of a known diagnostic failure reason.

## 6. Execution phases — do them in this order

### Phase 0 — Recover and establish a durable branch / draft PR

**Deliverable:** evidence-based recovery inventory and working durable draft PR. Investigate lost cache/worktree before reconstructing. Keep the PR draft until independently reviewed. Stop redoing work after crashes because edits lived only in scratch.

### Phase 1 — Finish minimal isolated diagnostic path

**Deliverable:** runner, exporter, V2 reporter and dashboard panel linked by a deterministic offline end-to-end fixture. No additional governance layer. Don't rewrite code that already works.

### Phase 2 — Validate only the meaningful safety/evidence gates

**Deliverable:** green latest-head tests including:

- Exporter: row/byte/context bounds; read-only transaction; wallet order; identity and clocks; audit linkage; late data; hostile oversized context using real isolated PostgreSQL driver.
- Runner: exact window; storage monitoring; stop/reap descendant processes with SIGTERM/SIGINT; incomplete manifests; resume/fail-closed; clock/source errors.
- Comparator: V2 cursor/normalization; three sources; matched/one-sided/ambiguous/INDETERMINATE; duplicates; wallet reconciliation; timing math; no fabricated eligibility.
- Dashboard: separate diagnostic state, authentic data mapping, refresh/staleness semantics, downloadable report, no certified-field change.
- Relevant original V5 regressions **only to prove unchanged behavior**, not to acquire V5 authority.
- TypeScript build, Python compilation, focused/full practical CI, diff/scope review, fresh independent review of current exact commit.

Do not repeatedly invalidate passing tests with untested new edits. Fix an actual failing defect, rerun affected tests and freeze the reviewed SHA.

### Phase 3 — Merge/review gate and controlled deployment

**Deliverable:** reviewed exact SHA, approved merge and **explicit user approval before production deployment**. Validate current GitHub main, resource headroom, baseline Poly2 ingestion, health and backup posture. Deploy **Shadow diagnostic components only** under dedicated limits. Do not change existing Poly2 strategy or trading controls, restart workers, activate V5 capture, or launch 24 hours as a side effect. If deployment truly requires impacting Poly2, stop and present the exact reason and minimal alternative.

### Phase 4 — Brief real operational smoke test

**Deliverable:** limited-duration observation that demonstrates:

- Each Shadow lane produces genuinely normalized prospective V2 trade events or explicitly explains zero genuine events and source health.
- Poly2 exporter can read correct data without DB writes.
- Same approved wallets, expected identities, timestamp semantics and dashboard updates.
- No orphan processes; bounded memory, disk, CPU and database load.
- At least one real matched example when the cohort yields a trade, or honest `NO_MATCHED_EVENT_OBSERVED` without fake data. A no-trade smoke run is not proof matching works; rely on offline fixture plus later real events.
- Certified Stage 1 semantics unchanged.

**Do not count smoke duration toward the 24-hour scientific window.** Report precise remaining issues rather than reintroducing attestations.

### Phase 5 — Full prospective 24-hour comparison

**This is the target milestone.** After smoke passes and user explicitly approves launch:

1. Freeze the manifest and start time; cohort and versions unchanged for the window.
2. Start the dedicated resource-limited Shadow observer, not the certified V5 experiment.
3. Keep Poly2 running with its existing collector and PAPER settings unchanged.
4. Publish live diagnostic metrics throughout, with accurate source freshness and honest unknowns.
5. Observe exactly 24 hours, preserving interruptions and coverage gaps rather than silently restarting with a new window.
6. Stop cleanly; freeze end marks; perform bounded Poly2 read-only export and any disclosed late-arrival grace procedure.
7. Run comparator and price-evidence assessment; create final report and mark truly complete only after artifact reconciliation.
8. Archive raw records, manifests, checksums, and the final dashboard/report evidence in durable storage.

If the observer fails before 24 hours, classify run `INCOMPLETE`, preserve useful evidence, diagnose the actual failure, and seek approval for a new window. **Never splice separate windows together and call them uninterrupted 24 hours.**

### Phase 6 — Answer the user's original decision

**Deliverable:** plain-language comparative verdict and supporting per-wallet data.

- Is Shadow faster at detecting the same trades? How much faster at median and tail? Which lane contributes?
- Does Shadow find additional credible trades Poly2 does not observe? Which are true coverage-backed misses versus unknown?
- Are additional trade opportunities likely *timely enough* to matter under Poly2's existing signal freshness and paper decision rules? What is demonstrable versus unknown?
- When contemporaneous executable quotes exist, would earlier detection improve available paper execution price after fees/depth/slippage assumptions? By how much, distributionally, and with what limitations?
- How often does Shadow add no value, arrive later, duplicate data, or degrade?
- Were costs and VPS resource impact acceptable?
- Recommendation: **ADOPT / TEST LONGER / DO NOT ADOPT**, with a scoped follow-up design if adopting (separate PR; no automatic production replacement).

**Do not define success as 'Shadow wins.'** A negative or inconclusive result is valid; the result must be observable and honest.

## 7. Minimum reporting tables

### 7.1 Coverage and discovery

| Wallet | Poly2 unique trades | Shadow unique (union) | Both | Shadow-only candidates | Poly2-only | Ambiguous | Indeterminate | Proved misses where coverage permits |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 5 wallet rows | measured | measured | measured | measured | measured | measured | measured | measured |
| TOTAL | measured | measured | measured | measured | measured | measured | measured | measured |

### 7.2 Speed

| Method | Valid matched N | Detection latency p50/p90/p95 | Lead vs Poly2 p50/p90/p95 | % earlier by >= 5s / 30s / 60s | Unknown clock/coverage N |
| --- | ---: | --- | --- | --- | ---: |
| Poly2 baseline | measured | measured | reference | reference | measured |
| CHAIN | measured | measured | measured | measured | measured |
| REST_TRADES | measured | measured | measured | measured | measured |
| REST_ACTIVITY | measured | measured | measured | measured | measured |
| Earliest Shadow union | measured | measured | measured | measured | measured |

### 7.3 Copyability / price evidence

| Category | Count | Evidence standard |
| --- | ---: | --- |
| Poly2 actual ingested trades | measured | source trade DB row |
| Actual Poly2 eligible/rejected decisions | measured or unknown | immutable linked audit |
| Actual Poly2 PAPER executions | measured or unknown | original linked paper action |
| Shadow-only observed candidates | measured | original Shadow observations; not automatically eligible |
| Matched opportunities with time-aligned executable quotes | measured | valid bid/ask/depth with timestamps |
| Earlier-observation price improvement | measured or unknown | comparable side/depth/fees at both times |
| Price advantage unknown | measured | missing/insufficient quote evidence |

## 8. Hard guardrails (short and operational)

**Required:** PAPER only, read-only diagnostic, no real orders, unchanged Poly2 production ingestion/trading behavior, bounded resource usage, stable source identity and timestamps, durable artifacts, truthful incomplete/unknown status, dashboard separation, explicit operator/user approval for production deploy and 24-hour launch.

**Not required for this diagnostic:** user signatures, named custodians, cryptographic worker enrollment, V5 authority pins, an ownership hierarchy, a new formal scientific-approval ceremony, or a certified V5 run. Do not use missing V5 authority to block **separate honest diagnostic evidence**. Do not pretend V5 checks passed.

**Security:** no secrets/keys/DB credentials embedded in artifacts, public UI or PR. Production read-only DB credentials must be scoped, stored securely, and never logged. Do not relax firewall or publisher permissions to expedite the run.

**Operational:** don't rely solely on historical two-hour memory safety. Perform a new measured launch preflight and monitor current resource use throughout 24 hours. Respect co-running services on the shared VPS.

## 9. Anti-drift rules for Hermes and future chats

1. **One question:** Is Shadow a better discovery source for Poly2, especially for speed, missing trades and price opportunity?
2. **One comparison:** Five approved wallets; same prospective 24-hour UTC interval.
3. **One baseline:** Existing unmodified Poly2 behavior; no hypothetical trading engine substitution.
4. **Three Shadow sources:** CHAIN, REST_TRADES, REST_ACTIVITY with valid V2 handling.
5. **One diagnostic result surface:** Separate, visible, readable live dashboard + final report.
6. **One durable development branch/PR:** Never entrust all work to a prunable Hermes cache worktree.
7. **No V5 bureaucracy:** Keep original V5 fail-closed, but avoid its certified workflow entirely.
8. **Preserve uncertainty:** Missing evidence is unknown; no invented fills, decisions or prices.
9. **Minimal changes:** Fix actual tested blockers; avoid redesigning adjacent systems.
10. **Deliver the experiment:** After valid PR, deployment and smoke test, conduct the authorized 24-hour run, not an endless series of preparations.

For every continuation, report only: `current phase / actual branch+SHA / verified work done / exact test results / remaining blocking defects / next concrete action`. Do not invent PR numbers or declare readiness without checks.

## 10. Completion checklist

- [ ] Investigated vanished worktree; documented recovered vs lost files.
- [ ] Created persistent development workspace and durable draft PR.
- [ ] V2-compatible three-lane Shadow observer works in isolated diagnostic mode.
- [ ] Poly2 read-only bounded exporter works with real isolated PostgreSQL driver tests.
- [ ] Runner process termination, interruption and limits are verified.
- [ ] Existing V2 comparator and identity rules reused; unknowns preserved.
- [ ] Comparison aggregates reconcile by wallet and by source.
- [ ] Separate diagnostic dashboard displays authentic data and correct status.
- [ ] Relevant test/build/regression/review gates pass at exact PR head.
- [ ] User-reviewed merge and separately approved Shadow diagnostic deployment.
- [ ] Live smoke test passes within current resource budget.
- [ ] User explicitly approves the 24-hour test start.
- [ ] One uninterrupted or transparently quality-qualified 24-hour window captured; any interruption recorded, not hidden.
- [ ] Frozen exports, source health, end-run report and dashboard are available.
- [ ] Report answers discovery speed, observed misses, and price opportunity or labels insufficient evidence.
- [ ] Recommendation is supported: adopt, test longer, or do not adopt.

## 11. First task to hand Hermes after adding this file to project sources

> **Follow `POLY_SHADOW_VS_POLY2_24_HOUR_COMPARISON_MASTER_PLAN_2026-10-21.md` as the controlling scope. Execute PHASE 0 first: recover any recoverable diagnostic implementation lost with `/root/.hermes/cache/scratch/poly-shadow-diagnostic-v1`; inspect repo/branches/PRs and verify live mains; put surviving or minimum rebuilt changes into a PERSISTENT git working location and push an early DRAFT PR. Do not deploy, restart Poly2, enable capture, start observers or launch the 24-hour run. Return recovered/lost files, current SHA, draft PR, and the shortest path to Phase 1. Do not add V5 attestations or authority procedures.**

---

### Final principle

**We are testing a trade-collection improvement, not proving organizational ownership of trading data.** Use sufficient engineering safeguards for truthful results and shared-VPS stability, then run the comparison and show the evidence.
