/**
 * Phase 4 comparison engine — deterministic, offline, read-only.
 *
 * Implements docs/shadow/PHASE4_COMPARISON_CONTRACT.md exactly:
 * - cohort separation enforced SYMMETRICALLY (CONTROLLED_OVERLAP primary on
 *   both Shadow observations and Poly2 export rows; SHADOW_EXPLORATORY and
 *   any non-cohort row never enters a primary denominator);
 * - frozen window enforced SYMMETRICALLY (export window must equal the
 *   frozen cohorts window — fail-closed — and out-of-window Poly2 rows are
 *   excluded from primary metrics and reported separately);
 * - event-level matching (Poly2 row ↔ Shadow economic group);
 * - raw discovery = earliest per-source arrival (never the racer FIRST row);
 * - usable discovery per the contract definition;
 * - coverage-of-union per the contract's frozen formula;
 * - policy impact + decision-relevance classification.
 *
 * Neither system's native identity is ever mutated. Ambiguity stays visible.
 */

import type { SourceObservationRow } from '../shadow/racing.js';
import { EXCHANGE_V2_STANDARD, EXCHANGE_V2_NEG_RISK } from '../shadow/v2constants.js';

// ─── Poly2 export contract (§3) ───

export interface Poly2ExportRow {
  wallet: string;
  txHash: string | null;
  asset: string | null;
  conditionId: string | null;
  side: 'BUY' | 'SELL' | null;
  size: number | null;
  price: number | null;
  sourceTs: number | null;
  ingestedUtc: string;
  normalizedUtc: string | null;
  decisionUtc: string | null;
  signalUtc: string | null;
  source: string;
  freshnessAgeSec: number | null;
  freshnessRejection: string | null;
  policyEligible: boolean | null;
  copyabilityOutcome: string | null;
  rejectionReason: string | null;
  paperOutcome: string | null;
}

export interface Poly2Export {
  window: { startUtc: string; endUtc: string };
  rows: Poly2ExportRow[];
}

/** Validate an export file structurally. Throws on contract violation. */
export function validatePoly2Export(data: unknown): Poly2Export {
  const d = data as Poly2Export;
  if (!d || typeof d !== 'object' || !Array.isArray(d.rows)) {
    throw new Error('poly2 export: missing rows array');
  }
  if (!d.window || Number.isNaN(Date.parse(d.window.startUtc)) || Number.isNaN(Date.parse(d.window.endUtc))) {
    throw new Error('poly2 export: window.startUtc/endUtc missing/invalid');
  }
  d.rows.forEach((r, i) => {
    if (typeof r.wallet !== 'string' || !r.wallet.startsWith('0x')) {
      throw new Error(`poly2 export row ${i}: wallet missing/invalid`);
    }
    if (typeof r.ingestedUtc !== 'string' || Number.isNaN(Date.parse(r.ingestedUtc))) {
      throw new Error(`poly2 export row ${i}: ingestedUtc missing/invalid`);
    }
  });
  return d;
}

/**
 * Fail-closed window check (contract §8): the sealed Poly2 export MUST cover
 * exactly the frozen comparison window. A mismatch is a contract error, not
 * a warning — comparing over different windows is not the same experiment.
 */
export function assertExportWindowMatches(
  exportData: Poly2Export,
  window: { startUtc: string; endUtc: string },
): void {
  if (Date.parse(exportData.window.startUtc) !== Date.parse(window.startUtc)
    || Date.parse(exportData.window.endUtc) !== Date.parse(window.endUtc)) {
    throw new Error(
      `poly2 export window ${exportData.window.startUtc}→${exportData.window.endUtc} `
      + `does not equal frozen comparison window ${window.startUtc}→${window.endUtc}`,
    );
  }
}

// ─── Shadow event groups ───

export interface ShadowGroup {
  groupKey: string;
  wallet: string;
  members: SourceObservationRow[];
  /** RAW discovery: earliest per-source arrival (§5 — never racer FIRST). */
  rawUtc: string;
  /** USABLE discovery: earliest completedUtc among usable members. */
  usableUtc: string | null;
  tx: string | null;
  asset: string | null;
  size6: string | null;
  side: 'BUY' | 'SELL' | null;
  sourceTs: number | null;
  roles: Set<string>;
  sources: Set<string>;
  /** Emitter classes observed among CHAIN members: standard / negRisk / unknown. */
  emitters: Set<string>;
}

