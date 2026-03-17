/**
 * Scalp MM Paper Results Analyzer
 *
 * Parses paper MM log files and produces a structured report.
 *
 * Usage:
 *   npx tsx src/scripts/scalp-mm-analyze.ts logs/paper-mm/epl-mun-ast-2026-03-15-2026-03-15.log
 *   npx tsx src/scripts/scalp-mm-analyze.ts logs/paper-mm/*.log
 */

import * as fs from 'fs';

const logFiles = process.argv.slice(2);

if (logFiles.length === 0) {
  console.error('Usage: npx tsx src/scripts/scalp-mm-analyze.ts <logfile> [logfile2] ...');
  process.exit(1);
}

interface MatchResult {
  file: string;
  event: string;
  config: Record<string, any>;
  totalTradesReceived: number;
  markets: Record<string, MarketResult>;
  duration: string;
  errors: string[];
  gameEvents: string[];
}

interface MarketResult {
  label: string;
  tradesProcessed: number;
  totalFills: number;
  bidFills: number;
  askFills: number;
  roundTrips: number;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  finalPosition: number;
  avgSpreadCapture: number;
  fillRate: number;
  roundTripRate: number;
}

function analyzeLogFile(filePath: string): MatchResult {
  const content = fs.readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');

  const result: MatchResult = {
    file: filePath,
    event: '',
    config: {},
    totalTradesReceived: 0,
    markets: {},
    duration: '',
    errors: [],
    gameEvents: [],
  };

  // Try to find JSON_SUMMARY line first (most reliable)
  for (const line of lines) {
    const jsonIdx = line.indexOf('JSON_SUMMARY:');
    if (jsonIdx !== -1) {
      try {
        const jsonStr = line.substring(jsonIdx + 'JSON_SUMMARY:'.length);
        const summary = JSON.parse(jsonStr);
        result.event = summary.event || '';
        result.config = summary.config || {};
        result.totalTradesReceived = summary.totalTradesReceived || 0;

        for (const [label, data] of Object.entries(summary.markets || {})) {
          const m = data as any;
          result.markets[label] = {
            label,
            tradesProcessed: m.tradesProcessed || 0,
            totalFills: m.totalFills || 0,
            bidFills: m.bidFills || 0,
            askFills: m.askFills || 0,
            roundTrips: m.roundTrips || 0,
            realizedPnl: m.realizedPnl || 0,
            unrealizedPnl: m.unrealizedPnl || 0,
            totalPnl: m.totalPnl || 0,
            finalPosition: m.finalPosition || 0,
            avgSpreadCapture: m.avgSpreadCapture || 0,
            fillRate: m.fillRate || 0,
            roundTripRate: m.roundTripRate || 0,
          };
        }
        break;
      } catch {
        // Fall through to line-by-line parsing
      }
    }
  }

  // Parse fills, events, errors from log lines
  let fillCount = 0;
  let firstTs = '';
  let lastTs = '';

  for (const line of lines) {
    // Extract timestamp
    const tsMatch = line.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    if (tsMatch) {
      if (!firstTs) firstTs = tsMatch[1];
      lastTs = tsMatch[1];
    }

    // Count fills
    if (line.includes('FILL BID') || line.includes('FILL ASK')) {
      fillCount++;
    }

    // Game events
    if (line.includes('EVENT ') && (line.includes('quotes CANCELLED') || line.includes('already paused'))) {
      result.gameEvents.push(line.trim());
    }

    // Errors
    if (line.includes('error') || line.includes('Error') || line.includes('STALE') || line.includes('reconnect')) {
      result.errors.push(line.trim());
    }

    // Event name
    if (line.includes('Event:') && !result.event) {
      const eventMatch = line.match(/Event:\s*(\S+)/);
      if (eventMatch) result.event = eventMatch[1];
    }
  }

  if (firstTs && lastTs) {
    result.duration = `${firstTs} - ${lastTs}`;
  }

  return result;
}

function printReport(results: MatchResult[]): void {
  console.log('='.repeat(80));
  console.log('SCALP MARKET MAKER — PAPER TRADING REPORT');
  console.log(`Generated: ${new Date().toISOString()}`);
  console.log('='.repeat(80));
  console.log('');

  let totalRealizedPnl = 0;
  let totalUnrealizedPnl = 0;
  let totalFills = 0;
  let totalRoundTrips = 0;

  for (const r of results) {
    console.log('-'.repeat(60));
    console.log(`Match: ${r.event}`);
    console.log(`Duration: ${r.duration}`);
    console.log(`CLOB trades received: ${r.totalTradesReceived}`);
    console.log(`Config: ${JSON.stringify(r.config)}`);
    console.log('');

    for (const [label, m] of Object.entries(r.markets)) {
      console.log(`  ${label}:`);
      console.log(`    Trades processed: ${m.tradesProcessed}`);
      console.log(`    Fills: ${m.totalFills} (${m.bidFills} bids, ${m.askFills} asks)`);
      console.log(`    Round trips: ${m.roundTrips}`);
      console.log(`    Realized PnL: ${m.realizedPnl >= 0 ? '+' : ''}$${m.realizedPnl.toFixed(2)}`);
      console.log(`    Unrealized PnL: ${m.unrealizedPnl >= 0 ? '+' : ''}$${m.unrealizedPnl.toFixed(2)}`);
      console.log(`    Total PnL: ${m.totalPnl >= 0 ? '+' : ''}$${m.totalPnl.toFixed(2)}`);
      console.log(`    Final position: ${m.finalPosition} shares`);
      if (m.roundTrips > 0) {
        console.log(`    Avg spread capture: $${m.avgSpreadCapture.toFixed(3)}/RT`);
      }
      console.log(`    Fill rate: ${m.fillRate.toFixed(1)}/hr`);
      console.log(`    RT rate: ${m.roundTripRate.toFixed(1)}/hr`);
      console.log('');

      totalRealizedPnl += m.realizedPnl;
      totalUnrealizedPnl += m.unrealizedPnl;
      totalFills += m.totalFills;
      totalRoundTrips += m.roundTrips;
    }

    if (r.gameEvents.length > 0) {
      console.log(`  Game events detected: ${r.gameEvents.length}`);
      for (const e of r.gameEvents.slice(0, 5)) {
        console.log(`    ${e}`);
      }
      console.log('');
    }

    if (r.errors.length > 0) {
      console.log(`  Errors/warnings: ${r.errors.length}`);
      for (const e of r.errors.slice(0, 5)) {
        console.log(`    ${e}`);
      }
      console.log('');
    }
  }

  console.log('='.repeat(80));
  console.log('AGGREGATE SUMMARY');
  console.log('='.repeat(80));
  console.log(`  Matches analyzed: ${results.length}`);
  console.log(`  Total fills: ${totalFills}`);
  console.log(`  Total round trips: ${totalRoundTrips}`);
  console.log(`  Total realized PnL: ${totalRealizedPnl >= 0 ? '+' : ''}$${totalRealizedPnl.toFixed(2)}`);
  console.log(`  Total unrealized PnL: ${totalUnrealizedPnl >= 0 ? '+' : ''}$${totalUnrealizedPnl.toFixed(2)}`);
  const grandTotal = totalRealizedPnl + totalUnrealizedPnl;
  console.log(`  Grand total PnL: ${grandTotal >= 0 ? '+' : ''}$${grandTotal.toFixed(2)}`);
  if (totalRoundTrips > 0) {
    console.log(`  Avg PnL per RT: $${(totalRealizedPnl / totalRoundTrips).toFixed(3)}`);
  }
  console.log('');
}

// Main
const results = logFiles.map(analyzeLogFile);
printReport(results);
