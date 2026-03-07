import { EventEmitter } from 'events';
import axios from 'axios';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('dota2-feed');

const STEAM_API_BASE = 'https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/';

interface DotaLiveGame {
  match_id: number;
  league_id: number;
  radiant_team?: { team_name: string; team_id: number };
  dire_team?: { team_name: string; team_id: number };
  radiant_series_wins: number;
  dire_series_wins: number;
  series_type: number; // 0=bo1, 1=bo3, 2=bo5
  scoreboard?: {
    duration: number;
    radiant: { score: number };
    dire: { score: number };
  };
}

interface TrackedMatch {
  matchId: string;
  radiantTeam: string;
  direTeam: string;
  radiantSeriesWins: number;
  direSeriesWins: number;
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
}

export class Dota2Feed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedMatches = new Map<string, TrackedMatch>();
  private handlers: ((event: GameEvent) => void)[] = [];

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!config.SCALP_STEAM_API_KEY) {
      log.info('Dota 2 feed disabled (no SCALP_STEAM_API_KEY)');
      return;
    }

    log.info('Dota 2 feed starting', { pollInterval: config.SCALP_DOTA2_POLL_INTERVAL_MS });

    // Initial poll
    await this.poll();

    // Start periodic polling
    this.pollTimer = setInterval(() => this.poll(), config.SCALP_DOTA2_POLL_INTERVAL_MS);
    this.healthy = true;
  }

  stop(): void {
    this.running = false;
    this.healthy = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    this.trackedMatches.clear();
    log.info('Dota 2 feed stopped');
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.handlers.push(handler);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  private async poll(): Promise<void> {
    try {
      const response = await axios.get(STEAM_API_BASE, {
        params: { key: config.SCALP_STEAM_API_KEY },
        timeout: 10_000,
      });

      const games: DotaLiveGame[] = response.data?.result?.games ?? [];

      for (const game of games) {
        if (!game.radiant_team || !game.dire_team) continue;

        const matchKey = `${game.league_id}-${game.radiant_team.team_id}-${game.dire_team.team_id}`;
        const seriesFormat = game.series_type === 0 ? 'bo1' : game.series_type === 1 ? 'bo3' : 'bo5';

        const prev = this.trackedMatches.get(matchKey);

        // Check if series score changed (= map win)
        if (prev) {
          const radiantWon = game.radiant_series_wins > prev.radiantSeriesWins;
          const direWon = game.dire_series_wins > prev.direSeriesWins;

          if (radiantWon || direWon) {
            const winner = radiantWon ? game.radiant_team.team_name : game.dire_team.team_name;
            const loser = radiantWon ? game.dire_team.team_name : game.radiant_team.team_name;
            const winnerScore = radiantWon ? game.radiant_series_wins : game.dire_series_wins;
            const loserScore = radiantWon ? game.dire_series_wins : game.radiant_series_wins;
            const mapNumber = winnerScore + loserScore;

            const winsNeeded = seriesFormat === 'bo1' ? 1 : seriesFormat === 'bo3' ? 2 : 3;
            const isDecisive = winnerScore >= winsNeeded;

            const event: GameEvent = {
              matchId: matchKey,
              game: 'dota2',
              eventType: isDecisive ? 'series_end' : 'map_win',
              winner,
              loser,
              seriesScore: [winnerScore, loserScore],
              seriesFormat,
              isSeriesDecisive: isDecisive,
              mapNumber,
              timestamp: new Date(),
              rawData: { matchId: game.match_id, leagueId: game.league_id },
            };

            log.info('Dota 2 event detected', {
              eventType: event.eventType,
              winner,
              score: `${winnerScore}-${loserScore}`,
              matchKey,
            });

            this.emitGameEvent(event);
          }
        }

        // Update tracked state
        this.trackedMatches.set(matchKey, {
          matchId: matchKey,
          radiantTeam: game.radiant_team.team_name,
          direTeam: game.dire_team.team_name,
          radiantSeriesWins: game.radiant_series_wins,
          direSeriesWins: game.dire_series_wins,
          seriesFormat,
        });
      }

      // Clean up finished matches (not in current live games)
      const activeKeys = new Set(
        games
          .filter((g) => g.radiant_team && g.dire_team)
          .map((g) => `${g.league_id}-${g.radiant_team!.team_id}-${g.dire_team!.team_id}`),
      );
      for (const key of this.trackedMatches.keys()) {
        if (!activeKeys.has(key)) {
          this.trackedMatches.delete(key);
        }
      }
    } catch (err: any) {
      log.warn(`Dota 2 poll failed: ${err.message}`);
    }
  }

  private emitGameEvent(event: GameEvent): void {
    this.emit('gameEvent', event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('Dota 2 feed handler error', { error: err.message });
      }
    }
  }
}
