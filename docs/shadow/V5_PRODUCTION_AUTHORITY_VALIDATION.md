# V5 authority V1 — uncommitted validation checkpoint

Validation-time branch: `feat/v5-production-authority-v1`.
Validation-time HEAD/base: `00718a78341e7aad67846ee0d3ad9d762d411b93`.
No staging, commit, push, PR creation, merge, deployment, production installation,
real observation, live comparator, pointer/publisher operation or trading enablement
was performed. This is **implementation/test acceptance pending parent-owned
fresh independent final-diff review**, not production launch readiness.

Design, operator schema, exact invocation and requirement-to-test matrix:
[V5_PRODUCTION_AUTHORITY_V1.md](V5_PRODUCTION_AUTHORITY_V1.md).

## Implemented contract

- An independent public operator-approved exact launch binding, installation roster
  and separately supplied JCS authority digest select trust; archives cannot select
  their own key/authority. Both backend and bot and every incarnation are required.
- Complete Ed25519 fence/drain records authenticate authority/run/generation,
  clocks, binding, writers, witness/checkpoints, chain positions and decision facts.
  Python RFC8785 and TypeScript JCS parity are exercised with real signatures.
- Every approved installation enrolls before S and before any admission. All ACKs
  and real transaction outcomes remain mandatory. Frozen population/initial-decision
  rules are unchanged. An authenticated terminal ARCHIVE binds population/drain
  heads and prevents authenticated prefixes from masquerading as complete history.
- The actual official offline CLI accepts the complete disposable observational
  lifecycle without a synthetic override and rejects absent/changed authority before
  comparison/output. Explicit synthetic and legacy v3/v4 guards remain intact.
- File replay/export stay disk-backed and streaming in journal length. No full
  archive JSON.parse or full-history arrays were added to production file replay.
- Private-key file loading checks opened descriptor owner, regular type, exact
  mode0600, no-follow, Ed25519 type and independently approved public-key identity.
  Tests use generated disposable keys only; no long-lived private material is in Git.

## Exact executed final gates

Every row has a separately recorded exit/log, not a shell status inferred from a
later successful command. Logs are outside the repository at
`/root/.hermes/cache/scratch/v5-authority-final-gates/`.

| Actual argv (repo cwd) | Exit | Result | Log |
|---|---:|---|---|
| `npm ci --ignore-scripts` | 0 | 52 packages; audit 0 vulnerabilities | initial tool execution receipt |
| `npx vitest run tests/poly2-production-authority.test.ts` | 0 | 49 passed | `authority-ts.log` |
| `python3 -B -m unittest discover -s tests -p poly2_authority_test.py -v` | 0 | 8 passed | `authority-python.log` |
| `npm test` | 0 | 29 files; 541 passed | `typescript.log` |
| `npm run build` | 0 | TypeScript noEmit build passed | `build.log` |
| `npm run safety` | 0 | static safety gate OK | `safety.log` |
| `python3 -B -m unittest discover -s tests -p '*.py' -v` | 0 | 209 discovered, 162 executed, 47 intentionally native-gated skips | `python.log` |
| `python3 -B /root/.hermes/cache/scratch/v5-authority-native-validate.py` | 0 | fresh owned fixtures, all below executed, source hashes matched, cleanup verified | `native.log` |
| `git diff --check` | 0 | clean whitespace | final tool execution receipt |

Earlier focused prior-format/comparator checks also passed:
`npx vitest run tests/poly2-production-authority.test.ts tests/poly2-prospective.test.ts tests/poly2-archive.test.ts tests/compare.test.ts`
returned 100 passed before the final authority cases were added; final full suite
above covers those final files. TDD production-constructor test first failed with
`Fence.__init__ unexpected keyword argument authority` before implementation.

Initial integration failures were resolved and rerun: missing Python cryptography/
greenlet dependencies; the legacy native timestamp adapter's binding omitting
`evidenceKind` (restored legacy compatibility); and a legacy bounded test expecting
the `UNINSTALLED` denial diagnostic (retained). Initial failed owned fixtures were
cleaned exactly; they are not treated as successful native proof. Production
containers/worktrees/secrets were not used to resolve dependency problems.

