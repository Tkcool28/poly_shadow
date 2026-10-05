# DASHBOARD — Phase 4 read-only comparison dashboard

## What it is

A single self-contained static HTML page generated from comparison
**artifacts** — never from live databases. It has no trading controls, no
network calls, no Poly2 access, and writes nothing. Phone-friendly
(responsive cards + horizontally scrollable tables).

## Build

```bash
# 1) comparison artifacts (offline):
npx tsx src/compare/cli.ts <shadowDataDir> <poly2-export.json> <cohorts.json> <outDir>

# 2) dashboard (optionally pass the data dir for source-health panel):
npx tsx src/compare/dashboard.ts <outDir> [shadowDataDir]

# open <outDir>/dashboard.html in any browser (double-click / phone via LAN)
```

Pipeline (handoff §14): `evidence/export files → comparison dataset →
dashboard`. The dashboard is regenerable from artifacts at any time; delete
and rebuild freely.

## Sections

- **Overview** — window, matched / Shadow-only / Poly2-only / ambiguous,
  raw and usable win counts.
- **Live source health** — CHAIN raw events, REST polls/errors, CDN age
  P50, quarantine count, `recoveryRequired` flag, latest observation
  (rendered "artifact-only" when no data dir is supplied).
- **Wallets** — per-wallet matched/only counts, median raw/usable deltas,
  and latest observed activity (either system).
- **Trade comparison** — every comparison record, auditable per trade:
  time, wallet, market/token, side, size, Shadow source(s), Shadow raw and
  usable times, Poly2 raw and usable times, raw/usable deltas
  (Δ = Poly2 − Shadow; positive = Shadow earlier), match-class pill,
  decision-relevance class, actionable marker. Filters: wallet, match
  class, winner, Shadow source, maker/taker role, BUY/SELL,
  actionable/not, decision class. Horizontally scrollable on phone.
- **Coverage** — per-system coverage of the union
  (`(matched + own-only) / (matched + both-only)`, ambiguous excluded, per
  contract §7) plus export rows excluded from primary metrics
  (non-cohort / out-of-window, per contract §8).
- **Latency** — raw and usable P50/P90/P95 over matched events.
- **Population** — Shadow source usage, maker/taker (chain roles),
  BUY/SELL, standard vs negRisk emitter, market breakdown where metadata
  exists.
- **Policy impact** — stale-rejections, how many Shadow saw inside the 300s
  budget, rejection-reason and decision-relevance breakdowns.

## Reading rules

- Δ convention: positive = Shadow earlier; ties < 1s.
- A smoke run (short window, few events) cannot support superiority
  conclusions — the frozen-window protocol is in
  `PHASE4_COMPARISON_CONTRACT.md` §8.
- Ambiguous records are shown, never hidden or forced.
