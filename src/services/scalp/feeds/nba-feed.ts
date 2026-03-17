import { EventEmitter } from 'events';
import axios from 'axios';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import { getNbaTeamName } from '../scalp-market-discovery';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('nba-feed');

// NBA CDN endpoints (free, no auth, no documented rate limit)
const NBA_SCOREBOARD_URL = 'https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json';
const NBA_PBP_URL = (gameId: string) =>
  `https://cdn.nba.com/static/json/liveData/playbyplay/playbyplay_${gameId}.json`;

// Minimum unanswered points to trigger a scoring_run event
const SCORING_RUN_THRESHOLD = 10;

// Only emit lead_change events starting from this period (Q4 = 4, OT = 5+)
const LEAD_CHANGE_MIN_PERIOD = 4;

// ─── NBA API Response Types ───

interface NbaTeam {
  teamId: number;
  teamTricode: string; // e.g. "BKN", "PHI"
  teamCity: string;
  teamName: string;
  score: number;
}

interface NbaGameScoreboard {
  gameId: string;
  gameStatus: number; // 1=pre-game, 2=in-progress, 3=final
  gameStatusText: string;
  period: number;
  gameClock: string;
  homeTeam: NbaTeam;
  awayTeam: NbaTeam;
  gameTimeUTC?: string;
}

interface NbaPlayAction {
  actionNumber: number;
  clock: string;
  period: number;
  teamTricode?: string;
  actionType: string; // "2pt", "3pt", "freethrow", "turnover", "foul", "period", etc.
  subType?: string;
  description?: string;
  scoreHome: string;
  scoreAway: string;
  isFieldGoal?: number;
  shotResult?: string; // "Made", "Missed"
  pointsTotal?: number;
}

// ─── Internal State ───

interface TrackedGame {
  gameId: string;
  homeTricode: string;
  awayTricode: string;
  homeTeamName: string; // Polymarket outcome name (e.g., "Nets")
  awayTeamName: string;
  lastActionNumber: number;
  prevLeader: 'home' | 'away' | 'tied';
  period: number;

  // Scoring run tracking
  lastScoringTeam: 'home' | 'away' | null;
  runPoints: number; // consecutive unanswered points by lastScoringTeam
  runEmittedAt: number; // timestamp of last scoring_run emission (dedupe within same run)
}

