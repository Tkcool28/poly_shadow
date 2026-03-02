import { describe, it, expect } from 'vitest';
import { computeConfidence, type ConfidenceConfig, type ConfidenceInput } from './confidence';

const defaultConfig: ConfidenceConfig = {
  priceScale: 0.002,
  volScale: 0.0003,
  minPriceChange: 0.0001,
};

function makeSnapshots(
  prices: number[],
  intervalMs = 1000,
  startMs = 1_000_000,
): ConfidenceInput['snapshots'] {
  return prices.map((price, i) => ({ price, timestampMs: startMs + i * intervalMs }));
}

function makeInput(overrides: Partial<ConfidenceInput> = {}): ConfidenceInput {
  return {
    openPrice: 100_000,
    currentPrice: 100_200, // +0.20%
    candleDurationMs: 300_000,
    elapsedMs: 270_000, // 30s remaining
    snapshots: makeSnapshots([100_000, 100_050, 100_100, 100_120, 100_150, 100_180, 100_200]),
    config: defaultConfig,
    ...overrides,
  };
}

describe('computeConfidence — early exits', () => {
  it('returns FLAT for openPrice <= 0', () => {
    const result = computeConfidence(makeInput({ openPrice: 0 }));
    expect(result.score).toBe(0);
    expect(result.direction).toBe('FLAT');
  });

  it('returns FLAT for currentPrice <= 0', () => {
    const result = computeConfidence(makeInput({ currentPrice: 0 }));
    expect(result.score).toBe(0);
    expect(result.direction).toBe('FLAT');
  });

  it('returns FLAT when move is below minPriceChange', () => {
    const result = computeConfidence(makeInput({
      openPrice: 100_000,
      currentPrice: 100_005, // +0.005% < 0.01%
    }));
    expect(result.score).toBe(0);
    expect(result.direction).toBe('FLAT');
  });
});

describe('computeConfidence — price move magnitude', () => {
  it('scores below threshold for coin-flip moves (+0.02% with choppy momentum)', () => {
    // Simulates the XRP coin-flip loss: tiny net move with noisy/choppy path
    const result = computeConfidence(makeInput({
      currentPrice: 100_020, // +0.02%
      snapshots: makeSnapshots([100_000, 100_030, 99_990, 100_025, 100_005, 100_015, 100_020]),
    }));
    expect(result.score).toBeLessThan(0.60); // Below default ARB_MIN_CONFIDENCE threshold
    expect(result.direction).toBe('UP');
  });

  it('scores high for strong moves (+0.50%) with consistent momentum', () => {
    const result = computeConfidence(makeInput({
      currentPrice: 100_500, // +0.50%
      snapshots: makeSnapshots([100_000, 100_080, 100_170, 100_260, 100_350, 100_430, 100_500]),
    }));
    expect(result.score).toBeGreaterThan(0.70);
    expect(result.direction).toBe('UP');
  });

  it('detects DOWN direction', () => {
    const result = computeConfidence(makeInput({
      currentPrice: 99_500, // -0.50%
      snapshots: makeSnapshots([100_000, 99_920, 99_830, 99_740, 99_650, 99_570, 99_500]),
    }));
    expect(result.score).toBeGreaterThan(0.70);
    expect(result.direction).toBe('DOWN');
  });
});

describe('computeConfidence — momentum', () => {
  it('penalizes reversing momentum (prices trending opposite)', () => {
    // Net move is UP (+0.20%), but recent prices are falling
    const result = computeConfidence(makeInput({
      currentPrice: 100_200,
      snapshots: makeSnapshots([100_000, 100_100, 100_300, 100_400, 100_350, 100_280, 100_200]),
    }));
    // Compared to consistent UP movement
    const consistent = computeConfidence(makeInput({
      currentPrice: 100_200,
      snapshots: makeSnapshots([100_000, 100_030, 100_060, 100_100, 100_140, 100_170, 100_200]),
    }));
    expect(result.score).toBeLessThan(consistent.score);
  });

  it('returns neutral momentum (0.5) with < 5 snapshots', () => {
    const result = computeConfidence(makeInput({
      snapshots: makeSnapshots([100_000, 100_100, 100_200]),
    }));
    expect(result.signals.momentum).toBe(0.5);
  });
});

describe('computeConfidence — volatility', () => {
  it('penalizes high volatility (zigzag prices)', () => {
    // Net move same (+0.20%), but zigzag path
    const zigzag = computeConfidence(makeInput({
      currentPrice: 100_200,
      snapshots: makeSnapshots([100_000, 100_400, 99_800, 100_500, 99_700, 100_300, 100_200]),
    }));
    const smooth = computeConfidence(makeInput({
      currentPrice: 100_200,
      snapshots: makeSnapshots([100_000, 100_030, 100_060, 100_100, 100_140, 100_170, 100_200]),
    }));
    expect(zigzag.signals.volatility).toBeLessThan(smooth.signals.volatility);
    expect(zigzag.score).toBeLessThan(smooth.score);
  });

  it('returns neutral volatility (0.5) with < 3 snapshots', () => {
    const result = computeConfidence(makeInput({
      snapshots: makeSnapshots([100_000, 100_200]),
    }));
    expect(result.signals.volatility).toBe(0.5);
  });
});

describe('computeConfidence — time score', () => {
  it('scores higher with less time remaining', () => {
    const nearEnd = computeConfidence(makeInput({ elapsedMs: 290_000 })); // 10s left
    const farFromEnd = computeConfidence(makeInput({ elapsedMs: 60_000 })); // 4 min left
    expect(nearEnd.signals.timeScore).toBeGreaterThan(farFromEnd.signals.timeScore);
  });
});

describe('computeConfidence — clamping', () => {
  it('composite score is clamped to [0, 1]', () => {
    const result = computeConfidence(makeInput({
      currentPrice: 101_000, // +1.0%
      snapshots: makeSnapshots([100_000, 100_150, 100_300, 100_500, 100_700, 100_850, 101_000]),
      elapsedMs: 299_000,
    }));
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('individual signals are in [0, 1]', () => {
    const result = computeConfidence(makeInput());
    const { moveMagnitude, momentum, volatility, timeScore } = result.signals;
    for (const signal of [moveMagnitude, momentum, volatility, timeScore]) {
      expect(signal).toBeGreaterThanOrEqual(0);
      expect(signal).toBeLessThanOrEqual(1);
    }
  });
});

describe('computeConfidence — empty/minimal snapshots', () => {
  it('produces valid result with empty snapshots', () => {
    const result = computeConfidence(makeInput({ snapshots: [] }));
    expect(result.direction).not.toBe('FLAT'); // Still has a valid price move
    expect(result.signals.momentum).toBe(0.5);
    expect(result.signals.volatility).toBe(0.5);
    expect(result.score).toBeGreaterThan(0);
  });

  it('produces valid result with single snapshot', () => {
    const result = computeConfidence(makeInput({
      snapshots: makeSnapshots([100_200]),
    }));
    expect(result.score).toBeGreaterThan(0);
    expect(result.signals.momentum).toBe(0.5);
    expect(result.signals.volatility).toBe(0.5);
  });
});
