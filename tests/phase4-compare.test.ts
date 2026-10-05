/**
 * Phase 4 comparison engine tests — implements PHASE4_COMPARISON_CONTRACT.md
 * against a synthetic Poly2 export fixture. Covers every match class, raw vs
 * usable timing, policy impact, decision relevance, and cohort separation.
 */

import { describe, expect, it } from 'vitest';
import {
  buildShadowGroups, compare, matchEvents, validatePoly2Export,
} from '../src/compare/phase4.js';
import type { Poly2Export, Poly2ExportRow } from '../src/compare/phase4.js';
import type { SourceObservationRow } from '../src/shadow/racing.js';

const W1 = '0x' + 'aa'.repeat(20); // controlled
const W2 = '0x' + 'bb'.repeat(20); // exploratory — must be excluded
const TX1 = '0x' + '11'.repeat(32);
const TX2 = '0x' + '22'.repeat(32);
const TX3 = '0x' + '33'.repeat(32);
const ASSET = '123456789';
const WINDOW = { startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-02T00:00:00.000Z' };

function obs(over: Partial<SourceObservationRow>): SourceObservationRow {
  return {
    source: 'REST_TRADES', identity: 'x', wallet: W1, side: 'BUY', asset: ASSET,
    size: '100.000000', price: '0.5000', sourceTs: 1_767_225_600,
    blockTimestamp: null,
    sourceFirstSeenUtc: '2026-01-01T10:00:00.000Z',
    completedUtc: '2026-01-01T10:00:01.000Z',
    role: 'UNKNOWN', groupKey: 'econ:' + TX1 + ':' + ASSET + ':100.000000',
    hydration: 'FULL', ...over,
  };
}

function row(over: Partial<Poly2ExportRow>): Poly2ExportRow {
  return {
    wallet: W1, txHash: TX1, asset: ASSET, conditionId: null, side: 'BUY',
    size: 100, price: 0.5, sourceTs: 1_767_225_600,
    ingestedUtc: '2026-01-01T10:00:10.000Z',
    normalizedUtc: '2026-01-01T10:00:15.000Z',
    decisionUtc: '2026-01-01T10:00:16.000Z', signalUtc: null, source: 'data-api',
    freshnessAgeSec: null, freshnessRejection: null, policyEligible: true,
    copyabilityOutcome: 'copied-paper', rejectionReason: null, paperOutcome: null,
    ...over,
  };
}

const exportOf = (rows: Poly2ExportRow[]): Poly2Export => ({ window: WINDOW, rows });
const cohortOf = (w: string) =>
  w === W1 ? 'CONTROLLED_OVERLAP' as const : w === W2 ? 'SHADOW_EXPLORATORY' as const : null;

describe('phase 4 comparison', () => {
  it('export validation rejects malformed rows', () => {
    expect(() => validatePoly2Export({ rows: [{ wallet: 'nope', ingestedUtc: 'x' }] })).toThrow();
    expect(validatePoly2Export(exportOf([row({})])).rows).toHaveLength(1);
  });

  it('MATCHED_HIGH_CONFIDENCE via tx+asset+size; raw delta = ingested − earliest arrival', () => {
    const g = buildShadowGroups([obs({})], cohortOf, WINDOW);
    const recs = matchEvents([row({})], g);
    expect(recs[0]!.match).toBe('MATCHED_HIGH_CONFIDENCE');
    const res = compare(exportOf([row({})]), g, WINDOW);
    expect(res.records[0]!.rawDeltaSec).toBe(10);          // Shadow 10s earlier
    expect(res.records[0]!.usableDeltaSec).toBe(14);       // usable: 15s vs 1s
    expect(res.records[0]!.decision).toBe('EARLIER_AND_USABLE');
    expect(res.raw.shadowEarlier).toBe(1);
  });

  it('raw discovery uses earliest source arrival, not racer commit order', () => {
    // CHAIN arrived at 10:00:00, REST at 09:59:50 — earliest wins regardless
    // of which committed reconciliation first.
    const g = buildShadowGroups([
      obs({ source: 'CHAIN', sourceFirstSeenUtc: '2026-01-01T10:00:00.000Z', identity: 'c', role: 'TAKER_AGGREGATE' }),
      obs({ sourceFirstSeenUtc: '2026-01-01T09:59:50.000Z', identity: 'r' }),
    ], cohortOf, WINDOW);
    const res = compare(exportOf([row({})]), g, WINDOW);
    expect(res.records[0]!.rawDeltaSec).toBe(20); // 10:00:10 − 09:59:50
  });

  it('MATCHED_PROBABLE without txHash (time-window match); AMBIGUOUS on two candidates', () => {
    const g = buildShadowGroups([obs({})], cohortOf, WINDOW);
    const noTx = row({ txHash: null });
    expect(matchEvents([noTx], g)[0]!.match).toBe('MATCHED_PROBABLE');

    const g2 = buildShadowGroups([
      obs({}),
      obs({ identity: 'other', groupKey: 'econ:' + TX2 + ':' + ASSET + ':100.000000',
            sourceTs: 1_767_225_600, sourceFirstSeenUtc: '2026-01-01T10:00:00.500Z' }),
    ], cohortOf, WINDOW);
    expect(matchEvents([noTx], g2)[0]!.match).toBe('AMBIGUOUS');
  });

  it('AMBIGUOUS on side conflict — never forced', () => {
    const g = buildShadowGroups([obs({ side: 'SELL' })], cohortOf, WINDOW);
    const recs = matchEvents([row({ side: 'BUY' })], g);
    expect(recs[0]!.match).toBe('AMBIGUOUS');
    expect(recs[0]!.note).toContain('side conflict');
  });

  it('SHADOW_ONLY and POLY2_ONLY stay visible; coverage math', () => {
    const g = buildShadowGroups([
      obs({}), // matches row 1
      obs({ identity: 'solo', groupKey: 'econ:' + TX3 + ':' + ASSET + ':50.000000', size: '50.000000' }), // shadow-only
    ], cohortOf, WINDOW);
    const rows = [row({}), row({ txHash: '0x' + '99'.repeat(32), size: 777, ingestedUtc: '2026-01-01T11:00:00.000Z' })];
    const res = compare(exportOf(rows), g, WINDOW);
    expect(res.coverage.matched).toBe(1);
    expect(res.coverage.shadowOnly).toBe(1);
    expect(res.coverage.poly2Only).toBe(1);
    expect(res.coverage.shadowCoveragePct).toBeCloseTo(0.5);
  });

  it('cohort separation: exploratory wallets never enter the primary comparison', () => {
    const g = buildShadowGroups([
      obs({ wallet: W2, groupKey: 'econ:' + TX2 + ':' + ASSET + ':100.000000' }),
    ], cohortOf, WINDOW);
    expect(g.size).toBe(0); // W2 filtered out of controlled groups
  });

  it('usable timing: PARTIAL hydration group is not usable → EARLIER_BUT_NOT_HYDRATED', () => {
    const g = buildShadowGroups([obs({ hydration: 'PARTIAL' })], cohortOf, WINDOW);
    expect([...g.values()][0]!.usableUtc).toBeNull();
    const res = compare(exportOf([row({})]), g, WINDOW);
    expect(res.records[0]!.decision).toBe('EARLIER_BUT_NOT_HYDRATED');
    expect(res.usable.n).toBe(0);
  });

  it('policy: stale-rejected Poly2 row Shadow saw within 300s budget', () => {
    const stale = row({
      freshnessRejection: 'stale-trade', freshnessAgeSec: 400,
      sourceTs: Math.floor(Date.parse('2026-01-01T10:00:00.000Z') / 1000) - 400,
    });
    const g = buildShadowGroups([obs({ sourceTs: stale.sourceTs })], cohortOf, WINDOW);
    const res = compare(exportOf([stale]), g, WINDOW);
    // Shadow arrived ~400s after source ts → NOT within budget here:
    expect(res.policy.staleRejected).toBe(1);
    expect(res.records[0]!.decision).toBe('EARLIER_BUT_POLICY_INELIGIBLE');
    // Now Shadow arrives 60s after sourceTs → within budget:
    const g2 = buildShadowGroups([obs({ sourceTs: stale.sourceTs,
      sourceFirstSeenUtc: new Date((stale.sourceTs! + 60) * 1000).toISOString() })], cohortOf, WINDOW);
    const res2 = compare(exportOf([stale]), g2, WINDOW);
    expect(res2.policy.staleRejectedShadowSawWithin300s).toBe(1);
  });

  it('EARLIER_BUT_TOO_LATE: raw earlier but usable not earlier', () => {
    const g = buildShadowGroups([obs({
      sourceFirstSeenUtc: '2026-01-01T10:00:00.000Z',
      completedUtc: '2026-01-01T10:00:30.000Z', // usable AFTER poly2's 15s
    })], cohortOf, WINDOW);
    const res = compare(exportOf([row({})]), g, WINDOW);
    expect(res.records[0]!.decision).toBe('EARLIER_BUT_TOO_LATE');
  });

  it('EARLIER_MAKER_ONLY: chain maker-leg-only group', () => {
    const g = buildShadowGroups([obs({
      source: 'CHAIN', role: 'MAKER_LEG', identity: 'm',
    })], cohortOf, WINDOW);
    const res = compare(exportOf([row({})]), g, WINDOW);
    expect(res.records[0]!.decision).toBe('EARLIER_MAKER_ONLY');
  });

  it('window filter: observations outside the window are excluded', () => {
    const g = buildShadowGroups([obs({ sourceFirstSeenUtc: '2025-12-31T23:00:00.000Z' })], cohortOf, WINDOW);
    expect(g.size).toBe(0);
  });

  it('one group claimed by two Poly2 rows → AMBIGUOUS', () => {
    const g = buildShadowGroups([obs({})], cohortOf, WINDOW);
    const res = compare(exportOf([row({}), row({ ingestedUtc: '2026-01-01T10:05:00.000Z' })]), g, WINDOW);
    expect(res.records.every((r) => r.match === 'AMBIGUOUS')).toBe(true);
  });
});