export class NbaFeed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private handlers: ((event: GameEvent) => void)[] = [];

  // Timers
  private scoreboardTimer: ReturnType<typeof setInterval> | null = null;
  private pbpTimers = new Map<string, ReturnType<typeof setInterval>>();

  // State
  private trackedGames = new Map<string, TrackedGame>();

  // Health tracking
  private consecutiveScoreboardFailures = 0;
  private lastSuccessfulPollAt = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!config.SCALP_NBA_ENABLED) {
      log.info('NBA feed disabled (SCALP_NBA_ENABLED=false)');
      return;
    }

    log.info('NBA feed starting', {
      scoreboardInterval: config.SCALP_NBA_SCOREBOARD_INTERVAL_MS,
      pbpInterval: config.SCALP_NBA_POLL_INTERVAL_MS,
    });

    // Initial scoreboard poll
    await this.pollScoreboard();

    // Start periodic scoreboard polling
    this.scoreboardTimer = setInterval(
      () => this.pollScoreboard(),
      config.SCALP_NBA_SCOREBOARD_INTERVAL_MS,
    );

    this.healthy = true;
  }

  stop(): void {
    this.running = false;
    this.healthy = false;

    if (this.scoreboardTimer) {
      clearInterval(this.scoreboardTimer);
      this.scoreboardTimer = null;
    }

    for (const timer of this.pbpTimers.values()) {
      clearInterval(timer);
    }
    this.pbpTimers.clear();
    this.trackedGames.clear();

    log.info('NBA feed stopped');
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.handlers.push(handler);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ─── Scoreboard Polling (every 30s) ───

  private async pollScoreboard(): Promise<void> {
    try {
      const response = await axios.get(NBA_SCOREBOARD_URL, {
        timeout: 10_000,
        headers: {
          'Accept': 'application/json',
          // Some NBA CDN endpoints require a Referer header
          'Referer': 'https://www.nba.com/',
        },
      });

      const games: NbaGameScoreboard[] =
        response.data?.scoreboard?.games ?? [];

      const liveGameIds = new Set<string>();

      for (const game of games) {
        if (game.gameStatus === 2) {
          // Game is in progress
          liveGameIds.add(game.gameId);

          if (!this.pbpTimers.has(game.gameId)) {
            this.startPbpPoller(game);
          }

          // Update period in tracked game
          const tracked = this.trackedGames.get(game.gameId);
          if (tracked) {
            tracked.period = game.period;
          }
        } else if (game.gameStatus === 3) {
          // Game is final — stop polling
          this.stopPbpPoller(game.gameId);
        }
      }

      // Clean up pollers for games no longer live
      for (const gameId of this.pbpTimers.keys()) {
        if (!liveGameIds.has(gameId)) {
          this.stopPbpPoller(gameId);
        }
      }

      // Reset failure counter on successful poll
      this.consecutiveScoreboardFailures = 0;
      this.lastSuccessfulPollAt = Date.now();
      if (!this.healthy) {
        this.healthy = true;
        log.info('NBA feed recovered — marking healthy');
      }

      if (games.length > 0) {
        const live = games.filter((g) => g.gameStatus === 2);
        if (live.length > 0) {
          log.debug('NBA scoreboard polled', {
            totalGames: games.length,
            liveGames: live.length,
            pollingGames: this.pbpTimers.size,
          });
        }
      }
    } catch (err: any) {
      this.consecutiveScoreboardFailures++;
      log.warn(`NBA scoreboard poll failed (${this.consecutiveScoreboardFailures}/${NbaFeed.MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
      if (this.consecutiveScoreboardFailures >= NbaFeed.MAX_CONSECUTIVE_FAILURES) {
        this.healthy = false;
        log.error('NBA feed UNHEALTHY — scoreboard poll failed too many times', {
          failures: this.consecutiveScoreboardFailures,
          lastSuccess: this.lastSuccessfulPollAt > 0
            ? `${Math.round((Date.now() - this.lastSuccessfulPollAt) / 1000)}s ago`
            : 'never',
        });
      }
    }
  }

  // ─── Play-by-Play Polling (every 5s for live games) ───

  private startPbpPoller(game: NbaGameScoreboard): void {
    const homeTeamName = getNbaTeamName(game.homeTeam.teamTricode);
    const awayTeamName = getNbaTeamName(game.awayTeam.teamTricode);

    if (!homeTeamName || !awayTeamName) {
      log.warn('Unknown NBA team tricode, skipping game', {
        gameId: game.gameId,
        home: game.homeTeam.teamTricode,
        away: game.awayTeam.teamTricode,
      });
      return;
    }

    // Determine initial leader
    const homeScore = game.homeTeam.score;
    const awayScore = game.awayTeam.score;
    let prevLeader: 'home' | 'away' | 'tied' = 'tied';
    if (homeScore > awayScore) prevLeader = 'home';
    else if (awayScore > homeScore) prevLeader = 'away';

    this.trackedGames.set(game.gameId, {
      gameId: game.gameId,
      homeTricode: game.homeTeam.teamTricode,
      awayTricode: game.awayTeam.teamTricode,
      homeTeamName,
      awayTeamName,
      lastActionNumber: 0,
      prevLeader,
      period: game.period,
      lastScoringTeam: null,
      runPoints: 0,
      runEmittedAt: 0,
    });

    log.info('Starting NBA play-by-play poller', {
      gameId: game.gameId,
      home: `${game.homeTeam.teamTricode} (${homeTeamName})`,
      away: `${game.awayTeam.teamTricode} (${awayTeamName})`,
      score: `${homeScore}-${awayScore}`,
      period: game.period,
    });

    // Poll immediately
    this.pollPlayByPlay(game.gameId);

    const timer = setInterval(
      () => this.pollPlayByPlay(game.gameId),
      config.SCALP_NBA_POLL_INTERVAL_MS,
    );
    this.pbpTimers.set(game.gameId, timer);
  }

  private stopPbpPoller(gameId: string): void {
    const timer = this.pbpTimers.get(gameId);
    if (timer) {
      clearInterval(timer);
      this.pbpTimers.delete(gameId);
    }
    this.trackedGames.delete(gameId);
  }

  private async pollPlayByPlay(gameId: string): Promise<void> {
    const tracked = this.trackedGames.get(gameId);
    if (!tracked) return;

    try {
      const response = await axios.get(NBA_PBP_URL(gameId), {
        timeout: 10_000,
        headers: {
          'Accept': 'application/json',
          'Referer': 'https://www.nba.com/',
        },
      });

      const actions: NbaPlayAction[] =
        response.data?.game?.actions ?? [];

      if (actions.length === 0) return;

      // Process only new actions since last poll
      const newActions = actions.filter(
        (a) => a.actionNumber > tracked.lastActionNumber,
      );

      if (newActions.length === 0) return;

      for (const action of newActions) {
        this.processAction(tracked, action);
      }

      // Update last processed action
      tracked.lastActionNumber = actions[actions.length - 1].actionNumber;
    } catch (err: any) {
      if (err.response?.status === 404) {
        // Play-by-play not yet available — game may not have started
        log.debug(`NBA PBP ${gameId} returned 404`);
      } else {
        log.warn(`NBA PBP poll failed: ${err.message}`, { gameId });
      }
    }
  }

  // ─── Action Processing ───

  private processAction(tracked: TrackedGame, action: NbaPlayAction): void {
    // Parse scores from the action
    const homeScore = parseInt(action.scoreHome, 10);
    const awayScore = parseInt(action.scoreAway, 10);
    if (isNaN(homeScore) || isNaN(awayScore)) return;

    // Update period from action
    if (action.period > tracked.period) {
      tracked.period = action.period;
    }

    // Determine if a scoring play happened
    const isScore = this.isScoringPlay(action);

    if (isScore && action.teamTricode) {
      const scoringTeam: 'home' | 'away' =
        action.teamTricode === tracked.homeTricode ? 'home' : 'away';

      // ─── Scoring Run Detection ───
      this.updateScoringRun(tracked, scoringTeam, homeScore, awayScore, action);
    }

    // ─── Lead Change Detection (Q4 / OT only) ───
    if (tracked.period >= LEAD_CHANGE_MIN_PERIOD) {
      let currentLeader: 'home' | 'away' | 'tied' = 'tied';
      if (homeScore > awayScore) currentLeader = 'home';
      else if (awayScore > homeScore) currentLeader = 'away';

      if (
        currentLeader !== 'tied' &&
        currentLeader !== tracked.prevLeader
      ) {
        // Lead has changed — includes tied→leading and direct lead swaps
        const newLeaderTeam = currentLeader === 'home'
          ? tracked.homeTeamName
          : tracked.awayTeamName;
        // Loser is always the team NOT currently leading
        const prevLeaderTeam = currentLeader === 'home'
          ? tracked.awayTeamName
          : tracked.homeTeamName;

        // Determine if this is a "decisive" lead change (small margin = more decisive)
        const margin = Math.abs(homeScore - awayScore);
        const isDecisive = margin <= 5; // Close game = more impactful lead change

        const event: GameEvent = {
          matchId: tracked.gameId,
          game: 'nba',
          eventType: 'lead_change',
          winner: newLeaderTeam,
          loser: prevLeaderTeam,
          seriesScore: [homeScore, awayScore],
          seriesFormat: 'bo1',
          isSeriesDecisive: false,
          mapNumber: tracked.period, // quarter/OT number
          timestamp: new Date(),
          rawData: {
            isDecisiveGame: isDecisive,
            period: tracked.period,
            homeTricode: tracked.homeTricode,
            awayTricode: tracked.awayTricode,
            margin,
            actionNumber: action.actionNumber,
            description: action.description,
          },
        };

        log.info('NBA lead change detected', {
          gameId: tracked.gameId,
          newLeader: newLeaderTeam,
          prevLeader: prevLeaderTeam,
          score: `${homeScore}-${awayScore}`,
          period: tracked.period,
          margin,
          isDecisive,
        });

        this.emitGameEvent(event);
      }

      // Update leader tracking (including transitions to/from tied)
      tracked.prevLeader = currentLeader;
    } else {
      // Pre-Q4: still track leader for when Q4 starts
      if (homeScore > awayScore) tracked.prevLeader = 'home';
      else if (awayScore > homeScore) tracked.prevLeader = 'away';
      else tracked.prevLeader = 'tied';
    }
  }

  /**
   * Check if an action is a scoring play (made field goal or free throw).
   */
  private isScoringPlay(action: NbaPlayAction): boolean {
    // Made field goals (2pt, 3pt)
    if (action.isFieldGoal === 1 && action.shotResult === 'Made') return true;

    // Made free throws
    if (
      action.actionType === 'freethrow' &&
      action.shotResult === 'Made'
    ) return true;

    return false;
  }

  /**
   * Track consecutive unanswered scoring by one team and emit scoring_run
   * when the run reaches the threshold.
   */
  private updateScoringRun(
    tracked: TrackedGame,
    scoringTeam: 'home' | 'away',
    homeScore: number,
    awayScore: number,
    action: NbaPlayAction,
  ): void {
    if (tracked.lastScoringTeam === scoringTeam) {
      // Same team keeps scoring — extend the run
      // Calculate points in this scoring play by looking at score change
      // We approximate by tracking points_total or using the action type
      const points = this.getPointsFromAction(action);
      tracked.runPoints += points;
    } else {
      // Different team scored — reset the run
      tracked.lastScoringTeam = scoringTeam;
      tracked.runPoints = this.getPointsFromAction(action);
    }

    // Emit scoring_run if threshold reached (dedupe: only emit once per run crossing)
    if (
      tracked.runPoints >= SCORING_RUN_THRESHOLD &&
      Date.now() - tracked.runEmittedAt > 30_000 // Minimum 30s between emissions
    ) {
      const runTeamName = scoringTeam === 'home'
        ? tracked.homeTeamName
        : tracked.awayTeamName;
      const otherTeamName = scoringTeam === 'home'
        ? tracked.awayTeamName
        : tracked.homeTeamName;

      // A scoring run in Q4 with a close game is more decisive
      const margin = Math.abs(homeScore - awayScore);
      const isDecisive = tracked.period >= LEAD_CHANGE_MIN_PERIOD && margin <= 10;

      const event: GameEvent = {
        matchId: tracked.gameId,
        game: 'nba',
        eventType: 'scoring_run',
        winner: runTeamName,
        loser: otherTeamName,
        seriesScore: [homeScore, awayScore],
        seriesFormat: 'bo1',
        isSeriesDecisive: false,
        mapNumber: tracked.period,
        timestamp: new Date(),
        rawData: {
          isDecisiveGame: isDecisive,
          runPoints: tracked.runPoints,
          period: tracked.period,
          homeTricode: tracked.homeTricode,
          awayTricode: tracked.awayTricode,
          margin,
          actionNumber: action.actionNumber,
          description: action.description,
        },
      };

      log.info('NBA scoring run detected', {
        gameId: tracked.gameId,
        team: runTeamName,
        runPoints: tracked.runPoints,
        score: `${homeScore}-${awayScore}`,
        period: tracked.period,
        isDecisive,
      });

      this.emitGameEvent(event);
      tracked.runEmittedAt = Date.now();
    }
  }

  /**
   * Determine how many points were scored in an action.
   */
  private getPointsFromAction(action: NbaPlayAction): number {
    if (action.actionType === '3pt' && action.shotResult === 'Made') return 3;
    if (action.actionType === '2pt' && action.shotResult === 'Made') return 2;
    if (action.actionType === 'freethrow' && action.shotResult === 'Made') return 1;
    return 0;
  }

  // ─── Event Emission ───

  private emitGameEvent(event: GameEvent): void {
    this.emit('gameEvent', event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('NBA feed handler error', { error: err.message });
      }
    }
  }
}
