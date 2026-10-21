# Recovered diagnostic source checkpoint — October 21, 2026

Phase 0 recovery is complete enough to proceed. **Phase 1 implementation is in progress; NOT DEPLOYABLE.**

The cache worktree and its preservation directory were deleted by scratch pruning. Hermes recovered historical source snapshots and subsequent matching patch chains from read-only session records; the exact final deleted tree remains unverified. No Git implementation commit or staged diagnostic changes survived. All eight named implementation/test files and three tracked patch chains below are RECOVERED; existing collectors, V2 comparator, certified publisher and Poly2 models are PRESENT_IN_MAIN. The deleted working directories are LOST, but the source is recoverable from records. Historical tests do not establish current readiness.

| Recovered file | SHA-256 at recovery checkpoint |
| --- | --- |
| `scripts/poly2-diagnostic-export.py` | `f4c8a09b8e34c0d2314f95ec49400bd4b46c5170a6132c6441e26e78e3696b27` |
| `scripts/uncertified-diagnostic-runner.py` | `5964d46f35087fb31e97cd8495b00b9c9b3bc4c6e629b63b9750229ab6840029` |
| `src/compare/diagnostic-report-cli.ts` | `e5e0988238a0683d4acccffc94585b05ae8cd98691209c390703e052ad525787` |
| `src/compare/uncertified-diagnostic.ts` | `24ac86e65779226117407e6cb77eef8df75c6ea27a441fb1b2f4b8ac96e397a4` |
| `tests/test_poly2_diagnostic_export.py` | `d1124162e3cd037a5de04503006595e874742e5e7d74f95a46593e19795238b9` |
| `tests/test_uncertified_diagnostic_runner.py` | `8845445487b6b3c14775176d06d9d945505019541ae5cd73a239ce18d5b2ad52` |
| `tests/test_uncertified_diagnostic_integration.py` | `4bf13fe4ac2e41cee92ff6f202251c88652a1404bb2ef9591cb161fb15cdfe74` |
| `tests/diagnostic-bounds.test.ts` | `89f9f319d3114eefc7fcb2b32c0483bc479eab076a8a93808aebdfeba863bf31` |
| `scripts/status/index.html` | `25c7036526f2ee8408b9421bb0621ace9cf257f95f6452a61c439e15f68e3235` |
| `src/compare/ndjson.ts` | `105fe2b4e9aa789881ee2c4514781d74e2acccba2e100322cd57e96d91adfc52` |
| `tests/status-live-render.test.ts` | `e0858d406c1b19471774b1b73e32335059ca9441d1416fa011004ac2b712a820` |

Recovery tasks: `95d0287d-bb97-4f09-a38c-39d0d6511f52` (inspection) and `95b1203f-49ed-4bc0-91c5-4edfb8bcb886` (restoration). Durable VPS recovery checkout: `/root/hermes-workspaces/poly-shadow-diagnostic-readiness-v1`; implementation checkout: `/workspace/poly-shadow-diagnostic`; remote draft: https://github.com/Tkcool28/poly_shadow/pull/23 . No production checkouts or services modified.

Recovery-fidelity limitation: snapshots plus evidenced patch chains are recovered work, not an assertion that every last uncommitted edit survived. The prior exact final tree is LOST/UNVERIFIED. Source copies were checked against current recovered-file SHA-256 values before further edits.

Verified starting Shadow main `29c0ff181dba212a56c50402766873afcd344ad2`; Poly2 main `219ad2c66442632b5e41506ba485062420a27c15`. Both production HEAD/main refs agree; working-tree/runtime health was not inferred. No open PRs existed before this new draft. Controlling plan copied unchanged (SHA-256 `5a09ea532f45700b5cdfd96fde529b498701b50efcc33f76a523dcdf42097b56`).

Fresh recovery checks: TypeScript build PASS; focused bounds/dashboard Vitest 10 passed, 1 browser skip. Python recovered exporter/runner/integration 33 cases, 5 failures in restricted local environment (subprocess/IPC and process-group lifecycle); no readiness claim. Baseline main full local TypeScript: 695 passed, 2 failed, 1 skipped; baseline Python: 268 cases, 35 failures, 39 errors, 55 skipped. Baseline failures include IPC and /proc process-observation restrictions; unrestricted CI is required without weakening fixtures. No native PostgreSQL test executed yet. Baseline build/static safety PASS.

Known implementation gaps identified before fixes: V2 disabled in recovered runner; closed end-window bounds; no late-arrival reconciliation; no native-driver fixture; no enforced memory/CPU envelope; final-only dashboard; missing matched timing/examples/p90 and explicit price-unknown output. This checkpoint deliberately preserves recovered code before corrections. Do not merge/deploy it as a completed implementation.

No observer/resource benchmark or production DB evidence collected. PRICE_ADVANTAGE_UNKNOWN. An instantaneous Hermes VPS preflight free-space value (41,122,324,480 bytes) is not a runtime resource budget or headroom proof.

Next: fix actual scope gaps, run native isolated PostgreSQL and full relevant regressions, produce fixture report/dashboard, independently review final exact PR head, then stop for user review. Future deployment/preflight must separately authorize actual cohort freeze, current main/runtime/ingestion verification, read-only DB access and resource measurements. Next operational milestone is a short bounded smoke test; no 24-hour launch is authorized here.
