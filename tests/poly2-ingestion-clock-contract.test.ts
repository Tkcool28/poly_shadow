import { describe, expect, it } from 'vitest';
import { epochMicros, inWindow } from '../src/compare/exact-clock.js';
import { compare, buildShadowGroups, type Poly2ExportRow } from '../src/compare/phase4.js';
import type { SourceObservationRow } from '../src/shadow/racing.js';

const window = { startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-02T00:00:00.000Z' };
function row(ingestedUtc: string): Poly2ExportRow {
  return {wallet:'0x'+'a'.repeat(40),txHash:null,asset:'7',conditionId:null,side:'BUY',size:100,price:0.5,sourceTs:null,ingestedUtc,normalizedUtc:null,decisionUtc:null,signalUtc:null,source:'data-api',freshnessAgeSec:null,freshnessRejection:null,policyEligible:null,copyabilityOutcome:null,rejectionReason:null,paperOutcome:null};
}
const result = (s: string) => compare({window,rows:[row(s)]},new Map(),window,()=> 'CONTROLLED_OVERLAP');
describe('authorized prospective timestamp amendment V1', () => {
  it('keeps source-time fallback and freshness thresholds exact at one microsecond beyond budget', () => {
    const o: SourceObservationRow = {source:'REST_TRADES',identity:'native',wallet:'0x'+'a'.repeat(40),asset:'7',side:'BUY',size:'100',price:'0.5',sourceTs:1767225600,blockTimestamp:null,sourceFirstSeenUtc:'2026-01-01T00:05:00.000001Z',completedUtc:'2026-01-01T00:05:00.000002Z',role:'UNKNOWN',groupKey:'g',hydration:'FULL'};
    const groups=buildShadowGroups([o],()=> 'CONTROLLED_OVERLAP',window);
    const outside=compare({window,rows:[row('2026-01-01T00:07:00.000002Z')]},groups,window,()=> 'CONTROLLED_OVERLAP');
    expect(outside.coverage.matched).toBe(0); // 120.000001s, not truncated 120s
    const matched=compare({window,rows:[{...row('2026-01-01T00:05:01.000001Z'),freshnessRejection:'stale',decisionUtc:'2026-01-01T00:05:01.000003Z'}]},groups,window,()=> 'CONTROLLED_OVERLAP');
    expect(matched.raw.shadowEarlier).toBe(1); expect(matched.records[0]!.rawDeltaSec).toBe(1);
    expect(matched.policy.staleRejectedShadowSawWithin300s).toBe(0); // 300.000001s
  });

  it('includes start plus one microsecond (old counterexample)', () => {
    expect(result('2026-01-01T00:00:00.000001Z').records).toHaveLength(1);
  });
  it('excludes end plus one microsecond without truncation (old counterexample)', () => {
    expect(result('2026-01-02T00:00:00.000001Z').excluded.outOfWindowPoly2Rows).toBe(1);
  });
  it('includes exact end without fractional digits (old counterexample)', () => {
    expect(result('2026-01-02T00:00:00Z').records).toHaveLength(1);
  });
  it('representation-only changes cannot change population (old counterexample)', () => {
    for (const s of ['2026-01-02T00:00:00Z','2026-01-02T00:00:00.000Z','2026-01-02T00:00:00.000000Z','2026-01-02T01:00:00+01:00','2026-01-01T19:00:00-05:00']) {
      const r = result(s); expect(r.records).toHaveLength(1);
      expect(r.records[0]!.poly2RawUtc).toBe(s);
      expect(r.records[0]!.clockEvidence.poly2RawUtc).toEqual({original:s,epochMicros:epochMicros(window.endUtc).toString()});
    }
  });
  it.each([
    ['2025-12-31T23:59:59.999999Z',false], ['2026-01-01T00:00:00Z',true],
    ['2026-01-01T00:00:00.000001Z',true], ['2026-01-01T23:59:59.999999Z',true],
    ['2026-01-02T00:00:00Z',true], ['2026-01-02T00:00:00.000001Z',false],
  ])('six endpoint cases: %s is %s', (s, expected) => {
    expect(inWindow(s as string, window)).toBe(expected);
    expect(result(s as string).records).toHaveLength(expected ? 1 : 0);
  });
  it.each(['2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-01-01','2026-01-01T00:00:00','2026-01-01 00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00+16:00','2026-01-01T00:00:00-16:00','2026-01-01T00:00:00+01:60','2026-01-01T00:00:00-00:00','2026-01-01T00:00:00.0000001Z','0000-01-01T00:00:00Z','2026-01-01T00:00:00z'])('rejects ambiguous/malformed/unsupported precision %s', s => {
    expect(() => epochMicros(s)).toThrow(); expect(() => result(s)).toThrow();
  });
  it.each(['2026-01-01T00:00:00Z\n','2026-01-01T00:00:00Z\r','2026-01-01T00:00:00Z\r\n','2026-01-01T00:00:00Z\t',' 2026-01-01T00:00:00Z','2026-01-01T00:00:00Z '])('rejects surrounding whitespace without parser divergence %j', s => {
    expect(() => epochMicros(s)).toThrow(); expect(() => result(s)).toThrow();
  });
  it('calendar/leap/negative epoch/offset exact values', () => {
    expect(epochMicros('1970-01-01T00:00:00Z')).toBe(0n);
    expect(epochMicros('1969-12-31T23:59:59.999999Z')).toBe(-1n);
    expect(epochMicros('2000-02-29T00:00:00+01:00')).toBe(epochMicros('2000-02-28T23:00:00Z'));
    expect(epochMicros('2026-01-01T00:00:00.1Z')).toBe(epochMicros('2026-01-01T00:00:00.100000Z'));
  });
  it('Shadow exact earliest arrival/completion and submillisecond latency retain originals', () => {
    const o: SourceObservationRow = {source:'REST_TRADES',identity:'native',wallet:'0x'+'a'.repeat(40),asset:'7',side:'BUY',size:'100',price:'0.5',sourceTs:null,blockTimestamp:null,sourceFirstSeenUtc:'2026-01-01T01:00:00.000002+01:00',completedUtc:'2026-01-01T01:00:00.000003+01:00',role:'UNKNOWN',groupKey:'g',hydration:'FULL'};
    const earliest = {...o, identity:'earlier',sourceFirstSeenUtc:'2026-01-01T00:00:00.000001Z',completedUtc:'2026-01-01T00:00:00.000002Z'};
    const g = buildShadowGroups([o,earliest],()=> 'CONTROLLED_OVERLAP',window).get('g')!;
    expect(g.rawUtc).toBe(earliest.sourceFirstSeenUtc); expect(g.usableUtc).toBe(earliest.completedUtc);
    const r = compare({window,rows:[{...row('2026-01-01T00:00:01.000000Z'),decisionUtc:'2026-01-01T00:00:01.000001Z'}]},new Map([['g',g]]),window,()=> 'CONTROLLED_OVERLAP');
    expect(r.records[0]!.rawDeltaSec).toBe(0.999999);
    expect(r.records[0]!.usableDeltaSec).toBe(0.999999);
    expect(r.records[0]!.decision).toBe('NO_MEANINGFUL_ADVANTAGE');
    expect(r.raw.tie).toBe(1);
  });
});
