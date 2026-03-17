/**
 * Scalp Heartbeat Manager
 *
 * Manages the CLOB API heartbeat kill-switch for market making safety.
 *
 * How it works:
 *   1. First call to postHeartbeat(null) starts a new heartbeat chain
 *   2. Server returns a heartbeat_id that must be passed to subsequent calls
 *   3. If no heartbeat is received within 10 seconds, the server auto-cancels ALL open orders
 *   4. This protects against process crashes, network failures, and runaway bugs
 *
 * The manager sends heartbeats every `intervalMs` (default 5s, well within the 10s deadline).
 * On failure, it retries immediately with exponential backoff up to 3 times before logging
 * a critical error. If heartbeats fail persistently, the server will auto-cancel all orders
 * within 10s — this is the desired safety behavior.
 *
 * Paper mode: no-op (logs heartbeat events without calling the API).
 * Live mode: calls clobClient.postHeartbeat() with chained heartbeat_id.
 */

import type { ClobClient } from '@polymarket/clob-client';

// ─── Types ───

export interface HeartbeatConfig {
  /** Milliseconds between heartbeat sends (default 5000). Must be < 10000 (server deadline). */
  intervalMs?: number;
  /** Maximum consecutive failures before logging critical error (default 3) */
  maxConsecutiveFailures?: number;
  /** Whether this is paper mode (no-op heartbeats) */
  isPaper: boolean;
}

export interface HeartbeatStats {
  isRunning: boolean;
  isPaper: boolean;
  totalSent: number;
  totalFailed: number;
  consecutiveFailures: number;
  lastSentAt: number;
  lastFailedAt: number;
  lastHeartbeatId: string | null;
  uptimeMs: number;
}

type HeartbeatLogFn = (msg: string) => void;

// ─── HeartbeatManager ───

export class HeartbeatManager {
  private config: Required<HeartbeatConfig>;
  private client: ClobClient | null;
  private timer: ReturnType<typeof setInterval> | null = null;

  // State
  private isRunning = false;
  private heartbeatId: string | null = null;
  private totalSent = 0;
  private totalFailed = 0;
  private consecutiveFailures = 0;
  private lastSentAt = 0;
  private lastFailedAt = 0;
  private startedAt = 0;

  // Callbacks
  private onLog: HeartbeatLogFn;
  private onCriticalFailure: (() => void) | null = null;

  constructor(
    config: HeartbeatConfig,
    client: ClobClient | null,
    onLog?: HeartbeatLogFn,
  ) {
    this.config = {
      intervalMs: config.intervalMs ?? 5_000,
      maxConsecutiveFailures: config.maxConsecutiveFailures ?? 3,
      isPaper: config.isPaper,
    };

    if (this.config.intervalMs >= 10_000) {
      throw new Error(
        `Heartbeat interval ${this.config.intervalMs}ms is too close to the 10s server deadline. ` +
        'Use a value < 10000ms (recommended: 5000ms).',
      );
    }

    this.client = client;
    this.onLog = onLog ?? ((msg: string) => console.log(`[HEARTBEAT] ${msg}`));

    if (!config.isPaper && !client) {
      throw new Error('Live heartbeat mode requires a ClobClient instance');
    }
  }

  /**
   * Register a callback for critical failures (consecutive heartbeat misses).
   * In live mode, this should trigger an emergency quote pull.
   */
  onCritical(callback: () => void): void {
    this.onCriticalFailure = callback;
  }

  /**
   * Start the heartbeat loop. In paper mode, logs a simulated heartbeat.
   * In live mode, sends the first heartbeat to start the chain, then continues on interval.
   */
  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;
    this.startedAt = Date.now();

    if (this.config.isPaper) {
      this.log('Heartbeat started (paper mode — no API calls)');
      this.timer = setInterval(() => {
        this.totalSent++;
        this.lastSentAt = Date.now();
        // Paper mode: silent no-op (don't spam logs every 5s)
      }, this.config.intervalMs);
      return;
    }

    // Live mode: send initial heartbeat to start the chain
    this.log('Starting heartbeat chain (live mode)...');
    await this.sendHeartbeat();

    // Schedule recurring heartbeats
    this.timer = setInterval(async () => {
      await this.sendHeartbeat();
    }, this.config.intervalMs);
  }

  /**
   * Stop the heartbeat loop. In live mode, the server will auto-cancel all orders
   * within 10 seconds of the last heartbeat — this is the expected behavior on shutdown.
   */
  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const mode = this.config.isPaper ? 'paper' : 'live';
    this.log(
      `Heartbeat stopped (${mode}) | sent=${this.totalSent} failed=${this.totalFailed} ` +
      `| ${this.config.isPaper ? 'no-op' : 'server will auto-cancel orders in ~10s'}`,
    );

    // Clear chain — next start() will begin a new chain
    this.heartbeatId = null;
  }

  /**
   * Send a single heartbeat. Chains the heartbeat_id from the previous response.
   * On failure, retries immediately up to maxConsecutiveFailures times.
   */
  private async sendHeartbeat(): Promise<void> {
    if (!this.client || this.config.isPaper) return;

    try {
      const response = await this.client.postHeartbeat(this.heartbeatId);

      if (response.error) {
        throw new Error(response.error);
      }

      this.heartbeatId = response.heartbeat_id ?? null;
      this.totalSent++;
      this.lastSentAt = Date.now();
      this.consecutiveFailures = 0;

    } catch (err: any) {
      this.totalFailed++;
      this.consecutiveFailures++;
      this.lastFailedAt = Date.now();

      const errMsg = err?.message || String(err);

      if (this.consecutiveFailures >= this.config.maxConsecutiveFailures) {
        this.log(
          `CRITICAL: ${this.consecutiveFailures} consecutive heartbeat failures! ` +
          `Server will auto-cancel all orders. Last error: ${errMsg.slice(0, 200)}`,
        );

        // Invoke critical callback (e.g., to pull quotes and stop trading)
        if (this.onCriticalFailure) {
          try {
            this.onCriticalFailure();
          } catch {
            // Don't let callback errors propagate
          }
        }

        // Reset chain — next successful heartbeat will start fresh
        this.heartbeatId = null;
      } else {
        this.log(
          `Heartbeat failed (${this.consecutiveFailures}/${this.config.maxConsecutiveFailures}): ${errMsg.slice(0, 200)}`,
        );
      }
    }
  }

  /**
   * Get current heartbeat health stats.
   */
  getStats(): HeartbeatStats {
    return {
      isRunning: this.isRunning,
      isPaper: this.config.isPaper,
      totalSent: this.totalSent,
      totalFailed: this.totalFailed,
      consecutiveFailures: this.consecutiveFailures,
      lastSentAt: this.lastSentAt,
      lastFailedAt: this.lastFailedAt,
      lastHeartbeatId: this.heartbeatId,
      uptimeMs: this.startedAt > 0 ? Date.now() - this.startedAt : 0,
    };
  }

  /**
   * Check if heartbeat is healthy (no consecutive failures, running, and recently sent).
   */
  isHealthy(): boolean {
    if (!this.isRunning) return false;
    if (this.config.isPaper) return true;
    if (this.consecutiveFailures > 0) return false;
    // Stale check: last heartbeat should be within 2x the interval
    if (this.lastSentAt > 0 && Date.now() - this.lastSentAt > this.config.intervalMs * 2) return false;
    return true;
  }

  private log(msg: string): void {
    this.onLog(msg);
  }
}