### Native exact final results (zero skips)

Final native logs/argv/inspection/source hashes/cleanup:
`/root/.hermes/cache/scratch/v5-authority-validation-native-final2/`.

| Suite argv suffix | Exit | Executed tests | Native-dependent cases |
|---|---:|---:|---:|
| `-B -m unittest discover -s tests -p poly2_authority_postgres_test.py -v` | 0 | 1 | 1 |
| `-B -m unittest discover -s tests -p poly2_fence_postgres_test.py -v` | 0 | 23 | 21; remaining 2 roster tests |
| `-B -m unittest discover -s tests -p poly2_drain_postgres_test.py -v` | 0 | 18 | 18 |
| `-B -m unittest discover -s tests -p poly2_ingestion_clock_postgres_test.py -v` | 0 | 4 | 1; remaining 3 parser/loading tests |
| owned-container current-host Python runtime `-B -m unittest discover -s /opt/current/tests -p poly2_session_postgres_test.py -v` | 0 | 6 | 6 actual AsyncSession/asyncpg |
| `node --import tsx tests/poly2_fence_e2e.ts <native-session-seal.json>` | 0 | standalone assertions | native-emitted source replay |
| `node --import tsx tests/poly2_fence_file_e2e.ts <native-file-journals>` | 0 | standalone assertions | native-emitted file replay |

Thus 52 fixture-enabled unittest cases executed, of which 47 are native-dependent;
the 47 full-discovery skips were separately exercised, not promoted from discovery.
The new native observational test includes actual committed same-transaction source
witness, producer restart/recovery, real SQL FREEZE, actual late decision/audit,
drain restart, signed ARCHIVE, file sealing, production validator, official CLI
(exit0), and identical direct-comparator output. All evidence/keys are disposable.

Three freshly created exact owned containers were inspected before execution:
`poly-shadow-v5-authority-owned-20261011-{epoch,drain,timestamp}`. Owner labels
match those names. Each had network `none`, tmpfs PGDATA, no bind/host mounts,
no published ports and verified empty `listen_addresses`. Dedicated reader SELECT
worked and DML was denied. Current host-installed Python/dependencies and matching
loader/libraries were copied only into the newly owned epoch fixture; no existing
production image/runtime/container was read or executed. Final source-hash map
matched after execution. All three were removed by exact ID with exit0; exact-ID
inspect returned absence exit1. Exact name and owner-label inventories were empty,
including an independent final readback after harness cleanup.

## Frozen scientific parity

The frozen row projection in `poly2-fenced-archive.ts` was extracted and byte-compared
to HEAD; unchanged SHA256:
`a1a193f4ebdda830acf4cca98424907c8c1e7a97316e2a05c8d05c498fb6c478`.

Eleven whole files were byte-compared against `git show HEAD:<path>` and remain
unchanged: `phase4.ts`, `poly2-adapter.ts`, `evidence.ts`, `exact-clock.ts`,
`poly2-prospective.ts`, `poly2-archive.ts`, `poly2-capture-worker.ts`,
`poly2-comparison-source-hook.py`, `exact_clock.py`, the comparison contract and
timestamp amendment. Their hashes are in the external JSON inventory. Actual
production CLI output was compared to unchanged `compare()` for both checkpoint-
seam and native observational fixtures. Native timing, original decision audit,
held/late commits, generation/drain and bounded-history suites passed.

## Changed inventory and hashes

All changes are unstaged. The table identifies implementation/tests/operator docs
as validated, excluding this self-referential report; this report's final hash and
complete publication inventory are recorded externally in the parent verification
artifacts. This table includes the final documentation/comment-only corrections.

