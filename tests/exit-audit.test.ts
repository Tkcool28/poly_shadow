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
    dataApiBaseUrl: 'https://data-api.test',
    tradesPollMs: 10_000,
    activityPollMs: 30_000,
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
    expect(store.rawLogs()).toHaveLength(1); // valid unwatched fill is now filtered before retention

    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0); // no replay storm
    expect(store.observations()).toHaveLength(0);
    expect(store.rawLogs()).toHaveLength(1); // valid unwatched fill is now filtered before retention
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

  it('5. missing ancestor: fail-closed recovery-required, cursor NOT advanced, no resume', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[1000, { hash: BLOCK_B, timestamp: 1_791_143_962 }]]);
    // No stored checkpoint hashes at all -> no proof of any ancestor.
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 1000, blockHash: BLOCK_A, updatedAtUtc: '2026-01-01T00:00:00.000Z' });
    for (let n = 872; n <= 1000; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: 1 });

    const w = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    await w.validateCursor();

    // Truly fail-closed: cursor is NOT advanced to an unverified provider
    // hash, nothing is tombstoned, and automatic recovery does not resume.
    const cursor = store.readCursor('https://rpc.test')!;
    expect(cursor.blockNumber).toBe(1000);
    expect(cursor.blockHash).toBe(BLOCK_A);
    expect(w.recoveryRequired).toBe(true);
    const q = store.quarantine().filter((x) => x.kind === 'REORG_ANOMALY');
    expect(q.some((x) => x.detail['recoveryRequired'] === true)).toBe(true);
    expect(q.some((x) => x.detail['ancestorVerified'] === false)).toBe(true);
    expect(store.tombstones()).toHaveLength(0);

    // Automatic scan/backfill must not resume from the unverified point.
    await w.backfillFromCursor();
    expect(store.readCursor('https://rpc.test')!.blockNumber).toBe(1000);
    expect(store.rawLogs()).toHaveLength(0);
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

  it('9. PENDING -> REMOVED_FLAG -> processRetries: zero observation', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc, state } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    state.failNext = true;
    await w.handleLog(fillLog(100, BLOCK_A));            // PENDING + queued
    await w.handleLog({ ...fillLog(100, BLOCK_A), removed: true }); // tombstone
    await w.processRetries();                            // must NOT observe
    expect(store.observations()).toHaveLength(0);
    const idx = store.dispositionIndex();
    expect([...idx.values()]).toContain('REMOVED_INVALID');
    expect([...idx.values()]).not.toContain('OBSERVED');
  });

  it('10. PENDING -> REMOVED_FLAG -> new process -> replay: zero observation', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([[100, { hash: BLOCK_A, timestamp: 1_791_143_962 }]]);
    const { rpc, state } = mockRpc(blocks);
    const w1 = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    state.failNext = true;
    await w1.handleLog(fillLog(100, BLOCK_A));           // durable PENDING
    await w1.handleLog({ ...fillLog(100, BLOCK_A), removed: true });
    // Process dies; a new watcher must not replay the removed identity.
    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0);
    expect(store.observations()).toHaveLength(0);
    expect([...store.dispositionIndex().values()]).toContain('REMOVED_INVALID');
  });

  it('11. PENDING old blockHash -> REORG_REWIND -> new-blockHash re-inclusion observes exactly once', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([
      [99, { hash: '0x' + '99'.repeat(32), timestamp: 1_791_143_910 }],
      [100, { hash: BLOCK_A, timestamp: 1_791_143_962 }],
    ]);
    const { rpc, state } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    state.failNext = true;
    await w.handleLog(fillLog(100, BLOCK_A));            // PENDING on old fork
    store.appendBlockHash({ chainId: 137, blockNumber: 99, blockHash: '0x' + '99'.repeat(32), firstSeenUtc: 'x' });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: 'x' });
    blocks.set(100, { hash: BLOCK_B, timestamp: 1_791_143_970 }); // fork
    await w.validateCursor();                            // proved rewind to 99

    // Old identity is tombstoned: replay terminalizes it, never observes.
    const w2 = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    expect(await w2.replayIncompleteFromStore()).toBe(0);
    expect(store.observations()).toHaveLength(0);

    // Re-inclusion under the NEW blockHash is new evidence — observed once.
    await w2.handleLog(fillLog(100, BLOCK_B));
    await w2.handleLog(fillLog(100, BLOCK_B));           // dup delivery
    expect(store.observations()).toHaveLength(1);
    expect(store.observations()[0]!.evidence.blockHash).toBe(BLOCK_B);
  });

  it('12. default chunk + shallow reorg: dense checkpoints PROVE a stored ancestor', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map();
    for (let n = 1; n <= 200; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, 'c'), timestamp: 1_791_143_000 + n });
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    await w.scanRange(1, 200); // single 200-block chunk, dense checkpoints
    const cursor = store.readCursor('https://rpc.test')!;
    expect(cursor.blockNumber).toBe(200);

    // Shallow reorg 6 blocks behind the cursor: a stored checkpoint inside
    // the 128-block walk must match (spacing 16 << lookback 128).
    blocks.set(200, { hash: BLOCK_B, timestamp: 1_791_144_000 });
    await w.validateCursor();
    expect(w.recoveryRequired).toBe(false);
    const rewound = store.readCursor('https://rpc.test')!;
    expect(rewound.blockNumber).toBeLessThan(200);
    expect(rewound.blockNumber).toBeGreaterThanOrEqual(200 - 128);
    // The rewound target is a genuinely stored, provider-verified checkpoint.
    expect(blocks.get(rewound.blockNumber)!.hash).toBe(rewound.blockHash);
    const q = store.quarantine().filter((x) => x.kind === 'REORG_ANOMALY');
    expect(q.some((x) => x.detail['ancestorVerified'] === true)).toBe(true);
    expect(q.some((x) => x.detail['recoveryRequired'] === true)).toBe(false);
  });

  it('13. no ancestor within window: cursor not advanced and automatic scan does not resume', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map();
    // Divergence older than the lookback: only blocks far below agree, and
    // no checkpoints were stored at all.
    for (let n = 900; n <= 1000; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, 'd'), timestamp: 1 });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 1000, blockHash: BLOCK_A, updatedAtUtc: 'x' });
    blocks.set(1000, { hash: BLOCK_B, timestamp: 2 });

    const w = new ChainWatcher(cfg(store.dir), store, clock(), mockRpc(blocks).rpc);
    await w.backfillFromCursor(); // full automatic path
    expect(w.recoveryRequired).toBe(true);
    expect(store.readCursor('https://rpc.test')!.blockNumber).toBe(1000); // unmoved
    expect(store.rawLogs()).toHaveLength(0);                              // no scan
    expect(store.observations()).toHaveLength(0);
  });

  it('14. after proved rewind: old fork rows tombstoned, replacement observed once', async () => {
    const store = tempStore();
    const blocks: Blocks = new Map([
      [99, { hash: '0x' + '99'.repeat(32), timestamp: 1_791_143_910 }],
      [100, { hash: BLOCK_A, timestamp: 1_791_143_962 }],
    ]);
    const { rpc } = mockRpc(blocks);
    const w = new ChainWatcher(cfg(store.dir), store, clock(), rpc);

    await w.handleLog(fillLog(100, BLOCK_A));            // observed on old fork
    expect(store.observations()).toHaveLength(1);
    store.appendBlockHash({ chainId: 137, blockNumber: 99, blockHash: '0x' + '99'.repeat(32), firstSeenUtc: 'x' });
    store.advanceCursor({ provider: 'https://rpc.test', blockNumber: 100, blockHash: BLOCK_A, updatedAtUtc: 'x' });
    blocks.set(100, { hash: BLOCK_B, timestamp: 1_791_143_970 }); // fork
    await w.validateCursor();                            // proved rewind to 99

    const id = { chainId: 137, emitter: EXCHANGE_V2_STANDARD, txHash: TX, logIndex: 7 };
    expect(store.logStatus(id)).toBe('REMOVED');         // old fork tombstoned
    // Replacement under the new blockHash: observed exactly once.
    await w.handleLog(fillLog(100, BLOCK_B));
    await w.handleLog(fillLog(100, BLOCK_B));
    expect(store.observations()).toHaveLength(2);
    expect(store.observations()[1]!.evidence.blockHash).toBe(BLOCK_B);
    expect(store.logStatus(id)).toBe('REINCLUDED');
  });

  it('15. provider head lag: invalid-range eth_getLogs clamps to fresh head, scan completes', async () => {
    const store = tempStore();
    // Node serving eth_getLogs is BEHIND the head advertised earlier:
    // toBlock beyond 150 -> range error; head re-fetch reports 150.
    const blocks: Blocks = new Map();
    for (let n = 100; n <= 150; n++) blocks.set(n, { hash: '0x' + n.toString(16).padStart(64, 'e'), timestamp: 1_791_143_000 + n });
    const gapLog = fillLog(140, blocks.get(140)!.hash);
    const rpc = async <T>(url: string, method: string, params: unknown[]): Promise<T> => {
      if (method === 'eth_getLogs') {
        const p = params[0] as { toBlock: string };
        if (parseInt(p.toBlock, 16) > 150) throw new Error('invalid block range params');
        return [gapLog] as T;
      }
      if (method === 'eth_getBlockByNumber') {
        const n = parseInt(params[0] as string, 16);
        const b = blocks.get(n);
        if (!b) throw new Error(`no block ${n}`);
        return { hash: b.hash, timestamp: '0x' + b.timestamp.toString(16) } as T;
      }
      if (method === 'eth_blockNumber') return '0x96' as T; // 150
      throw new Error(`unexpected ${method}`);
    };
    const w = new ChainWatcher(cfg(store.dir), store, clock(),
      rpc as typeof import('../src/shadow/egress.js').rpcCall);
    // Caller believed the head was 190; the lagging node rejects the range.
    await w.scanRange(100, 190);
    // Scan completed to the CLAMPED head; the log at 140 was captured.
    expect(store.observations()).toHaveLength(1);
    expect(store.readCursor('https://rpc.test')!.blockNumber).toBe(150);
    // No failure quarantine: head lag is handled, not an anomaly.
    expect(store.quarantine().filter((q) => q.kind === 'TRANSIENT_FAILURE')).toHaveLength(0);
  });
});
