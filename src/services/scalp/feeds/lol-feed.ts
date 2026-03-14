import { EventEmitter } from 'events';
import axios from 'axios';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('lol-feed');

// LoL Esports API endpoints (undocumented but stable, powers lolesports.com)
const LOL_ESPORTS_API = 'https://esports-api.lolesports.com/persisted/gw';
const LOL_LIVE_STATS_API = 'https://feed.lolesports.com/livestats/v1';
// Public gateway key embedded in lolesports.com frontend — not a secret
const LOL_API_KEY = config.SCALP_LOL_API_KEY || '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z';
const UNHEALTHY_AFTER_FAILURES = 3;

// ─── API Response Types ───

interface LolTeamResult {
  gameWins: number;
}

interface LolTeam {
  name: string;
  code: string;
  image?: string;
  result: LolTeamResult | null;
}

interface LolGame {
  id: string;
  number: number;
  state: string; // 'unstarted' | 'in_game' | 'paused' | 'finished'
}

interface LolMatch {
  id: string;
  teams: LolTeam[];
  strategy: { type: string; count: number };
}

interface LolScheduleEvent {
  id: string;
  type?: string; // 'match' | 'show'
  match: LolMatch;
  games: LolGame[];
  league: { name: string; slug: string };
}

interface LolFrameTeam {
  totalGold: number;
  inhibitors: number;
  towers: number;
  barons: number;
  totalKills: number;
  dragons: string[]; // ["ocean", "mountain", "infernal", "elder", ...]
}

interface LolFrame {
  rfc460Timestamp: string;
  gameState: string; // 'in_game' | 'finished' | 'paused'
  blueTeam: LolFrameTeam;
  redTeam: LolFrameTeam;
}

interface LolTeamMetadata {
  esportsTeamId: string;
  participantMetadata: { participantId: number; summonerName: string; championId: string; role: string }[];
}

interface LolWindowResponse {
  gameMetadata: {
    blueTeamMetadata: LolTeamMetadata;
    redTeamMetadata: LolTeamMetadata;
  };
  frames: LolFrame[];
}

// ─── Internal State ───

interface TrackedMatch {
  matchId: string;
  team1Name: string;
  team2Name: string;
  team1Code: string;
  team2Code: string;
  team1Wins: number;
  team2Wins: number;
  seriesFormat: 'bo1' | 'bo3' | 'bo5';
  activeGameIds: Set<string>;
  leagueName: string;
}

interface TrackedGameState {
  gameId: string;
  matchId: string;
  gameNumber: number;
  blueTeamName: string | null; // resolved from team ID mapping
  redTeamName: string | null;
  blueTeamId: string;
  redTeamId: string;
  blueBarons: number;
  redBarons: number;
  blueDragons: string[];
  redDragons: string[];
  blueGold: number;
  redGold: number;
  gameState: string;
  metadataResolved: boolean;
}

