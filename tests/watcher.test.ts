/**
 * Watcher evidence-safety tests (independent re-review findings 1–3):
 * removed-log handling, transient failure + replay, restart/reorg recovery.
 * These exercise the real ChainWatcher against an in-memory RPC mock and a
 * real ShadowStore in a temp dir — not storage methods in isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChainWatcher, ReorgSignal } from '../src/shadow/watcher.js';
import { ShadowStore } from '../src/shadow/storage.js';
import type { ShadowConfig } from '../src/shadow/config.js';
import {
  EXCHANGE_V2_STANDARD,
  TOPIC_ORDER_FILLED_V2,
} from '../src/shadow/v2constants.js';

const WATCHED = '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029';
const TX = '0x' + 'aa'.repeat(32);
const ORDER_HASH = '0x' + 'bb'.repeat(32);
const BLOCK_A = '0x' + 'a1'.repeat(32);
const BLOCK_B = '0x' + 'b2'.repeat(32); // reorg replacement for same height

function word(v: bigint | number): string {
  return BigInt(v).toString(16).padStart(64, '0');
}
function addrTopic(addr: string): string {
  return '0x' + addr.slice(2).padStart(64, '0');
}

/** Minimal real V2 OrderFilled log: watched wallet = maker, taker = exchange. */
function fillLog(blockNumber: number, blockHash: string, logIndex = 7, removed = false) {
  const data = '0x' + [
    word(0),              // side BUY
    word(12345n),         // tokenId
    word(381_236_800n),   // makerAmountFilled
    word(680_780_000n),   // takerAmountFilled
    word(0n),             // fee
    word(0n),             // builder
    word(0n),             // metadata
  ].join('');
  return {
    address: EXCHANGE_V2_STANDARD,
    topics: [TOPIC_ORDER_FILLED_V2, ORDER_HASH, addrTopic(WATCHED), addrTopic(EXCHANGE_V2_STANDARD)],
    data,
    transactionHash: TX,
    logIndex,
    blockNumber,
    blockHash,
    ...(removed ? { removed: true } : {}),
  };
}

function cfg(dataDir: string): ShadowConfig {
  return {
    chainId: 137,
    polygonHttpRpcUrl: 'https://rpc.test',
    polygonWsRpcUrl: 'wss://rpc.test',
    polygonHttpRpcUrlB: null,
    watchedWallets: new Set([WATCHED]),
    dataDir,
    heartbeatMs: 1000,
    staleMs: 5000,
    verifyIntervalMs: 60_000,
    backfillChunkBlocks: 200,
    dataApiBaseUrl: 'https://data-api.test',
    tradesPollMs: 10_000,
    activityPollMs: 30_000,
  };
}

type Blocks = Map<number, { hash: string; timestamp: number }>;

/** Mock RPC over a mutable block table; failNext() injects one transient error. */
function mockRpc(blocks: Blocks) {
  const state = { failNext: false, calls: [] as string[] };
  const rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
    state.calls.push(method);
    if (state.failNext) { state.failNext = false; throw new Error('RPC temporarily down'); }
    if (method === 'eth_getBlockByNumber') {
      const n = parseInt(params[0] as string, 16);
      const b = blocks.get(n);
      if (!b) throw new Error(`no block ${n}`);
      return { hash: b.hash, timestamp: '0x' + b.timestamp.toString(16) } as T;
    }
    if (method === 'eth_blockNumber') {
      return ('0x' + Math.max(...blocks.keys()).toString(16)) as T;
    }
    if (method === 'eth_getLogs') return [] as T;
    throw new Error(`unexpected method ${method}`);
  };
  return { rpc: rpc as typeof import('../src/shadow/egress.js').rpcCall, state };
}

/** Mock RPC with a controllable artificial delay on block fetches. */
function slowRpc(blocks: Blocks, delayMs: number) {
  const rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
    if (method === 'eth_getBlockByNumber') {
      await new Promise((r) => setTimeout(r, delayMs));
      const n = parseInt(params[0] as string, 16);
      const b = blocks.get(n);
      if (!b) throw new Error(`no block ${n}`);
      return { hash: b.hash, timestamp: '0x' + b.timestamp.toString(16) } as T;
    }
    if (method === 'eth_blockNumber') return ('0x' + Math.max(...blocks.keys()).toString(16)) as T;
    if (method === 'eth_getLogs') return [] as T;
    throw new Error(`unexpected method ${method}`);
  };
  return rpc as typeof import('../src/shadow/egress.js').rpcCall;
}

