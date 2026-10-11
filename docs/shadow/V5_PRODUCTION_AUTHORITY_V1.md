# V5 production observational authority amendment V1

**Scope:** repository implementation and disposable tests only. This is not an
installation receipt, deployment authorization, real production evidence, window
launch, or scientific-completeness verdict. Parent-owned independent review and
validation are recorded in `V5_PRODUCTION_AUTHORITY_VALIDATION.md`; publication
and production installation are separate gates.

## Preserved science and existing formats

The original five-wallet cohort, inclusive exact 24-hour clocks, sources and
acquisition, stable identity mapping, matching/latency/exclusions/thresholds,
metrics, committed original-ingestion population, original initial decisions,
witness/checkpoint/fence ACK/fixed-ID drain semantics are unchanged. Original
strings and microsecond audit clocks remain evidence. Backend and bot remain the
only approved services, and every approved runtime instance must participate.
Direct/manual SQL outside that declared architecture remains an operational
contract violation, not a cryptographic absence-proof requirement.

V3 and V4 are unchanged. Explicit synthetic V5 remains unsigned and uses its
existing canonicalization and direct test validators. Production CLI never sets
`allowSynthetic=true`. The legacy source-hook/checkpoint activation guards remain;
production uses the fenced/session-observer route, not a callback-only fallback.
Production authority changes custody and identity, not scientific row projection.

## Independently controlled public authority

A controlled operator must independently inspect and approve the complete actual
deployment roster **and installation evidence** before observation starts. Do not
construct authority from a producer health cache, ENROLL records, archive manifest,
or a producer-generated list. Inspect supervisor/incarnation inventory, deployed
Poly2 and Shadow revisions, the observer component and reviewed protocol bytes,
canonical writer entry points and session-factory installation before any source
session is created, witness schema/retention, key custody, clock behavior and
source retention. Every bot/backend replica must be named; existing sessions,
alternate sessionmakers, direct SQL, unapproved scaling or changed incarnations
invalidate that approval. No installation is performed here.

Retain a separately controlled installation attestation for each worker. Its
`installationSha256` is the digest of that independently reviewed attestation, not
a producer assertion that it installed itself. The operator-approved authority
contains the approved installation entries; signed ENROLL is a separate runtime
participation proof referencing the **exact** entry. Neither replaces the other.
A public SHA/signature does not prove code coverage or honest source completeness.

Public JSON schema (all fields required; no key/path/roster/run defaults):

```text
{
  schemaVersion: 1,
  version: "poly2-production-authority-v1",
  binding: {
    runId, shadowRunId, poly2CodeSha, shadowCodeSha,
    componentSha256, protocolDigest, generationId,
    cohort: [exact five lowercase 0x addresses],
    window: { startUtc, endUtc },
    expectedWorkers: ["backend:<incarnation>", "bot:<incarnation>", ...],
    evidenceKind: "observational",
    sourcePublicKey: <Ed25519 SPKI PEM public key>
  },
  cohortSha256: <JCS digest of ordered exact cohort>,
  requiredWriterServices: ["backend", "bot"],
  producerFingerprint: <SHA256 of Ed25519 SPKI DER>,
  approvedUtc: <strict original clock before S>,
  installations: {
    "<exact worker>": {
      installationSha256: <64 lowercase hex>,
      approvedUtc: <strict clock no later than authority approval>
    }, ...
  }
}
```

`poly2CodeSha`/`shadowCodeSha` are full lowercase 40-hex Git revisions;
`componentSha256` and `protocolDigest` are 64-hex independent installation/protocol
pins. Do not silently compute new expected identities at launch. Bind the whole
public authority by `authorityDigest(authority)`, SHA256 of RFC8785 canonical UTF8.
Retain that digest separately in the approved invocation/seal, not inside an
archive-selected trust root. Exact JSON field values, cohort ordering, roster and
original window strings must match. `E-S` is exactly 86400000000 microseconds.
Schema, producer fingerprint, approved installations and both service roles are
validated independently in Python and TypeScript.

Store authority in an operator-controlled immutable/read-only run-input location,
outside the source spool/archive/output paths, with a separate immutable approved
invocation carrying its digest. The producer receives detached public inputs. The
validator rechecks the independent digest on every invocation; file replacement
with different bytes/data cannot silently select another authority. OS custody of
this location and invocation is an installation prerequisite, not something a
read-only archive can prove. JSON formatting is immaterial; canonical content is
what is pinned. No private key appears in public authority or archive.