export type CohortFn = (w: string) => 'CONTROLLED_OVERLAP' | 'SHADOW_EXPLORATORY' | null;

function usable(o: SourceObservationRow): boolean {
  return !!(o.wallet && o.side && o.asset && o.size && o.price && o.hydration === 'FULL');
}

/** Emitter class of a CHAIN observation (identity = chainId:emitter:tx:logIndex:blockHash). */
function emitterClass(o: SourceObservationRow): 'standard' | 'negRisk' | 'unknown' | null {
  if (o.source !== 'CHAIN') return null;
  const emitter = o.identity.split(':')[1]?.toLowerCase();
  if (emitter === EXCHANGE_V2_STANDARD.toLowerCase()) return 'standard';
  if (emitter === EXCHANGE_V2_NEG_RISK.toLowerCase()) return 'negRisk';
  return 'unknown';
}

export function buildShadowGroups(
  obs: SourceObservationRow[],
  walletCohort: CohortFn,
  window: { startUtc: string; endUtc: string },
): Map<string, ShadowGroup> {
  const groups = new Map<string, ShadowGroup>();
  for (const o of obs) {
    if (o.sourceFirstSeenUtc < window.startUtc || o.sourceFirstSeenUtc > window.endUtc) continue;
    const cohort = walletCohort(o.wallet);
    if (cohort !== 'CONTROLLED_OVERLAP') continue; // primary comparison only
    const key = o.groupKey;
    let g = groups.get(key);
    if (!g) {
      g = {
        groupKey: key, wallet: o.wallet, members: [],
        rawUtc: o.sourceFirstSeenUtc, usableUtc: null,
        tx: key.startsWith('econ:') ? key.split(':')[1] ?? null : null,
        asset: o.asset, size6: o.size, side: o.side,
        sourceTs: o.sourceTs, roles: new Set(), sources: new Set(), emitters: new Set(),
      };
      groups.set(key, g);
    }
    g.members.push(o);
    g.roles.add(o.role);
    g.sources.add(o.source);
    const em = emitterClass(o);
    if (em) g.emitters.add(em);
    if (o.sourceFirstSeenUtc < g.rawUtc) g.rawUtc = o.sourceFirstSeenUtc;
    if (usable(o) && (g.usableUtc === null || o.completedUtc < g.usableUtc)) {
      g.usableUtc = o.completedUtc;
    }
  }
  return groups;
}

// ─── matching (§6) ───

export type MatchClass =
  | 'MATCHED_HIGH_CONFIDENCE' | 'MATCHED_PROBABLE'
  | 'SHADOW_ONLY' | 'POLY2_ONLY' | 'AMBIGUOUS';

const sizeEq = (a: string | null, b: number | null): boolean =>
  a !== null && b !== null && Math.abs(Number(a) - b) < 5e-7;
const sideOk = (a: string | null, b: string | null): boolean => !a || !b || a === b;
const sideConflict = (a: string | null, b: string | null): boolean => !!a && !!b && a !== b;

export interface MatchRecord {
  poly2Index: number | null;   // index into the INCLUDED rows array; null for SHADOW_ONLY
  groupKey: string | null;     // null for POLY2_ONLY
  match: MatchClass;
  note: string | null;
}

