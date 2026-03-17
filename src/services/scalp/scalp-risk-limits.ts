/**
 * Scalp Risk Limits & Circuit Breakers
 *
 * Enforces hard safety limits on the market making engine:
 *
 * 1. **Max loss per match**: If realized + unrealized PnL drops below threshold,
 *    stop quoting immediately and cancel all orders.
 *
 * 2. **Max inventory hard cap**: Absolute position limit — if inventory exceeds
 *    this, reject fills on the side that would increase exposure.
 *
 * 3. **Drawdown circuit breaker**: If PnL drops from peak by more than threshold,
 *    pause quoting for a cooldown period.
 *
 * 4. **Fill rate anomaly**: If fills are coming too fast (> N per minute),
 *    pause quoting (likely adverse selection or feed delay).
 *
 * 5. **Session time limit**: Maximum quoting duration (auto-shutdown).
 *
 * Each check returns a RiskDecision: ALLOW, REDUCE_SIZE, or HALT.
 * The market maker should call `checkRisk()` before each trade cycle.
 */

// ─── Types ───

export type RiskAction = 'ALLOW' | 'REDUCE_SIZE' | 'HALT';

export interface RiskDecision {
  action: RiskAction;
  reason: string;
  /** For REDUCE_SIZE: factor to multiply order size by (0-1) */
  sizeFactor?: number;
}

export interface RiskLimitsConfig {
  /** Maximum loss (negative PnL) per match in USD before halting (default: -20) */
  maxLossPerMatch: number;
  /** Maximum one-sided inventory in shares (absolute) before halting (default: 200) */
  maxInventoryShares: number;
  /** Maximum one-sided inventory in USD before halting (default: 100) */
  maxInventoryUsd: number;
  /** Drawdown from peak PnL that triggers a pause, in USD (default: -10) */
  drawdownPauseThreshold: number;
  /** Cooldown after drawdown pause, in ms (default: 60000 = 1 min) */
  drawdownCooldownMs: number;
  /** Max fills per minute before triggering adverse selection halt (default: 20) */
  maxFillsPerMinute: number;
  /** Cooldown after fill rate anomaly, in ms (default: 30000 = 30s) */
  fillRateCooldownMs: number;
  /** Maximum quoting session duration in ms (default: 10800000 = 3 hours) */
  maxSessionMs: number;
}

export interface RiskState {
  peakPnl: number;
  isHalted: boolean;
  haltReason: string | null;
  haltedAt: number;
  pausedUntil: number;
  pauseReason: string | null;
  totalHalts: number;
  totalPauses: number;
}

// Default risk limits (conservative for paper testing, can be widened for live)
const DEFAULT_LIMITS: RiskLimitsConfig = {
  maxLossPerMatch: -20,
  maxInventoryShares: 200,
  maxInventoryUsd: 100,
  drawdownPauseThreshold: -10,
  drawdownCooldownMs: 60_000,
  maxFillsPerMinute: 20,
  fillRateCooldownMs: 30_000,
  maxSessionMs: 3 * 60 * 60 * 1000, // 3 hours
};

type RiskLogFn = (msg: string) => void;

// ─── RiskLimits ───

export class RiskLimits {
  private config: RiskLimitsConfig;
  private state: RiskState;
  private fillTimestamps: number[] = [];
  private sessionStartedAt = 0;
  private onLog: RiskLogFn;

  constructor(config?: Partial<RiskLimitsConfig>, onLog?: RiskLogFn) {
    this.config = { ...DEFAULT_LIMITS, ...config };
    this.onLog = onLog ?? ((msg: string) => console.log(`[RISK] ${msg}`));

    this.state = {
      peakPnl: 0,
      isHalted: false,
      haltReason: null,
      haltedAt: 0,
      pausedUntil: 0,
      pauseReason: null,
      totalHalts: 0,
      totalPauses: 0,
    };
  }

  /**
   * Mark the session as started (for session time limit tracking).
   */
  startSession(): void {
    this.sessionStartedAt = Date.now();
  }

