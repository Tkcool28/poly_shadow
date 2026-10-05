/**
 * Consolidated exit-audit acceptance matrix — the finite test set requested
 * for Phase 2 sign-off:
 *   1. terminal no-observation restart (no replay storm)
 *   2. pending watched-fill restart (durable replay completes once)
 *   3. repeat delivery AFTER a new-process restart (idempotent, no dup)
 *   4. reorg with old-fork raw: tombstoned fork row is never revived
 *   5. missing ancestor: fail-closed, explicitly unverified bounded rewind
 *   6. delayed concurrent WSS+backfill delivery during a reorg: no deadlock,
 *      no duplicate active observation
 *   7. subscription-start boundary: handshake-gap log captured via overlap
 *   8. reverse-arrival OrdersMatched cross-check (aggregate first)
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { ShadowStore } from '../src/shadow/storage.js';
import type { ShadowConfig } from '../src/shadow/config.js';
import {
  EXCHANGE_V2_STANDARD,
  TOPIC_ORDER_FILLED_V2,
  TOPIC_ORDERS_MATCHED_V2,
} from '../src/shadow/v2constants.js';

const WATCHED = '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029';
const OTHER = '0x' + 'cc'.repeat(20);
const TX = '0x' + 'aa'.repeat(32);
const ORDER_HASH = '0x' + 'bb'.repeat(32);
const BLOCK_A = '0x' + 'a1'.repeat(32);
const BLOCK_B = '0x' + 'b2'.repeat(32);

function word(v: bigint | number): string {
  return BigInt(v).toString(16).padStart(64, '0');
}
function addrTopic(addr: string): string {
  return '0x' + addr.slice(2).padStart(64, '0');
}

function fillLog(
  blockNumber: number, blockHash: string,
  opts: { logIndex?: number; maker?: string; taker?: string; tx?: string } = {},
) {
  const data = '0x' + [
    word(0), word(12345n), word(381_236_800n), word(680_780_000n),
    word(0n), word(0n), word(0n),
  ].join('');
  return {
    address: EXCHANGE_V2_STANDARD,
    topics: [
      TOPIC_ORDER_FILLED_V2, ORDER_HASH,
      addrTopic(opts.maker ?? WATCHED), addrTopic(opts.taker ?? EXCHANGE_V2_STANDARD),
    ],
    data,
    transactionHash: opts.tx ?? TX,
    logIndex: opts.logIndex ?? 7,
    blockNumber,
    blockHash,
  };
}

/** OrdersMatched for the same order hash; amount can be made to mismatch. */
function matchedLog(blockNumber: number, blockHash: string, makerAmount = 381_236_800n) {
  const data = '0x' + [word(0), word(12345n), word(makerAmount), word(680_780_000n)].join('');
  return {
    address: EXCHANGE_V2_STANDARD,
    topics: [TOPIC_ORDERS_MATCHED_V2, ORDER_HASH, addrTopic(WATCHED)],
    data,
    transactionHash: TX,
    logIndex: 8,
    blockNumber,
    blockHash,
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

interface MockOpts {
  failNext?: boolean;
  delayMs?: number;
  logs?: Array<ReturnType<typeof fillLog>>;
}

function mockRpc(blocks: Blocks, opts: MockOpts = {}) {
  const state = { failNext: opts.failNext ?? false };
  const rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
    if (opts.delayMs) await new Promise((r) => setTimeout(r, opts.delayMs));
    if (state.failNext) { state.failNext = false; throw new Error('RPC temporarily down'); }
    if (method === 'eth_getBlockByNumber') {
      const n = parseInt(params[0] as string, 16);
      const b = blocks.get(n);
      if (!b) throw new Error(`no block ${n}`);
      return { hash: b.hash, timestamp: '0x' + b.timestamp.toString(16) } as T;
    }
    if (method === 'eth_blockNumber') return ('0x' + Math.max(...blocks.keys()).toString(16)) as T;
    if (method === 'eth_getLogs') return (opts.logs ?? []) as T;
    throw new Error(`unexpected method ${method}`);
  };
  return { rpc: rpc as typeof import('../src/shadow/egress.js').rpcCall, state };
}

function clock() {
  let t = Date.parse('2026-01-01T00:00:00.000Z');
  return () => new Date(t++).toISOString();
}

const dirs: string[] = [];
function tempStore(): ShadowStore {
  const d = mkdtempSync(join(tmpdir(), 'shadow-exit-'));
  dirs.push(d);
  return new ShadowStore(d);
}
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

describe('exit-audit acceptance matrix', () => {
  it('1. terminal no-observation rows are not replayed on restart', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc } = mockRpc(blocks);

    const w1 = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await w1.handleLog(matchedLog(100, BLOCK_A));                 // OrdersMatched
    await w1.handleLog(fillLog(100, BLOCK_A, { maker: OTHER }));  // unwatched
    expect(store.observations()).toHaveLength(0);
    expect(store.rawLogs()).toHaveLength(2);

    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0); // no replay storm
    expect(store.observations()).toHaveLength(0);
    expect(store.rawLogs()).toHaveLength(2);
  });

  it('2. pending watched fill is replayed once after restart', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc, state } = mockRpc(blocks);
    state.failNext = true;

    const w1 = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await w1.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(0);
    // Disposition is durably PENDING.
    expect([...store.dispositionIndex().values()]).toContain('PENDING');

    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(1);
    expect(store.observations()).toHaveLength(1);

    const w3 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w3.replayIncompleteFromStore()).toBe(0);
  });

  it('3. repeat delivery after a new-process restart cannot double-commit', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);

    const w1 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    await w1.handleLog(fillLog(100, BLOCK_A));
    expect(store.observations()).toHaveLength(1);

    // New process: in-memory sets empty; seeded from durable dispositions.
    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0); // seeds dedup
    await w2.handleLog(fillLog(100, BLOCK_A));            // WSS re-delivery
    expect(store.observations()).toHaveLength(1);
    expect(store.rawLogs()).toHaveLength(1);
  });

  it('4. old-fork raw row tombstoned by a rewind is never revived by replay', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([
      [99, { hash: '0x' + '99'.repeat(32), timestamp: 1_791_143_910 }],
      [100, { hash: BLOCK_A, timestamp: 1_791_143_962 }],
    ]);
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    await w.handleLog(fillLog(100, BLOCK_A));
    store.appendBlockHash({ chainId: 137, blockNumber: 99, blockHash: '0x' + '99'.repeat(32), firstSeenUtc: '2026-01-01T00:00:00.000Z' });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: '2026-01-01T00:00:00.000Z' });

    blocks.set(100, { hash: BLOCK_B, timestamp: 1_791_143_970 }); // fork
    await w.validateCursor(); // rewinds to 99, tombstones the fork row

    // The tombstoned fork row has an OBSERVED disposition but REMOVED status;
    // a restart's replay must not emit a second observation for it.
    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0);
    expect(store.observations()).toHaveLength(1);
  });

  it('5. missing ancestor: fail-closed unverified bounded rewind, quarantined', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[1000, { hash: BLOCK_B, timestamp: 1_791_143_962 }]]);
    // No stored checkpoint hashes at all -> no proof of any ancestor.
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 1000, blockHash: BLOCK_A, updatedAtUtc: '2026-01-01T00:00:00.000Z' });
    for (let n = 872; n <= 1000; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: 1 });

    const w = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    await w.validateCursor();

    const cursor = store.readCursor('https://rpc.test')!;
    expect(cursor.blockNumber).toBe(1000 - 128); // bounded, not "proved"
    const q = store.quarantine().filter((x) => x.kind === 'REORG_ANOMALY');
    expect(q.some((x) => x.detail['unverifiedBoundedRewind'] === true)).toBe(true);
    expect(q.some((x) => x.detail['ancestorVerified'] === false)).toBe(true);
  });

  it('6. reorg during delayed concurrent deliveries: no deadlock, no dup', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc } = mockRpc(blocks, { delayMs: 25 });
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    store.appendBlockHash({ chainId: 137, blockNumber: 99, blockHash: '0x' + '99'.repeat(32), firstSeenUtc: 'x' });
    blocks.set(99, { hash: '0x' + '99'.repeat(32), timestamp: 1_791_143_910 });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: 'x' });

    const log = fillLog(100, BLOCK_A);
    const deliveries = Promise.all([w.handleLog(log), w.handleLog(log)]);
    const rewind = w.validateCursor(); // concurrent rewind mid-delivery
    await Promise.race([
      Promise.all([deliveries, rewind]),
      new Promise((_, rej) => setTimeout(() => rej(new Error('deadlock')), 4000)),
    ]);
    // At most one observation; a stale-generation handler leaves PENDING.
    expect(store.observations().length).toBeLessThanOrEqual(1);
    expect(store.rawLogs().length).toBe(1);
  }, 8000);

  it('7. first-start boundary: handshake-gap log captured by overlap backfill', async () => {
    const store = tempStore();
    // Chain head is 200; the event happened at 190 — inside the 64-block
    // first-start overlap window (during the subscribe handshake).
    const blocks: Blocks = new Map();
    for (let n = 136; n <= 200; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, 'a'), timestamp: 1_791_143_000 + n });
    const gapLog = fillLog(190, blocks.get(190)!.hash);
    const { rpc } = mockRpc(blocks, { logs: [gapLog] });

    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);
    await w.backfillFromCursor(); // no cursor -> first-start overlap scan
    expect(store.observations()).toHaveLength(1);
    expect(store.observations()[0]!.eventId).toBe(`137:${EXCHANGE_V2_STANDARD}:${TX}:7`);
  });

  it('8. reverse-arrival OrdersMatched still cross-checks (aggregate first)', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    // Aggregate FIRST, then a MISMATCHED OrdersMatched arrives later.
    await w.handleLog(fillLog(100, BLOCK_A));
    await w.handleLog(matchedLog(100, BLOCK_A, 999n)); // wrong maker amount
    const q = store.quarantine().filter((x) => x.kind === 'ORDERSMATCHED_MISMATCH');
    expect(q.length).toBe(1);
    expect(q[0]!.detail['errs']).toContain('makerAmountFilled mismatch');

    // And the classic order still works exactly once.
    const store2 = tempStore();
    const w2 = new ChainWatcher(cfg(store2.dir), store2, clock(), mockRpc(blocks).rpc);
    await w2.handleLog(matchedLog(100, BLOCK_A, 999n));
    await w2.handleLog(fillLog(100, BLOCK_A));
    expect(store2.quarantine().filter((x) => x.kind === 'ORDERSMATCHED_MISMATCH').length).toBe(1);
  });
});
