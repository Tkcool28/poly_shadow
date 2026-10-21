# Diagnostic readiness completion V1 — recovery checkpoint

Status: **BLOCKED_DIAGNOSTIC_IMPLEMENTATION**. Current phase: **Phase 0, recovery**.
This checkpoint is not implementation readiness, deployment approval, or a run result.

## Controlling specification

The complete supplied October 21 master plan is preserved alongside this file as
`POLY_SHADOW_VS_POLY2_24_HOUR_COMPARISON_MASTER_PLAN_2026-10-21.md`.
SHA-256: `5a09ea532f45700b5cdfd96fde529b498701b50efcc33f76a523dcdf42097b56`.
The old Polycopy specialist plan is not the specification.

## Verified starting state

Read on October 21, 2026:

| Repository | Remote main (fresh full clone) | Production HEAD ref and main ref |
| --- | --- | --- |
| Tkcool28/poly_shadow | `29c0ff181dba212a56c50402766873afcd344ad2` | main, same SHA |
| Tkcool28/Poly2 | `219ad2c66442632b5e41506ba485062420a27c15` | main, same SHA |

GitHub searches found no open PR in either repository. Shadow's remote branch
inventory and `git ls-remote` found no diagnostic branch. Recent Shadow PR history
through #22 was inspected; the recent work concerns certified monitoring,
freshness, collector integration and memory controls, not a verified separate
diagnostic exporter/runner/reporting path.

Production revision checks used only filesystem reads of HEAD and branch refs.
They do not establish clean working trees, DB health, current wallet approvals,
or runtime configuration. No such conclusions are claimed.

Development clone: `/workspace/poly-shadow-diagnostic`, outside production and
outside the reported prunable Hermes cache. Remote branch:
`feat/diagnostic-readiness-completion-v1`. The pushed draft PR is the durable copy
of this progress; the local clone must not be treated as the only durable copy.

## Recovery inventory

| File/component | Classification | Direct evidence / remaining uncertainty |
| --- | --- | --- |
| `src/shadow/main.ts`, `config.ts`, `rest-poller.ts`, `racing.ts` | PRESENT_IN_MAIN | Three-lane entrypoint, V2 option, normalized clocks, native source journals and reconciliation inspected in starting main. Existing V2 configuration requires the historical exact five-wallet set; actual deployment cohort must be checked later. |
| `src/compare/phase4-v2.ts`, `phase4.ts` | PRESENT_IN_MAIN | `compareV2()`, high-confidence/probable/ambiguous matching, coverage-dependent INDETERMINATE and retrospective classification inspected. No certified CLI changes proposed. |
| `scripts/status/publisher.py`, `collector.py`, `index.html` | PRESENT_IN_MAIN | Existing atomic status publisher and certified surface exist; a separate diagnostic surface is still missing. |
| Poly2 `backend/src/polycopy/models.py` | PRESENT_IN_MAIN | Persisted trades, signals, decision log and paper orders inspected as exporter inputs. No Poly2 edits. |
| Poly2 vendored `poly2-comparison-checkpoint.py` | PRESENT_IN_MAIN | Existing certified SQL linkage reviewed as schema context, not used as a diagnostic exporter or bypassed. |
| VPS `.git/worktrees/poly-shadow-diagnostic-v1/HEAD`, `gitdir`, `logs/HEAD` | RECOVERED (metadata only) | Worktree points to `feat/uncertified-diagnostic-comparison-v1`; gitdir references `/root/.hermes/cache/scratch/poly-shadow-diagnostic-v1/.git`. Two reflog entries only: creation at starting main and reset to the same SHA. Contents recorded below. No implementation commit proved. |
| VPS `.git/refs/heads/feat/uncertified-diagnostic-comparison-v1` | RECOVERED (metadata only) | Contains starting Shadow main SHA only. Local branch name is not surviving implementation. |
| Prior diagnostic exporter source and tests | UNVERIFIED, not declared LOST | Cache access denied by connector; no recovered source bytes. Exact filenames not independently known. |
| Prior diagnostic runner source and tests | UNVERIFIED, not declared LOST | Same restriction. Historical test counts are not current test results. |
| Prior diagnostic reporter/dashboard source and unfinished tests | UNVERIFIED, not declared LOST | Same restriction. |

No implementation file is positively classified LOST yet. Forcing a LOST label
would misrepresent the inaccessible evidence. No uncommitted Git recovery is
claimed. Local fresh-clone `git fsck --no-reflogs --unreachable` produced no
unreachable objects; that says nothing about VPS-only loose objects.

