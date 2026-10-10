# Phase 4 writer inventory and closure authority

Status: **authorized application writer inventory and fail-closed service/instance roster contract defined**. This prospective artifact does not assert that the synthetic producer is installed in production or authorize a launch.

## Read-only source/runtime inventory

Inspected `/opt/poly2` at `bd61efc90a4ff8bfc17b8a31abc4a40dd655f81`; its pre-existing dirty path was `reports/PAPER_TRADING_RUN_LOG.md` and was not changed. No production DB query/import, file write, service change, or deploy was made.

| Comparator-relevant fact | Actual source write path | Runtime/service path | Scope |
|---|---|---|---|
| Original `Trade` row and `ingested_at` | The only `Trade(...)` construction found in application source is `ingestion/service.py:542`, inside canonical `ingest_trade_rows`; database default is applied at flush. | `bot` calls `run_ingestion_cycle` in `bot/daemon.py:32,114-121`; `backend` exposes `/score/candidates` in `api/routes.py:215-228`, which calls `score_all_wallets` and historical bootstrap. | Both are ingestion-capable DB clients and must participate. Within the bot path, ordinary wallet ingestion, approved-wallet catch-up (`ingestion/catchup.py:29,64,126`), and historical bootstrap (`ingestion/service.py:294-296`) all converge on the same insertion helper. |
| Initial `PaperOrder` and decision time | The only two application constructors found are `execution/service.py:186,438`; skip and execution paths write `DecisionLogEntry` at `:202-211,517-533` in the same source transaction. | `bot` calls `run_execution_cycle` via `bot/daemon.py`; no backend route constructs an initial PaperOrder in inspected source. | `bot` is required for initial-decision state. The read-only drain now joins the exact `signal_id`/`source_trade_id` audit context, requires exactly one expected `signal_skipped` or `paper_order_executed` audit, and retains audit ID/action/context/created-at. Audit time is not substituted for `PaperOrder.t2_decided_at`. |
| Other `DecisionLogEntry` rows | Scoring, catch-up progress, wallet/API changes, bankroll and settlement have other audit writers. | `bot`, `backend`, and other API processes. | Not initial-decision evidence unless linked to the exact source trade and signal and paired with the original PaperOrder. |
| Non-comparator services in checked-in Compose | `/opt/poly2/docker-compose.yml` defines `migrate`, `watchdog`, `frontend`, plus `backend` and `bot`. | At inspection, `docker ps` showed one running `poly2-backend-1`, one `poly2-bot-1`, and one `poly2-watchdog-1`; PostgreSQL/Redis/frontend also ran. | Watchdog writes heartbeat only; frontend has no DB writer path; migration is a schema/setup job, not an accepted in-window writer. The live listing is an observation, not a retained supervisor roster or proof no external SQL client exists. |

Static search found one application Trade constructor and two PaperOrder constructors; checked-in test fixtures are not runtime writers. This does **not** inventory external/manual SQL, untracked processes, additional scaled replicas, already-open transactions, or a different deployed source revision.

## DecisionLogEntry corroboration

`SQLAdapter.scan()` now includes the audit in each PostgreSQL decision fact. It fails closed for a missing audit, wrong action/linkage, or multiple candidate audits. A later disappearance/conflict cannot seal a terminal drain. Offline archive replay verifies the retained audit ID, action, signal ID, source trade ID, and exact created-at timestamp while continuing to use the original PaperOrder decision clock. SQLite-only synthetic tests do not establish PostgreSQL audit behavior; the native PostgreSQL suite is the acceptance evidence.

## Required prospective enrollment/closure protocol

The prospective run binding is the declared roster for the authorized application architecture:

1. The required runtime services are exactly `bot` and `backend`. `bot` covers Trade ingestion, approved-wallet catch-up and initial decisions; `backend` covers candidate-history Trade bootstrap. Each authorized runtime instance is declared as `service:instance-id` in `expectedWorkers`, where the complete identifier matches `^(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$`. The run binding also fixes `poly2CodeSha` and the Shadow component hash as the installation/version identity for this cohort.
2. Every declared instance must enroll once before its first comparator-relevant transaction. Enrollment is bound to the run and exact runtime identity. A duplicate, unknown service, malformed identity, late enrollment or attempt by an unregistered identity is rejected.
3. On generation close, every enrolled instance must acknowledge the same next fence generation. Identical repeated ACKs are idempotent; a stale/wrong generation, unregistered identity or conflicting ACK payload fails visibly. An ACK is journaled against its identity and does not resolve an unknown source transaction. Closure also requires every pre-close transaction to be committed with a source witness or explicitly rolled back.
4. The terminal receipt repeats the fixed required service set, complete declared instance roster and acknowledgements. Python and TypeScript validators independently require both `backend` and `bot` and require the unique ACK identities to equal the declared instance set. Missing either service or any declared instance leaves closure incomplete; no archive can seal from a partial response set.
5. This boundary is the **deployed/authorized application architecture**, not a proof that hypothetical direct-SQL or rogue processes do not exist. Such writes are out-of-contract operational violations; this experiment does not require cryptographically disproving their absence. Do not add a database-wide denial, PKI or infrastructure requirement merely to prove this boundary.

Named regressions cover bot-only/backend-only/unknown-service and malformed-ID roster rejection, duplicate instances, multiple declared bot instances, idempotent identical ACKs, conflicting-generation ACK rejection, and a re-chained journal missing each service instance's ACK. Native PostgreSQL tests retain source-transaction drain, late-commit, DecisionLogEntry corroboration and archive replay checks. The current reader/writer integration remains synthetic and is not installed into `/opt/poly2`; this document does not authorize production changes or experiment launch.

## Acceptance boundary

A synthetic Phase 4 receipt passes only when the run binding declares at least one valid `backend:` and one valid `bot:` runtime identity, every declared identity enrolls, every identity acknowledges the same fence generation, old-generation work is resolved, and both Python and TypeScript receipt validators agree. Additional instances within either authorized service are allowed but each must be declared and acknowledged. `watchdog` and `frontend` are not comparator-relevant; direct SQL and other unlisted processes are outside the authorized comparator-writer architecture. Any such write is an operational contract violation, not a requirement for this experiment to disprove.

No production change, commit, push, deploy, experiment, historical reinterpretation, or trade was performed.