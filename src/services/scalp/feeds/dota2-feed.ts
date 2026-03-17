import { EventEmitter } from 'events';
import axios from 'axios';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('dota2-feed');

const STEAM_API_BASE = 'https://api.steampowered.com/IDOTA2Match_570/GetLiveLeagueGames/v1/';

/**
 * Count set bits in a number (tower/barracks bitmask).
 */
function popcount(n: number): number {
  let count = 0;
  let v = n;
  while (v) {
    count += v & 1;
    v >>>= 1;
  }
  return count;
}

// ─── Steam API Response Types ───

interface DotaPlayer {
  account_id: number;
  name: string;
  hero_id: number;
  level: number;
  kill_count: number;
  death_count: number;
  assists_count: number;
  last_hits: number;
  denies: number;
  gold: number;
  gold_per_min: number;
  xp_per_min: number;
  net_worth: number;
  // Items, abilities, etc. exist but we don't need them
}

interface DotaTeamScoreboard {
  score: number;
  tower_state: number;     // 11-bit bitmask: bits 0-10 for T1/T2/T3/T4 towers
  barracks_state: number;  // 6-bit bitmask: bits 0-5 for melee/ranged per lane
  players?: DotaPlayer[];
}

interface DotaScoreboard {
  duration: number;
  roshan_respawn_timer: number;  // seconds until Roshan respawns (0 = alive)
  radiant: DotaTeamScoreboard;
  dire: DotaTeamScoreboard;
}

interface DotaLiveGame {
  match_id: number;
  league_id: number;
  radiant_team?: { team_name: string; team_id: number };
  dire_team?: { team_name: string; team_id: number };
  radiant_series_wins: number;
  dire_series_wins: number;
  series_type: number; // 0=bo1, 1=bo3, 2=bo5
  scoreboard?: DotaScoreboard;
}

// ─── Internal State ───

interface TrackedMatch {
  matchId: string;
  radiantTeam: string;
  direTeam: string;
  radiantSeriesWins: number;
  direSeriesWins: number;
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
}

/**
 * Per-game in-play state tracked between polls for delta detection.
 * Keyed by match_id (the individual game, not the series).
 */
interface TrackedGameState {
  // Series context (for event emission)
  seriesKey: string;      // league_id-radiant_id-dire_id
  gameMatchId: number;    // Steam match_id for this specific game

  // Tower state (11 towers per team: T1 bot/mid/top, T2 bot/mid/top, T3 bot/mid/top, T4 top/bot)
  prevRadiantTowers: number;   // count of standing towers
  prevDireTowers: number;

  // Barracks state (6 barracks per team: melee/ranged for each of 3 lanes)
  prevRadiantBarracks: number; // count of standing barracks
  prevDireBarracks: number;

  // Roshan
  roshanAlive: boolean;

  // Gold lead (radiant net_worth - dire net_worth)
  prevGoldLead: number;

  // Game duration at last poll (to detect new game vs same game)
  prevDuration: number;
}

