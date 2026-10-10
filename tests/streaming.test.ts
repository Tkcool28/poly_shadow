import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readNdjson } from '../src/compare/ndjson.js';
import { readHealth, readMarketMetadata, readShadowGroups } from '../src/compare/evidence.js';
import { buildShadowGroups, compare } from '../src/compare/phase4.js';
import type { SourceObservationRow } from '../src/shadow/racing.js';
import { fixtureArchive } from './poly2-fixtures.js';

const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(tmpdir(), 'poly-stream-test-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const window = { startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-02T00:00:00.000Z' };
const cohort = (w: string) => w === '0xabc' ? 'CONTROLLED_OVERLAP' as const : null;
const observation: SourceObservationRow = { source: 'REST_TRADES', identity: 'id', wallet: '0xabc', side: 'BUY', asset: '7', size: '1.000000', price: '0.5', sourceTs: 1767225600, blockTimestamp: null, sourceFirstSeenUtc: window.startUtc, completedUtc: '2026-01-01T00:00:00.500Z', role: 'UNKNOWN', groupKey: 'econ:0xtx:7:1.000000', hydration: 'FULL' };
function put(d: string, name: string, rows: unknown[]) { writeFileSync(join(d, name), rows.map(r => JSON.stringify(r)).join('\n')); }
async function collect(file: string, chunkSize = 1) { const rows = []; for await (const row of readNdjson(file, chunkSize)) rows.push(row); return rows; }

