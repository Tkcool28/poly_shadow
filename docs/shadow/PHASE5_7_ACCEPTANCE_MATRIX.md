# Phases 5–7 acceptance-to-file/test matrix

Scope: repository-only implementation and disposable validation. No commit/push, deployment, experiment, provider calls, trading, production services or protected run writes. Comparator and Phase 4 scientific contracts remain frozen.

| Requirement | Authority/writer | Reader/field | Deterministic acceptance |
|---|---|---|---|
| Whole-run quarantine counts, resolutions, windows, ages and class breakdown | operational-evidence.ts immutable quarantine + resolution streams / SQLite derived index | runtimeHealthSnapshot → collector → dashboard | instrumentation-v2.test.ts whole-run rebuild/early failure/classification/terminal impact |
| CHAIN request progress, unresolved RPC oldest age, tail and recovery; invalid/rebuild state | RPC/recovery/tail streams; watcher/store index telemetry | runtime health CHAIN and index status | instrumentation-v2.test.ts RPC resolution/restart and tail; runtime-health.test.ts |
| Independent REST sources, last poll/success, streak/traversal/cap/cursor/publication uncertainty | REST page/poll receipts; fixed-size per-source derived summaries | runtime health source summaries; collector source health | instrumentation-v2.test.ts sticky per-source failure/cap/restart; REST regression suites |
| GREEN/DEGRADED/AT_RISK/UNKNOWN independent of liveness, broken sink | shared runtime-health/data-quality and sink control | collector quality, explicit EVIDENCE_SINK_FAILURE | instrumentation-v2.test.ts states; operational-sink-failure.test.ts and status instrumentation tests |
| Poly2 writer roster/enrollment/ACK generation, population/drain/archive/reconciliation | existing fenced capture artifacts, diagnostic-only streaming derived status | collector Poly2 operational summary; frontend | status_instrumentation_test.py synthetic authoritative diagnostic and missing evidence |
| Full-run append-only 5s telemetry, bounded aggregates/memory | memory.ts, runtime-memory.ts, operational-evidence.ts, storage-budget.ts | telemetry rows with memory/cgroup/PSI/events/index/cache/requests/clocks/storage | instrumentation-v2.test.ts cgroup fixture, telemetry actual-write failure; bounded-memory regressions |
| Conservative 24h per-family expected/upper storage and reserve; prelaunch and runtime gate | storage-budget.ts and scripts/storage_budget.py deterministic plan; stat-only inventory | observer startup gate and runner prelaunch gate; dashboard disk state | instrumentation-v2.test.ts budget boundary; storage_budget_test.py runner gate |
| Durable independent publisher, no finite retirement | scripts/status/publisher.py persistent fixed-cadence loop + service example; runtime publisher diagnostics | status publication state and frontend advancing stale warning | status_publisher_test.py >1500 cycles/failure/recovery/restart/independence/horizon proof |
| Mobile 390px rendering/stale/critical state readability | scripts/status/index.html | real browser deterministic fixture | browser artifact path in PHASE5_7_VALIDATION_REPORT.md |
| Full validation/build/safety/frozen scope | repository tests and static checks | validation report | npm test; Python full discovery; npm run build; npm run safety; git diff --check |

Previous finite mechanism evidence will be recorded from exact read-only scheduler artifact, not inferred from the UI refresh cadence. Native PostgreSQL capture/fence/archive rerun required only if shared scientific implementation is touched. No final integrated fault matrix is claimed.
