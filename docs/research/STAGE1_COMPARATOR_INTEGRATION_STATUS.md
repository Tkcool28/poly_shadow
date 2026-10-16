# Stage 1 comparator integration — minimum next actions

The existing frozen comparator is src/compare/phase4.ts. Its CLI accepts a sealed Poly2 export and ordinary Shadow source_observations.ndjson. This PR adds an **offline research-evidence reader** that first verifies the exact version-2 raw replay before reducing its rows via existing addShadowObservation. No new matcher or scientific metric is introduced.

## What is not yet proven
The corrected GitHub v2 campaign and stopped October 13 production capture did not observe the same window. The existing 24-hour Phase 4 protocol explicitly forbids scientific conclusions from truncated windows. A research-only static bridge is not the production v2 collector, and does not make old arrivals prospective.

## Remaining work within Stage 1
1. Add fixture tests for exact v2 replay, corrupted clocks/hashes, off-cohort and off-window rows, and byte-identical comparator group reduction. Run existing Phase 4 tests and CI. Do not merge this branch until those checks pass.
2. Verify the **existing** prospective Poly2 capture/fence authority end-to-end, including its exact code revisions, source writer roster, and ability to produce an authentic same-window sealed export; do not use a historical table copy in place of live capture.
3. Establish and review one bounded integration between the verified v2 collector output and the normal append-only Shadow observation journals, preserving per-source original arrival and normalization clocks. The one-shot research reader in this PR is only the format compatibility tool.
4. Before authorizing a run, predeclare a common observation window, five frozen wallets, resource ceilings, source completeness accounting and paired event support thresholds. No trade/scoring/fee/PAPER behavior changes.
5. Run the existing comparator only on **same-window** independent Shadow and Poly2 artifacts. Report MATCHED/SHADOW_ONLY/POLY2_ONLY/AMBIGUOUS; CHAIN corroboration; RAW and USABLE timing; policy relevance; and missing/unproved evidence. A shorter smoke run remains smoke evidence, not a conclusive scientific result.

## Stop conditions
No VPS modification or deployment under this PR; no launch, automatic merge, altered matcher, artificial old timestamps, synthetic Poly2 production authority, or trading execution. If the production capture authority cannot be established, report a concrete blocker. Avoid new scientific tests or re-frozen matching rules.
