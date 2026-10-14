# Superseding clock compatibility review

**Overall classification: BLOCKED_EVIDENCE_REPRODUCIBILITY.**

The first bounded public campaign at PR head34ef59c passed raw acquisition,
identity/yield/cursor/budget checks, but the adapter assigned:

```ts
firstSeenUtc: responseUtc,
completedUtc: responseUtc
```

Frozen RestRawRow defines completedUtc as normalization completion, and
src/compare/phase4.ts uses it for USABLE discovery. A received response is not
proof that normalization finished. The original artifact's timestamps therefore
cannot prove point-in-time scientific compatibility, despite exact byte replay.
Independent review acknowledged this missed finding and superseded its prior PASS.

The original ZIP and all original manifest-listed files are unchanged:
manifestSHA256 `caca65cb03524f2cb68f26cd62a16d1391ec47ca3ac24e30039a45bd89261f95`.
The 2,000 additional identities,1,000 new coarse candidates,56 groups gaining
support and one CHAIN-supported candidate remain valid acquisition observations.
Do not treat their original completedUtc as verified usability time.

## Narrow correction

The isolated research adapter now uses `v2-cursor-research-2`, with receipt
evidenceVersion2. Each prepared row obtains a separately measured normalization
clock; the row and receipt normalizationTimes vector persist that value before
transactional publication. SourceFirstSeenUtc remains original response arrival.
A clock before arrival fails closed. Replay requires the exact durable version2
values and rejects missing clocks/legacy version1 as TIMING_UNVERIFIED; it never
substitutes response, current replay time or inferred later request times.

Offline tests deliberately separate arrival and normalization by1s, assert both
values survive publication, and verify missing/legacy clocks fail replay. Frozen
source identity, candidate grouping, normal production collector and comparison
rules remain unchanged. Typechecking/static safety and focused regressions pass.

## Remaining evidence gate

A corrected live campaign was **not** executed. The assignment authorized one
public campaign, already consumed; neither a CI rerun nor another provider is a
valid way to reconstruct missing original clock measurements. The original bundle
must remain historical evidence with timing marked UNVERIFIED.

Smallest next step: independent review of the clock fix, then separate authorization
for one new bounded GitHub Actions public campaign with evidenceVersion2. It must
retain distinct measured arrival/normalization events and pass delayed processing,
restart and exact replay checks. Only then reconsider a short CHAIN-correlated VPS
validation. No VPS validation or24-hour run is recommended at this stage.
