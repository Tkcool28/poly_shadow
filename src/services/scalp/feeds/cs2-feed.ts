import { EventEmitter } from 'events';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('cs2-feed');

// HLTV Scorebot WebSocket (Socket.IO v3 protocol)
const HLTV_SCOREBOT_URL = 'wss://scorebot-secure.hltv.org';
const HLTV_REST_BASE = 'https://www.hltv.org/matches';

interface HltvMapEnd {
  mapName: string;
  firstHalf: { team1: number; team2: number };
  secondHalf: { team1: number; team2: number };
  winner: string; // team name
}

interface HltvMatchState {
  matchId: string;
  team1: string;
  team2: string;
  seriesScore: [number, number];
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
  currentMap: number;
}

/**
 * CS2 feed using HLTV Scorebot.
 *
 * Note: HLTV Scorebot uses Socket.IO v3 protocol. This implementation uses
 * socket.io-client for proper framing/heartbeat. If socket.io-client is not
 * available, falls back to polling HLTV REST API.
 *
 * Phase 1: Placeholder that emits events when connected.
 * Full implementation requires either socket.io-client or manual Socket.IO framing.
 */
export class CS2Feed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private activeMatches = new Map<string, HltvMatchState>();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private handlers: ((event: GameEvent) => void)[] = [];

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!config.SCALP_CS2_ENABLED) {
      log.info('CS2 feed disabled');
      return;
    }

    // HLTV Scorebot Socket.IO not yet implemented — rely on bot detector for CS2 signals
    log.warn('CS2 feed: HLTV Scorebot not yet implemented, relying on bot detector for CS2 signals');
    this.healthy = false;
  }

  stop(): void {
    this.running = false;
    this.healthy = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    log.info('CS2 feed stopped');
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.handlers.push(handler);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  /**
   * Manually inject a game event (for testing / manual triggering).
   */
  injectEvent(event: GameEvent): void {
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('CS2 feed handler error', { error: err.message });
      }
    }
  }

  private emitGameEvent(event: GameEvent): void {
    this.emit('gameEvent', event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('CS2 feed handler error', { error: err.message });
      }
    }
  }
}