export class LolFeed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private handlers: ((event: GameEvent) => void)[] = [];
  private consecutiveDiscoveryFailures = 0;

  // Timers
  private discoveryTimer: ReturnType<typeof setInterval> | null = null;
  private gameTimers = new Map<string, ReturnType<typeof setInterval>>();

  // State
  private trackedMatches = new Map<string, TrackedMatch>();
  private gameStates = new Map<string, TrackedGameState>();

  // Team esportsTeamId → full team name (populated from getLive + window cross-reference)
  private teamIdToName = new Map<string, string>();

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    log.info('LoL feed starting', {
      pollInterval: config.SCALP_LOL_POLL_INTERVAL_MS,
      discoveryInterval: config.SCALP_LOL_DISCOVERY_INTERVAL_MS,
    });

    // Initial discovery
    await this.discoverLiveMatches();

    // Periodic match discovery
    this.discoveryTimer = setInterval(
      () => this.discoverLiveMatches(),
      config.SCALP_LOL_DISCOVERY_INTERVAL_MS,
    );

    this.healthy = true;
  }

  stop(): void {
    this.running = false;
    this.healthy = false;
    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = null;
    }
    for (const timer of this.gameTimers.values()) {
      clearInterval(timer);
    }
    this.gameTimers.clear();
    this.trackedMatches.clear();
    this.gameStates.clear();
    this.teamIdToName.clear();
    log.info('LoL feed stopped');
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.handlers.push(handler);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ─── Match Discovery (every 30s) ───

  private async discoverLiveMatches(): Promise<void> {
    try {
      const response = await axios.get(`${LOL_ESPORTS_API}/getLive`, {
        params: { hl: 'en-US' },
        headers: { 'x-api-key': LOL_API_KEY },
        timeout: 10_000,
      });

      const events: LolScheduleEvent[] = response.data?.data?.schedule?.events ?? [];

      const activeMatchIds = new Set<string>();
      const activeGameIds = new Set<string>();

      for (const event of events) {
        // Only process actual matches, not broadcast "show" wrappers
        if (event.type && event.type !== 'match') continue;

        const match = event.match;
        if (!match?.teams || match.teams.length < 2) continue;

        const team1 = match.teams[0];
        const team2 = match.teams[1];
        const seriesCount = match.strategy?.count ?? 1;
        const seriesFormat: 'bo1' | 'bo3' | 'bo5' =
          seriesCount <= 1 ? 'bo1' : seriesCount <= 3 ? 'bo3' : 'bo5';

        const matchId = match.id;
        activeMatchIds.add(matchId);

        const team1Wins = team1.result?.gameWins ?? 0;
        const team2Wins = team2.result?.gameWins ?? 0;

        // Detect series score changes (= a game ended)
        const prev = this.trackedMatches.get(matchId);
        if (prev) {
          const team1WonGame = team1Wins > prev.team1Wins;
          const team2WonGame = team2Wins > prev.team2Wins;

          if (team1WonGame || team2WonGame) {
            const winner = team1WonGame ? team1.name : team2.name;
            const loser = team1WonGame ? team2.name : team1.name;
            const winnerScore = team1WonGame ? team1Wins : team2Wins;
            const loserScore = team1WonGame ? team2Wins : team1Wins;
            const mapNumber = team1Wins + team2Wins;
            const winsNeeded = seriesFormat === 'bo1' ? 1 : seriesFormat === 'bo3' ? 2 : 3;
            const isDecisive = winnerScore >= winsNeeded;

            const gameEvent: GameEvent = {
              matchId,
              game: 'lol',
              eventType: isDecisive ? 'series_end' : 'map_win',
              winner,
              loser,
              seriesScore: [winnerScore, loserScore],
              seriesFormat,
              isSeriesDecisive: isDecisive,
              mapNumber,
              timestamp: new Date(),
              rawData: { league: event.league?.name },
            };

            log.info('LoL game ended', {
              eventType: gameEvent.eventType,
              winner,
              score: `${winnerScore}-${loserScore}`,
              league: event.league?.name,
            });

            this.emitGameEvent(gameEvent);
          }
        }

        // Update tracked match
        const matchActiveGames = new Set<string>();
        for (const game of event.games ?? []) {
          if (game.state === 'in_game') {
            matchActiveGames.add(game.id);
            activeGameIds.add(game.id);

            // Start polling this game if not already
            if (!this.gameTimers.has(game.id)) {
              this.startGamePoller(game.id, matchId, game.number, team1.name, team2.name);
            }
          }
        }

        this.trackedMatches.set(matchId, {
          matchId,
          team1Name: team1.name,
          team2Name: team2.name,
          team1Code: team1.code,
          team2Code: team2.code,
          team1Wins,
          team2Wins,
          seriesFormat,
          activeGameIds: matchActiveGames,
          leagueName: event.league?.name ?? '',
        });
      }

      // Stop polling games that are no longer active
      for (const gameId of this.gameTimers.keys()) {
        if (!activeGameIds.has(gameId)) {
          clearInterval(this.gameTimers.get(gameId)!);
          this.gameTimers.delete(gameId);
          this.gameStates.delete(gameId);
        }
      }

      // Clean up finished matches
      for (const key of this.trackedMatches.keys()) {
        if (!activeMatchIds.has(key)) {
          this.trackedMatches.delete(key);
        }
      }

      this.consecutiveDiscoveryFailures = 0;
      if (!this.healthy && this.running) this.healthy = true;

      if (events.length > 0 || this.trackedMatches.size > 0) {
        log.debug('LoL match discovery', {
          liveEvents: events.length,
          trackedMatches: this.trackedMatches.size,
          activeGames: activeGameIds.size,
          pollingGames: this.gameTimers.size,
        });
      }
    } catch (err: any) {
      this.consecutiveDiscoveryFailures++;
      if (err.response?.status === 403) {
        log.warn('LoL esports API returned 403 — API key may be invalid');
        this.healthy = false;
      } else {
        log.warn(`LoL match discovery failed: ${err.message}`);
        if (this.consecutiveDiscoveryFailures >= UNHEALTHY_AFTER_FAILURES) {
          this.healthy = false;
        }
      }
    }
  }

  // ─── Per-Game Live Stats Polling ───

  private startGamePoller(
    gameId: string,
    matchId: string,
    gameNumber: number,
    team1Name: string,
    team2Name: string,
  ): void {
    log.info('Starting LoL game poller', { gameId: gameId.slice(0, 20), matchId, gameNumber });

    this.gameStates.set(gameId, {
      gameId,
      matchId,
      gameNumber,
      blueTeamName: null,
      redTeamName: null,
      blueTeamId: '',
      redTeamId: '',
      blueBarons: 0,
      redBarons: 0,
      blueDragons: [],
      redDragons: [],
      blueGold: 0,
      redGold: 0,
      gameState: 'in_game',
      metadataResolved: false,
    });

    // Poll immediately, then on interval
    this.pollGameState(gameId, team1Name, team2Name);

    const timer = setInterval(
      () => this.pollGameState(gameId, team1Name, team2Name),
      config.SCALP_LOL_POLL_INTERVAL_MS,
    );
    this.gameTimers.set(gameId, timer);
  }

  private async pollGameState(gameId: string, team1Name: string, team2Name: string): Promise<void> {
    const state = this.gameStates.get(gameId);
    if (!state) return;

    try {
      const response = await axios.get<LolWindowResponse>(
        `${LOL_LIVE_STATS_API}/window/${gameId}`,
        { timeout: 10_000 },
      );

      const data = response.data;
      if (!data?.frames?.length) return;

      // Resolve blue/red → team name mapping on first successful poll
      if (!state.metadataResolved && data.gameMetadata) {
        const blueId = data.gameMetadata.blueTeamMetadata?.esportsTeamId ?? '';
        const redId = data.gameMetadata.redTeamMetadata?.esportsTeamId ?? '';
        state.blueTeamId = blueId;
        state.redTeamId = redId;

        // Try to resolve via cached team ID mapping
        if (this.teamIdToName.has(blueId)) {
          state.blueTeamName = this.teamIdToName.get(blueId)!;
          state.redTeamName = this.teamIdToName.get(redId) ?? null;
        } else if (this.teamIdToName.has(redId)) {
          state.redTeamName = this.teamIdToName.get(redId)!;
          state.blueTeamName = this.teamIdToName.get(blueId) ?? null;
        } else {
          // Cross-reference with participant names to identify teams.
          // Approach: fetch /details for player data, but for MVP just use
          // the team order from getLive and try to correlate.
          // We'll resolve lazily via tryResolveTeamMapping.
          this.tryResolveTeamMapping(state, data.gameMetadata, team1Name, team2Name);
        }

        if (state.blueTeamName && state.redTeamName) {
          state.metadataResolved = true;
          log.info('LoL game team mapping resolved', {
            gameId: gameId.slice(0, 20),
            blue: state.blueTeamName,
            red: state.redTeamName,
          });
        }
      }

      const latestFrame = data.frames[data.frames.length - 1];

      // Game end detection (fast path — complement to getLive series score detection)
      if (latestFrame.gameState === 'finished' && state.gameState === 'in_game') {
        state.gameState = 'finished';
        log.info('LoL game finished via live stats', { gameId: gameId.slice(0, 20) });

        // Stop polling — getLive will handle the definitive series score change
        const timer = this.gameTimers.get(gameId);
        if (timer) {
          clearInterval(timer);
          this.gameTimers.delete(gameId);
        }
        return;
      }

      const blue = latestFrame.blueTeam;
      const red = latestFrame.redTeam;
      if (!blue || !red) return;

      // ─── In-Game Event Detection ───

      // Baron Nashor detection
      if (blue.barons > state.blueBarons) {
        this.onObjectiveKill(state, 'blue', 'baron_kill', blue.barons);
      }
      if (red.barons > state.redBarons) {
        this.onObjectiveKill(state, 'red', 'baron_kill', red.barons);
      }

      // Elder Dragon detection
      const blueElderCount = blue.dragons.filter((d) => d === 'elder').length;
      const prevBlueElderCount = state.blueDragons.filter((d) => d === 'elder').length;
      if (blueElderCount > prevBlueElderCount) {
        this.onObjectiveKill(state, 'blue', 'elder_dragon', blueElderCount);
      }

      const redElderCount = red.dragons.filter((d) => d === 'elder').length;
      const prevRedElderCount = state.redDragons.filter((d) => d === 'elder').length;
      if (redElderCount > prevRedElderCount) {
        this.onObjectiveKill(state, 'red', 'elder_dragon', redElderCount);
      }

      // Update tracked state
      state.blueBarons = blue.barons;
      state.redBarons = red.barons;
      state.blueDragons = [...blue.dragons];
      state.redDragons = [...red.dragons];
      state.blueGold = blue.totalGold;
      state.redGold = red.totalGold;
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Game not yet available or already ended — not an error
        log.debug(`LoL game ${gameId.slice(0, 20)} returned 404`);
      } else {
        log.warn(`LoL game poll failed: ${err.message}`, { gameId: gameId.slice(0, 20) });
      }
    }
  }

  // ─── Team Mapping ───

  /**
   * Try to resolve which team is blue/red by cross-referencing metadata.
   * The window API returns esportsTeamId for each side. If we can correlate
   * those IDs with team names from getLive, we know the mapping.
   *
   * Fallback: use participant metadata to identify players (not implemented in MVP).
   * If resolution fails, in-game events are skipped (conservative — no bad trades).
   */
  private tryResolveTeamMapping(
    state: TrackedGameState,
    metadata: LolWindowResponse['gameMetadata'],
    team1Name: string,
    team2Name: string,
  ): void {
    const blueId = metadata.blueTeamMetadata?.esportsTeamId ?? '';
    const redId = metadata.redTeamMetadata?.esportsTeamId ?? '';

    // If we have no IDs, we can't resolve
    if (!blueId || !redId) return;

    // Check if we've seen these IDs before in other games of the same match
    if (this.teamIdToName.has(blueId)) {
      state.blueTeamName = this.teamIdToName.get(blueId)!;
    }
    if (this.teamIdToName.has(redId)) {
      state.redTeamName = this.teamIdToName.get(redId)!;
    }

    // If one side is resolved, the other is the remaining team
    if (state.blueTeamName && !state.redTeamName) {
      state.redTeamName = state.blueTeamName === team1Name ? team2Name : team1Name;
      this.teamIdToName.set(redId, state.redTeamName);
    } else if (!state.blueTeamName && state.redTeamName) {
      state.blueTeamName = state.redTeamName === team1Name ? team2Name : team1Name;
      this.teamIdToName.set(blueId, state.blueTeamName);
    }

    // If neither side resolved and this is the first game we've seen for this match,
    // try fetching the schedule endpoint for team IDs.
    // For MVP: we attempt a single getEventDetails call to get the mapping.
    if (!state.blueTeamName && !state.redTeamName) {
      this.fetchTeamIdMapping(blueId, redId, team1Name, team2Name, state);
    }
  }

  /**
   * Fetch team schedule data to build esportsTeamId → name mapping.
   * Uses the getSchedule endpoint which includes team IDs.
   */
  private async fetchTeamIdMapping(
    blueId: string,
    redId: string,
    team1Name: string,
    team2Name: string,
    state: TrackedGameState,
  ): Promise<void> {
    try {
      // Try getTeams endpoint with both IDs
      const response = await axios.get(`${LOL_ESPORTS_API}/getTeams`, {
        params: { hl: 'en-US', id: `${blueId},${redId}` },
        headers: { 'x-api-key': LOL_API_KEY },
        timeout: 10_000,
      });

      const teams: { id: string; name: string; code: string }[] =
        response.data?.data?.teams ?? [];

      for (const team of teams) {
        this.teamIdToName.set(team.id, team.name);
        if (team.id === blueId) state.blueTeamName = team.name;
        if (team.id === redId) state.redTeamName = team.name;
      }

      if (state.blueTeamName && state.redTeamName) {
        log.info('Resolved team IDs via getTeams', {
          blue: state.blueTeamName,
          red: state.redTeamName,
        });
      }
    } catch (err: any) {
      log.debug('getTeams call failed, team mapping incomplete', { error: err.message });
      // No fallback — better to skip in-game events than to trade the wrong direction.
    }
  }

  // ─── Event Emission ───

  private onObjectiveKill(
    state: TrackedGameState,
    side: 'blue' | 'red',
    eventType: 'baron_kill' | 'elder_dragon',
    count: number,
  ): void {
    const winnerName = side === 'blue' ? state.blueTeamName : state.redTeamName;
    const loserName = side === 'blue' ? state.redTeamName : state.blueTeamName;

    if (!winnerName || !loserName) {
      log.debug(`Skipping ${eventType} — team mapping not resolved`, {
        gameId: state.gameId.slice(0, 20),
        side,
      });
      return;
    }

    const match = this.trackedMatches.get(state.matchId);
    if (!match) return;

    const winsNeeded = match.seriesFormat === 'bo1' ? 1 : match.seriesFormat === 'bo3' ? 2 : 3;
    const isDecisiveGame =
      match.team1Wins === winsNeeded - 1 && match.team2Wins === winsNeeded - 1;

    const winnerScore = winnerName === match.team1Name ? match.team1Wins : match.team2Wins;
    const loserScore = winnerName === match.team1Name ? match.team2Wins : match.team1Wins;

    const event: GameEvent = {
      matchId: match.matchId,
      game: 'lol',
      eventType,
      winner: winnerName,
      loser: loserName,
      seriesScore: [winnerScore, loserScore],
      seriesFormat: match.seriesFormat,
      isSeriesDecisive: false,
      mapNumber: state.gameNumber,
      timestamp: new Date(),
      rawData: {
        objectiveCount: count,
        side,
        league: match.leagueName,
        isDecisiveGame,
        blueGold: state.blueGold,
        redGold: state.redGold,
        goldDiff: state.blueGold - state.redGold,
      },
    };

    log.info(`LoL ${eventType} detected`, {
      winner: winnerName,
      game: state.gameNumber,
      count,
      league: match.leagueName,
      goldDiff: state.blueGold - state.redGold,
    });

    this.emitGameEvent(event);
  }

  private emitGameEvent(event: GameEvent): void {
    this.emit('gameEvent', event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('LoL feed handler error', { error: err.message });
      }
    }
  }
}
