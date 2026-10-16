# Stage 1 prospective v2 integration — review and execution handoff

Repository work only. No VPS access, installation, deployment, authority approval,
provider campaign, paired comparison or merge is performed by this change.
Fixture outputs verify wiring, not scientific coverage or speed.

## Revisions and acquisition

Starting Shadow main: `116b3268eae30374e57d8737277b1ba28ea89d71` (merged #16).
Poly2 main: `219ad2c66442632b5e41506ba485062420a27c15` (merged #26).
Implementation: `feat/stage1-prospective-v2-comparator`; review the exact PR head.
After merge, independently approve the actual merge SHA, not the pre-merge head.

`SHADOW_V2_CURSOR=true` is explicit in the existing Phase 4 runner's fixed child
environment. Configuration refuses any cohort except the exact existing five
wallets. Ordinary startup defaults to the existing legacy-only behavior.
CHAIN and the existing 10s trades / 30s activity schedules remain. Two supplemental
v2 pollers run a sequential cohort cycle every 60s; overlapping supplemental cycles
are skipped. All four REST pollers share the same request scheduler. Scheduling,
queue deadline and quota skips are durable REST_POLL receipts, not quarantines or
successful empty responses. Cadences are scheduling targets; actual request and
response clocks are recorded, including queue effects and missed opportunities.

V2 uses the reviewed `page`, `filters`, `LIMITS`, wallet constants and frozen
identity/normalization functions from the existing research adapter. It does not
instantiate research Evidence/SQLite, replay old observations, use research arrival
times, introduce another source kind or bypass egress. Each traversal starts at
page one with a fresh fixed query end; cursors are ephemeral, never a cross-poll
watermark. Restart begins a new prospective traversal. Repeated/invalid cursors,
row ordering, cohort, identity and query-window anomalies fail before publication
of that page. Earlier valid pages remain immutable.

New rows append through the existing `rest_raw.ndjson` ->
`source_observations.ndjson` -> `reconciliation.ndjson` path. The original v2 wire
row is retained in `sourcePayload`, alongside reviewed field-name mapping in
`payload`. Source-native IDs, group keys, hydration and UNKNOWN roles are unchanged.
HTTP request start is sampled at transport dispatch, full bounded response arrival
before JSON parsing, and completion independently after normalization. Raw and
normalized clocks are persisted before reconciliation. Duplicate identities retain
original clocks across legacy/v2 pages and restart repair. CHAIN clocks are never
replaced by REST. Existing operational receipts/quarantine/recovery apply.

The existing comparator, metric definitions, matching and research bridge are
unchanged. API exhaustion, quota or page limits never prove complete coverage.
All REST receipts retain `UNKNOWN_UNPROVEN`.

## Bounded resources

- Five fixed wallets, two v2 endpoints, at most 3 pages x 100 rows per traversal.
- V2 body <=1 MiB, request timeout 3s, traversal admission deadline 8s; no retries.
- One shared REST HTTP request in flight; >=500ms dispatch spacing; <=60 starts
  in a rolling minute, with supplemental v2 <=20. Legacy has the remaining 40
  starts for its existing 30 trades +10 activity requests/minute. No provider
  request is sent for quota/deadline skips. 403/429/503 stop subsequent REST host
  requests for the process lifetime; no automatic retry/restart grants completeness.
- Supplemental cohort cycles never overlap. No whole-history in-memory sets or
  cursor persistence; durable exact indexes supply publication deduplication.
- Before each v2 page, reserve 8 MiB for bounded publication and require the
  existing 10 GiB free-space reserve. Conservatively stop v2 before the combined
  raw/source/reconciliation/REST-receipt/poll-telemetry journals plus reservation
  exceed 8 GiB. This includes existing-source bytes and survives restart by stat;
  it is not a guarantee about total CHAIN, index or Poly2 disk usage. Never delete
  evidence to make room. Resource refusal is a terminal publication/resource
  failure with quarantine and a final poll receipt, not an empty success.
- Keep existing observer cgroup verification: MemoryHigh 3 GiB, MemoryMax 4 GiB,
  MemorySwapMax 512 MiB and verified memory.oom.group=1. The 256 MiB isolated
  research-process limit is not a claim about the integrated CHAIN observer.
- Existing prelaunch expected 26h envelope +25% margin +10 GiB reserve remains
  27,096,358,240 free bytes. Keep Poly2/drain allowances and the shared-host
  capacity review; this task provides no VPS capacity measurement.

## Poly2 compatibility and operational prerequisites

No Poly2 source change is required. `validate_installed_identity` compares actual
Git HEAD, protocol/component digests, run and generation to independently approved
binding values. Shadow runtime revision is validated by independent authority and
proved by this launcher's own checkout checks. The `fc8eb3...` manifest provenance
and historical CI ABI checkout are not runtime consumer revision gates.

Verify in the actual installation, under separate operational authorization:

1. Both source-aware backend and bot installations run the approved Poly2 SHA,
   have Git metadata, editable `backend[comparison]` and exact reviewed protocol
   bytes. Stock Docker lacks this installation contract; merely enabling env does
   not establish capture. Record actual `deployed_sha()` and `identities()` from
   each installation, plus the independently attested installation hashes.
2. All backend/bot replicas use the shared factory from `db.get_sessionmaker`;
   this covers backend scoring and bot tail/catchup/bootstrap. Enumerate every
   incarnation in expectedWorkers. Manual SQL writers are outside this protocol;
   do not infer their coverage or omit an existing writer.
3. Independently pinned `poly2-production-authority-v1` approval binds the exact
   five sorted wallets, identical inclusive S/E (exactly 24h), run/generation,
   both actual revisions, protocol/component hashes, public producer identity,
   required backend/bot services and every installation. Never derive the trust
   pin from producer output. Keep key/custody files outside evidence roots.
4. Verify migration 0014/witness table, durable shared spool and safe custody,
   pre-S installation/approval/enrollment of every worker, ACTIVE capture and
   complete authoritative roster. Existing cached factories require controlled
   source-instance restart before S. Preserve PAPER/live/kill-switch/business
   settings. Missing enrollment or authority fails the experiment, not trading.
5. Retain immutable source ingestion and native tradedAt clocks, witness/transaction
   proof and original initial decision timestamps. Missing normalized/policy
   evidence remains null/UNKNOWN_UNPROVEN; no historical-table substitution.
6. After inclusive E, require real worker epoch ACKs and transaction resolution,
   fixed-population FREEZE, complete initial-decision drain and signed terminal
   ARCHIVE. Pending/no-witness outcomes cannot be guessed into completeness.

These are deployment/preflight requirements, not observed production facts.
Poly2 #26's exact head `ffaae394884a72e7375ab2f3da7acb5ee476a3d9` has successful
CI run 38361005165, including native PostgreSQL capture/official comparator ABI.
Local/current-consumer checks and this PR's CI are reported separately in the PR.

## Exact separately authorized execution sequence

Do not execute this section under the implementation handoff. First review/merge
this PR, install the approved revisions in a separately authorized operation, and
approve actual installation evidence and one future window. Replace the values
below only with independently reviewed concrete paths/identities; no defaults or
synthetic override. Use a fresh `phase4-*` run and fresh capture generation.

In the approved Poly2 runtime, read identity evidence before authority approval:

```sh
python -c 'from polycopy.shadow_capture import deployed_sha,identities; print(deployed_sha()); print(identities())'
python -m polycopy.shadow_controller status
```

Set `SHADOW_SHA` to the reviewed deployed **merge SHA**, `RUN_DIR` to the fresh
absolute Shadow `runs/phase4-*` path, `AUTHORITY` to independent public approval,
`AUTHORITY_PIN` to its separately held digest, `START`/`END` to its exact future
24-hour UTC window, and `CURRENT_POINTER` to the reviewed current-run pointer.
From the verified clean Shadow main checkout:

```sh
python -B scripts/phase4-runner.py preflight --expected-shadow-sha "$SHADOW_SHA" --experiment "$RUN_DIR" --production-authority "$AUTHORITY" --authority-sha256 "$AUTHORITY_PIN"
python -B scripts/phase4-runner.py seal --approve-seal --expected-shadow-sha "$SHADOW_SHA" --experiment "$RUN_DIR" --production-authority "$AUTHORITY" --authority-sha256 "$AUTHORITY_PIN" --start-utc "$START" --end-utc "$END"
python -B scripts/phase4-runner.py run --expected-shadow-sha "$SHADOW_SHA" --experiment "$RUN_DIR" --production-authority "$AUTHORITY" --authority-sha256 "$AUTHORITY_PIN" --current-run-pointer "$CURRENT_POINTER"
```

Source capture must already be armed/enrolled before S; the runner cannot install
or enroll Poly2. It requires actual HEAD==origin/main, independent authority,
protected Poly2 baseline, capacity and scope checks; never bypass a failed gate.
A missed start, failed capture or early exit does not authorize an automatic rerun.

In the approved Poly2 runtime, after E strictly (not at inclusive E):

```sh
python -m polycopy.shadow_controller recover
python -m polycopy.shadow_controller close
python -m polycopy.shadow_controller status
python -m polycopy.shadow_controller recover
python -m polycopy.shadow_controller fence
python -m polycopy.shadow_controller freeze
python -m polycopy.shadow_controller drain
python -m polycopy.shadow_controller handoff
```

Inspect every result. Do not proceed on null/exit 2, error, missing ACK, outstanding
transaction or pending drain. Repeat only the existing idempotent recover/status/
drain as justified by actual progress, within the 2h drain budget; no forced ACK,
source-history copy or altered end. Retain failed generations.

Transfer the authentic retained public handoff to offline analysis. Set `HANDOFF`
to that exact directory, `ARCHIVE` to a new exclusive JSON output, `COHORTS` to the
runner's frozen cohorts.json, and `OUT` to a new comparison output directory:

```sh
node --import tsx --input-type=module - "$HANDOFF" "$ARCHIVE" "$AUTHORITY" "$AUTHORITY_PIN" <<'JS'
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {loadAuthority} from './src/compare/production-authority.ts';
import {sealFencedArchiveFiles,validateFencedArchiveFile} from './src/compare/poly2-fenced-archive.ts';
const [handoff,archive,path,pin]=process.argv.slice(2);
const authority=loadAuthority(path,pin);
const binding=JSON.parse(readFileSync(join(handoff,'binding.json'),'utf8'));
sealFencedArchiveFiles(binding,join(handoff,'fence.ndjson'),join(handoff,'drain.ndjson'),archive,authority);
validateFencedArchiveFile(archive,binding.cohort,binding.window,false,authority);
JS
node --import tsx src/compare/cli.ts "$RUN_DIR/shadow-data" "$ARCHIVE" "$COHORTS" "$OUT" "$AUTHORITY" "$AUTHORITY_PIN"
```

Require committed runner report and sealed v5 authority validation. Report event
coverage, RAW/USABLE timing, CHAIN corroboration, existing policy classifications,
source exclusions/skips/quarantine and missing evidence. A smoke fixture or short
run is not a conclusive 24-hour comparison. No financial or PAPER simulation.
