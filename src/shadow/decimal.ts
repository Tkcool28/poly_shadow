/**
 * Exact decimal arithmetic for V2 fill normalization (BigInt only — no floats).
 *
 * Hermes Gate A rules:
 * - BUY:  shares = takerAmountFilled / 1e6 ; gross price = makerAmountFilled / takerAmountFilled
 * - SELL: shares = makerAmountFilled / 1e6 ; gross price = takerAmountFilled / makerAmountFilled
 * - Price is rendered with Decimal half-up rounding to exactly 10 fractional
 *   places before entering the canonical key. 8/14 sampled raw ratios were
 *   already exact; 6 required the rounding. This is an empirically supported
 *   presentation rule for that sample — discrepancies go to quarantine,
 *   the canonical contract is never loosened.
 */

const TEN = 10n;
export const PRICE_SCALE = TEN ** 10n; // 1e10
export const SHARE_SCALE = 1_000_000n; // 1e6 settlement units

/** num/den rounded half-up to 10 decimal places, returned as scaled integer. */
export function ratioScaled10(num: bigint, den: bigint): bigint {
  if (den <= 0n || num < 0n) throw new Error('ratioScaled10: invalid inputs');
  // half-up: floor((2*num*SCALE + den) / (2*den))
  return (2n * num * PRICE_SCALE + den) / (2n * den);
}

/** Format a 1e10-scaled integer as a decimal string with exactly 10 fraction digits. */
export function formatScaled10(scaled: bigint): string {
  const int = scaled / PRICE_SCALE;
  const frac = (scaled % PRICE_SCALE).toString().padStart(10, '0');
  return `${int}.${frac}`;
}

/** Exact gross price string (10 dp, half-up) for a fill ratio. */
export function grossPrice10(num: bigint, den: bigint): string {
  return formatScaled10(ratioScaled10(num, den));
}

/** Shares string with exactly 6 decimal places from 1e6 settlement units (exact). */
export function shares6(amountUnits: bigint): string {
  if (amountUnits < 0n) throw new Error('shares6: negative');
  const int = amountUnits / SHARE_SCALE;
  const frac = (amountUnits % SHARE_SCALE).toString().padStart(6, '0');
  return `${int}.${frac}`;
}

/**
 * Trim trailing zeros in the fraction of a fixed decimal string.
 * "680.780000" -> "680.78", "11.000000" -> "11", "0.5092544849" unchanged.
 * Used only for canonical-key rendering; storage keeps full precision.
 */
export function trimDecimal(s: string): string {
  if (!s.includes('.')) return s;
  const trimmed = s.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' ? '0' : trimmed;
}