export function matchEvents(rows: Poly2ExportRow[], groups: Map<string, ShadowGroup>): MatchRecord[] {
  const records: MatchRecord[] = [];
  const claimed = new Map<string, number[]>(); // groupKey -> poly2 indexes

  rows.forEach((r, i) => {
    const wallet = r.wallet.toLowerCase();
    const high: string[] = [];
    const probable: string[] = [];
    let conflict: string | null = null;
    for (const [key, g] of groups) {
      if (g.wallet !== wallet) continue;
      if (r.asset && g.asset !== r.asset) continue;
      if (!sizeEq(g.size6, r.size)) continue;
      if (sideConflict(g.side, r.side)) { conflict ??= key; continue; }
      if (r.txHash && g.tx && g.tx === r.txHash.toLowerCase()) { high.push(key); continue; }
      if (!r.txHash && sideOk(g.side, r.side)) {
        const near = (g.sourceTs !== null && r.sourceTs !== null
          && Math.abs(g.sourceTs - r.sourceTs) <= 120)
          || (r.sourceTs === null
            && Math.abs(Date.parse(g.rawUtc) - Date.parse(r.ingestedUtc)) <= 120_000);
        if (near) probable.push(key);
      }
    }
    if (high.length === 1) {
      records.push({ poly2Index: i, groupKey: high[0]!, match: 'MATCHED_HIGH_CONFIDENCE', note: null });
      claimed.set(high[0]!, [...(claimed.get(high[0]!) ?? []), i]);
    } else if (high.length > 1) {
      records.push({ poly2Index: i, groupKey: high.join('|'), match: 'AMBIGUOUS', note: `${high.length} high-confidence groups` });
      high.forEach((k) => claimed.set(k, [...(claimed.get(k) ?? []), i]));
    } else if (probable.length === 1) {
      records.push({ poly2Index: i, groupKey: probable[0]!, match: 'MATCHED_PROBABLE', note: null });
      claimed.set(probable[0]!, [...(claimed.get(probable[0]!) ?? []), i]);
    } else if (probable.length > 1) {
      records.push({ poly2Index: i, groupKey: probable.join('|'), match: 'AMBIGUOUS', note: `${probable.length} probable groups` });
      probable.forEach((k) => claimed.set(k, [...(claimed.get(k) ?? []), i]));
    } else if (conflict) {
      records.push({ poly2Index: i, groupKey: conflict, match: 'AMBIGUOUS', note: 'side conflict — not forced' });
      claimed.set(conflict, [...(claimed.get(conflict) ?? []), i]);
    } else {
      records.push({ poly2Index: i, groupKey: null, match: 'POLY2_ONLY', note: null });
    }
  });

  // One group claimed by two Poly2 rows → AMBIGUOUS on all involved.
  for (const [, idxs] of claimed) {
    if (idxs.length > 1) {
      for (const rec of records) {
        if (rec.poly2Index !== null && idxs.includes(rec.poly2Index) && rec.match !== 'AMBIGUOUS') {
          rec.match = 'AMBIGUOUS';
          rec.note = 'one Shadow group claimed by multiple Poly2 rows';
        }
      }
    }
  }

  for (const [key] of groups) {
    if (!claimed.has(key)) {
      records.push({ poly2Index: null, groupKey: key, match: 'SHADOW_ONLY', note: null });
    }
  }
  return records;
}

// ─── metrics (§7) ───

const pctile = (sorted: number[], p: number): number | null =>
  sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]! : null;

function latencyStats(deltas: number[]) {
  const s = [...deltas].sort((a, b) => a - b);
  return {
    n: s.length,
    shadowEarlier: s.filter((d) => d >= 1).length,
    poly2Earlier: s.filter((d) => d <= -1).length,
    tie: s.filter((d) => d > -1 && d < 1).length,
    median: pctile(s, 50), p50: pctile(s, 50), p90: pctile(s, 90), p95: pctile(s, 95),
  };
}

export type DecisionClass =
  | 'EARLIER_AND_USABLE' | 'EARLIER_BUT_NOT_HYDRATED' | 'EARLIER_BUT_POLICY_INELIGIBLE'
  | 'EARLIER_MAKER_ONLY' | 'EARLIER_BUT_TOO_LATE' | 'NO_MEANINGFUL_ADVANTAGE';

