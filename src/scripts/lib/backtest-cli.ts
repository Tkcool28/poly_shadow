/**
 * Shared CLI flag definitions and config builder for backtest scripts.
 */

import type { SimConfig } from './backtest-engine';
import type { CalibrationData } from './backtest-db';
import { FALLBACK_FAK_FAILURE_RATE } from './backtest-engine';

// ─── Common CLI Flags ───

export const COMMON_FLAGS = {
  'copy-percent': { type: 'string' as const },
  'max-trade': { type: 'string' as const },
  'max-pred': { type: 'string' as const },
  'min-buy-price': { type: 'string' as const, default: '0.60' },
  gate: { type: 'string' as const, default: '175' },
  'exclude-slugs': { type: 'string' as const, default: 'updown-5m,updown-15m' },
  'no-empirical-slippage': { type: 'boolean' as const, default: false },
  'no-capital-lockup': { type: 'boolean' as const, default: false },
  'no-majority': { type: 'boolean' as const, default: false },
  'both-sides': { type: 'boolean' as const, default: false },
  'follow-sells': { type: 'boolean' as const, default: false },
  'follow-all': { type: 'boolean' as const, default: false },
  'starting-capital': { type: 'string' as const },
  seed: { type: 'string' as const, default: '42' },
  'warmup-hours': { type: 'string' as const, default: '0' },
  verbose: { type: 'boolean' as const, default: false },
  output: { type: 'string' as const, default: '' },
  hours: { type: 'string' as const, default: '0' },
  days: { type: 'string' as const, default: '0' },
  'include-open': { type: 'boolean' as const, default: false },
  'no-train-test': { type: 'boolean' as const, default: false },
} as const;

// ─── DB Allocation Row ───

export interface AllocRow {
  copyTradePercent?: number | null;
  maxPositionUsd?: number | null;
  maxPredictionPositionUsd?: number | null;
  minBuyPrice?: number | null;
  excludeEventSlugPatterns?: string | null;
  majorityOnlyMode?: boolean;
  currentCapital?: number | null;
}

// ─── Config Builder ───

export function buildSimConfig(
  args: Record<string, string | boolean | undefined>,
  calibration: CalibrationData,
  allocConfig?: AllocRow | null,
  overrides?: Partial<SimConfig>,
): SimConfig {
  const copyPercent = parseFloat(
    (args['copy-percent'] as string) ?? String(allocConfig?.copyTradePercent ?? 0.10)
  );
  const maxTradeUsd = parseFloat(
    (args['max-trade'] as string) ?? String(allocConfig?.maxPositionUsd ?? 8)
  );
  const maxPredUsd = parseFloat(
    (args['max-pred'] as string) ?? String(allocConfig?.maxPredictionPositionUsd ?? 30)
  );
  const minBuyPrice = parseFloat(
    (args['min-buy-price'] as string) ?? String(allocConfig?.minBuyPrice ?? 0.60)
  );
  // Disable majority gate if: --no-majority, --follow-all, or DB allocation has majorityOnlyMode=false (unless --gate explicitly set)
  const gateExplicitlySet = args.gate !== undefined && args.gate !== '175';
  const majorityGate = (args['no-majority'] || args['follow-all'])
    ? 0
    : (allocConfig?.majorityOnlyMode === false && !gateExplicitlySet)
      ? 0
      : parseInt((args.gate as string) ?? '175', 10);
  const excludeSlugs = ((args['exclude-slugs'] as string) ?? allocConfig?.excludeEventSlugPatterns ?? 'updown-5m,updown-15m')
    .split(',').map(s => s.trim()).filter(Boolean);
  const startingCapital = parseFloat(
    (args['starting-capital'] as string) ?? String(allocConfig?.currentCapital ?? 450)
  );

  return {
    copyPercent,
    maxTradeUsd,
    maxPredUsd,
    startingCapital,
    minBuyPrice,
    majorityGate,
    excludeSlugs,
    useCapitalLockup: !args['no-capital-lockup'],
    bothSides: !!(args['both-sides'] || args['follow-all']),
    followSells: !!(args['follow-sells'] || args['follow-all']),
    seed: parseInt((args.seed as string) ?? '42', 10),
    accumulatorWarmupSec: parseInt((args['warmup-hours'] as string) ?? '0', 10) * 3600,
    empiricalSlippage: calibration.slippage,
    fakFailureRate: calibration.fakFailureRate,
    ...overrides,
  };
}

// ─── Formatting Helpers ───

export function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

export function rpad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : ' '.repeat(n - s.length) + s;
}

// ─── Time Window Helper ───

export function getTimeWindow(args: Record<string, string | boolean | undefined>): { hours: number; days: number; cutoffTs: number } | null {
  const hours = parseInt((args.hours as string) ?? '0', 10);
  const days = parseInt((args.days as string) ?? '0', 10);
  if (days <= 0 && hours <= 0) return null;
  const windowSeconds = days > 0 ? days * 86400 : hours * 3600;
  return { hours, days, cutoffTs: Math.floor(Date.now() / 1000) - windowSeconds };
}
