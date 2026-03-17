import { EventEmitter } from 'events';
import axios from 'axios';
import { createJobLogger } from '../../../lib/logger';
import { config } from '../../../config/env';
import type { GameEvent, GameFeed } from '../scalp-types';

const log = createJobLogger('soccer-feed');

// ESPN API endpoints (free, no auth)
const ESPN_SCOREBOARD_URL = (league: string) =>
  `https://site.api.espn.com/apis/site/v2/sports/soccer/${league}/scoreboard`;

// ─── ESPN API Response Types ───

interface EspnCompetitor {
  id: string;
  team: {
    id: string;
    displayName: string;     // e.g. "Arsenal"
    shortDisplayName: string; // e.g. "Arsenal"
    abbreviation: string;     // e.g. "ARS"
  };
  score: string; // "2"
  homeAway: 'home' | 'away';
  statistics?: Array<{
    name: string;
    displayValue: string;
  }>;
}

interface EspnStatus {
  clock: number; // seconds remaining in period (or elapsed depending on sport)
  displayClock: string; // "45:00"
  period: number; // 1 = 1H, 2 = 2H
  type: {
    id: string;
    state: 'pre' | 'in' | 'post';
    completed: boolean;
    description: string; // "Halftime", "First Half", "Second Half"
    detail: string; // "45:00 - 1st Half"
  };
}

interface EspnDetailAthlete {
  displayName: string;
  team?: { id: string };
}

interface EspnDetail {
  type: { id: string; text: string };
  clock: { value: number; displayValue: string };
  team: { id: string };
  redCard: boolean;
  yellowCard: boolean;
  athletesInvolved?: EspnDetailAthlete[];
}

interface EspnCompetition {
  id: string;
  competitors: EspnCompetitor[];
  status: EspnStatus;
  details?: EspnDetail[];
}

interface EspnEvent {
  id: string;
  name: string; // "Arsenal vs Everton"
  competitions: EspnCompetition[];
}

// ─── Internal State ───

interface TrackedMatch {
  matchId: string;
  homeTeam: string;  // ESPN display name
  awayTeam: string;
  prevHomeScore: number;
  prevAwayScore: number;
  period: string; // '1H', '2H', 'HT', 'ET'
  started: boolean;  // have we seen at least one poll with state=in
  processedDetails: Set<string>; // dedup keys for processed detail events (e.g., "1338_94")
}

export class SoccerFeed extends EventEmitter implements GameFeed {
  private running = false;
  private healthy = false;
  private handlers: ((event: GameEvent) => void)[] = [];
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private trackedMatches = new Map<string, TrackedMatch>();

  // Health tracking
  private consecutivePollFailures = 0;
  private lastSuccessfulPollAt = 0;
  private static readonly MAX_CONSECUTIVE_FAILURES = 5;

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    if (!config.SCALP_SOCCER_ENABLED) {
      log.info('Soccer feed disabled (SCALP_SOCCER_ENABLED=false)');
      return;
    }

    const leagues = config.SCALP_SOCCER_LEAGUES.split(',').map((l) => l.trim());
    log.info('Soccer feed starting', {
      leagues,
      pollInterval: config.SCALP_SOCCER_POLL_INTERVAL_MS,
    });

    // Initial poll
    await this.pollAllLeagues();

