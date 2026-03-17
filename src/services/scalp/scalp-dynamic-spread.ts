/**
 * Dynamic Spread Calculator for Market Making
 *
 * Adjusts spread width based on match context:
 * - Time-of-match: wider near halftime/fulltime (soccer) or end of quarter (NBA)
 * - Volatility: wider when recent price moves are large
 * - Inventory: wider when we need to reduce exposure
 * - Score state: wider in close games (higher event impact)
 *
 * Usage:
 *   const ds = new DynamicSpread({ baseSpread: 0.04, sport: 'soccer' });
 *   const spread = ds.getSpread({ matchMinute: 45, volatility: 0.02, inventory: 15, fairValue: 0.55 });
 */

export interface DynamicSpreadConfig {
  /** Base spread width in price units (e.g. 0.04 = 4c) */
  baseSpread: number;
  /** Sport type — determines time-based widening pattern */
  sport: 'soccer' | 'nba';
  /** Minimum spread width (floor) */
  minSpread?: number;
  /** Maximum spread width (ceiling) */
  maxSpread?: number;
  /** Volatility multiplier: spread += volatility * volMultiplier (default: 2.0) */
  volatilityMultiplier?: number;
  /** Inventory penalty: spread += |inventory| / maxInventory * inventoryPenalty (default: 0.02) */
  inventoryPenalty?: number;
  /** Max inventory for penalty calculation */
  maxInventory?: number;
}

export interface SpreadContext {
  /** Current match minute (0-90+ for soccer, 0-48+ for NBA) */
  matchMinute?: number;
  /** Current quarter (1-4+ for NBA) */
  quarter?: number;
  /** Recent price volatility (standard deviation of last N trades) */
  volatility?: number;
  /** Current inventory in shares (absolute value used) */
  inventory?: number;
  /** Current fair value — used to detect edge-of-range (near 0 or 1) */
  fairValue?: number;
  /** Is the match in a dead ball / stoppage? */
  isStopped?: boolean;
  /** Score differential (absolute) — closer games = wider spread */
  scoreDiff?: number;
}

interface ResolvedConfig {
  baseSpread: number;
  sport: 'soccer' | 'nba';
  minSpread: number;
  maxSpread: number;
  volatilityMultiplier: number;
  inventoryPenalty: number;
  maxInventory: number;
}

/**
 * Soccer time multipliers (percentage of base spread to ADD).
 * Based on when goals are most likely / price is most volatile:
 * - Early match (0-15): settling period, moderate widening
 * - Mid first half (15-40): steady state, base spread
 * - Approaching halftime (40-45+): moderate widening (tactical changes)
 * - Halftime (45-47): narrow briefly (no action, but price stable)
 * - Early second half (47-60): settling, moderate widening
 * - Mid second half (60-75): base spread
 * - Final 15min (75-90): significant widening (desperation, tactical shifts)
 * - Injury time (90+): maximum widening (chaos)
 */
function getSoccerTimeMultiplier(matchMinute: number): number {
  if (matchMinute <= 0) return 0;       // pre-match
  if (matchMinute <= 5) return 0.5;     // opening: moderate
  if (matchMinute <= 15) return 0.3;    // early settling
  if (matchMinute <= 40) return 0;      // steady state
  if (matchMinute <= 47) return 0.3;    // halftime zone
  if (matchMinute <= 60) return 0.2;    // early 2nd half
  if (matchMinute <= 75) return 0;      // steady state
  if (matchMinute <= 85) return 0.3;    // approaching end
  if (matchMinute <= 90) return 0.5;    // final minutes
  return 0.75;                          // injury time — maximum
}

/**
 * NBA time multipliers.
 * NBA has 12-minute quarters (48 min total). Key volatile moments:
 * - Start of each quarter: settling
 * - End of each quarter: timeout-heavy, tactical, buzzer-beaters
 * - Close game in 4th quarter: extremely volatile
 */
function getNbaTimeMultiplier(matchMinute: number, quarter?: number): number {
  if (matchMinute <= 0) return 0;
  const q = quarter ?? Math.ceil(matchMinute / 12);
  const minuteInQuarter = matchMinute - (q - 1) * 12;

  // Overtime
  if (q > 4) return 0.75;

  // End of quarter (last 2 minutes)
  if (minuteInQuarter >= 10) return 0.4 + (q === 4 ? 0.3 : 0);

  // Start of quarter
  if (minuteInQuarter <= 2) return 0.2;

  // 4th quarter generally wider
  if (q === 4) return 0.2;

  return 0; // steady state
}