/** Strictly increasing ISO clock — REINCLUDED detection depends on ordering. */
function clock() {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  return () => new Date(t++).toISOString();
}

const dirs: string[] = [];
function tempStore(): ShadowStore {
  const d = mkdtempSync(join(tmpdir(), 'shadow-test-'));
  dirs.push(d);
  return new ShadowStore(d);
}
afterEach(() => {
  vi.useRealTimers();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** Load-balanced provider: advertised head can lead the log/block backend. */
function lagRpc() {
  const state = {
    head: 105, safeHead: 102, invalids: 0, nulls: 0,
    nullAt: 100, withLog: false, mismatch: false,
    ranges: [] as number[][], blockCalls: [] as number[], headCalls: 0,
  };
  const rpc = async <T>(_url: string, method: string, params: unknown[]): Promise<T> => {
    if (method === 'eth_blockNumber') {
      state.headCalls++;
      return ('0x' + state.safeHead.toString(16)) as T;
    }
    if (method === 'eth_getLogs') {
      const p = params[0] as { fromBlock: string; toBlock: string };
      const start = parseInt(p.fromBlock, 16), end = parseInt(p.toBlock, 16);
      state.ranges.push([start, end]);
      if (state.invalids-- > 0 || end > state.safeHead) throw new Error('invalid block range');
      return (state.withLog ? [fillLog(100, BLOCK_A)] : []) as T;
    }
    if (method === 'eth_getBlockByNumber') {
      const n = parseInt(params[0] as string, 16);
      state.blockCalls.push(n);
      if (n === state.nullAt && state.nulls-- > 0) return null as T;
      return { hash: state.mismatch ? BLOCK_B : BLOCK_A, timestamp: '0x64' } as T;
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { state, rpc: rpc as typeof import('../src/shadow/egress.js').rpcCall };
}

async function settleRetries(work: Promise<unknown>) {
  // Attach rejection handling before advancing timers (no unhandled rejection).
  const result = work.then(() => null, (error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeNull();
}

describe('bounded provider-lag retries', () => {
  it.each(['block', 'range'])('time-based %s availability after 1.2s succeeds within the bounded budget', async (kind) => {
    vi.useFakeTimers();
    const store = tempStore();
    const started = Date.now();
    const attempts: number[] = [];
    const { state, rpc } = lagRpc();
    state.safeHead = 100; state.withLog = true;
    const timedRpc: typeof rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === (kind === 'block' ? 'eth_getBlockByNumber' : 'eth_getLogs')) {
        const elapsed = Date.now() - started;
        attempts.push(elapsed);
        if (elapsed <= 1203) {
          if (kind === 'block') return null as T;
          throw new Error('invalid block range');
        }
      }
      return rpc<T>(url, method, params);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(), timedRpc);
    const work = w.scanRange(100, 100);
    await vi.advanceTimersByTimeAsync(1204);
    expect(store.observations()).toHaveLength(0);
    expect(store.quarantine()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(296);
    await work;
    expect(attempts.slice(0, 5)).toEqual([0, 100, 300, 700, 1500]);
    expect(store.observations()).toHaveLength(1);
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()[0]!.sourceFirstSeenUtc).toBe(store.rawLogs()[0]!.firstSeenUtc);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
    expect(store.quarantine()).toHaveLength(0);
  });

  it.each(['block', 'range'])('time-based %s exhaustion is bounded to six attempts and one failure at 3.1s', async (kind) => {
    vi.useFakeTimers();
    const store = tempStore();
    const started = Date.now();
    const attempts: number[] = [];
    const { state, rpc } = lagRpc();
    state.safeHead = 100; state.withLog = true;
    const unavailableRpc: typeof rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === (kind === 'block' ? 'eth_getBlockByNumber' : 'eth_getLogs')) {
        attempts.push(Date.now() - started);
        if (kind === 'block') return null as T;
        throw new Error('invalid block range');
      }
      return rpc<T>(url, method, params);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(), unavailableRpc);
    const work = w.scanRange(100, 100);
    await vi.advanceTimersByTimeAsync(3099);
    expect(store.quarantine()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await work;
    expect(attempts).toEqual([0, 100, 300, 700, 1500, 3100]);
    expect(store.quarantine().map((q) => q.kind)).toEqual(['TRANSIENT_FAILURE']);
    expect(store.observations()).toHaveLength(0);
    expect(store.readCursor('https://rpc.test')).toBeNull();
    expect(store.tombstones()).toHaveLength(0);
    if (kind === 'block') expect([...store.dispositionIndex().values()]).toEqual(['PENDING']);
  });

  it('startup stored cursor null exhaustion keeps verifier active and validates on its next cycle', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 6; state.safeHead = 101;
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: clock()() });
    const before = store.readCursor('https://rpc.test');
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    try {
      // Production ACK handler records exactly one startup failure.
      const recorded = w.backfillFromCursor().catch((err) =>
        (w as unknown as { recordFailure(where: string, err: unknown): void }).recordFailure('backfill', err));
      await vi.advanceTimersByTimeAsync(3100);
      await recorded;
      expect(vi.getTimerCount()).toBe(1);
      expect(state.blockCalls).toEqual([100, 100, 100, 100, 100, 100]);
      expect(state.ranges).toHaveLength(0);
      expect(store.readCursor('https://rpc.test')).toEqual(before);
      expect(store.quarantine().map((q) => q.kind)).toEqual(['TRANSIENT_FAILURE']);
      expect(store.tombstones()).toHaveLength(0);
      expect(w.recoveryRequired).toBe(false);
      expect(vi.getTimerCount()).toBe(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(state.blockCalls[6]).toBe(100); // validate BEFORE scanning
      expect(state.ranges).toEqual([[101, 101]]);
      expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(101);
      expect(store.quarantine()).toHaveLength(1);
    } finally { w.stop(); }
  });
  it('removal during a null retry dominates eventual hydration and restart replay', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 4;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    const work = w.handleLog(fillLog(100, BLOCK_A));
    await vi.advanceTimersByTimeAsync(300);
    await w.handleLog(fillLog(100, BLOCK_A, 7, true));
    await vi.advanceTimersByTimeAsync(1200);
    await work;
    await w.processRetries();
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()).toHaveLength(0);
    expect(store.tombstones().map((t) => t.reason)).toEqual(['REMOVED_FLAG']);
    expect([...store.dispositionIndex().values()]).toEqual(['REMOVED_INVALID']);
    const restarted = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    expect(await restarted.replayIncompleteFromStore()).toBe(0);
    expect(store.quarantine()).toHaveLength(0);
  });

  it.each([true, false])('real cursor mismatch waits for unavailable ancestor; provable=%s preserves fail-closed recovery', async (provable) => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nullAt = 99; state.nulls = 6;
    store.appendBlockHash({ chainId: 137, blockNumber: 99, blockHash: BLOCK_A, firstSeenUtc: clock()() });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: clock()() });
    const ancestorRpc: typeof rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_getBlockByNumber' && params[0] === '0x64') return { hash: BLOCK_B, timestamp: '0x64' } as T;
      state.mismatch = !provable;
      return rpc<T>(url, method, params);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(), ancestorRpc);
    const initial = w.validateCursor().catch((err) => err);
    await vi.advanceTimersByTimeAsync(3100);
    expect(String(await initial)).toContain('after 6 attempts');
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
    expect(store.tombstones()).toHaveLength(0);
    expect(store.quarantine()).toHaveLength(0);
    expect(w.recoveryRequired).toBe(false); // unavailable is not unprovable
    await w.validateCursor();
    expect(w.recoveryRequired).toBe(!provable);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(provable ? 99 : 100);
    expect(store.quarantine()).toHaveLength(1);
    expect(store.quarantine()[0]!.detail['ancestorVerified']).toBe(provable);
  });

  it('live and scan concurrent same identity during null hydration commit exactly once', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 4; state.withLog = true; state.safeHead = 100;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    const live = w.handleLog(fillLog(100, BLOCK_A));
    const scan = w.scanRange(100, 100);
    await vi.advanceTimersByTimeAsync(1500);
    await Promise.all([live, scan]);
    await w.processRetries();
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()).toHaveLength(1);
    expect([...store.dispositionIndex().values()]).toEqual(['OBSERVED']);
    expect(store.observations()[0]!.sourceFirstSeenUtc).toBe(store.rawLogs()[0]!.firstSeenUtc);
    expect(store.quarantine()).toHaveLength(0);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
  });

  it('scan-discovered hash conflict cannot advance the cursor ahead of queued recovery', async () => {
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.mismatch = true;
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: clock()() });
    const conflictRpc: typeof rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_getLogs') return [fillLog(101, BLOCK_A)] as T;
      return rpc<T>(url, method, params);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(), conflictRpc);
    const internals = w as unknown as { runExclusive(fn: () => Promise<void>): Promise<void> };
    await internals.runExclusive(() => w.scanRange(101, 101));
    await internals.runExclusive(async () => {}); // drain queued recovery
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
    expect(w.recoveryRequired).toBe(true);
    expect(store.tombstones().map((t) => t.reason)).toEqual(['HASH_CONFLICT']);
    expect(store.observations()).toHaveLength(0);
  });

  it('clamps H to backend H-N and scans the next chunk without a gap', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    const w = new ChainWatcher({ ...cfg(store.dir), backfillChunkBlocks: 4 }, store, clock(), rpc);
    await settleRetries(w.scanRange(100, state.head));
    expect(state.ranges).toEqual([[100, 103], [100, 102], [103, 105]]);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(102);
    expect(store.quarantine()).toHaveLength(0);
    state.safeHead = 105;
    await settleRetries(w.scanRange(103, 105));
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(105);
  });

  it('retries two invalid ranges before success without duplicate observations', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.safeHead = 100; state.invalids = 2; state.withLog = true;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await settleRetries(w.scanRange(100, 100));
    expect(state.ranges).toHaveLength(3);
    expect(state.headCalls).toBe(2);
    expect(store.observations()).toHaveLength(1);
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.quarantine()).toHaveLength(0);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
  });

  it('null, null, success backs off 100/200ms and preserves arrival exactly once', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 2;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    const work = Promise.all([w.handleLog(fillLog(100, BLOCK_A)), w.handleLog(fillLog(100, BLOCK_A))]);
    await vi.advanceTimersByTimeAsync(99);
    expect(state.blockCalls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.blockCalls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(199);
    expect(store.observations()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await work;
    await w.processRetries();
    expect(state.blockCalls).toHaveLength(3);
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()).toHaveLength(1);
    expect(store.observations()[0]!.sourceFirstSeenUtc).toBe(store.rawLogs()[0]!.firstSeenUtc);
    expect(store.quarantine()).toHaveLength(0);
    expect(store.tombstones()).toHaveLength(0);
  });

  it('null exhaustion emits one failure, stops the cursor, and restart replays PENDING', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 6; state.withLog = true; state.safeHead = 100;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await settleRetries(w.scanRange(100, 100));
    expect(state.blockCalls).toHaveLength(6);
    expect(store.quarantine()).toHaveLength(1);
    expect(store.quarantine()[0]!.kind).toBe('TRANSIENT_FAILURE');
    expect(store.tombstones()).toHaveLength(0);
    expect(store.readCursor('https://rpc.test')).toBeNull();
    expect([...store.dispositionIndex().values()]).toEqual(['PENDING']);
    expect(w.recoveryRequired).toBe(false);
    const restarted = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    expect(await restarted.replayIncompleteFromStore()).toBe(1);
    await restarted.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(1);
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.quarantine()).toHaveLength(1);
    expect(store.observations()[0]!.sourceFirstSeenUtc).toBe(store.rawLogs()[0]!.firstSeenUtc);
  });

  it('invalid-range exhaustion emits one failure and preserves the last cursor', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.safeHead = 105;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await w.scanRange(99, 99);
    state.invalids = 6;
    await settleRetries(w.scanRange(100, 105));
    expect(state.ranges.slice(1)).toHaveLength(6);
    expect(store.quarantine()).toHaveLength(1);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(99);
  });

  it.each([100, 102])('null checkpoint/end %s exhaustion never advances the cursor', async (nullAt) => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nullAt = nullAt; state.nulls = 6;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await w.scanRange(99, 99);
    await settleRetries(w.scanRange(100, 102));
    expect(state.blockCalls.filter((n) => n === nullAt)).toHaveLength(6);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(99);
    expect(store.quarantine()).toHaveLength(1);
  });

  it('cursor validation retries null without entering reorg recovery', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: clock()() });
    state.nulls = 2;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await settleRetries(w.validateCursor());
    expect(state.blockCalls).toHaveLength(3);
    expect(w.recoveryRequired).toBe(false);
    expect(store.quarantine()).toHaveLength(0);
    expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(100);
  });

  it('first-start lag with no cursor is retried by the next verifier tick', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.safeHead = 105; state.invalids = 1;
    // The initial head leads the backend, whose re-read is below chunk start.
    let heads = 0;
    const firstStartRpc: typeof rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_blockNumber' && heads++ < 2) {
        return (heads === 1 ? '0x69' : '0x28') as T; // 105, then 40 (< 41)
      }
      return rpc<T>(url, method, params);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(), firstStartRpc);
    try {
      await w.backfillFromCursor();
      expect(store.readCursor('https://rpc.test')).toBeNull();
      expect(store.quarantine()).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(store.readCursor('https://rpc.test')?.blockNumber).toBe(105);
      expect(store.quarantine()).toHaveLength(0);
    } finally { w.stop(); }
  });

  it('null then a real hash mismatch still tombstones as a reorg', async () => {
    vi.useFakeTimers();
    const store = tempStore();
    const { state, rpc } = lagRpc();
    state.nulls = 1; state.mismatch = true;
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await settleRetries(w.handleLog(fillLog(100, BLOCK_A)));
    expect(state.blockCalls).toHaveLength(2);
    expect(store.observations()).toHaveLength(0);
    expect(store.tombstones().map((t) => t.reason)).toEqual(['HASH_CONFLICT']);
    expect(store.quarantine().map((q) => q.kind)).toEqual(['REORG_ANOMALY']);
  });
});

