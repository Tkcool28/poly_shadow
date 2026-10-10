# Operational storage envelope v2

Repository-only engineering plan. This is not an observed volume forecast, a source-completeness proof, a production capacity approval, or authority to launch. The shared machine-readable plan is `storage-budget-v2.json`; TypeScript `src/shadow/storage-budget.ts` and Python `scripts/storage_budget.py` consume it. Language-parity and exact-threshold tests live in `instrumentation-v2.test.ts` and `storage_budget_test.py`.

## Horizon and assumptions

The observation window is 86,400 seconds (24 hours), with a separately budgeted maximum drain/grace of 7,200 seconds. The launch calculation uses all 93,600 seconds (26 hours), not just the observation window. Expected and upper rates are explicit conservative engineering allowances, not measurements from protected runs. Source rates can exceed an allowance; callers must treat that as a sizing assumption failure rather than drop evidence. There is no evidence rotation, truncation, sampling away of failures, or automatic deletion to meet this budget.

| Family | Expected bytes/s | Upper bytes/s | 26h expected bytes | 26h upper bytes | Accounting scope / rationale |
|---|---:|---:|---:|---:|---|
| telemetry | 1,800 | 8,192 | 168,480,000 | 766,771,200 | Append-only 5s runtime samples; upper allowance is 40 KiB per sample, including bounded operational aggregates, queues, caches, cgroup, storage inventory and publisher clocks. |
| lineageRecovery | 12,000 | 131,072 | 1,123,200,000 | 12,268,339,200 | RPC request/retry lineage, recovery receipts and tail proofs; bounded in-memory parent cache does not bound retained disk history. |
| quarantineResolution | 2,000 | 65,536 | 187,200,000 | 6,134,169,600 | Immutable quarantine facts and separately keyed resolutions; sustained failure storms are budgeted independently from RPC evidence. |
| restReceipts | 12,000 | 65,536 | 1,123,200,000 | 6,134,169,600 | Page and final-poll receipts for both REST sources, including failure/cap/cursor/publication uncertainty. |
| auditSnapshots | 20 | 128 | 1,872,000 | 11,980,800 | Ten-minute diagnostic audits; upper allowance is 76,800 bytes per scheduled audit. |
| chainRawScientific | 64,000 | 262,144 | 5,990,400,000 | 24,536,678,400 | Existing raw logs, tombstones, observations, dispositions, reconciliation and REST raw/source observations. Scientific evidence is retained unchanged. |
| poly2Capture | 16,000 | 131,072 | 1,497,600,000 | 12,268,339,200 | Poly2 capture journal, fence/population/drain artifacts and retained export handoff; no native source volume claim. |
| indexes | 32,000 | 262,144 | 2,995,200,000 | 24,536,678,400 | Rebuildable SQLite operational/recovery/racing indexes and their working overhead; conservative allowance rather than a heap budget. |

For any horizon `seconds`, each family is `ceil(rate * seconds)`. Sum the expected amounts separately from the upper amounts. The maximum horizon totals are:

- Expected: **13,087,152,000 bytes**.
- Upper: **86,657,126,400 bytes**.
- Additional margin: **21,664,281,600 bytes** (`ceil(upper * 0.25)`).
- Untouched alert/headroom reserve: **10,737,418,240 bytes (10 GiB)**.
- Required launch free space: **119,058,826,240 bytes (approximately 110.882 GiB)**.

The old 10 GiB warning is a reserve floor, **not** sufficient launch capacity. It is added after the upper envelope and margin, not counted twice or substituted for the evidence budget. Margin accounts for uncertainty, transient filesystem/index/archive working space and overhead; it is not a promise of an unlimited-volume run. Validate approved traffic assumptions and free space again before any separately authorized launch.

## Gates and runtime thresholds

Both runner preflight and observer startup reject launch unless available filesystem bytes are at least the full envelope + margin + reserve. Runner preflight applies this before production adapter or launch side effects. Unavailable sizing inputs fail the launch gate; no weaker default restores permission.

Runtime inventory is stat-only for a fixed set of evidence files and a bounded scan of direct capture files. No dashboard read reparses raw CHAIN evidence. Remaining budget uses `max(0, ceil(93600 - elapsedSeconds))` from observer startup; the status collector independently derives remaining horizon from the bound run window. Disk states are:

- `GREEN`: free bytes >= remaining upper envelope + margin + 10 GiB reserve.
- `DEGRADED`: reserve <= free bytes < remaining required amount.
- `AT_RISK`: free bytes < 10 GiB reserve.
- `UNKNOWN`: free-space measurement unavailable.

These runtime states are diagnostics/alerts, not a scientific verdict and not an installed automatic shutdown policy. Even after the sizing horizon, the reserve remains. The publisher itself has an unlimited lifetime: the 26h budget does not retire it or prove capacity indefinitely.

Actual authoritative append failures (including ENOSPC before append or a torn append) latch the operational sink broken, retire its telemetry loop via fatal control, and gate later upstream work. Restart rebuild cannot accept a torn authoritative tail. Mutable status publication failures instead retain the last-known public snapshot and retry; its advancing stale warning prevents that snapshot being advertised as current. No recursive write to the failed sink is required to report failure.

## Validation boundary

The tests use disposable files, fake cgroup fixtures, controlled clocks, actual atomic publication and injected write failures. Publisher lifecycle tests cover more than 1,500 cycles, recovery/restart and the full 24h + 2h horizon. They do not establish physical power-loss durability, real-world source traffic volume or production filesystem capacity. The service example is not installed or enabled. No production scheduler or protected run was modified.