Recovered worktree reflog SHA transitions:

```
0000000000000000000000000000000000000000 -> 29c0ff181dba212a56c50402766873afcd344ad2
29c0ff181dba212a56c50402766873afcd344ad2 -> 29c0ff181dba212a56c50402766873afcd344ad2 (reset: moving to HEAD)
```

Other inspected locations: `/opt`, `/root/hermes-workspaces`, and existing local
Shadow development directories under `/workspace/scratch/56ac43c22f1e`. No
diagnostic implementation was identified there. This was not an exhaustive
content scan of every persistent developer directory or Hermes archive.

## Exact blocker and next corrective action

Direct read-only `filesystem_list` of the reported cache path returned:
`secret or credential path denied`. No alternate path or tool was used to
circumvent that restriction.

An ordinary Hermes read-only inspection request was submitted through the
available `polycopy` routing context (the unrelated repository was explicitly
excluded from changes). Task ID: `95d0287d-bb97-4f09-a38c-39d0d6511f52`.
Its requested scope is inspection only: cache, reflogs, dangling objects without
`--lost-found`, relevant logs/artifacts, exact surviving file paths and checksums.
Latest task command status: **waiting_for_approval**. No recovery result exists
yet. The gateway reports native Hermes approval gates and no MCP approval authority.

Smallest next action: resolve that native read-only recovery approval, obtain
the bounded recovery inventory and surviving source bytes, then commit recovered
or minimally rebuilt components onto this branch. Do not start a duplicate
implementation while the required recovery search is pending.

## Implementation and validation at this checkpoint

Only this checkpoint and the unchanged controlling plan have been added.
Runner, bounded SQL exporter, reporter, public diagnostic surface and new
regression tests are **not implemented by this checkpoint**.

New implementation tests executed: **0**. Full TS/Python regression gates,
native PostgreSQL exporter tests, resource/process fixtures, offline end-to-end
diagnostic/dashboard fixture and independent final implementation review:
**NOT RUN / NOT SATISFIED**. Existing historical passing counts are not reused.

Preparation: `npm ci --ignore-scripts` succeeded (52 packages), and Python
psycopg 3.3.6 plus existing authority dependencies installed locally.
No local PostgreSQL server or initdb is installed. Package-manager setup failed
with setgroups/setegid/seteuid permission errors; no native DB test is claimed.
A later implementation can provision PostgreSQL in isolated CI if local server
installation remains unavailable. No production DB may be used for fixtures.

Checks applicable to the documentation checkpoint: original plan byte equality,
Git whitespace check, and exact changed-file scope. These checks are not
substitutes for diagnostic acceptance tests.

Resource measurements: no observer RSS/CPU/disk/request measurements collected.
Hermes preflight reported 41,122,324,480 free bytes on the VPS, an instantaneous
metadata reading only, not an approved resource budget or 24-hour headroom proof.

## Evidence limitations and future operator handoff

No prospective observation, baseline DB export, actual five-wallet cohort read,
matched example, decision/action result or quote evidence was collected.
**PRICE_ADVANTAGE_UNKNOWN**. Poly2 paper orders have historical book snapshots,
but those alone do not establish quotes at Shadow's earlier observation time.
No quote sidecar has been added.

Deployment readiness: **NO — Phase 0 blocked; do not deploy this draft**.
Certified Stage 1 `COMPARISON_NOT_AUTHORIZED` semantics and all V5 code are
unchanged. No source DB write, migration, capture activation, worker restart,
observer launch, comparison launch, deployment or merge occurred.

After recovery, implementation and all required exact-head tests/review pass:

1. Stop for user review of the completed draft PR. Merge/deployment require
   separate authorization; do not deploy this documentation checkpoint.
2. In a separately authorized preflight, verify current mains and runtime,
   freeze the actual five approved wallets, confirm baseline ingestion and
   read-only DB credentials, and measure shared VPS resource headroom.
3. Deploy only the reviewed separate diagnostic path with approved resource
   ceilings and isolated run storage. Do not restart or alter Poly2.
4. Authorize and run a short bounded smoke test; verify genuine normalization,
   bounded read-only export, clocks, dashboard freshness and child cleanup.
   Report `NO_MATCHED_EVENT_OBSERVED` if appropriate; do not invent an example.
5. Review smoke evidence. A 24-hour comparison requires its own explicit start
   authorization and a fresh exact UTC window; smoke time is excluded.

This document intentionally supplies no executable launch command for a path
that has not yet been implemented and validated.
