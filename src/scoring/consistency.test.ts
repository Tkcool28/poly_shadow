import { describe, it, expect } from 'vitest';
import { computeConsistency } from './consistency';

function makePositions(pnls: number[]): Array<{ realizedPnl: number; timestamp: number }> {
  return pnls.map((pnl, i) => ({ realizedPnl: pnl, timestamp: 1000 + i }));
}

describe('computeMaxDrawdown', () => {
  it('returns 0 for empty positions', () => {
    const result = computeConsistency([]);
    expect(result.maxDrawdown).toBe(0);
  });

  it('returns 0 for all wins (monotonic rise)', () => {
    const result = computeConsistency(makePositions([10, 20, 5]));
    expect(result.maxDrawdown).toBe(0);
  });

  it('computes drawdown after a loss following wins', () => {
    // cumPnl: 100, 50 → peak=100, trough=50 → drawdown = 50/100 = 0.5
    const result = computeConsistency(makePositions([100, -50]));
    expect(result.maxDrawdown).toBeCloseTo(0.5, 5);
  });

  it('computes drawdown with loss then recovery', () => {
    // cumPnl: 100, 20, 70 → peak=100, trough=20 → drawdown = 80/100 = 0.8
    const result = computeConsistency(makePositions([100, -80, 50]));
    expect(result.maxDrawdown).toBeCloseTo(0.8, 5);
  });

  it('returns 0 for all losses (peak never > 0)', () => {
    // cumPnl: -10, -30, -35 → peak never goes above 0
    const result = computeConsistency(makePositions([-10, -20, -5]));
    expect(result.maxDrawdown).toBe(0);
  });

  it('caps drawdown at 1.0 when cumPnl goes negative past peak', () => {
    // cumPnl: 100, 70, 90, -30 → peak=100, trough=-30 → raw drawdown = 130/100 = 1.3
    // Capped at 1.0 (100%) per convention
    const result = computeConsistency(makePositions([100, -30, 20, -120]));
    expect(result.maxDrawdown).toBe(1.0);
  });

  it('handles single winning position', () => {
    const result = computeConsistency(makePositions([50]));
    expect(result.maxDrawdown).toBe(0);
  });

  it('handles single losing position', () => {
    const result = computeConsistency(makePositions([-50]));
    expect(result.maxDrawdown).toBe(0);
  });

  it('detects drawdown mid-sequence even if equity recovers', () => {
    // cumPnl: 100, 60, 120, 80 → peak=120 at pos 3, drawdown from 120 to 80 = 40/120 ≈ 0.333
    // Earlier: peak=100, drop to 60 = 40/100 = 0.4 → this is the max
    const result = computeConsistency(makePositions([100, -40, 60, -40]));
    expect(result.maxDrawdown).toBeCloseTo(0.4, 5);
  });
});

describe('computeConsistency (other metrics)', () => {
  it('computes winRate correctly', () => {
    const result = computeConsistency(makePositions([10, -5, 20, -3]));
    expect(result.winRate).toBe(0.5);
  });

  it('computes streaks correctly', () => {
    const result = computeConsistency(makePositions([10, 20, 30, -5, -10, 20]));
    expect(result.maxWinStreak).toBe(3);
    expect(result.maxLossStreak).toBe(2);
  });
});