export interface ComparisonResult {
  window: { startUtc: string; endUtc: string };
  cohort: 'CONTROLLED_OVERLAP';
  records: Array<MatchRecord & {
    wallet: string | null;
    /** Display time: Shadow raw arrival when known, else Poly2 ingest. */
    timeUtc: string | null;
    market: string | null;
    asset: string | null;
    side: 'BUY' | 'SELL' | null;
    size: string | null;
    shadowSources: string[];
    shadowRoles: string[];
    shadowRawUtc: string | null;
    shadowUsableUtc: string | null;
    poly2RawUtc: string | null;
    poly2UsableUtc: string | null;
    rawDeltaSec: number | null;
    usableDeltaSec: number | null;
    decision: DecisionClass | null;
    actionable: boolean;
  }>;
  coverage: {
    matched: number; shadowOnly: number; poly2Only: number; ambiguous: number;
    /**
     * Coverage of the non-ambiguous event union U = matched + shadowOnly +
     * poly2Only (contract §7, frozen): Shadow = (matched + shadowOnly) / U,
     * Poly2 = (matched + poly2Only) / U. AMBIGUOUS stays visible but is
     * excluded from U because it cannot be attributed to either system.
     */
    shadowUnionCoveragePct: number | null; poly2UnionCoveragePct: number | null;
  };
  raw: ReturnType<typeof latencyStats>;
  usable: ReturnType<typeof latencyStats>;
  policy: {
    staleRejected: number;
    staleRejectedShadowSawWithin300s: number;
    rejectionReasons: Record<string, number>;
  };
  decisionRelevance: Record<DecisionClass, number>;
  population: {
    shadowSources: Record<string, number>;
    chainRoles: Record<string, number>;
    buySell: Record<string, number>;
    /** standard vs negRisk emitter split across groups with CHAIN evidence. */
    emitters: Record<string, number>;
    /** market breakdown where metadata exists (REST hydration or export). */
    markets: Record<string, number>;
  };
  /** Rows sealed out of primary metrics (fail-closed, reported separately). */
  excluded: {
    nonCohortPoly2Rows: number;
    outOfWindowPoly2Rows: number;
    byWallet: Record<string, number>;
  };
}

const POLY2_FRESHNESS_BUDGET_SEC = 300; // Poly2's known 5-minute rule — measured, never changed