  /**
   * Check all risk limits and return a decision.
   *
   * @param realizedPnl - Realized PnL from completed round trips
   * @param unrealizedPnl - Unrealized PnL from open inventory at mark
   * @param positionShares - Current net position in shares (positive = long)
   * @param fairValue - Current fair value for USD conversion
   */
  checkRisk(
    realizedPnl: number,
    unrealizedPnl: number,
    positionShares: number,
    fairValue: number,
  ): RiskDecision {
    const now = Date.now();
    const totalPnl = realizedPnl + unrealizedPnl;
    const positionUsd = Math.abs(positionShares * fairValue);

    // ─── Hard halt: already halted ───
    if (this.state.isHalted) {
      return { action: 'HALT', reason: `HALTED: ${this.state.haltReason}` };
    }

    // ─── Temporary pause check ───
    if (this.state.pausedUntil > now) {
      const remainingSec = Math.round((this.state.pausedUntil - now) / 1000);
      return { action: 'HALT', reason: `PAUSED (${remainingSec}s remaining): ${this.state.pauseReason}` };
    } else if (this.state.pausedUntil > 0) {
      // Pause expired — clear it
      this.log(`Pause expired, resuming: was "${this.state.pauseReason}"`);
      this.state.pausedUntil = 0;
      this.state.pauseReason = null;
    }

    // ─── 1. Max loss per match ───
    if (totalPnl <= this.config.maxLossPerMatch) {
      this.halt(`Max loss breached: PnL ${fmtUsd(totalPnl)} <= limit ${fmtUsd(this.config.maxLossPerMatch)}`);
      return { action: 'HALT', reason: this.state.haltReason! };
    }

    // ─── 2. Max inventory hard cap (shares) ───
    if (Math.abs(positionShares) > this.config.maxInventoryShares) {
      this.halt(
        `Max inventory (shares) breached: ${Math.abs(positionShares)} shares > limit ${this.config.maxInventoryShares}`,
      );
      return { action: 'HALT', reason: this.state.haltReason! };
    }

    // ─── 3. Max inventory hard cap (USD) ───
    if (positionUsd > this.config.maxInventoryUsd) {
      this.halt(
        `Max inventory (USD) breached: $${positionUsd.toFixed(2)} > limit $${this.config.maxInventoryUsd.toFixed(2)}`,
      );
      return { action: 'HALT', reason: this.state.haltReason! };
    }

    // ─── 4. Drawdown from peak ───
    if (totalPnl > this.state.peakPnl) {
      this.state.peakPnl = totalPnl;
    }
    const drawdown = totalPnl - this.state.peakPnl;
    if (drawdown <= this.config.drawdownPauseThreshold && this.state.peakPnl > 0) {
      this.pause(
        `Drawdown: PnL dropped ${fmtUsd(drawdown)} from peak ${fmtUsd(this.state.peakPnl)}`,
        this.config.drawdownCooldownMs,
      );
      return { action: 'HALT', reason: this.state.pauseReason! };
    }

    // ─── 5. Fill rate anomaly ───
    this.pruneOldFills(now);
    const recentFills = this.fillTimestamps.length;
    if (recentFills > this.config.maxFillsPerMinute) {
      this.pause(
        `Fill rate anomaly: ${recentFills} fills/min > limit ${this.config.maxFillsPerMinute}`,
        this.config.fillRateCooldownMs,
      );
      return { action: 'HALT', reason: this.state.pauseReason! };
    }

    // ─── 6. Session time limit ───
    if (this.sessionStartedAt > 0) {
      const sessionMs = now - this.sessionStartedAt;
      if (sessionMs > this.config.maxSessionMs) {
        this.halt(`Session time limit: ${Math.round(sessionMs / 60_000)}min > limit ${Math.round(this.config.maxSessionMs / 60_000)}min`);
        return { action: 'HALT', reason: this.state.haltReason! };
      }
    }

    // ─── 7. Soft inventory warning (reduce size) ───
    const inventoryUtilization = positionUsd / this.config.maxInventoryUsd;
    if (inventoryUtilization > 0.75) {
      const factor = Math.max(0.1, 1 - inventoryUtilization);
      return {
        action: 'REDUCE_SIZE',
        reason: `Inventory at ${(inventoryUtilization * 100).toFixed(0)}% of max — reducing size`,
        sizeFactor: factor,
      };
    }

    return { action: 'ALLOW', reason: 'OK' };
  }

  /**
   * Record a fill for fill-rate tracking.
   */
  recordFill(): void {
    this.fillTimestamps.push(Date.now());
  }

  /**
   * Hard halt — permanent until reset. Used for max loss and inventory breaches.
   */
  private halt(reason: string): void {
    if (this.state.isHalted) return;
    this.state.isHalted = true;
    this.state.haltReason = reason;
    this.state.haltedAt = Date.now();
    this.state.totalHalts++;
    this.log(`HALT: ${reason}`);
  }

  /**
   * Temporary pause — resumes after cooldown. Used for drawdown and fill-rate.
   */
  private pause(reason: string, durationMs: number): void {
    this.state.pausedUntil = Date.now() + durationMs;
    this.state.pauseReason = reason;
    this.state.totalPauses++;
    this.log(`PAUSE (${Math.round(durationMs / 1000)}s): ${reason}`);
  }

  /**
   * Reset a halt (manual override — use with caution).
   */
  resetHalt(): void {
    if (!this.state.isHalted) return;
    this.log(`Halt reset manually (was: ${this.state.haltReason})`);
    this.state.isHalted = false;
    this.state.haltReason = null;
  }

  /**
   * Get the current risk state.
   */
  getState(): RiskState {
    return { ...this.state };
  }

  /**
   * Get a summary string for logging.
   */
  getSummary(): string {
    const status = this.state.isHalted
      ? `HALTED: ${this.state.haltReason}`
      : this.state.pausedUntil > Date.now()
        ? `PAUSED: ${this.state.pauseReason}`
        : 'OK';
    return `risk=${status} peak=${fmtUsd(this.state.peakPnl)} halts=${this.state.totalHalts} pauses=${this.state.totalPauses} fills/min=${this.fillTimestamps.length}`;
  }

  /**
   * Prune fill timestamps older than 60 seconds.
   */
  private pruneOldFills(now: number): void {
    const cutoff = now - 60_000;
    while (this.fillTimestamps.length > 0 && this.fillTimestamps[0] < cutoff) {
      this.fillTimestamps.shift();
    }
  }

  private log(msg: string): void {
    this.onLog(msg);
  }
}

// ─── Helpers ───

function fmtUsd(v: number): string {
  const sign = v >= 0 ? '+' : '-';
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
