import { describe, it, expect } from 'vitest';
import {
  ratioScaled10, formatScaled10, grossPrice10, shares6, trimDecimal,
} from '../src/shadow/decimal.js';

describe('exact decimal normalization (BigInt)', () => {
  it('exact ratios stay exact', () => {
    // 55742: BUY 680.78 @ 0.56 exactly (real amounts from production receipt)
    expect(grossPrice10(381_236_800n, 680_780_000n)).toBe('0.5600000000');
    expect(shares6(680_780_000n)).toBe('680.780000');
  });

  it('10-dp half-up rounding reproduces the rounded production cases', () => {
    // 55718: 0.5092544849 (required rounding); 55765: 0.7454545455
    expect(grossPrice10(25_450_323_900n, 49_975_650_000n)).toBe('0.5092544849');
    expect(grossPrice10(8_200_000n, 11_000_000n)).toBe('0.7454545455');
  });

  it('SELL direction: 55789 @ 0.78 and 55716 @ 0.77 exactly', () => {
    // SELL: price = takerAmount/makerAmount
    expect(grossPrice10(3_939_000n, 5_050_000n)).toBe('0.7800000000');
    expect(grossPrice10(4_620_000n, 6_000_000n)).toBe('0.7700000000');
  });

  it("ties round half-up (not banker's rounding)", () => {
    // 1.00000000005 exactly representable tie at the 11th digit:
    // num/den = 1.00000000005 -> 10dp half-up => 1.0000000001
    const scaled = ratioScaled10(20_000_000_001n, 20_000_000_000n);
    expect(formatScaled10(scaled)).toBe('1.0000000001');
  });

  it('extremes: tiny and near-1 prices', () => {
    expect(grossPrice10(1n, 1_000n)).toBe('0.0010000000');
    expect(grossPrice10(1n, 10_000_000_000n)).toBe('0.0000000001'); // smallest representable nonzero
    expect(grossPrice10(1n, 1_000_000_000_000n)).toBe('0.0000000000'); // below precision -> zero
    expect(grossPrice10(999_999_999_900n, 1_000_000_000_000n)).toBe('0.9999999999');
  });

  it('zero/invalid inputs throw (FOK non-fills never normalize)', () => {
    expect(() => grossPrice10(0n, 0n)).toThrow();
    expect(() => shares6(-1n)).toThrow();
  });

  it('trimDecimal renders comparison-facing strings', () => {
    expect(trimDecimal('680.780000')).toBe('680.78');
    expect(trimDecimal('11.000000')).toBe('11');
    expect(trimDecimal('0.5092544849')).toBe('0.5092544849');
    expect(trimDecimal('0.5600000000')).toBe('0.56');
  });
});