export function compare(
  exportData: Poly2Export,
  groups: Map<string, ShadowGroup>,
  window: { startUtc: string; endUtc: string },
  walletCohort: CohortFn,
  marketByGroupKey?: Map<string, string>,
): ComparisonResult {
  assertExportWindowMatches(exportData, window);

  // Symmetric cohort + window enforcement on the Poly2 side (contract §2/§8).
  const included: Poly2ExportRow[] = [];
  const excluded = { nonCohortPoly2Rows: 0, outOfWindowPoly2Rows: 0, byWallet: {} as Record<string, number> };
  for (const r of exportData.rows) {
    const w = r.wallet.toLowerCase();
    if (walletCohort(r.wallet) !== 'CONTROLLED_OVERLAP') {
      excluded.nonCohortPoly2Rows++;
      excluded.byWallet[w] = (excluded.byWallet[w] ?? 0) + 1;
      continue;
    }
    if (r.ingestedUtc < window.startUtc || r.ingestedUtc > window.endUtc) {
      excluded.outOfWindowPoly2Rows++;
      excluded.byWallet[w] = (excluded.byWallet[w] ?? 0) + 1;
      continue;
    }
    included.push(r);
  }

  const records = matchEvents(included, groups);
  const enriched: ComparisonResult['records'] = [];
  const rawDeltas: number[] = [];
  const usableDeltas: number[] = [];
  const decision: Record<DecisionClass, number> = {
    EARLIER_AND_USABLE: 0, EARLIER_BUT_NOT_HYDRATED: 0, EARLIER_BUT_POLICY_INELIGIBLE: 0,
    EARLIER_MAKER_ONLY: 0, EARLIER_BUT_TOO_LATE: 0, NO_MEANINGFUL_ADVANTAGE: 0,
  };
  const policy = { staleRejected: 0, staleRejectedShadowSawWithin300s: 0, rejectionReasons: {} as Record<string, number> };

  const isMatched = (m: MatchClass) => m === 'MATCHED_HIGH_CONFIDENCE' || m === 'MATCHED_PROBABLE';

  for (const rec of records) {
    const row = rec.poly2Index !== null ? included[rec.poly2Index]! : null;
    const g = rec.groupKey && !rec.groupKey.includes('|') ? groups.get(rec.groupKey) ?? null : null;
    let rawDelta: number | null = null;
    let usableDelta: number | null = null;
    let dec: DecisionClass | null = null;

    if (isMatched(rec.match) && row && g) {
      rawDelta = (Date.parse(row.ingestedUtc) - Date.parse(g.rawUtc)) / 1000;
      rawDeltas.push(rawDelta);
      const poly2Usable = row.normalizedUtc ?? row.decisionUtc;
      if (poly2Usable && g.usableUtc) {
        usableDelta = (Date.parse(poly2Usable) - Date.parse(g.usableUtc)) / 1000;
        usableDeltas.push(usableDelta);
      }
      // Decision relevance (§7 ordered rules).
      if (rawDelta < 1) dec = 'NO_MEANINGFUL_ADVANTAGE';
      else if (row.freshnessRejection || row.policyEligible === false) dec = 'EARLIER_BUT_POLICY_INELIGIBLE';
      else if (!g.usableUtc) dec = 'EARLIER_BUT_NOT_HYDRATED';
      else if ([...g.roles].every((r) => r === 'MAKER_LEG') && !g.sources.has('REST_TRADES') && !g.sources.has('REST_ACTIVITY')) dec = 'EARLIER_MAKER_ONLY';
      else if (usableDelta === null || usableDelta < 1) dec = 'EARLIER_BUT_TOO_LATE';
      else dec = 'EARLIER_AND_USABLE';
      decision[dec]++;

      if (row.freshnessRejection) {
        policy.staleRejected++;
        if (g.sourceTs !== null && (Date.parse(g.rawUtc) / 1000 - g.sourceTs) <= POLY2_FRESHNESS_BUDGET_SEC) {
          policy.staleRejectedShadowSawWithin300s++;
        }
      }
    }
    if (row?.rejectionReason) {
      policy.rejectionReasons[row.rejectionReason] = (policy.rejectionReasons[row.rejectionReason] ?? 0) + 1;
    }

    const poly2Usable = row ? (row.normalizedUtc ?? row.decisionUtc) : null;
    enriched.push({
      ...rec,
      wallet: row?.wallet ?? g?.wallet ?? null,
      timeUtc: g?.rawUtc ?? row?.ingestedUtc ?? null,
      market: (g && marketByGroupKey?.get(g.groupKey)) ?? row?.conditionId ?? null,
      asset: g?.asset ?? row?.asset ?? null,
      side: g?.side ?? row?.side ?? null,
      size: g?.size6 ?? (row?.size != null ? String(row.size) : null),
      shadowSources: g ? [...g.sources].sort() : [],
      shadowRoles: g ? [...g.roles].sort() : [],
      shadowRawUtc: g?.rawUtc ?? null,
      shadowUsableUtc: g?.usableUtc ?? null,
      poly2RawUtc: row?.ingestedUtc ?? null,
      poly2UsableUtc: poly2Usable ?? null,
      rawDeltaSec: rawDelta, usableDeltaSec: usableDelta, decision: dec,
      actionable: dec === 'EARLIER_AND_USABLE',
    });
  }

  const matched = records.filter((r) => isMatched(r.match)).length;
  const shadowOnly = records.filter((r) => r.match === 'SHADOW_ONLY').length;
  const poly2Only = records.filter((r) => r.match === 'POLY2_ONLY').length;
  const ambiguous = records.filter((r) => r.match === 'AMBIGUOUS').length;
  const union = matched + shadowOnly + poly2Only; // AMBIGUOUS visible, never in U

  const population = {
    shadowSources: {} as Record<string, number>, chainRoles: {} as Record<string, number>,
    buySell: {} as Record<string, number>, emitters: {} as Record<string, number>,
    markets: {} as Record<string, number>,
  };
  for (const g of groups.values()) {
    for (const s of g.sources) population.shadowSources[s] = (population.shadowSources[s] ?? 0) + 1;
    for (const r of g.roles) population.chainRoles[r] = (population.chainRoles[r] ?? 0) + 1;
    for (const e of g.emitters) population.emitters[e] = (population.emitters[e] ?? 0) + 1;
    const bs = g.side ?? 'unknown';
    population.buySell[bs] = (population.buySell[bs] ?? 0) + 1;
    const m = marketByGroupKey?.get(g.groupKey);
    if (m) population.markets[m] = (population.markets[m] ?? 0) + 1;
  }

  return {
    window, cohort: 'CONTROLLED_OVERLAP', records: enriched,
    coverage: {
      matched, shadowOnly, poly2Only, ambiguous,
      shadowUnionCoveragePct: union > 0 ? (matched + shadowOnly) / union : null,
      poly2UnionCoveragePct: union > 0 ? (matched + poly2Only) / union : null,
    },
    raw: latencyStats(rawDeltas),
    usable: latencyStats(usableDeltas),
    policy, decisionRelevance: decision, population, excluded,
  };
}
