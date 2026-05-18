/**
 * Polymarket Sports WebSocket Logger
 *
 * Connects to wss://sports-api.polymarket.com/ws and logs all messages
 * for EPL matches during today's games. Used to evaluate this WS as a
 * faster alternative to ESPN polling for goal detection.
 *
 * Usage:
 *   npx tsx scripts/sports-ws-logger.ts
 *   npx tsx scripts/sports-ws-logger.ts --league=epl --runtime=180
 */

import WebSocket from 'ws';
import * as fs from 'fs';
import * as path from 'path';

const args = process.argv.slice(2);
function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

const leagueFilter = getArg('league')?.toLowerCase() ?? '';  // empty = log all
const runtimeMin = parseInt(getArg('runtime') ?? '180', 10);
const logDir = path.resolve(__dirname, '..', 'logs', 'paper-mm');
const logFile = `${logDir}/sports-ws-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.jsonl`;

// Ensure log dir
fs.mkdirSync(logDir, { recursive: true });

const logStream = fs.createWriteStream(logFile, { flags: 'a' });

let totalMsgs = 0;
let filteredMsgs = 0;
let lastScore = new Map<number, string>();  // gameId -> score
let reconnects = 0;

function log(msg: string): void {
  const ts = new Date().toISOString();
  console.log(`[${ts}] ${msg}`);
}

function connect(): void {
  const ws = new WebSocket('wss://sports-api.polymarket.com/ws');

  ws.on('open', () => {
    log(`Connected to Sports WS${reconnects > 0 ? ` (reconnect #${reconnects})` : ''}`);
  });

  ws.on('message', (data: WebSocket.Data) => {
    totalMsgs++;
    const raw = data.toString();

    try {
      const parsed = JSON.parse(raw);
      const league = (parsed.leagueAbbreviation || '').toLowerCase();

      // Filter by league if specified
      if (leagueFilter && league !== leagueFilter) return;

      filteredMsgs++;

      // Write to JSONL log
      logStream.write(JSON.stringify({
        receivedAt: new Date().toISOString(),
        ...parsed,
      }) + '\n');

      // Check for score changes
      const gameId = parsed.gameId;
      const score = parsed.eventState?.score;
      const prevScore = lastScore.get(gameId);

      if (score && score !== prevScore) {
        const homeTeam = parsed.homeTeam || '?';
        const awayTeam = parsed.awayTeam || '?';
        const elapsed = parsed.eventState?.elapsed || '?';
        const period = parsed.eventState?.period || '?';

        if (prevScore) {
          log(`SCORE CHANGE: ${homeTeam} vs ${awayTeam} | ${prevScore} -> ${score} | ${elapsed}' ${period} | league=${league}`);
        } else {
          log(`TRACKING: ${homeTeam} vs ${awayTeam} | ${score} | ${elapsed}' ${period} | league=${league}`);
        }

        lastScore.set(gameId, score);
      }
    } catch {
      // Non-JSON message
    }
  });

  ws.on('close', (code: number) => {
    reconnects++;
    log(`Sports WS closed (code ${code}), reconnecting in 3s...`);
    setTimeout(connect, 3000);
  });

  ws.on('error', (err: Error) => {
    log(`Sports WS error: ${err.message}`);
  });
}

log(`Sports WS Logger starting`);
log(`League filter: ${leagueFilter || 'ALL'}`);
log(`Runtime: ${runtimeMin} minutes`);
log(`Log file: ${logFile}`);
log('');

connect();

// Stats every 60s
setInterval(() => {
  log(`STATS: total=${totalMsgs} filtered=${filteredMsgs} tracking=${lastScore.size} games reconnects=${reconnects}`);
}, 60_000);

// Auto-shutdown
setTimeout(() => {
  log(`Auto-shutdown after ${runtimeMin} minutes. Final: total=${totalMsgs} filtered=${filteredMsgs}`);
  logStream.end();
  process.exit(0);
}, runtimeMin * 60 * 1000);
