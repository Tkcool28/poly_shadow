import type { ConfidenceResult } from './confidence';

// ─── Candle timing ───

export interface CandleInfo {
  candleStartMs: number;
  candleEndMs: number;
  elapsedMs: number;
  slugTimestamp: number; // Unix seconds of candle start
}

// ─── Supported assets ───

// All assets with {asset}-updown-{duration}-{ts} slug format on Polymarket.
// Each needs a Binance USDT trade stream for direction detection.
export const SUPPORTED_ASSETS = ['btc', 'eth', 'sol', 'xrp'] as const;
export type SupportedAsset = typeof SUPPORTED_ASSETS[number];

// ─── Duration config (asset-independent timing) ───

export interface ArbDurationConfig {
  duration: string;         // "5m", "15m", "4h"
  candleDurationMs: number;
  entryStartMs: number;     // ms into candle when entry window opens
  entryEndMs: number;       // ms into candle when entry window closes
  epochOffsetMs: number;    // Offset from epoch for candle alignment (0 for most, 3600000 for 4h)
}

// Slug formats verified against Gamma API (2026-03):
//   5 Min  → {asset}-updown-5m-{ts}          (aligned to epoch, all 4 assets)
//   15 Min → {asset}-updown-15m-{ts}         (aligned to epoch, all 4 assets)
//   1 Hour → {fullname}-up-or-down-{month}-{day}-{hour}{ampm}-et  (human-readable, ET timezone)
//   4 Hour → {asset}-updown-4h-{ts}          (1h offset: 01:00, 05:00, 09:00... UTC)
export const DURATION_CONFIGS: Record<string, ArbDurationConfig> = {
  '5m': {
    duration: '5m',
    candleDurationMs: 300_000,
    entryStartMs: 240_000,   // 4:00
    entryEndMs: 270_000,     // 4:30
    epochOffsetMs: 0,
  },
  '15m': {
    duration: '15m',
    candleDurationMs: 900_000,
    entryStartMs: 780_000,   // 13:00
    entryEndMs: 840_000,     // 14:00
    epochOffsetMs: 0,
  },
  '1h': {
    duration: '1h',
    candleDurationMs: 3_600_000,
    entryStartMs: 3_300_000, // 55:00
    entryEndMs: 3_480_000,   // 58:00
    epochOffsetMs: 0,        // Human-readable slug format in ET timezone
  },
  '4h': {
    duration: '4h',
    candleDurationMs: 14_400_000,
    entryStartMs: 14_100_000, // 3:55:00
    entryEndMs: 14_280_000,   // 3:58:00
    epochOffsetMs: 3_600_000, // Candles start at 01:00, 05:00, 09:00, 13:00, 17:00, 21:00 UTC
  },
};

// ─── Full market config (asset + duration, built at runtime) ───

export interface ArbMarketConfig extends ArbDurationConfig {
  asset: SupportedAsset;
  type: string;             // "{asset}-{duration}" e.g. "btc-5m", "eth-15m"
  slugPrefix: string;       // "{asset}-updown-{duration}-"
}

/** Build a full market config from asset + duration. */
export function buildMarketConfig(asset: SupportedAsset, dc: ArbDurationConfig): ArbMarketConfig {
  return {
    ...dc,
    asset,
    type: `${asset}-${dc.duration}`,
    slugPrefix: `${asset}-updown-${dc.duration}-`,
  };
}

// ─── Market discovery ───

export interface MarketInfo {
  slug: string;
  upTokenId: string;
  downTokenId: string;
  conditionId: string;
  negRisk: boolean;
  upPrice?: number;    // Current UP outcome price (for contrarian entry)
  downPrice?: number;  // Current DOWN outcome price (for contrarian entry)
}

// ─── Candle runtime state ───

export interface CandleState {
  candleStartMs: number;
  candleEndMs: number;
  slugTimestamp: number;
  openPrice: number;
  marketInfo: MarketInfo | null;
  entered: boolean;
  entryDirection: 'UP' | 'DOWN' | null;
  entryTokenId: string | null;
  entryPrice: number | null;
  entryShares: number | null;
  entryAmountUsd: number | null;
  orderId: string | null;
  cycleId: string | null; // DB record ID
  permanentSkipChecked: boolean;       // Whether circuit breakers + capital have been evaluated
  permanentSkipReason: string | null;  // If non-null, permanent skip was triggered
  lastConfidence: ConfidenceResult | null; // Last evaluation result (for window-expiry SKIPPED record)
}
