import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { ShadowStore, type ObservationRow } from '../src/shadow/storage.js';
import { RacingStore, Reconciler, publishChainObservation, chainGroupKey } from '../src/shadow/racing.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const obs: ObservationRow = {
  eventId: '137:exchange:tx:0', role: 'TAKER_AGGREGATE', wallet: 'wallet', side: 'BUY',
  tokenId: 'asset', shares: '1.000000', price10: '0.5000000000', feeUnits: '0',
  blockTimestamp: 1, source: 'CHAIN', sourceFirstSeenUtc: '2026-01-01T00:00:00Z',
  firstSeenUtc: '2026-01-01T00:00:01Z',
  evidence: { chainId: 137, emitter: 'exchange', txHash: 'tx', logIndex: 0, blockHash: 'hash' },
};
const key = '137:exchange:tx:0:hash';
for (const stage of ['canonical', 'source', 'group', 'position'] as const) {
  it(`fails closed after authoritative ${stage} append and rebuilds exactly once on reopening`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'index-failure-')); dirs.push(dir);
    let shadow = new ShadowStore(dir), racing = new RacingStore(dir);
    await shadow.initializeIndex(); await racing.initializeIndex();
    let reconciler = new Reconciler(racing);
    const target = stage === 'canonical' ? shadow : racing;
    const table = { canonical: 'canonical_observations', source: 'identities', group: 'groups', position: 'positions' }[stage];
    // Real SQLite failure: for positions the preceding group INSERT has already succeeded.
    (target as any).db.exec(`CREATE TRIGGER fail_update BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'injected index failure'); END`);
    const publish = () => {
      if (!shadow.canonicalObservation(key)) shadow.appendObservation(obs);
      publishChainObservation(racing, reconciler, shadow.canonicalObservation(key)!);
    };
    expect(publish).toThrow('injected index failure');
    const file = stage === 'canonical' ? 'observations.ndjson' : stage === 'source' ? 'source_observations.ndjson' : 'reconciliation.ndjson';
    const bytes = readFileSync(join(dir, file), 'utf8');
    expect(bytes.trim().split('\n')).toHaveLength(1);
    expect(target.indexTelemetry()).toMatchObject(stage === 'canonical' ? { indexInvalid: true } : { racingIndexInvalid: true });
    for (let n = 0; n < 3; n++) {
      expect(publish).toThrow(/index invalid/);
      expect(() => target === shadow ? shadow.observations() : racing.reconciliation()).toThrow(/index invalid/);
      expect(() => target === shadow ? shadow.appendObservation(obs) : reconciler.record('CHAIN', key, chainGroupKey(obs), obs.sourceFirstSeenUtc)).toThrow(/index invalid/);
      expect(() => target === shadow ? shadow.advanceCursor({ provider: 'test', blockNumber: 1, blockHash: 'hash', updatedAtUtc: obs.firstSeenUtc }) : racing.appendPollTelemetry({} as any)).toThrow(/index invalid/);
      await expect(target.initializeIndex()).rejects.toThrow(/index invalid/);
      expect(readFileSync(join(dir, file), 'utf8')).toBe(bytes);
    }
    // close must not turn this same poisoned object into an implicit repair/read loop.
    target.close();
    expect(() => target === shadow ? shadow.identityState(key) : racing.hasGroup(chainGroupKey(obs))).toThrow(/index invalid/);
    shadow.close(); racing.close();
    shadow = new ShadowStore(dir); racing = new RacingStore(dir); reconciler = new Reconciler(racing);
    await shadow.initializeIndex(); await racing.initializeIndex();
    publish(); publish();
    expect(shadow.observations()).toEqual([obs]);
    expect(shadow.canonicalObservation(key)).toEqual(obs);
    expect(racing.sourceObservations()).toHaveLength(1);
    expect(racing.sourceObservations()[0]).toMatchObject({ sourceFirstSeenUtc: obs.sourceFirstSeenUtc, completedUtc: obs.firstSeenUtc });
    expect(racing.reconciliation()).toEqual([{ groupKey: chainGroupKey(obs), source: 'CHAIN', identity: key, position: 'FIRST', atUtc: obs.sourceFirstSeenUtc }]);
    expect(reconciler.record('REST_TRADES', 'later', chainGroupKey(obs), '2026-01-02T00:00:00Z')).toBe('CORROBORATOR');
    expect(racing.reconciliation()[0]?.position).toBe('FIRST');
    shadow.close(); racing.close();
  });
}