## Signing and canonical byte contract

Use the existing `sourcePublicKey`, `signature` (base64 Ed25519) and `signedPayload`
model. No alternate certificate/wire signature model is introduced. Python uses
`cryptography` Ed25519 and the reviewed `rfc8785` package; Node uses its native
Ed25519 verifier. Install optional producer dependencies from
`scripts/requirements-comparison-authority.txt`. Legacy synthetic imports do not
load these optional cryptographic packages.

For every production fence event and drain frame, `signedPayload` is exactly the
RFC8785/JCS JSON encoding of:

```text
{
  domain: "poly2-v5-authenticated-record-v1",
  stream: "fence" | "drain",
  authoritySha256: <whole independently pinned public authority digest>,
  bindingSha256: <JCS whole binding digest>,
  runId: <exact binding run>, generationId: <exact launch generation>,
  record: <FULL record excluding signature and signedPayload proof fields>
}
```

All semantic fields, original clocks, writer identities, seq/cursor, prior chain
hash, admission/witness, checkpoint, ACK, fence, FREEZE, query, per-ID decision,
counts and completion fields are authenticated. `signedPayload` is redundant
retained rendering: verifier reconstructs it from the full record and requires
byte equality before verifying the signature. It cannot substitute another
payload. The proof fields are excluded to avoid circular self-signing. Unknown
extra semantic fields are also included, never dropped by a subset signature.

Production binding/journal/receipt digests also use JCS. Keys sort by UTF16 code
units, strings are valid Unicode (no lone surrogates), numbers are finite with
safe integral operands; ECMAScript numeric serialization handles -0, decimals and
exponents. Python RFC8785 performs this serialization; there is no homemade float
formatter. Unsupported numeric/Unicode evidence fails closed, never rounded or
rewritten into eligible scientific facts. Synthetic V5 retains its older
canonical/digest behavior. Cross-language disposable vectors exercise Unicode,
small exponents, fractions, -0, binding digest, signed bytes/signature, original
microsecond clock, writer IDs, seq/cursor and the complete journal hash.

## External private-key custody and future installation

Generate a new producer Ed25519 key under separate installation authorization;
never check it into Git, put it in authority, log it, or reuse disposable fixture
keys. Private material stays outside source/run exports in an owner-only regular
mode `0600` file, accessible only to the approved producer process principal.
`production_authority.load_private_key(explicit_path, binding)` opens no-follow,
checks the opened descriptor's owner/type/exact mode, requires Ed25519 and matches
the independently approved PEM. Do not grant Shadow/comparator access to that
file. Protect backups, service credential delivery and process access separately;
mode bits alone are not a process-isolation proof.

Future Poly2 wiring, **not executed here**:

1. Obtain installation/operator approvals above; retain exact public authority,
   independent digest, component/protocol bytes, roster attestations and revisions.
2. Give every declared process an explicit strict `service:incarnation-id`,
   the explicit external key location, authority location/digest, run/generation,
   and the same explicit durable source-fence spool directory. No defaults.
3. Load public JSON, call `A.validate(authority, independently_approved_digest,
   binding)`, and load the external key using the descriptor-checked loader.
   Construct `Fence(spool, binding, authority=authority,
   authority_pin=independently_approved_digest, private_key=key)` before S.
4. Install `ObservedSessionFactory(actual_async_sessionmaker, fence, worker,
   Trade, Wallet, Market)` before any comparator-relevant source session/flush,
   including backend history bootstrap and all bot ingestion/catchup/decision
   paths. Do not retrofit already-open sessions and pretend they were enrolled.
   Constructor journals authenticated ENROLL referencing the approved install.
5. Verify all exact instances' enrollments are durably present **before S** and
   before any relevant admission. Partial roster blocks every admission. Source
   availability remains fail-contained; a failed experimental admission must
   invalidate comparison, not trading. Synthetic mode is not a recovery fallback.
6. On restart use the same immutable authority/key/run/generation and retained
   spool. Replay every authenticated record; key/binding mismatch, corrupt/torn
   authority or unknown commit remains fail-closed. Never delete/reset journal,
   relabel evidence, infer rollback from missing witness or rotate key mid-run.
7. After the inclusive E has passed, call `close_epoch()`. Each actual instance
   calls its factory's `acknowledge_epoch()` for that exact fence epoch. Resolve
   preepoch work only from real committed same-transaction witnesses or confirmed
   outer rollback; call `recover(dedicated_read_only_reader)` and `complete()`.
