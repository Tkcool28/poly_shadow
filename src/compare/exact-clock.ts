/** Prospective timestamp amendment V1. Originals are never rewritten.
 * Strict Gregorian, explicit zone, 0..6 fractional digits; integer microseconds.
 * Reject excess precision rather than silently discarding it (PostgreSQL parity).
 */
export function epochMicros(value: unknown): bigint {
  if (typeof value !== 'string') throw new Error('clock: explicit timestamp required');
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!m) throw new Error('clock: strict explicit zone timestamp with at most microsecond precision required');
  const y = Number(m[1]), month = Number(m[2]), day = Number(m[3]);
  const hour = Number(m[4]), minute = Number(m[5]), second = Number(m[6]);
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28,31,30,31,30,31,31,30,31,30,31];
  const zone = m[8]!;
  const zh = zone === 'Z' ? 0 : Number(zone.slice(1,3));
  const zm = zone === 'Z' ? 0 : Number(zone.slice(4,6));
  if (y < 1 || month < 1 || month > 12 || day < 1 || day > days[month-1]!
    || hour > 23 || minute > 59 || second > 59 || zh > 15 || zm > 59 || zone === '-00:00')
    throw new Error('clock: invalid calendar/zone (leap seconds and unknown offsets unsupported)');
  // Integer civil-date conversion; no Date.parse, floating epoch or rollover.
  const adjusted = y - (month <= 2 ? 1 : 0);
  const era = Math.floor(adjusted / 400), yoe = adjusted - era * 400;
  const mp = month + (month > 2 ? -3 : 9);
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1;
  const civilDays = era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
  const offset = (zh * 60 + zm) * (zone[0] === '-' ? -1 : 1);
  return (BigInt(civilDays) * 86400n + BigInt(hour * 3600 + minute * 60 + second - offset * 60)) * 1000000n
    + BigInt((m[7] ?? '').padEnd(6, '0'));
}
export function inWindow(clock: string, window: {startUtc: string; endUtc: string}): boolean {
  const start = epochMicros(window.startUtc), end = epochMicros(window.endUtc);
  if (end < start) throw new Error('clock: reversed window');
  const t = epochMicros(clock);
  return start <= t && t <= end;
}
export const clockOrder = (a: string, b: string): number => {
  const x = epochMicros(a), y = epochMicros(b); return x < y ? -1 : x > y ? 1 : 0;
};
export const deltaSeconds = (a: string, b: string): number => Number(epochMicros(a) - epochMicros(b)) / 1000000;
/** Existing numeric source clocks have an exact decimal microsecond contract too. */
export function secondsMicros(value: number): bigint {
  if (!Number.isFinite(value)) throw new Error('clock: invalid source seconds');
  const s = String(value), m = /^(-?)(\d+)(?:\.(\d{1,6}))?$/.exec(s);
  if (!m) throw new Error('clock: source seconds beyond supported precision');
  return (BigInt(m[2]!) * 1000000n + BigInt((m[3] ?? '').padEnd(6,'0'))) * (m[1] ? -1n : 1n);
}
/** JSON-safe dual representation keyed by untouched field name. */
export function clockEvidence(row: Record<string, unknown>, fields: readonly string[]): Record<string, {original: string; epochMicros: string}> {
  return Object.fromEntries(fields.filter(k => row[k] != null).map(k => [k, {original: String(row[k]), epochMicros: epochMicros(row[k]).toString()}]));
}
