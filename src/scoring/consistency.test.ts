import { describe, it, expect } from 'vitest';
import { computeConsistency } from './consistency';

function makePositions(pnls: number[]): Array<{ realizedPnl: number; timestamp: number }> {
  // Space each position 1 day apart so daily binning treats them as separate days
  return pnls.map((pnl, i) => ({ realizedPnl: pnl, timestamp: 1000 + i * 86400 }));
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

  it('returns 1.0 for all losses (equity never went positive)', () => {
    // cumPnl: -10, -30, -35 → peak never goes above 0 → 100% drawdown
    const result = computeConsistency(makePositions([-10, -20, -5]));
    expect(result.maxDrawdown).toBe(1.0);
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
    expect(result.maxDrawdown).toBe(1.0);
  });

  it('captures underwater drawdown for loss-then-recovery', () => {
    // cumPnl: -20, 30 → eventualPeak=30, underwater depth=20
    // underwater DD = 20/30 ≈ 0.6667
    const result = computeConsistency(makePositions([-20, 50]));
    expect(result.maxDrawdown).toBeCloseTo(0.6667, 3);
  });

  it('detects drawdown mid-sequence even if equity recovers', () => {
    // cumPnl: 100, 60, 120, 80 → peak=120 at pos 3, drawdown from 120 to 80 = 40/120 ≈ 0.333
    // Earlier: peak=100, drop to 60 = 40/100 = 0.4 → this is the max
    const result = computeConsistency(makePositions([100, -40, 60, -40]));
    expect(result.maxDrawdown).toBeCloseTo(0.4, 5);
  });

  it('captures underwater drawdown relative to eventual peak', () => {
    // cumPnl: -50, -150, 200 → eventualPeak=200
    // Deepest underwater: 150 at day 2
    // underwater DD = 150/200 = 0.75
    const result = computeConsistency(makePositions([-50, -100, 350]));
    expect(result.maxDrawdown).toBeCloseTo(0.75, 3);
  });

  it('caps underwater drawdown at 1.0 when depth exceeds eventual peak', () => {
    // cumPnl: -500, 10 → eventualPeak=10
    // underwater DD = 500/10 = 50, capped at 1.0
    const result = computeConsistency(makePositions([-500, 510]));
    expect(result.maxDrawdown).toBe(1.0);
  });

  it('takes max of standard DD and underwater DD', () => {
    // cumPnl: -10, 90, 50 → eventualPeak=90
    // Underwater DD: 10/90 ≈ 0.111
    // Standard DD: (90-50)/90 ≈ 0.444
    // Max: 0.444 (standard DD wins)
    const result = computeConsistency(makePositions([-10, 100, -40]));
    expect(result.maxDrawdown).toBeCloseTo(0.4444, 3);
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