| Path | SHA256 |
|---|---|
| `docs/shadow/PHASE4_AUTHORITATIVE_FENCE_RESUME.md` | `83bdfc92bd3d7dd24f174d8cb08ffc706ef40ae8695bc6bd55b1e4621f8a0265` |
| `docs/shadow/PHASE4_CAPTURE_BLOCKER.md` | `c318f19fb631b171878754dbd363e28a269f56744e4102eff0e23ec9f81f2d35` |
| `docs/shadow/PHASE4_OFFLINE_ARCHIVE.md` | `5f30b86af31e7519b61dd58beecb2cae9673e8f140d6d2abd168155c066f6d87` |
| `docs/shadow/V5_PRODUCTION_AUTHORITY_V1.md` | `641aa84fcdaeafa34c2a2b90ee5afdb98f7b415cda593c5e13fddcf992ba6cfc` |
| `scripts/poly2-comparison-checkpoint.py` | `01a5599f80a1a540628eb2bc43bd6565d910fa986b73bfa607e19c40ccc50e12` |
| `scripts/poly2-comparison-drain.py` | `7a37349acbf471b883f8132fe8970dc6e5db3201e87ed508c30db2a074fc0131` |
| `scripts/poly2-comparison-fence.py` | `29536001414b11a85f18c3870567bfcda13826da74fa2bc007d36b3af8fb83aa` |
| `scripts/poly2-comparison-session-observer.py` | `686ae8f79fc80a7c5daa12c25581e37d61480594e4a1175b5e340df9919d11cf` |
| `scripts/production_authority.py` | `1945d3b031ab435d9c85814c47a29ca0d4453984f08fda3c148b64eda41b0010` |
| `scripts/requirements-comparison-authority.txt` | `fa80347b82caa503781e5fd6d53f686d1de0ff5b6c64492cf08cce6b47b98357` |
| `src/compare/cli.ts` | `15d442af96c7b73ad7d04e4f0a0dcb2114c31bbd72418e10a581712578d25a2d` |
| `src/compare/poly2-fenced-archive.ts` | `dd9b56471b2161ecbbf3594da10acbde982fbe6a68c403e7334d6725d86bd404` |
| `src/compare/production-authority.ts` | `f5dec82036c9bca5c49d28d024dd747077293dbfdd8e88f771ed53be4994cf34` |
| `tests/poly2-production-authority.test.ts` | `cccb0da4cc5c434a35ccea726b4e19445f7f4c94e349a32c0f51dd5e7dcff907` |
| `tests/poly2_authority_fixture.py` | `31ccefc12518446ebd1a1808ef29415e4827da8cba23187dc72cbd37ccda5178` |
| `tests/poly2_authority_native_e2e.ts` | `100cda074662811ec4073df223b82b8d6ab73f322d624aad757ffdd6d29c7ee8` |
| `tests/poly2_authority_postgres_test.py` | `08403e300b068edd6057353f24e7341daf2a21c474350dc236809100948fc0a4` |
| `tests/poly2_authority_test.py` | `98503438ddb177740822d12fb146ac691e75ee14f689abe792433b248468a2fd` |

## Parent reconciliation and independent review

The parent reconciled all implementation hashes and reran focused authority tests
(49 TypeScript / 8 Python), full TypeScript (541 across 29 files), full Python
(209 discovered / 162 passed / 47 skipped), build, safety and whitespace checks.
The parent also reran the owned native harness: 1 observational, 23 fence, 18 drain,
4 timestamp and 6 actual AsyncSession cases passed, zero skips; exact fixture
cleanup was verified. Frozen scientific whole files and row projection remain
byte-identical to the base. Fresh independent review `deleg_7c007ce8` returned
**PASS, no blocking findings**, covering all 19 changed paths. The reviewer itself
executed 49 TypeScript and 8 Python authority tests; native execution is parent
verification, not reviewer execution.

## Remaining gates / limits

This report records precommit validation/review, not publication or installation.
No commit/stage/push/PR was made at the validation checkpoint described above. Future controlled operator installation approval, real roster/incarnation
attestations, external key custody, immutable authority/pin delivery and separately
authorized observation remain unperformed prerequisites. No real production
scientific conclusion, upstream REST completeness proof or universal rogue-writer
absence proof is claimed. No implementation/test gate listed above remains unrun.