export class DynamicSpread {
  private config: ResolvedConfig;

  constructor(config: DynamicSpreadConfig) {
    this.config = {
      baseSpread: config.baseSpread,
      sport: config.sport,
      minSpread: config.minSpread ?? 0.02,
      maxSpread: config.maxSpread ?? 0.10,
      volatilityMultiplier: config.volatilityMultiplier ?? 2.0,
      inventoryPenalty: config.inventoryPenalty ?? 0.02,
      maxInventory: config.maxInventory ?? 50,
    };
  }

  /**
   * Calculate the recommended spread width given current match context.
   * Returns spread in price units (e.g. 0.04 = 4c).
   */
  getSpread(ctx: SpreadContext): number {
    let spread = this.config.baseSpread;

    // 1. Time-based widening
    if (ctx.matchMinute !== undefined && ctx.matchMinute > 0) {
      const timeMult = this.config.sport === 'soccer'
        ? getSoccerTimeMultiplier(ctx.matchMinute)
        : getNbaTimeMultiplier(ctx.matchMinute, ctx.quarter);
      spread += this.config.baseSpread * timeMult;
    }

    // 2. Volatility-based widening
    if (ctx.volatility !== undefined && ctx.volatility > 0) {
      spread += ctx.volatility * this.config.volatilityMultiplier;
    }

    // 3. Inventory-based widening
    if (ctx.inventory !== undefined && Math.abs(ctx.inventory) > 0) {
      const invRatio = Math.min(1, Math.abs(ctx.inventory) / this.config.maxInventory);
      spread += invRatio * this.config.inventoryPenalty;
    }

    // 4. Edge-of-range widening: when fair value is near 0 or 1, spread should be wider
    // (less liquid, more skewed)
    if (ctx.fairValue !== undefined) {
      const edgeDist = Math.min(ctx.fairValue, 1 - ctx.fairValue);
      if (edgeDist < 0.15) {
        // Below 0.15 or above 0.85: widen by up to 50%
        const edgeMult = (0.15 - edgeDist) / 0.15 * 0.5;
        spread += this.config.baseSpread * edgeMult;
      }
    }

    // 5. Close-game widening (if score differential provided)
    if (ctx.scoreDiff !== undefined && ctx.scoreDiff === 0) {
      // Tied game: events have maximum price impact
      spread += this.config.baseSpread * 0.15;
    }

    // 6. Stoppage tightening (dead ball = less risk)
    if (ctx.isStopped) {
      spread *= 0.8;
    }

    // Clamp
    return Math.max(this.config.minSpread, Math.min(this.config.maxSpread, spread));
  }

  /**
   * Get a breakdown of spread components for logging/debugging.
   */
  getSpreadBreakdown(ctx: SpreadContext): {
    base: number;
    time: number;
    volatility: number;
    inventory: number;
    edge: number;
    score: number;
    stoppage: number;
    final: number;
  } {
    let time = 0;
    let volatility = 0;
    let inventory = 0;
    let edge = 0;
    let score = 0;
    const stoppage = ctx.isStopped ? -0.2 : 0;  // as multiplier

    if (ctx.matchMinute !== undefined && ctx.matchMinute > 0) {
      const timeMult = this.config.sport === 'soccer'
        ? getSoccerTimeMultiplier(ctx.matchMinute)
        : getNbaTimeMultiplier(ctx.matchMinute, ctx.quarter);
      time = this.config.baseSpread * timeMult;
    }

    if (ctx.volatility !== undefined && ctx.volatility > 0) {
      volatility = ctx.volatility * this.config.volatilityMultiplier;
    }

    if (ctx.inventory !== undefined && Math.abs(ctx.inventory) > 0) {
      const invRatio = Math.min(1, Math.abs(ctx.inventory) / this.config.maxInventory);
      inventory = invRatio * this.config.inventoryPenalty;
    }

    if (ctx.fairValue !== undefined) {
      const edgeDist = Math.min(ctx.fairValue, 1 - ctx.fairValue);
      if (edgeDist < 0.15) {
        edge = this.config.baseSpread * ((0.15 - edgeDist) / 0.15 * 0.5);
      }
    }

    if (ctx.scoreDiff !== undefined && ctx.scoreDiff === 0) {
      score = this.config.baseSpread * 0.15;
    }

    const final = this.getSpread(ctx);

    return {
      base: this.config.baseSpread,
      time,
      volatility,
      inventory,
      edge,
      score,
      stoppage: ctx.isStopped ? (this.config.baseSpread + time + volatility + inventory + edge + score) * stoppage : 0,
      final,
    };
  }
}
