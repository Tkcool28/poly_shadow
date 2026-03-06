import { describe, it, expect } from 'vitest';
import {
  isExpiredPosition,
  partitionPositions,
  type ExpandedPositionRow,
} from './expired-position-detector';
import { computeConsistency } from './consistency';
import { computeRecency } from './recency';

const BASE_DATE = new Date('2026-02-15T00:00:00Z');
const BASE_EPOCH = Math.floor(BASE_DATE.getTime() / 1000);

function makePosition(overrides: Partial<ExpandedPositionRow> = {}): ExpandedPositionRow {
  return {
    asset: 'token-abc',
    conditionId: 'cond-123',
    cashPnl: -100,
    initialValue: 100,
    curPrice: 0,
    currentValue: 0,
    endDate: new Date('2026-02-10T00:00:00Z'),
    snapshotAt: BASE_DATE,
    ...overrides,
  };
}

// ─── isExpiredPosition ───

describe('isExpiredPosition', () => {
  const closedMarkets = new Set(['cond-closed']);

  describe('Criterion A: market closed + terminal price', () => {
    it('detects loss in closed market (curPrice=0)', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: 0 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(true);
    });

    it('detects win in closed market (curPrice=0.98)', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: 0.98, currentValue: 500 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(true);
    });

    it('detects with null curPrice in closed market', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: null });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(true);
    });

    it('detects near-zero loss in closed market (curPrice=0.03)', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: 0.03 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(true);
    });

    it('skips ambiguous curPrice (0.5) in closed market', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: 0.5, currentValue: 250 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(false);
    });

    it('skips ambiguous curPrice (0.10) in closed market', () => {
      const pos = makePosition({ conditionId: 'cond-closed', curPrice: 0.10, currentValue: 50 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(false);
    });
  });

  describe('Criterion B: worthless position fallback', () => {
    it('detects worthless position in non-closed market', () => {
      const pos = makePosition({ conditionId: 'cond-open', curPrice: 0, currentValue: 0 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(true);
    });

    it('does NOT detect position with curPrice=0 but currentValue>0', () => {
      const pos = makePosition({ conditionId: 'cond-open', curPrice: 0, currentValue: 50 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(false);
    });
  });

  describe('negative cases', () => {
    it('returns false for active position in open market', () => {
      const pos = makePosition({ conditionId: 'cond-open', curPrice: 0.65, currentValue: 325 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(false);
    });

    it('returns false for position with null curPrice in open market', () => {
      const pos = makePosition({ conditionId: 'cond-open', curPrice: null, currentValue: 100 });
      expect(isExpiredPosition(pos, closedMarkets)).toBe(false);
    });
  });
});

// ─── partitionPositions ───

describe('partitionPositions', () => {
  const closedMarkets = new Set(['cond-closed-A', 'cond-closed-B']);

  it('partitions mixed positions correctly', () => {
    const positions = [
      // Expired: closed market, curPrice=0 (loss)
      makePosition({ asset: 'tok-1', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: -200, initialValue: 200 }),
      // Expired: closed market, curPrice=0.99 (unredeemed win)
      makePosition({ asset: 'tok-2', conditionId: 'cond-closed-B', curPrice: 0.99, currentValue: 495, cashPnl: 490, initialValue: 5 }),
      // Truly open: market not closed, active
      makePosition({ asset: 'tok-3', conditionId: 'cond-open', curPrice: 0.7, currentValue: 350, cashPnl: 50, initialValue: 300 }),
      // Expired: worthless fallback (market not closed but position is dead)
      makePosition({ asset: 'tok-4', conditionId: 'cond-unknown', curPrice: 0, currentValue: 0, cashPnl: -150, initialValue: 150 }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());

    expect(result.trulyOpen).toHaveLength(1);
    expect(result.trulyOpen[0]).toEqual({ cashPnl: 50, initialValue: 300 });

    expect(result.syntheticClosed).toHaveLength(3);
    expect(result.syntheticClosed.map(s => s.realizedPnl)).toEqual([-200, 490, -150]);
  });

  it('deduplicates by asset against DB closed positions', () => {
    const positions = [
      // This asset is already in DB closed positions — should be skipped
      makePosition({ asset: 'dup-asset', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: -100 }),
      // This asset is NOT in DB closed positions — should be converted
      makePosition({ asset: 'unique-asset', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: -200 }),
    ];

    const dbClosedAssets = new Set(['dup-asset']);
    const result = partitionPositions(positions, closedMarkets, dbClosedAssets);

    expect(result.syntheticClosed).toHaveLength(1);
    expect(result.syntheticClosed[0].realizedPnl).toBe(-200);
  });

  it('allows same conditionId with different assets', () => {
    // Same market (conditionId) but different tokens (Yes vs No outcome)
    const positions = [
      makePosition({ asset: 'yes-token', conditionId: 'cond-closed-A', curPrice: 0.99, currentValue: 990, cashPnl: 480, initialValue: 510 }),
      makePosition({ asset: 'no-token', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: -500, initialValue: 500 }),
    ];

    // DB has the yes-token as closed position
    const dbClosedAssets = new Set(['yes-token']);
    const result = partitionPositions(positions, closedMarkets, dbClosedAssets);

    // Only the no-token should be converted
    expect(result.syntheticClosed).toHaveLength(1);
    expect(result.syntheticClosed[0].realizedPnl).toBe(-500);
  });

  it('skips positions with null cashPnl AND null initialValue', () => {
    const positions = [
      makePosition({ asset: 'tok-null', conditionId: 'cond-closed-A', curPrice: null, cashPnl: null, initialValue: null }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.syntheticClosed).toHaveLength(0);
    expect(result.trulyOpen).toHaveLength(0);
  });

  it('converts position with null cashPnl but valid initialValue', () => {
    const positions = [
      makePosition({ asset: 'tok-partial', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: null, initialValue: 300 }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.syntheticClosed).toHaveLength(1);
    expect(result.syntheticClosed[0].realizedPnl).toBe(0);
    expect(result.syntheticClosed[0].totalBought).toBe(300);
  });

  it('uses endDate for timestamp when available', () => {
    const endDate = new Date('2026-02-20T12:00:00Z');
    const positions = [
      makePosition({ asset: 'tok-end', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, endDate }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.syntheticClosed[0].timestamp).toBe(Math.floor(endDate.getTime() / 1000));
  });

  it('falls back to snapshotAt when endDate is null', () => {
    const snapshotAt = new Date('2026-02-18T08:00:00Z');
    const positions = [
      makePosition({ asset: 'tok-snap', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, endDate: null, snapshotAt }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.syntheticClosed[0].timestamp).toBe(Math.floor(snapshotAt.getTime() / 1000));
  });

  it('returns all as trulyOpen when no positions are expired', () => {
    const positions = [
      makePosition({ asset: 'tok-1', conditionId: 'cond-open', curPrice: 0.5, currentValue: 250 }),
      makePosition({ asset: 'tok-2', conditionId: 'cond-open', curPrice: 0.8, currentValue: 400 }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.trulyOpen).toHaveLength(2);
    expect(result.syntheticClosed).toHaveLength(0);
  });

  it('returns all as syntheticClosed when all positions are expired', () => {
    const positions = [
      makePosition({ asset: 'tok-1', conditionId: 'cond-closed-A', curPrice: 0, currentValue: 0, cashPnl: -100, initialValue: 100 }),
      makePosition({ asset: 'tok-2', conditionId: 'cond-closed-B', curPrice: 0, currentValue: 0, cashPnl: -200, initialValue: 200 }),
    ];

    const result = partitionPositions(positions, closedMarkets, new Set());
    expect(result.trulyOpen).toHaveLength(0);
    expect(result.syntheticClosed).toHaveLength(2);
  });
});

// ─── Integration with scoring modules ───

describe('integration: synthetic positions in scoring', () => {

  it('synthetic losses reduce win rate', () => {
    // 10 real wins
    const dbClosed = Array.from({ length: 10 }, (_, i) => ({
      realizedPnl: 50,
      timestamp: BASE_EPOCH - 86400 * (10 - i),
    }));

    // Without synthetic losses
    const before = computeConsistency(dbClosed);
    expect(before.winRate).toBe(1.0);

    // 5 synthetic losses from expired positions
    const synthetic = Array.from({ length: 5 }, (_, i) => ({
      realizedPnl: -100,
      timestamp: BASE_EPOCH - 86400 * (5 - i),
    }));

    const after = computeConsistency([...dbClosed, ...synthetic]);
    expect(after.winRate).toBeCloseTo(10 / 15, 5); // ~0.667
  });

  it('synthetic losses increase max drawdown', () => {
    // 5 wins (+100 each) then 3 synthetic losses (-150 each), 1 day apart
    const positions = [
      ...Array.from({ length: 5 }, (_, i) => ({ realizedPnl: 100, timestamp: 1000 + i * 86400 })),
      ...Array.from({ length: 3 }, (_, i) => ({ realizedPnl: -150, timestamp: 1000 + (5 + i) * 86400 })),
    ];

    const result = computeConsistency(positions);
    // Peak = 500, trough = 500 - 450 = 50 → drawdown = 450/500 = 0.9
    expect(result.maxDrawdown).toBeCloseTo(0.9, 5);
  });

  it('synthetic losses reduce recent PnL and win rate', () => {
    const now = Math.floor(Date.now() / 1000);
    const recentWins = Array.from({ length: 5 }, (_, i) => ({
      realizedPnl: 100,
      timestamp: now - 86400 * (5 - i),
    }));

    const recentLosses = Array.from({ length: 3 }, (_, i) => ({
      realizedPnl: -200,
      timestamp: now - 86400 * (3 - i),
    }));

    const before = computeRecency(recentWins, now);
    expect(before.recentPnl30d).toBe(500);
    expect(before.recentWinRate30d).toBe(1.0);

    const after = computeRecency([...recentWins, ...recentLosses], now);
    expect(after.recentPnl30d).toBe(500 - 600); // -100
    expect(after.recentWinRate30d).toBeCloseTo(5 / 8, 5); // 0.625
  });
});
