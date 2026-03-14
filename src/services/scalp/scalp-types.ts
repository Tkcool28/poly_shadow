/**
 * Shared types for the scalp worker subsystem.
 */

export interface GameEvent {
  matchId: string;
  game: 'cs2' | 'dota2' | 'lol' | 'val' | 'atp' | 'wta';
  eventType: 'map_win' | 'series_end';
  winner: string;
  loser: string;
  seriesScore: [number, number];
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
  isSeriesDecisive: boolean;
  mapNumber: number; // 1, 2, 3 for map wins; 0 for series_end
  timestamp: Date;
  rawData?: Record<string, unknown>;
}

export interface BotSignal {
  tokenId: string;
  side: 'BUY' | 'SELL';
  avgPrice: number;
  totalUsd: number;
  tradeCount: number;
  confidence: 'LOW' | 'MEDIUM' | 'HIGH';
  timestamp: Date;
}

export interface EnhancedBotSignal extends BotSignal {
  buyVolumeUsd: number;
  sellVolumeUsd: number;
  netImbalance: number;        // (buy-sell)/(buy+sell), -1 to 1
  confidenceScore: number;     // 0.0 to 1.0 composite
  volumeSpike: number;         // current volume / trailing average
  pricePersisted: boolean;     // did price hold after ENTRY_DELAY_MS?
}

export interface ScalpSignal {
  matchId: string;
  game: string;
  slug: string;
  conditionId: string;
  tokenId: string;
  outcomeLabel: string;
  eventType: string;
  eventSequence: number;
  eventDetail: string;
  signalSource: 'bot' | 'game_api' | 'both';
  signalConfidence: 'LOW' | 'MEDIUM' | 'HIGH';
  estimatedFairValue: number;
  currentAsk: number;
  estimatedEdge: number;
  timestamp: Date;
  confidenceScore?: number;
}

export interface GameFeed {
  start(): Promise<void>;
  stop(): void;
  onEvent(handler: (event: GameEvent) => void): void;
  isHealthy(): boolean;
}

export type ScalpGame = 'cs2' | 'dota2' | 'lol' | 'val' | 'atp' | 'wta';

// Slug prefixes for discovering esports/tennis markets
export const GAME_SLUG_PREFIXES: Record<ScalpGame, string> = {
  cs2: 'cs2-',
  dota2: 'dota2-',
  lol: 'lol-',
  val: 'val-',
  atp: 'atp-',
  wta: 'wta-',
};

// Slug pattern for series winner: {game}-{team1}-{team2}-{YYYY-MM-DD} with no further suffix
// This is an allowlist approach — anything not matching series or map is derivative
export const SERIES_SLUG_PATTERN = /^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}$/;

// Slug suffixes for individual map markets: exactly -game1, -game2, -game3
export const MAP_SLUG_PATTERN = /-game\d+$/;

/**
 * Estimate fair value of series winner after a map win.
 * Based on historical BO3/BO5 win probabilities given series score.
 */
export function estimateSeriesFairValue(
  seriesScore: [number, number],
  seriesFormat: 'bo1' | 'bo3' | 'bo5',
  priorProbability: number,
): number {
  const [winnerScore, loserScore] = seriesScore;
  const winsNeeded = seriesFormat === 'bo1' ? 1 : seriesFormat === 'bo3' ? 2 : 3;

  // If series is already decided
  if (winnerScore >= winsNeeded) return 0.99;

  // Simplified model: assume each remaining map is 50/50 (neutral)
  // P(win series | current score) using binomial probability
  const remainingForWinner = winsNeeded - winnerScore;
  const remainingForLoser = winsNeeded - loserScore;
  const maxRemaining = remainingForWinner + remainingForLoser - 1;

  // Probability of winning at least remainingForWinner out of maxRemaining maps
  let prob = 0;
  for (let k = remainingForWinner; k <= maxRemaining; k++) {
    prob += binomialPmf(maxRemaining, k, 0.5);
  }

  // Blend with prior (60% model, 40% prior)
  return prob * 0.6 + priorProbability * 0.4;
}

function binomialPmf(n: number, k: number, p: number): number {
  return binomialCoeff(n, k) * Math.pow(p, k) * Math.pow(1 - p, n - k);
}

function binomialCoeff(n: number, k: number): number {
  if (k > n) return 0;
  if (k === 0 || k === n) return 1;
  let result = 1;
  for (let i = 0; i < k; i++) {
    result = (result * (n - i)) / (i + 1);
  }
  return result;
}