8. `freeze(SQLAdapter(idle_autocommit_reader, 'postgres', checkpoint=True))`
   reconciles original facts against all committed witnesses in actual
   repeatable-read/read-only SQL. Use `FencedDrain(explicit_drain_spool, fence,
   adapter)` until each frozen ID has its original initial decision and linked
   immutable source audit. Missing decisions/timeouts are incomplete, not exclusion.
9. `write_seal_journals(new_exclusive_handoff_directory)` revalidates the full
   drain and writes a signed terminal ARCHIVE event committing the exact terminal
   drain and population receipt hashes. This prevents an authenticated prefix or
   truncated suffix from being mistaken for a complete export. No fence records
   may follow ARCHIVE. Retire/detach experimental observation once sealed; ordinary
   source trading need not stop. Repeated exact handoff is idempotent at the
   authority level but requires a fresh exclusive export/output path.
10. Offline Node `sealFencedArchiveFiles(binding, fencePath, drainPath,
    newArchivePath, external)` accepts only the independent authority and full
    authenticated lifecycle; file replay remains streaming/disk-backed. Verify
    with `validateFencedArchiveFile(path, cohort, window, false, external)`.

Official comparison invocation for future **offline** retained files:

```sh
node --import tsx src/compare/cli.ts \
  <retained-shadow-data-dir> <sealed-v5-archive.json> \
  <frozen-cohorts.json> <new-output-dir> \
  <independently-approved-public-authority.json> <independent-authority-JCS-sha256>
```

The fifth/sixth run arguments are required for V5. Missing/changed authority,
synthetic evidence or any record failure abort before Shadow reads/comparison or
output creation/overwrite. No override enables synthetic production comparison.
No DB, key or network access occurs in the offline CLI. Existing v3/v4 invocation
behavior remains unchanged. This repository amendment does not install a runner,
start a window, alter a pointer or publisher, deploy, merge or enable trading.

## Acceptance test map

`tests/poly2-production-authority.test.ts` contains individually enumerated tests:

| Required boundary | Named assertion/test family |
|---|---|
| Independent authority, no self-selected key, wrong pin/key | `no authority`, `self-declared key only`, `wrong independent pin`, `wrong external key rejected` |
| Exact run/shadowRun/generation/Poly2SHA/ShadowSHA/component/protocol/cohort/window/roster | `external %s binding mismatch` parameterized individually |
| FULL record authentication after recomputing unkeyed hashes and signed byte rendering | `altered authenticated %s` for ARM/ENROLL/ATTEMPT/COMMITTED/CLOSE/ACK/FENCE/FREEZE/ARCHIVE; separate SQL checkpoint and decision/drain tests |
| Missing backend/bot in independently approved authority | `approved authority missing required %s service` with fresh independent fixture pin |
| Missing any multi-instance enrollment or ACK | `each approved instance %s must enroll`, `each signed generation ACK %s is individually required` |
| Unexpected writer/late enrollment | `unexpected signed writer and late signed enrollment rejected semantically` |
| Cross-run/generation replay | exact external run/generation mismatch plus Python restart replay test |
| Torn/truncated/reordered/duplicate/conflicting authenticated history | `authenticated journal %s rejected`, `production CLI torn input creates no output` |
| No synthetic production, no observational synthetic-only path | `production CLI synthetic input creates no output`, `observational through synthetic-only validator is denied` |
| Normal official CLI success without synthetic override | `full Python observational lifecycle, disk replay and official CLI ... frozen output parity` |
| Python/TS bytes/digests/clocks/IDs/sequence/journal | `Python/TS JCS ... complete journal hash vectors` |

`tests/poly2_authority_test.py` additionally tests secure private-key file mode,
symlink and key mismatch, denial before spool creation, each instance's enrollment
and ACK across restart, altered authenticated SQLite authority and cross-run/
generation restart. `poly2_authority_fixture.py` is an explicitly disposable
checkpoint seam, not a native SQL proof.

`tests/poly2_authority_postgres_test.py` separately executes an actual committed
same-source-transaction witness, producer restart/recovery, SQL FREEZE, pending
then original late decision/audit, drain restart, signed ARCHIVE, file export,
production validator and official offline CLI. Its key is generated in memory and
its public authority independently constructed by the fixture. It never claims
real production evidence. Existing native epoch/drain/timestamp/AsyncSession and
bounded replay tests remain required regression gates. Exact executed results,
source hashes and owned-fixture cleanup are recorded separately in the validation
report; discovery skips are never promoted to native proof.