    // Start periodic polling
    this.pollTimer = setInterval(
      () => this.pollAllLeagues(),
      config.SCALP_SOCCER_POLL_INTERVAL_MS,
    );

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
    log.info('Soccer feed stopped');
  }

  onEvent(handler: (event: GameEvent) => void): void {
    this.handlers.push(handler);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  // ─── Polling ───

  private async pollAllLeagues(): Promise<void> {
    const leagues = config.SCALP_SOCCER_LEAGUES.split(',').map((l) => l.trim());
    for (const league of leagues) {
      await this.pollLeague(league);
    }
  }

  private async pollLeague(league: string): Promise<void> {
    try {
      const response = await axios.get(ESPN_SCOREBOARD_URL(league), {
        timeout: 10_000,
        headers: { Accept: 'application/json' },
      });

      const events: EspnEvent[] = response.data?.events ?? [];
      const activeMatchIds = new Set<string>();

      for (const event of events) {
        const competition = event.competitions?.[0];
        if (!competition) continue;

        const status = competition.status;
        const matchId = `soccer-${league}-${event.id}`;

        if (status.type.state === 'in') {
          // Match is in progress
          activeMatchIds.add(matchId);
          this.processLiveMatch(matchId, competition, league);
        } else if (status.type.state === 'post') {
          // Match finished — clean up
          this.trackedMatches.delete(matchId);
        }
      }

      // Clean up tracked matches no longer in the scoreboard
      for (const key of this.trackedMatches.keys()) {
        if (key.startsWith(`soccer-${league}-`) && !activeMatchIds.has(key)) {
          this.trackedMatches.delete(key);
        }
      }

      // Reset failure counter on successful poll
      this.consecutivePollFailures = 0;
      this.lastSuccessfulPollAt = Date.now();
      if (!this.healthy) {
        this.healthy = true;
        log.info('Soccer feed recovered — marking healthy');
      }

      const liveCount = activeMatchIds.size;
      if (liveCount > 0) {
        log.debug('Soccer scoreboard polled', {
          league,
          totalEvents: events.length,
          liveMatches: liveCount,
        });
      }
    } catch (err: any) {
      this.consecutivePollFailures++;
      log.warn(`Soccer scoreboard poll failed for ${league} (${this.consecutivePollFailures}/${SoccerFeed.MAX_CONSECUTIVE_FAILURES}): ${err.message}`);
      if (this.consecutivePollFailures >= SoccerFeed.MAX_CONSECUTIVE_FAILURES) {
        this.healthy = false;
        log.error('Soccer feed UNHEALTHY — poll failed too many times', {
          league,
          failures: this.consecutivePollFailures,
          lastSuccess: this.lastSuccessfulPollAt > 0
            ? `${Math.round((Date.now() - this.lastSuccessfulPollAt) / 1000)}s ago`
            : 'never',
        });
      }
    }
  }

  private processLiveMatch(
    matchId: string,
    competition: EspnCompetition,
    league: string,
  ): void {
    const homeComp = competition.competitors.find((c) => c.homeAway === 'home');
    const awayComp = competition.competitors.find((c) => c.homeAway === 'away');
    if (!homeComp || !awayComp) return;

    const homeScore = parseInt(homeComp.score, 10) || 0;
    const awayScore = parseInt(awayComp.score, 10) || 0;
    const homeTeam = homeComp.team.displayName;
    const awayTeam = awayComp.team.displayName;

    // Determine period
    const period = this.getPeriod(competition.status);

    const prev = this.trackedMatches.get(matchId);

    if (!prev) {
      // First time seeing this live match — initialize tracking
      this.trackedMatches.set(matchId, {
        matchId,
        homeTeam,
        awayTeam,
        prevHomeScore: homeScore,
        prevAwayScore: awayScore,
        period,
        started: true,
        processedDetails: new Set<string>(),
      });

      // Seed processedDetails with existing details to avoid stale red card emissions
      this.seedProcessedDetails(matchId, competition);

      log.info('Tracking live soccer match', {
        matchId,
        home: homeTeam,
        away: awayTeam,
        score: `${homeScore}-${awayScore}`,
        period,
        league,
      });
      return;
    }

    // Update period
    prev.period = period;

    // ─── Goal Detection ───
    const homeDelta = homeScore - prev.prevHomeScore;
    const awayDelta = awayScore - prev.prevAwayScore;

    if (homeDelta > 0) {
      // Home team scored
      for (let i = 0; i < homeDelta; i++) {
        this.emitGoalEvent(
          matchId,
          homeTeam,
          awayTeam,
          homeScore,
          awayScore,
          prev.prevHomeScore + i,
          prev.prevAwayScore,
          'home',
          period,
          competition.status,
        );
      }
    }

    if (awayDelta > 0) {
      // Away team scored
      for (let i = 0; i < awayDelta; i++) {
        this.emitGoalEvent(
          matchId,
          awayTeam,
          homeTeam,
          homeScore,
          awayScore,
          prev.prevHomeScore,
          prev.prevAwayScore + i,
          'away',
          period,
          competition.status,
        );
      }
    }

    // ─── Red Card Detection ───
    this.detectRedCards(matchId, competition, homeComp, awayComp, homeScore, awayScore, period);

    // Update previous scores
    prev.prevHomeScore = homeScore;
    prev.prevAwayScore = awayScore;
  }

  private emitGoalEvent(
    matchId: string,
    scoringTeam: string,
    concedingTeam: string,
    currentHomeScore: number,
    currentAwayScore: number,
    prevHomeScoreAtGoal: number,
    prevAwayScoreAtGoal: number,
    scoringSide: 'home' | 'away',
    period: string,
    status: EspnStatus,
  ): void {
    // Calculate pre-goal state for context
    const prevScorerGoals = scoringSide === 'home' ? prevHomeScoreAtGoal : prevAwayScoreAtGoal;
    const prevConcederGoals = scoringSide === 'home' ? prevAwayScoreAtGoal : prevHomeScoreAtGoal;
    const newScorerGoals = prevScorerGoals + 1;

    // Determine goal context
    const isEqualizer = newScorerGoals === prevConcederGoals;
    const wasLosing = prevScorerGoals < prevConcederGoals;
    const wasWinning = prevScorerGoals > prevConcederGoals;
    const isGoAhead = wasLosing && newScorerGoals > prevConcederGoals;
    // "isDecisiveGame" means this is a high-impact goal for probability:
    // go-ahead goals and goals that extend a lead are more impactful
    const isDecisiveGame = isGoAhead || wasWinning;

    const event: GameEvent = {
      matchId,
      game: 'soccer',
      eventType: 'goal',
      winner: scoringTeam,    // team that scored
      loser: concedingTeam,   // team that conceded
      seriesScore: [currentHomeScore, currentAwayScore],
      seriesFormat: 'bo1',
      isSeriesDecisive: false,
      mapNumber: 1, // single match
      timestamp: new Date(),
      rawData: {
        isDecisiveGame,
        period,
        matchMinute: status.displayClock,
        goalType: 'regular',
        previousScore: [prevHomeScoreAtGoal, prevAwayScoreAtGoal],
        isEqualizer,
        isGoAhead,
        wasLosing,
        wasWinning,
        scoringSide,
      },
    };

    log.info('Soccer goal detected', {
      matchId,
      scorer: scoringTeam,
      conceder: concedingTeam,
      score: `${currentHomeScore}-${currentAwayScore}`,
      period,
      minute: status.displayClock,
      isGoAhead,
      isEqualizer,
      isDecisive: isDecisiveGame,
    });

    this.emitGameEvent(event);
  }

  // ─── Red Card Helpers ───

  /** Build a dedup key for a detail event: "{clockValue}_{typeId}" */
  private detailKey(detail: EspnDetail): string {
    return `${detail.clock.value}_${detail.type.id}`;
  }

  /**
   * On first poll of a live match, seed processedDetails with all existing
   * details so we don't emit stale red cards from before we started tracking.
   */
  private seedProcessedDetails(matchId: string, competition: EspnCompetition): void {
    const tracked = this.trackedMatches.get(matchId);
    if (!tracked) return;

    const details = competition.details ?? [];
    for (const detail of details) {
      tracked.processedDetails.add(this.detailKey(detail));
    }

    const redCardCount = details.filter((d) => d.redCard).length;
    if (redCardCount > 0) {
      log.info('Seeded existing red cards (not emitting)', {
        matchId,
        redCardCount,
        totalDetails: details.length,
      });
    }
  }

  /**
   * Scan competition.details for new red cards and emit events.
   */
  private detectRedCards(
    matchId: string,
    competition: EspnCompetition,
    homeComp: EspnCompetitor,
    awayComp: EspnCompetitor,
    homeScore: number,
    awayScore: number,
    period: string,
  ): void {
    const tracked = this.trackedMatches.get(matchId);
    if (!tracked) return;

    const details = competition.details ?? [];

    for (const detail of details) {
      // Only care about red cards
      if (!detail.redCard) continue;

      const key = this.detailKey(detail);
      if (tracked.processedDetails.has(key)) continue;

      // Mark as processed
      tracked.processedDetails.add(key);

      // Determine which team got the red card via team.id
      const cardedTeamId = detail.team?.id;
      let cardedTeamName: string;
      let opposingTeamName: string;

      if (cardedTeamId === homeComp.team.id) {
        cardedTeamName = homeComp.team.displayName;
        opposingTeamName = awayComp.team.displayName;
      } else if (cardedTeamId === awayComp.team.id) {
        cardedTeamName = awayComp.team.displayName;
        opposingTeamName = homeComp.team.displayName;
      } else {
        // Unknown team ID — log and skip
        log.warn('Red card for unknown team ID', {
          matchId,
          cardedTeamId,
          homeTeamId: homeComp.team.id,
          awayTeamId: awayComp.team.id,
        });
        continue;
      }

      const playerName = detail.athletesInvolved?.[0]?.displayName ?? 'Unknown';
      const matchMinute = detail.clock?.displayValue ?? '';

      const event: GameEvent = {
        matchId,
        game: 'soccer',
        eventType: 'red_card',
        winner: opposingTeamName,    // team that benefits from the red card
        loser: cardedTeamName,       // team that got the red card (now with 10 men)
        seriesScore: [homeScore, awayScore],
        seriesFormat: 'bo1',
        isSeriesDecisive: false,
        mapNumber: 1,
        timestamp: new Date(),
        rawData: {
          isDecisiveGame: true,
          period,
          matchMinute,
          playerName,
          cardedTeam: cardedTeamName,
        },
      };

      log.info('Soccer red card detected', {
        matchId,
        player: playerName,
        cardedTeam: cardedTeamName,
        benefitingTeam: opposingTeamName,
        score: `${homeScore}-${awayScore}`,
        period,
        minute: matchMinute,
      });

      this.emitGameEvent(event);
    }
  }

  private getPeriod(status: EspnStatus): string {
    if (status.type.description?.toLowerCase().includes('halftime')) return 'HT';
    if (status.period === 1) return '1H';
    if (status.period === 2) return '2H';
    if (status.period > 2) return 'ET';
    return `P${status.period}`;
  }

  // ─── Event Emission ───

  private emitGameEvent(event: GameEvent): void {
    this.emit('gameEvent', event);
    for (const handler of this.handlers) {
      try {
        handler(event);
      } catch (err: any) {
        log.error('Soccer feed handler error', { error: err.message });
      }
    }
  }
}
