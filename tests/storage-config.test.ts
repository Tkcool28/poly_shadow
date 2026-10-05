import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowStore, type RawLogRow } from '../src/shadow/storage.js';
import { assertNoCredentials, loadConfig, CredentialGuardError } from '../src/shadow/config.js';
import { assertAllowedUrl, EgressBlockedError } from '../src/shadow/egress.js';

function rawRow(over: Partial<RawLogRow> = {}): RawLogRow {
  return {
    chainId: 137, emitter: '0xe111180000d2663c0091e4f400237545b87b996b',
    blockNumber: 100, blockHash: '0xaaa', txHash: '0xtx1', logIndex: 3,
    topic0: '0xd543', topics: ['0xd543'], data: '0x', firstSeenUtc: '2026-10-05T00:00:00.000Z',
    ...over,
  };
}

describe('append-only storage and reorg semantics', () => {
  it('removal is a tombstone; raw row is never edited', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
    const s = new ShadowStore(dir);
    s.appendRawLog(rawRow());
    expect(s.logStatus({ chainId: 137, emitter: rawRow().emitter, txHash: '0xtx1', logIndex: 3 })).toBe('CONFIRMED');
    s.appendTombstone({
      chainId: 137, emitter: rawRow().emitter, txHash: '0xtx1', logIndex: 3,
      blockHash: '0xaaa', removedAtUtc: '2026-10-05T00:01:00.000Z', reason: 'REMOVED_FLAG',
    });
    expect(s.logStatus({ chainId: 137, emitter: rawRow().emitter, txHash: '0xtx1', logIndex: 3 })).toBe('REMOVED');
    expect(s.rawLogs()).toHaveLength(1); // original evidence intact
    rmSync(dir, { recursive: true, force: true });
  });

  it('re-inclusion at a new blockHash yields REINCLUDED, both rows preserved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
    const s = new ShadowStore(dir);
    const id = { chainId: 137, emitter: rawRow().emitter, txHash: '0xtx1', logIndex: 3 };
    s.appendRawLog(rawRow());
    s.appendTombstone({ ...id, blockHash: '0xaaa', removedAtUtc: '2026-10-05T00:01:00.000Z', reason: 'REORG_REWIND' });
    s.appendRawLog(rawRow({ blockHash: '0xbbb', firstSeenUtc: '2026-10-05T00:02:00.000Z' }));
    expect(s.logStatus(id)).toBe('REINCLUDED');
    expect(s.rawLogs()).toHaveLength(2);
    rmSync(dir, { recursive: true, force: true });
  });

  it('reorg rewind tombstones above ancestor and quarantines the anomaly', () => {
    const dir = mkdtempSync(join(tmpdir(), 'shadow-'));
    const s = new ShadowStore(dir);
    s.appendRawLog(rawRow({ blockNumber: 100 }));
    s.appendRawLog(rawRow({ blockNumber: 101, txHash: '0xtx2', logIndex: 0 }));
    const n = s.tombstoneAboveBlock(137, 100, '2026-10-05T00:05:00.000Z');
    expect(n).toBe(1);
    expect(s.quarantine().some((q) => q.kind === 'REORG_ANOMALY')).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('fail-closed credential guard', () => {
  it('passes with a clean env', () => {
    expect(() => assertNoCredentials({ SHADOW_WATCHED_WALLETS: '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029' })).not.toThrow();
  });
  it('refuses to start with any credential material present', () => {
    for (const env of [
      { PRIVATE_KEY: '0xabc' },
      { CLOB_API_SECRET: 'x' },
      { ARB_PRIVATE_KEY: 'x' },
      { SCALP_CLOB_API_KEY: 'x' },
      { RELAYER_API_KEY: 'x' },
    ]) {
      expect(() => assertNoCredentials(env)).toThrow(CredentialGuardError);
    }
  });
  it('loadConfig requires watched wallets and defaults chain 137', () => {
    expect(() => loadConfig({})).toThrow(/SHADOW_WATCHED_WALLETS/);
    const cfg = loadConfig({ SHADOW_WATCHED_WALLETS: '0xD38B71F3E8ED1AF71983E5C309EAC3DFA9B35029' });
    expect(cfg.chainId).toBe(137);
    expect(cfg.watchedWallets.has('0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029')).toBe(true);
  });
});

describe('egress allowlist', () => {
  it('allows only data/gamma APIs and configured RPC endpoints', () => {
    const rpc = ['https://polygon-bor-rpc.publicnode.com'];
    expect(() => assertAllowedUrl('https://data-api.polymarket.com/trades', rpc)).not.toThrow();
    expect(() => assertAllowedUrl('https://gamma-api.polymarket.com/markets', rpc)).not.toThrow();
    expect(() => assertAllowedUrl(rpc[0]!, rpc)).not.toThrow();
  });
  it('blocks trading and unknown hosts', () => {
    const rpc = ['https://polygon-bor-rpc.publicnode.com'];
    expect(() => assertAllowedUrl('https://clob.polymarket.com/order', rpc)).toThrow(EgressBlockedError);
    expect(() => assertAllowedUrl('https://relayer-v2.polymarket.com/', rpc)).toThrow(EgressBlockedError);
    expect(() => assertAllowedUrl('https://evil.example.com', rpc)).toThrow(EgressBlockedError);
  });
});
