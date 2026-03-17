/**
 * Shared types for the scalp worker subsystem.
 */

export interface GameEvent {
  matchId: string;
  game: 'cs2' | 'dota2' | 'lol' | 'val' | 'atp' | 'wta' | 'nba' | 'soccer';
  eventType: 'map_win' | 'series_end' | 'baron_kill' | 'elder_dragon' | 'roshan_kill' | 'barracks_destroyed' | 'gold_lead_shift' | 'lead_change' | 'scoring_run' | 'goal' | 'red_card';
  winner: string;
  loser: string;
  seriesScore: [number, number];
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
  isSeriesDecisive: boolean;
  mapNumber: number; // 1, 2, 3 for map wins; 0 for series_end; period for NBA
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

export type ScalpGame = 'cs2' | 'dota2' | 'lol' | 'val' | 'atp' | 'wta' | 'nba' | 'soccer';

// Slug prefixes for discovering esports/tennis markets
export const GAME_SLUG_PREFIXES: Record<ScalpGame, string> = {
  cs2: 'cs2-',
  dota2: 'dota2-',
  lol: 'lol-',
  val: 'val-',
  atp: 'atp-',
  wta: 'wta-',
  nba: 'nba-',
  soccer: 'epl-',
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

/**
 * Estimate probability shift for in-game events (Baron, Elder Dragon).
 * These are ADDITIVE shifts to the current series-level price.
 *
 * Sources for game-level win probability impact:
 * - Baron Nashor: ~60-75% game win rate for team that takes it
 *   (Oracle's Elixir 2023-24 pro data, ~+15-25% over baseline 50%)
 * - Elder Dragon: ~55-70% game win rate
 *   (~+10-20% over baseline, lower than Baron due to conditional availability)
 *
 * Series-level dampening: in a bo3/bo5, one game's outcome shifts series
 * probability by roughly (game_shift × 1/remaining_games). We use conservative
 * fixed estimates: non-decisive ~40% dampening, decisive game = full game shift.
 */
export function estimateInGameProbShift(
  eventType: 'baron_kill' | 'elder_dragon' | 'roshan_kill' | 'barracks_destroyed' | 'gold_lead_shift' | 'lead_change' | 'scoring_run' | 'goal' | 'red_card',
  isDecisiveGame: boolean,
): number {
  if (eventType === 'baron_kill') {
    // Baron Nashor: +15-25% game win probability → ~6-12% series shift
    return isDecisiveGame ? 0.12 : 0.06;
  }
  if (eventType === 'elder_dragon') {
    // Elder Dragon: +10-20% game win probability → ~4-8% series shift
    return isDecisiveGame ? 0.08 : 0.04;
  }
  if (eventType === 'roshan_kill') {
    // Roshan: Aegis of the Immortal (+second life for carry), ~60-70% game win correlation
    // Similar impact to Baron Nashor. 8-10 min respawn, teams fight over it.
    return isDecisiveGame ? 0.15 : 0.08;
  }
  if (eventType === 'barracks_destroyed') {
    // Barracks (rax): mega creeps at 3/3, each rax gives permanent lane advantage
    // First rax ~+15-20% game win; stacks multiplicatively toward mega creeps
    return isDecisiveGame ? 0.20 : 0.10;
  }
  if (eventType === 'gold_lead_shift') {
    // Net worth lead swing of ≥5K gold: indicates teamfight win or major objective
    // Moderate signal — gold leads are informative but reversible
    return isDecisiveGame ? 0.08 : 0.04;
  }
  if (eventType === 'lead_change') {
    // NBA Q4/OT lead change: the team that was behind takes the lead
    // Q4 lead changes are among the biggest NBA probability shifters (10-30%)
    // "Decisive" here means close game (score margin was small before the change)
    return isDecisiveGame ? 0.20 : 0.10;
  }
  if (eventType === 'scoring_run') {
    // NBA scoring run: one team scores 10+ unanswered points
    // Indicates momentum shift, typically 5-15% probability change
    return isDecisiveGame ? 0.10 : 0.05;
  }
  if (eventType === 'goal') {
    // Soccer goal: massive probability shift, especially go-ahead goals.
    // "Decisive" here means go-ahead or insurance goal (not equalizer).
    // Go-ahead goals shift win probability by 25-40%; other goals by 15-25%.
    return isDecisiveGame ? 0.25 : 0.15;
  }
  if (eventType === 'red_card') {
    // Soccer red card: playing with 10 men for remainder of match.
    // Significant disadvantage, ~15% shift for decisive situations, ~8% otherwise.
    return isDecisiveGame ? 0.15 : 0.08;
  }
  return 0;
}