describe('streaming offline evidence', () => {
  it.each(['', '\n', ' \r\n\t\n'])('keeps empty/blank semantics: %j', async text => {
    const d = dir(); const f = join(d, 'rows.ndjson'); writeFileSync(f, text); expect(await collect(f)).toEqual([]);
  });
  it.each(['', '\n'])('decodes chunk-split UTF8 and final newline %j', async ending => {
    const d = dir(); const f = join(d, 'rows.ndjson'); writeFileSync(f, '\n {"text":"€猫😀"}\r\n\t\n{"n":2}' + ending);
    expect(await collect(f)).toEqual([{ text: '€猫😀' }, { n: 2 }]);
  });
  it('fails visibly with file and physical line, never skips malformed rows', async () => {
    const d = dir(); const f = join(d, 'bad.ndjson'); writeFileSync(f, '{}\n\n{bad}\n{}');
    await expect(collect(f)).rejects.toThrow(`${f}:3`);
    await expect(readHealth(d)).resolves.toMatchObject({ available: true, restPolls: 0 });
    writeFileSync(join(d, 'raw_logs.ndjson'), '{}\n{bad}'); await expect(readHealth(d)).rejects.toThrow('raw_logs.ndjson:2');
    writeFileSync(join(d, 'rest_raw.ndjson'), '{bad}'); await expect(readMarketMetadata(d)).rejects.toThrow('rest_raw.ndjson:1');
    writeFileSync(join(d, 'source_observations.ndjson'), '\n{bad}'); await expect(readShadowGroups(d, cohort, window)).rejects.toThrow('source_observations.ndjson:2');
  });
  it('matches every legacy health field, upper median, null coercion and last row (not max time)', async () => {
    const d = dir(); const tel = [{ ageHeader: null }, { ageHeader: '9', error: 'a' }, { ageHeader: 'bogus' }, { ageHeader: -1, error: 'z'.repeat(150) }, { ageHeader: '' }, { ageHeader: '2' }, {}];
    const obs = [{ completedUtc: window.endUtc }, {}]; const quar = [{ detail: { recoveryRequired: true } }, { detail: { recoveryRequired: 'true' } }];
    put(d, 'poll_telemetry.ndjson', tel); put(d, 'source_observations.ndjson', obs); put(d, 'quarantine.ndjson', quar); put(d, 'raw_logs.ndjson', [{}, {}, {}]);
    const ages = tel.map(t => Number(t.ageHeader)).filter(a => !Number.isNaN(a)).sort((a,b) => a-b);
    expect(await readHealth(d)).toEqual({ available: true, chainRawEvents: 3, latestObservationUtc: '', restPolls: tel.length, restErrors: 2, lastRestError: 'z'.repeat(120), cdnAgeP50Sec: ages[Math.floor(ages.length/2)], quarantineCount: 2, recoveryRequired: true });
    expect(await readHealth()).toEqual({ available: false });
    expect(await readHealth(dir())).toEqual({ available: true, chainRawEvents: 0, latestObservationUtc: null, restPolls: 0, restErrors: 0, lastRestError: null, cdnAgeP50Sec: null, quarantineCount: 0, recoveryRequired: false });
  });
  it('preserves first-wins market map and full canonical comparator outputs; production CLI rejects fixture archives', async () => {
    const d = dir(); const rows = [observation, { ...observation, source: 'REST_ACTIVITY' as const, completedUtc: window.startUtc }, { ...observation, wallet: '0xother', groupKey: 'excluded' }, { ...observation, groupKey: 'late', sourceFirstSeenUtc: '2027-01-01T00:00:00Z' }, { ...observation, groupKey: 'econ:0xother:7:1.000000', hydration: 'PARTIAL' as const }];
    put(d, 'source_observations.ndjson', rows);
    put(d, 'rest_raw.ndjson', [{ payload: { transactionHash: '0xTX', asset: 7, size: 1, title: '猫 first' } }, { payload: { transactionHash: '0xtx', asset: '7', size: 1, title: 'later' } }, { payload: { transactionHash: '0xOTHER', asset: 7, size: 1, conditionId: 'fallback' } }, { payload: { transactionHash: '0xignored', asset: 7, size: '1', title: 'ignored' } }]);
    const markets = await readMarketMetadata(d); expect([...markets]).toEqual([['econ:0xtx:7:1.000000', '猫 first'], ['econ:0xother:7:1.000000', 'fallback']]);
    const groups = await readShadowGroups(d, cohort, window); expect([...groups.values()].every(g => g.members.length === 0)).toBe(true);
    const exported = { window, rows: [{ wallet: '0xabc', txHash: '0xtx', asset: '7', conditionId: null, side: 'BUY' as const, size: 1, price: 0.5, sourceTs: observation.sourceTs, ingestedUtc: '2026-01-01T00:00:02.123Z', normalizedUtc: '2026-01-01T00:00:03.456Z', decisionUtc: null, signalUtc: null, source: 'fixture', freshnessAgeSec: 301, freshnessRejection: 'stale', policyEligible: false, copyabilityOutcome: null, rejectionReason: 'stale', paperOutcome: null }] };
    const expected = compare(exported, buildShadowGroups(rows, cohort, window), window, cohort, markets);
    expect(compare(exported, groups, window, cohort, markets)).toEqual(expected);
    put(d, 'unused.ndjson', []); const archived=fixtureArchive(exported.rows, window, ['0xabc']); writeFileSync(join(d, 'export.json'), JSON.stringify(archived)); writeFileSync(join(d, 'cohorts.json'), JSON.stringify({ window, controlled: ['0xabc'] }));
    let cliError:unknown;
    try{execFileSync(process.execPath,['--import','tsx','src/compare/cli.ts',d,join(d,'export.json'),join(d,'cohorts.json'),d],{stdio:'pipe'});}catch(error){cliError=error;}
    expect(String((cliError as {stderr?:unknown}|undefined)?.stderr)).toContain('synthetic comparator fixtures are not production authority');
    expect(()=>readFileSync(join(d,'comparison.json'))).toThrow();
    writeFileSync(join(d,'comparison.json'),JSON.stringify(expected));
    execFileSync(process.execPath, ['--import', 'tsx', 'src/compare/dashboard.ts', d, d]);
    const html = readFileSync(join(d, 'dashboard.html'), 'utf8'); const health = JSON.parse(html.match(/const HEALTH = (.*);/)![1]!);
    expect(health).toEqual(await readHealth(d));
  });
  it('does not truncate a line larger than the stream chunk', async () => {
    const d = dir(); const f = join(d, 'long.ndjson'); const row = { text: '猫'.repeat(80_000) };
    put(d, 'long.ndjson', [row, { last: true }]);
    expect(await collect(f, 4096)).toEqual([row, { last: true }]);
  });
  it('keeps exact age order statistics including repeated values and coercions', async () => {
    for (const ages of [[null, '', 'Infinity', '-Infinity', 1, 1, 1, 'bogus', {}, []], ['2', '8'], ['bad'], [3, 2, 1]]) {
      const d = dir(); put(d, 'poll_telemetry.ndjson', ages.map(ageHeader => ({ ageHeader })));
      const sorted = ages.map(Number).filter(n => !Number.isNaN(n)).sort((a,b) => a-b);
      expect((await readHealth(d))['cdnAgeP50Sec']).toBe(sorted.length ? sorted[Math.floor(sorted.length/2)] : null);
    }
  });
  it('production CLI rejects synthetic archives; dashboard reports malformed evidence line', () => {
    const d = dir(); writeFileSync(join(d, 'export.json'), JSON.stringify(fixtureArchive([], window, ['0xabc'])));
    writeFileSync(join(d, 'cohorts.json'), JSON.stringify({ window, controlled: ['0xabc'] }));
    const run = (kind: string) => {
      const args = kind === 'cli' ? [d, join(d, 'export.json'), join(d, 'cohorts.json'), d] : [d, d];
      try { execFileSync(process.execPath, ['--import', 'tsx', `src/compare/${kind}.ts`, ...args], { stdio: 'pipe' }); }
      catch (error) { return String((error as { stderr: Buffer }).stderr); }
      throw new Error('malformed evidence was accepted');
    };
    writeFileSync(join(d, 'rest_raw.ndjson'), '\n{bad}'); expect(run('cli')).toContain('synthetic comparator fixtures are not production authority');
    writeFileSync(join(d, 'rest_raw.ndjson'), ''); writeFileSync(join(d, 'source_observations.ndjson'), JSON.stringify(observation) + '\n{bad}'); expect(run('cli')).toContain('synthetic comparator fixtures are not production authority');
    writeFileSync(join(d, 'source_observations.ndjson'), '');
    expect(run('cli')).toContain('synthetic comparator fixtures are not production authority');
    writeFileSync(join(d, 'comparison.json'),JSON.stringify(compare({window,rows:[]},new Map(),window,cohort,new Map())));
    writeFileSync(join(d, 'poll_telemetry.ndjson'), '\n\n{bad}'); expect(run('dashboard')).toContain('poll_telemetry.ndjson:3');
  });
});
