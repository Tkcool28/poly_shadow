// ─── Signal weights (tuning requires code review, not runtime config) ───

const W_MOVE = 0.35;
const W_MOMENTUM = 0.30;
const W_VOLATILITY = 0.20;
const W_TIME = 0.15;

// Minimum snapshots for meaningful momentum / volatility analysis
const MIN_MOMENTUM_SNAPS = 5;
const MIN_VOLATILITY_SNAPS = 3;

// ─── Interfaces ───

export interface ConfidenceConfig {
  priceScale: number;      // Sigmoid scale for price move (default 0.002)
  volScale: number;        // Exp decay for volatility (default 0.0003)
  minPriceChange: number;  // Hard floor — below this, FLAT (from ARB_MIN_PRICE_CHANGE)
}

export interface ConfidenceInput {
  openPrice: number;
  currentPrice: number;
  candleDurationMs: number;
  elapsedMs: number;
  snapshots: Array<{ price: number; timestampMs: number }>; // 1s snapshots, oldest first
  config: ConfidenceConfig;
}

export interface ConfidenceResult {
  score: number;               // 0.0-1.0 composite
  direction: 'UP' | 'DOWN' | 'FLAT';
  signals: {
    priceMovePct: number;      // Raw % move from open (signed)
    moveMagnitude: number;     // 0-1 score for abs move size
    momentum: number;          // 0-1 trend consistency
    volatility: number;        // 0-1 (1=calm, 0=choppy)
    timeScore: number;         // 0-1 (less remaining = higher)
  };
}

// ─── Scoring ───

const FLAT_RESULT: ConfidenceResult = {
  score: 0,
  direction: 'FLAT',
  signals: { priceMovePct: 0, moveMagnitude: 0, momentum: 0, volatility: 0, timeScore: 0 },
};

export function computeConfidence(input: ConfidenceInput): ConfidenceResult {
  const { openPrice, currentPrice, candleDurationMs, elapsedMs, snapshots, config } = input;

  // Early-exit guards
  if (openPrice <= 0 || currentPrice <= 0) return FLAT_RESULT;

  const pctChange = (currentPrice - openPrice) / openPrice;
  if (Math.abs(pctChange) < config.minPriceChange) return FLAT_RESULT;

  const direction: 'UP' | 'DOWN' = pctChange > 0 ? 'UP' : 'DOWN';

  // Signal 1: Price move magnitude
  const moveMagnitude = clamp(1 - Math.exp(-Math.abs(pctChange) / config.priceScale));

  // Signal 2: Momentum alignment
  const momentum = computeMomentum(snapshots, direction);

  // Signal 3: Volatility penalty
  const volatility = computeVolatility(snapshots, config.volScale);

  // Signal 4: Time remaining
  const remainingMs = candleDurationMs - elapsedMs;
  const timeScore = clamp(1 - Math.min(remainingMs / 300_000, 1.0));

  const composite = clamp(
    W_MOVE * moveMagnitude +
    W_MOMENTUM * momentum +
    W_VOLATILITY * volatility +
    W_TIME * timeScore,
  );

  return {
    score: composite,
    direction,
    signals: {
      priceMovePct: pctChange,
      moveMagnitude,
      momentum,
      volatility,
      timeScore,
    },
  };
}

// ─── Signal helpers ───

function computeMomentum(
  snapshots: Array<{ price: number; timestampMs: number }>,
  direction: 'UP' | 'DOWN',
): number {
  if (snapshots.length < MIN_MOMENTUM_SNAPS) return 0.5; // Neutral fallback

  // Sub-signal 1: Half-split comparison (using % change for price-normalization)
  const mid = Math.floor(snapshots.length / 2);
  const olderAvg = avg(snapshots.slice(0, mid).map(s => s.price));
  const newerAvg = avg(snapshots.slice(mid).map(s => s.price));
  const midAvg = (olderAvg + newerAvg) / 2;
  const relDiff = midAvg > 0 ? (newerAvg - olderAvg) / midAvg : 0;
  const aligned = direction === 'UP' ? relDiff : -relDiff;
  // Sigmoid on relative change: ±0.05% → ~0.5, ±0.2% → ~0.73, ±1% → ~1.0
  const halfSplitScore = 1 / (1 + Math.exp(-aligned * 5000));

  // Sub-signal 2: Step consistency (fraction of moves in expected direction)
  let consistentSteps = 0;
  let totalSteps = 0;
  for (let i = 1; i < snapshots.length; i++) {
    const delta = snapshots[i].price - snapshots[i - 1].price;
    if (delta === 0) continue;
    totalSteps++;
    const stepAligned = direction === 'UP' ? delta > 0 : delta < 0;
    if (stepAligned) consistentSteps++;
  }
  const stepScore = totalSteps > 0 ? consistentSteps / totalSteps : 0.5;

  return clamp((halfSplitScore + stepScore) / 2);
}

function computeVolatility(
  snapshots: Array<{ price: number; timestampMs: number }>,
  volScale: number,
): number {
  if (snapshots.length < MIN_VOLATILITY_SNAPS) return 0.5; // Neutral fallback

  // Standard deviation of second-to-second returns
  const returns: number[] = [];
  for (let i = 1; i < snapshots.length; i++) {
    const prev = snapshots[i - 1].price;
    if (prev <= 0) continue;
    returns.push((snapshots[i].price - prev) / prev);
  }

  if (returns.length < 2) return 0.5;

  const mean = returns.reduce((s, v) => s + v, 0) / returns.length;
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1);
  const stdDev = Math.sqrt(variance);

  return clamp(Math.exp(-stdDev / volScale));
}

function avg(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function clamp(v: number, min = 0, max = 1): number {
  return Math.max(min, Math.min(max, v));
}
