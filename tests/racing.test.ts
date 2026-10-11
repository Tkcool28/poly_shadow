/**
 * Phase 3 source-racing acceptance tests (handoff §13):
 *   1. /trades dedup
 *   2. /activity dedup
 *   3. same trade from multiple sources in different arrival orders
 *   4. first-seen winner preservation + late corroborating source
 *   5. source-only identity retention (unmatched stays visible)
 *   6. REST retry/error behavior (error is telemetry, recovery on next poll)
 *   7. restart idempotence
 *   8. chain + REST reconciliation (economic-trade candidate group)
 *   9. maker-only / non-TRADE activity retained as its own population
 *  10. same transaction with multiple legitimate fills stays distinct
 *  11. metadata hydration failure never loses the raw observation
 */

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RacingStore, Reconciler, activityIdentity, chainGroupKey, tradeGroupKey, tradesIdentity,
} from '../src/shadow/racing.js';
import { RestPoller } from '../src/shadow/rest-poller.js';
import { OperationalEvidence } from '../src/shadow/operational-evidence.js';
import type { RestGetResult } from '../src/shadow/egress.js';

const WATCHED = '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029';
const TX = '0x' + 'aa'.repeat(32);
const ASSET = '28774665463932631392072718054733378944250725021214679767633993409918492440355';

function trade(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proxyWallet: WATCHED, side: 'BUY', asset: ASSET,
    conditionId: '0x' + '11'.repeat(32), size: 160.26, price: 0.89,
    timestamp: 1_724_210_494, title: 'Test market?', slug: 'test-market',
    transactionHash: TX, ...over,
  };
}

function activity(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    proxyWallet: WATCHED, timestamp: 1_724_210_494, conditionId: '0x' + '11'.repeat(32),
    type: 'TRADE', size: 160.26, usdcSize: 142.63, transactionHash: TX,
    price: 0.89, asset: ASSET, side: 'BUY', title: 'Test market?', ...over,
  };
}

function restOk(body: unknown[], headers: Partial<RestGetResult['headers']> = {}) {
  return async (): Promise<RestGetResult> => ({
    status: 200,
    headers: { age: '3', cacheControl: 'public, max-age=5', etag: null, date: null, ...headers },
    body,
  });
}

function clock(start = '2026-01-01T00:00:00.000Z') {
  let t = Date.parse(start);
  return () => new Date(t++).toISOString();
}