describe('watcher evidence safety', () => {
  it('removed notice is never swallowed by dedup; re-inclusion in a new block is new evidence', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);

    await w.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(1);

    // Same (tx, logIndex) arrives removed — must tombstone despite prior add.
    await w.handleLog(fillLog(100, BLOCK_A, 7, true));
    expect(store.tombstones()).toHaveLength(1);
    const id = { chainId: 137, emitter: EXCHANGE_V2_STANDARD, txHash: TX, logIndex: 7 };
    expect(store.logStatus(id)).toBe('REMOVED');

    // Re-included in a different block — new evidence, new observation.
    blocks.set(100, { hash: BLOCK_B, timestamp: 1_791_143_970 });
    await w.handleLog(fillLog(100, BLOCK_B));
    expect(store.rawLogs()).toHaveLength(2);
    expect(store.observations()).toHaveLength(2);
    expect(store.logStatus(id)).toBe('REINCLUDED');
  });

  it('transient RPC failure records quarantine, suppresses nothing, and replay commits', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc, state } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, () => '2026-01-01T00:00:00.000Z', rpc);

    state.failNext = true; // first blockRef call fails
    await w.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(0); // not committed
    expect(store.quarantine().some((q) => q.kind === 'TRANSIENT_FAILURE')).toBe(true);

    await w.processRetries(); // replay succeeds now
    expect(store.observations()).toHaveLength(1);
    expect(store.observations()[0]!.eventId).toBe(`137:${EXCHANGE_V2_STANDARD}:${TX}:7`);
    // Raw evidence row exists exactly once (no duplicate from the retry).
    expect(store.rawLogs()).toHaveLength(1);
  });

  it('cursor-hash mismatch walks to common ancestor, tombstones above it, rewinds', async () => {
    const store = tempStore();
    // Our recorded view: blocks 98,99,100 on chain A.
    const blocks: Blocks = new Map([
      [98, { hash: '0x' + '98'.repeat(32), timestamp: 1_791_143_900 }],
      [99, { hash: '0x' + '99'.repeat(32), timestamp: 1_791_143_910 }],
      [100, { hash: BLOCK_A, timestamp: 1_791_143_962 }],
    ]);
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, () => '2026-01-01T00:00:00.000Z', rpc);

    // Record evidence: a fill at block 100 plus scanned block hashes.
    await w.handleLog(fillLog(100, BLOCK_A));
    for (const [n, b] of blocks) {
      store.appendBlockHash({ chainId: 137, blockNumber: n, blockHash: b.hash, firstSeenUtc: '2026-01-01T00:00:00.000Z' });
    }
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: '2026-01-01T00:00:00.000Z' });

    // Reorg: block 99 stays, block 100 is replaced by a different hash.
    blocks.set(100, { hash: BLOCK_B, timestamp: 1_791_143_970 });

    await w.validateCursor();
    const cursor = store.readCursor('https://rpc.test')!;
    expect(cursor.blockNumber).toBe(99); // rewound to common ancestor
    expect(store.tombstones().some((t) => t.reason === 'REORG_REWIND')).toBe(true);
    const id = { chainId: 137, emitter: EXCHANGE_V2_STANDARD, txHash: TX, logIndex: 7 };
    expect(store.logStatus(id)).toBe('REMOVED');
    // First-seen evidence preserved — append-only, nothing edited or deleted.
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()).toHaveLength(1);
  });

  it('hash conflict in blockRef raises ReorgSignal and does NOT emit with conflicting timestamp', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_B, timestamp: 1_791_143_970 }]]); // disagrees with log
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, () => '2026-01-01T00:00:00.000Z', rpc);

    await w.handleLog(fillLog(100, BLOCK_A)); // log claims BLOCK_A
    expect(store.observations()).toHaveLength(0); // no emission under conflict
    expect(store.quarantine().some((q) => q.kind === 'REORG_ANOMALY')).toBe(true);
  });

  it('WSS endpoint goes through the egress assertion', () => {
    const store = tempStore();
    const bad = { ...cfg(store.dir), polygonWsRpcUrl: 'wss://evil.example.com' };
    const w = new ChainWatcher(bad, store);
    expect(() => w.start()).toThrow(/egress blocked/);
  });

  it('ReorgSignal carries the block number', () => {
    expect(new ReorgSignal(100).blockNumber).toBe(100);
  });

  it('restart after transient failure: durable replay completes the observation exactly once', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);

    // Run 1: RPC fails; raw evidence is persisted but no observation.
    const { rpc: rpc1, state } = mockRpc(blocks);
    const w1 = new ChainWatcher(cfg(store.dir), store, clock(), rpc1);
    state.failNext = true;
    await w1.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(0);
    expect(store.rawLogs()).toHaveLength(1);
    // Process dies here — retryQueue was in memory only.

    // Run 2: a NEW watcher over the SAME store replays the incomplete raw row.
    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    const replayed = await w2.replayIncompleteFromStore();
    expect(replayed).toBe(1);
    expect(store.observations()).toHaveLength(1);
    expect(store.rawLogs()).toHaveLength(1); // no duplicate raw evidence
    expect(store.observations()[0]!.eventId).toBe(`137:${EXCHANGE_V2_STANDARD}:${TX}:7`);

    // Run 3: replay is idempotent once the observation exists.
    const w3 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w3.replayIncompleteFromStore()).toBe(0);
    expect(store.observations()).toHaveLength(1);
  });

  it('concurrent deliveries of the same log commit exactly once', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), slowRpc(blocks, 25));

    const log = fillLog(100, BLOCK_A);
    await Promise.all([w.handleLog(log), w.handleLog(log), w.handleLog(log)]);
    expect(store.rawLogs()).toHaveLength(1);
    expect(store.observations()).toHaveLength(1);
  });

  it('removal identity is block-aware: distinct removals are distinct tombstones', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);

    await w.handleLog(fillLog(100, BLOCK_A, 7, true));
    await w.handleLog(fillLog(100, BLOCK_A, 7, true)); // duplicate notice, same block
    await w.handleLog(fillLog(100, BLOCK_B, 7, true)); // distinct removal, new block
    expect(store.tombstones()).toHaveLength(2);
  });

  it('observation preserves raw arrival time separately from completion time', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc, state } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    state.failNext = true;
    await w.handleLog(fillLog(100, BLOCK_A)); // arrival recorded in the raw row
    const arrival = store.rawLogs()[0]!.firstSeenUtc;

    await w.processRetries();
    const obs = store.observations()[0]!;
    expect(obs.sourceFirstSeenUtc).toBe(arrival); // discovery latency preserved
    expect(obs.firstSeenUtc > obs.sourceFirstSeenUtc).toBe(true); // completed later
  });
});
