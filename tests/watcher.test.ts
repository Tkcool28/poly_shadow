/**
 * Watcher evidence-safety tests (independent re-review findings 1–3):
 * removed-log handling, transient failure + replay, restart/reorg recovery.
 * These exercise the real ChainWatcher against an in-memory RPC mock and a
 * real ShadowStore in a temp dir — not storage methods in isolation.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
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
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

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
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

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
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

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
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

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
});
