/**
 * Normalize an outcome string for comparison.
 * Strips punctuation (apostrophes, quotes, etc.) that differs between
 * API and DB representations, then trims and lowercases.
 *
 * Example: "Anyone's Legend" → "anyones legend"
 */
export function normalizeOutcome(s: string): string {
  return s.replace(/[^\w\s]/g, '').trim().toLowerCase();
}