export class Dota2Feed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedMatches = new Map<string, TrackedMatch>();
  private gameStates = new Map<number, TrackedGameState>(); // keyed by match_id
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
    this.gameStates.clear();
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
      const activeGameMatchIds = new Set<number>();

      for (const game of games) {
        if (!game.radiant_team || !game.dire_team) continue;

        const matchKey = `${game.league_id}-${game.radiant_team.team_id}-${game.dire_team.team_id}`;
        const seriesFormat = game.series_type === 0 ? 'bo1' : game.series_type === 1 ? 'bo3' : 'bo5';

        const prev = this.trackedMatches.get(matchKey);

        // ─── Series Score Change Detection (map_win / series_end) ───
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

        // Update tracked series state
        this.trackedMatches.set(matchKey, {
          matchId: matchKey,
          radiantTeam: game.radiant_team.team_name,
          direTeam: game.dire_team.team_name,
          radiantSeriesWins: game.radiant_series_wins,
          direSeriesWins: game.dire_series_wins,
          seriesFormat,
        });

        // ─── In-Game Event Detection (scoreboard parsing) ───
        if (game.scoreboard && game.match_id) {
          activeGameMatchIds.add(game.match_id);
          this.processScoreboard(game, matchKey, seriesFormat);
        }
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

      // Clean up game states for matches no longer live
      for (const matchId of this.gameStates.keys()) {
        if (!activeGameMatchIds.has(matchId)) {
          this.gameStates.delete(matchId);
        }
      }
    } catch (err: any) {
      log.warn(`Dota 2 poll failed: ${err.message}`);
    }
  }

  /**
   * Parse the scoreboard for a live game and detect in-game events by comparing
   * with previous poll state. Emits roshan_kill, barracks_destroyed, and gold_lead_shift.
   */
  private processScoreboard(
    game: DotaLiveGame,
    seriesKey: string,
    seriesFormat: 'bo1' | 'bo3' | 'bo5',
  ): void {
    const sb = game.scoreboard!;
    const radiant = sb.radiant;
    const dire = sb.dire;
    if (!radiant || !dire) return;

    const matchId = game.match_id;
    const radiantTeam = game.radiant_team!.team_name;
    const direTeam = game.dire_team!.team_name;

    // Current tower/barracks counts from bitmasks
    const radiantTowers = popcount(radiant.tower_state ?? 0);
    const direTowers = popcount(dire.tower_state ?? 0);
    const radiantBarracks = popcount(radiant.barracks_state ?? 0);
    const direBarracks = popcount(dire.barracks_state ?? 0);

    // Sum net_worth across all players per team
    const radiantNetWorth = (radiant.players ?? []).reduce((sum, p) => sum + (p.net_worth ?? 0), 0);
    const direNetWorth = (dire.players ?? []).reduce((sum, p) => sum + (p.net_worth ?? 0), 0);
    const goldLead = radiantNetWorth - direNetWorth; // positive = radiant leads

    // Roshan state: roshan_respawn_timer > 0 means Roshan is dead (respawning)
    const roshanAlive = (sb.roshan_respawn_timer ?? 0) === 0;

    const prevState = this.gameStates.get(matchId);

    if (!prevState) {
      // First time seeing this game — initialize state, no events to emit
      this.gameStates.set(matchId, {
        seriesKey,
        gameMatchId: matchId,
        prevRadiantTowers: radiantTowers,
        prevDireTowers: direTowers,
        prevRadiantBarracks: radiantBarracks,
        prevDireBarracks: direBarracks,
        roshanAlive,
        prevGoldLead: goldLead,
        prevDuration: sb.duration,
      });
      return;
    }

    // If duration jumped backwards or reset to near-zero, this is a new game in the series
    // under the same match_id slot — reset state
    if (sb.duration < prevState.prevDuration - 30) {
      this.gameStates.set(matchId, {
        seriesKey,
        gameMatchId: matchId,
        prevRadiantTowers: radiantTowers,
        prevDireTowers: direTowers,
        prevRadiantBarracks: radiantBarracks,
        prevDireBarracks: direBarracks,
        roshanAlive,
        prevGoldLead: goldLead,
        prevDuration: sb.duration,
      });
      return;
    }

    // Compute series context for isDecisiveGame
    const match = this.trackedMatches.get(seriesKey);
    const winsNeeded = seriesFormat === 'bo1' ? 1 : seriesFormat === 'bo3' ? 2 : 3;
    const isDecisiveGame = match
      ? match.radiantSeriesWins === winsNeeded - 1 && match.direSeriesWins === winsNeeded - 1
      : false;
    const radiantSeriesWins = match?.radiantSeriesWins ?? 0;
    const direSeriesWins = match?.direSeriesWins ?? 0;

    // ─── Roshan Kill Detection ───
    // Roshan was alive last poll but is now dead (respawn timer started)
    if (prevState.roshanAlive && !roshanAlive) {
      // Determine which team killed Roshan: the team with the gold lead is the likely killer.
      // This is a heuristic — the Steam API doesn't explicitly say who killed Rosh.
      // Gold lead + recent gold swing is the best signal available.
      const killer = goldLead >= 0 ? radiantTeam : direTeam;
      const victim = goldLead >= 0 ? direTeam : radiantTeam;
      const winnerScore = goldLead >= 0 ? radiantSeriesWins : direSeriesWins;
      const loserScore = goldLead >= 0 ? direSeriesWins : radiantSeriesWins;

      const event: GameEvent = {
        matchId: seriesKey,
        game: 'dota2',
        eventType: 'roshan_kill',
        winner: killer,
        loser: victim,
        seriesScore: [winnerScore, loserScore],
        seriesFormat,
        isSeriesDecisive: false,
        mapNumber: radiantSeriesWins + direSeriesWins + 1,
        timestamp: new Date(),
        rawData: {
          matchId: game.match_id,
          leagueId: game.league_id,
          isDecisiveGame,
          roshanRespawnTimer: sb.roshan_respawn_timer,
          goldLead,
          gameDuration: sb.duration,
        },
      };

      log.info('Dota 2 Roshan killed', {
        killer,
        goldLead,
        duration: Math.round(sb.duration),
        matchKey: seriesKey,
      });

      this.emitGameEvent(event);
    }

    // ─── Barracks Destroyed Detection ───
    // Barracks count decreased for a team = the enemy destroyed one
    if (radiantBarracks < prevState.prevRadiantBarracks) {
      // Radiant lost barracks → Dire destroyed them
      const destroyed = prevState.prevRadiantBarracks - radiantBarracks;

      const event: GameEvent = {
        matchId: seriesKey,
        game: 'dota2',
        eventType: 'barracks_destroyed',
        winner: direTeam,  // Dire destroyed radiant's barracks
        loser: radiantTeam,
        seriesScore: [direSeriesWins, radiantSeriesWins],
        seriesFormat,
        isSeriesDecisive: false,
        mapNumber: radiantSeriesWins + direSeriesWins + 1,
        timestamp: new Date(),
        rawData: {
          matchId: game.match_id,
          leagueId: game.league_id,
          isDecisiveGame,
          destroyedCount: destroyed,
          remainingBarracks: radiantBarracks,
          isMegaCreeps: radiantBarracks === 0,
          goldLead,
          gameDuration: sb.duration,
        },
      };

      log.info('Dota 2 barracks destroyed', {
        attacker: direTeam,
        defender: radiantTeam,
        destroyed,
        remaining: radiantBarracks,
        mega: radiantBarracks === 0,
        matchKey: seriesKey,
      });

      this.emitGameEvent(event);
    }

    if (direBarracks < prevState.prevDireBarracks) {
      // Dire lost barracks → Radiant destroyed them
      const destroyed = prevState.prevDireBarracks - direBarracks;

      const event: GameEvent = {
        matchId: seriesKey,
        game: 'dota2',
        eventType: 'barracks_destroyed',
        winner: radiantTeam,  // Radiant destroyed dire's barracks
        loser: direTeam,
        seriesScore: [radiantSeriesWins, direSeriesWins],
        seriesFormat,
        isSeriesDecisive: false,
        mapNumber: radiantSeriesWins + direSeriesWins + 1,
        timestamp: new Date(),
        rawData: {
          matchId: game.match_id,
          leagueId: game.league_id,
          isDecisiveGame,
          destroyedCount: destroyed,
          remainingBarracks: direBarracks,
          isMegaCreeps: direBarracks === 0,
          goldLead,
          gameDuration: sb.duration,
        },
      };

      log.info('Dota 2 barracks destroyed', {
        attacker: radiantTeam,
        defender: direTeam,
        destroyed,
        remaining: direBarracks,
        mega: direBarracks === 0,
        matchKey: seriesKey,
      });

      this.emitGameEvent(event);
    }

    // ─── Tower Kill Logging (informational, no separate event type) ───
    if (radiantTowers < prevState.prevRadiantTowers) {
      const lost = prevState.prevRadiantTowers - radiantTowers;
      log.debug('Dota 2 tower destroyed', {
        attacker: direTeam,
        defender: radiantTeam,
        towersLost: lost,
        remaining: radiantTowers,
        matchKey: seriesKey,
      });
    }
    if (direTowers < prevState.prevDireTowers) {
      const lost = prevState.prevDireTowers - direTowers;
      log.debug('Dota 2 tower destroyed', {
        attacker: radiantTeam,
        defender: direTeam,
        towersLost: lost,
        remaining: direTowers,
        matchKey: seriesKey,
      });
    }

    // ─── Gold Lead Shift Detection ───
    // Emit when the gold lead swings by >= 5000 gold since last poll
    const goldSwing = goldLead - prevState.prevGoldLead;
    if (Math.abs(goldSwing) >= 5000) {
      // The team that gained gold is the "winner" of this swing
      const gainer = goldSwing > 0 ? radiantTeam : direTeam;
      const loser = goldSwing > 0 ? direTeam : radiantTeam;
      const winnerScore = goldSwing > 0 ? radiantSeriesWins : direSeriesWins;
      const loserScore = goldSwing > 0 ? direSeriesWins : radiantSeriesWins;

      const event: GameEvent = {
        matchId: seriesKey,
        game: 'dota2',
        eventType: 'gold_lead_shift',
        winner: gainer,
        loser,
        seriesScore: [winnerScore, loserScore],
        seriesFormat,
        isSeriesDecisive: false,
        mapNumber: radiantSeriesWins + direSeriesWins + 1,
        timestamp: new Date(),
        rawData: {
          matchId: game.match_id,
          leagueId: game.league_id,
          isDecisiveGame,
          goldSwing,
          newGoldLead: goldLead,
          prevGoldLead: prevState.prevGoldLead,
          radiantNetWorth,
          direNetWorth,
          gameDuration: sb.duration,
        },
      };

      log.info('Dota 2 gold lead shift', {
        gainer,
        swing: goldSwing,
        newLead: goldLead,
        duration: Math.round(sb.duration),
        matchKey: seriesKey,
      });

      this.emitGameEvent(event);
    }

    // ─── Update Tracked State ───
    prevState.prevRadiantTowers = radiantTowers;
    prevState.prevDireTowers = direTowers;
    prevState.prevRadiantBarracks = radiantBarracks;
    prevState.prevDireBarracks = direBarracks;
    prevState.roshanAlive = roshanAlive;
    prevState.prevGoldLead = goldLead;
    prevState.prevDuration = sb.duration;
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