const dirs: string[] = [];
function tempRacing(): RacingStore {
  const d = mkdtempSync(join(tmpdir(), 'shadow-racing-'));
  dirs.push(d);
  return new RacingStore(d);
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function poller(
  store: RacingStore, rec: Reconciler,
  source: 'REST_TRADES' | 'REST_ACTIVITY',
  fetchFn: (url: string) => Promise<RestGetResult>,
  now: () => string = clock(),
) {
  return new RestPoller({
    source, endpoint: source === 'REST_TRADES' ? 'trades' : 'activity',
    baseUrl: 'https://data-api.test', wallets: new Set([WATCHED]),
    intervalMs: 10_000,
  }, store, rec, now, fetchFn);
}

describe('phase 3 source racing', () => {
  it('1. /trades dedup: same payload polled twice commits once', async () => {
    const store = tempRacing();
    const p = poller(store, new Reconciler(store), 'REST_TRADES', restOk([trade()]));
    await p.pollAll();
    await p.pollAll();
    expect(store.restRaw()).toHaveLength(1);
    expect(store.sourceObservations()).toHaveLength(1);
    const tel = store.pollTelemetry();
    expect(tel[1]!.duplicates).toBe(1);
    expect(tel[1]!.newIdentities).toBe(0);
  });

  it('2. /activity dedup, type is part of identity', async () => {
    const store = tempRacing();
    const p = poller(store, new Reconciler(store), 'REST_ACTIVITY',
      restOk([activity(), activity({ type: 'MERGE', asset: '', side: '' })]));
    await p.pollAll();
    await p.pollAll();
    expect(store.sourceObservations()).toHaveLength(2); // TRADE + MERGE distinct
    expect(activityIdentity(activity({ type: 'TRADE' }) as never))
      .not.toBe(activityIdentity(activity({ type: 'MERGE' }) as never));
  });

  it('3. same trade, sources in either order: exactly one FIRST winner, rest corroborate', async () => {
    for (const order of [['REST_TRADES', 'REST_ACTIVITY'], ['REST_ACTIVITY', 'REST_TRADES']] as const) {
      const store = tempRacing();
      const rec = new Reconciler(store);
      const g = tradeGroupKey(TX, ASSET, '160.260000');
      const t0 = '2026-01-01T00:00:00.000Z';
      const t1 = '2026-01-01T00:00:02.000Z';
      rec.record(order[0], `${order[0]}:id`, g, t0);
      rec.record(order[1], `${order[1]}:id`, g, t1);
      const rows = store.reconciliation();
      expect(rows).toHaveLength(2);
      expect(rows.filter((r) => r.position === 'FIRST')).toHaveLength(1);
      expect(rows.find((r) => r.position === 'FIRST')!.source).toBe(order[0]);
      // Each source keeps its own timing evidence.
      expect(rows.find((r) => r.position === 'CORROBORATOR')!.atUtc).toBe(t1);
    }
  });

  it('4. first-seen winner survives restart; late corroborator never overwrites', async () => {
    const store = tempRacing();
    const g = tradeGroupKey(TX, ASSET, '160.260000');
    const rec1 = new Reconciler(store);
    expect(rec1.record('REST_TRADES', 'a', g, '2026-01-01T00:00:01.000Z')).toBe('FIRST');
    // Process dies. New reconciler over the same store.
    const rec2 = new Reconciler(store);
    expect(rec2.record('CHAIN', 'b', g, '2026-01-01T00:00:00.500Z')).toBe('CORROBORATOR');
    // Even though CHAIN's timestamp is EARLIER, the durable winner is not
    // overwritten — arrival order at this observer is the recorded fact.
    expect(store.reconciliation().find((r) => r.position === 'FIRST')!.source)
      .toBe('REST_TRADES');
  });

  it('5. source-only identity remains visible (ungrouped, unmatched)', async () => {
    const store = tempRacing();
    const rec = new Reconciler(store);
    const p = poller(store, rec, 'REST_TRADES', restOk([trade({ transactionHash: '0x' + 'ff'.repeat(32) })]));
    await p.pollAll();
    const obs = store.sourceObservations()[0]!;
    const groupRows = store.reconciliation().filter((r) => r.groupKey === obs.groupKey);
    expect(groupRows).toHaveLength(1);          // only one source ever saw it
    expect(groupRows[0]!.position).toBe('FIRST');
    expect(groupRows[0]!.source).toBe('REST_TRADES');
  });

  it('6. REST error is telemetry; next poll recovers and commits', async () => {
    const store = tempRacing();
    let fail = true;
    const fetchFn = async (_url: string): Promise<RestGetResult> => {
      if (fail) { fail = false; throw new Error('socket hang up'); }
      return restOk([trade()])();
    };
    const p = poller(store, new Reconciler(store), 'REST_TRADES', fetchFn);
    await p.pollAll();
    expect(store.sourceObservations()).toHaveLength(0);
    expect(store.pollTelemetry()[0]!.error).toContain('socket hang up');
    await p.pollAll();
    expect(store.sourceObservations()).toHaveLength(1);
    expect(store.pollTelemetry()[1]!.error).toBeNull();
  });

  it('7. restart: new poller over same store does not re-commit', async () => {
    const store = tempRacing();
    const rec = new Reconciler(store);
    await poller(store, rec, 'REST_TRADES', restOk([trade()])).pollAll();
    const p2 = poller(store, new Reconciler(store), 'REST_TRADES', restOk([trade()]));
    expect(p2.seenCount).toBe(1); // seeded from durable evidence
    await p2.pollAll();
    expect(store.sourceObservations()).toHaveLength(1);
  });

  it('8. chain + REST reconciliation: same economic trade, one group, CHAIN first', async () => {
    const store = tempRacing();
    const rec = new Reconciler(store);
    // Chain observation arrives first (as main.ts wires it).
    const chainObs = {
      eventId: `137:0xemitter:${TX}:7`,
      evidence: { txHash: TX, blockHash: '0x' + 'a1'.repeat(32) },
      tokenId: ASSET, shares: '160.260000', sourceFirstSeenUtc: '2026-01-01T00:00:00.000Z',
    };
    const g = chainGroupKey(chainObs as never);
    expect(rec.record('CHAIN', `${chainObs.eventId}:${chainObs.evidence.blockHash}`, g,
      chainObs.sourceFirstSeenUtc)).toBe('FIRST');
    // REST /trades later: same tx+asset+size → same candidate group.
    const p = poller(store, rec, 'REST_TRADES', restOk([trade()]), clock('2026-01-01T00:00:05.000Z'));
    await p.pollAll();
    const rows = store.reconciliation().filter((r) => r.groupKey === g);
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.source === 'CHAIN')!.position).toBe('FIRST');
    expect(rows.find((r) => r.source === 'REST_TRADES')!.position).toBe('CORROBORATOR');
  });

  it('9. non-TRADE activity (maker-side liquidity) is retained, ungrouped', async () => {
    const store = tempRacing();
    const p = poller(store, new Reconciler(store), 'REST_ACTIVITY',
      restOk([activity({ type: 'MERGE', asset: '', side: '', price: 0, size: 316.48 })]));
    await p.pollAll();
    const obs = store.sourceObservations()[0]!;
    expect(obs.source).toBe('REST_ACTIVITY');
    expect(obs.groupKey.startsWith('ungrouped:')).toBe(true); // visible, unmatched
    expect(store.reconciliation()).toHaveLength(1);            // still tracked
  });

  it('10. same tx, multiple legitimate fills → distinct identities (no txHash dedup)', () => {
    const a = tradesIdentity(trade({ size: 100, price: 0.5 }) as never);
    const b = tradesIdentity(trade({ size: 200, price: 0.5 }) as never);
    const c = tradesIdentity(trade({ size: 100, price: 0.51 }) as never);
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('11. missing metadata → PARTIAL hydration, raw observation preserved', async () => {
    const store = tempRacing();
    const bare = trade();
    delete bare['title'];
    delete bare['conditionId'];
    const p = poller(store, new Reconciler(store), 'REST_TRADES', restOk([bare]));
    await p.pollAll();
    const obs = store.sourceObservations()[0]!;
    expect(obs.hydration).toBe('PARTIAL');
    expect(store.restRaw()).toHaveLength(1); // raw evidence survives
    expect(store.restRaw()[0]!.payload['side']).toBe('BUY');
  });

  it('12. /trades polls request maker+taker (takerOnly=false) and measure cache headers', async () => {
    const store = tempRacing();
    let seenUrl = '';
    const fetchFn = async (url: string): Promise<RestGetResult> => {
      seenUrl = url;
      return restOk([trade()])();
    };
    const p = poller(store, new Reconciler(store), 'REST_TRADES', fetchFn);
    await p.pollAll();
    expect(seenUrl).toContain('takerOnly=false');
    const tel = store.pollTelemetry()[0]!;
    expect(tel.ageHeader).toBe('3');                    // CDN freshness measured
    expect(tel.cacheControl).toBe('public, max-age=5');
    expect(tel.newestSourceTs).toBe(1_724_210_494);
    // No freshness rejection: an old trade is still recorded.
    expect(store.sourceObservations()).toHaveLength(1);
  });

  it('13. REST 429 and timeout become structured quarantine evidence', async () => {
    for (const [status,fetchFn,klass] of [[429,restOk([]), 'HTTP_429'],[503,restOk([]),'HTTP_503'],[500,restOk([]),'HTTP_FAILURE'],[null,async()=>{throw Error('timeout')},'TIMEOUT']] as const) {
      const store=tempRacing(); const op=new OperationalEvidence((store as unknown as {dir:string}).dir);
      const fn=status===null?fetchFn:async()=>({...(await (fetchFn as () => Promise<RestGetResult>)()),status});
      const p=new RestPoller({source:'REST_ACTIVITY',endpoint:'activity',baseUrl:'https://data-api.test',wallets:new Set([WATCHED]),intervalMs:1000},store,new Reconciler(store),clock(),fn as never,op);
      await p.pollAll(); expect(op.quarantineState().unresolved).toBe(1); expect(op.quarantineStateIds()).toHaveLength(1);
      expect(JSON.parse(readFileSync(join((store as unknown as {dir:string}).dir,'quarantine_v2.ndjson'),'utf8')).errorClass).toBe(klass);
    }
  });

  it('14. malformed REST item emits a structured quarantine before direct wallet rejection', async () => {
    const store=tempRacing();const op=new OperationalEvidence((store as unknown as {dir:string}).dir);
    const p=new RestPoller({source:'REST_TRADES',endpoint:'trades',baseUrl:'https://data-api.test',wallets:new Set([WATCHED]),intervalMs:1000},store,new Reconciler(store),clock(),restOk([null as never]) as never,op);
    await expect(p.pollWallet(WATCHED)).rejects.toThrow(/malformed REST item/);expect(op.quarantineState()).toMatchObject({unresolved:1,total:1});
  });

  it('15. capped REST page creates an explicit completeness quarantine', async () => {
    const store=tempRacing();const op=new OperationalEvidence((store as unknown as {dir:string}).dir);
    const rows=Array.from({length:100},(_,i)=>trade({transactionHash:`0x${String(i).padStart(64,'0')}`}));
    const p=new RestPoller({source:'REST_TRADES',endpoint:'trades',baseUrl:'https://data-api.test',wallets:new Set([WATCHED]),intervalMs:1000},store,new Reconciler(store),clock(),restOk(rows),op);
    await p.pollAll();expect(op.quarantineState()).toMatchObject({unresolved:1,total:1});
  });
});
