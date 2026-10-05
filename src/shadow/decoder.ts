/**
 * V2 OrderFilled / OrdersMatched decoder and role classifier.
 *
 * Role model (Hermes feasibility §3, verified against production receipts):
 *   1. Passive maker-order fill:  maker = makerOrder.maker, taker = takerOrder.maker.
 *      If the watched wallet is `maker` here -> MAKER_LEG: a first-class,
 *      separately classified population. Investigating whether Poly2 misses
 *      useful maker-side wallet activity is a core purpose of Shadow.
 *   2. Active taker aggregate:    maker = takerOrder.maker, taker = EXCHANGE address.
 *      All 14/14 reconstructed production trades use this form -> TAKER_AGGREGATE.
 *   3. Wallet appearing as `taker` with another maker -> individual leg of the
 *      wallet's own active order (TAKER_LEG_REDUNDANT): raw evidence is kept,
 *      but it must never become a trade record (the aggregate covers it).
 *   4. OrdersMatched repeats the aggregate -> cross-check only, never a record.
 *
 * Dedup of raw logs is strictly by (chainId, emitter, txHash, logIndex,
 * blockHash). NO tx/wallet-level side suppression (upstream's V1 phantom
 * heuristic) and NO summing of legs + aggregate + OrdersMatched.
 */

import {
  EXCHANGE_V2_NEG_RISK,
  EXCHANGE_V2_STANDARD,
  SIDE_BUY,
  TOPIC_ORDER_FILLED_V2,
  TOPIC_ORDERS_MATCHED_V2,
  V2_EXCHANGES,
} from './v2constants.js';
import { grossPrice10, shares6 } from './decimal.js';

export interface RawLog {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  logIndex: string | number;
  blockNumber: string | number;
  blockHash?: string;
  removed?: boolean;
}

export type FillRole =
  | 'TAKER_AGGREGATE'      // watched wallet = maker, taker = exchange
  | 'MAKER_LEG'            // watched wallet = maker, taker = other wallet (first-class population)
  | 'TAKER_LEG_REDUNDANT'; // watched wallet = taker, maker = other wallet

export interface DecodedOrderFilled {
  kind: 'OrderFilled';
  emitter: string;
  isNegRisk: boolean;
  orderHash: string;
  maker: string;
  taker: string;
  side: 'BUY' | 'SELL';
  tokenId: string;           // full decimal uint256
  makerAmountFilled: bigint; // 6-decimal units
  takerAmountFilled: bigint;
  fee: bigint;
  builder: string;
  metadata: string;
}

export interface DecodedOrdersMatched {
  kind: 'OrdersMatched';
  emitter: string;
  takerOrderHash: string;
  takerOrderMaker: string;
  side: 'BUY' | 'SELL';
  tokenId: string;
  makerAmountFilled: bigint;
  takerAmountFilled: bigint;
}

export type DecodedV2Event = DecodedOrderFilled | DecodedOrdersMatched;

function topicAddress(topic: string): string {
  return '0x' + topic.slice(-40).toLowerCase();
}

function dataWords(data: string): string[] {
  const d = data.startsWith('0x') ? data.slice(2) : data;
  if (d.length % 64 !== 0) throw new Error(`malformed data: ${d.length} hex chars`);
  const out: string[] = [];
  for (let i = 0; i < d.length; i += 64) out.push(d.slice(i, i + 64));
  return out;
}

function wordUint(w: string | undefined): bigint {
  if (w === undefined) throw new Error('missing data word');
  return BigInt('0x' + w);
}

function topicAt(topics: string[], i: number): string {
  const t = topics[i];
  if (t === undefined) throw new Error(`missing topic ${i}`);
  return t;
}

/** Strict V2 decode. Returns null for unknown topics/emitters; throws on malformed V2 data. */
export function decodeV2Log(log: RawLog): DecodedV2Event | null {
  const emitter = log.address.toLowerCase();
  if (!V2_EXCHANGES.has(emitter)) return null;
  if (log.topics.length === 0) return null;
  const topic0 = topicAt(log.topics, 0).toLowerCase();
  const isNegRisk = emitter === EXCHANGE_V2_NEG_RISK;

  if (topic0 === TOPIC_ORDER_FILLED_V2) {
    if (log.topics.length !== 4) throw new Error('OrderFilled: expected 4 topics');
    const w = dataWords(log.data);
    if (w.length !== 7) throw new Error(`OrderFilled: expected 7 data words, got ${w.length}`);
    const side = Number(wordUint(w[0]));
    if (side !== SIDE_BUY && side !== 1) throw new Error(`OrderFilled: bad side ${side}`);
    return {
      kind: 'OrderFilled',
      emitter,
      isNegRisk,
      orderHash: topicAt(log.topics, 1),
      maker: topicAddress(topicAt(log.topics, 2)),
      taker: topicAddress(topicAt(log.topics, 3)),
      side: side === SIDE_BUY ? 'BUY' : 'SELL',
      tokenId: wordUint(w[1]).toString(10),
      makerAmountFilled: wordUint(w[2]),
      takerAmountFilled: wordUint(w[3]),
      fee: wordUint(w[4]),
      builder: '0x' + w[5],
      metadata: '0x' + w[6],
    };
  }

  if (topic0 === TOPIC_ORDERS_MATCHED_V2) {
    if (log.topics.length !== 3) throw new Error('OrdersMatched: expected 3 topics');
    const w = dataWords(log.data);
    if (w.length !== 4) throw new Error(`OrdersMatched: expected 4 data words, got ${w.length}`);
    const side = Number(wordUint(w[0]));
    return {
      kind: 'OrdersMatched',
      emitter,
      takerOrderHash: topicAt(log.topics, 1),
      takerOrderMaker: topicAddress(topicAt(log.topics, 2)),
      side: side === SIDE_BUY ? 'BUY' : 'SELL',
      tokenId: wordUint(w[1]).toString(10),
      makerAmountFilled: wordUint(w[2]),
      takerAmountFilled: wordUint(w[3]),
    };
  }

  return null; // known emitter, foreign event (transfers etc.) — not an error
}

/** Classify a decoded OrderFilled relative to a watched wallet. */
export function classifyFill(
  fill: DecodedOrderFilled,
  watchedWallets: ReadonlySet<string>,
): { wallet: string; role: FillRole } | null {
  const makerWatched = watchedWallets.has(fill.maker);
  const takerWatched = watchedWallets.has(fill.taker);

  if (makerWatched && (fill.taker === EXCHANGE_V2_STANDARD || fill.taker === EXCHANGE_V2_NEG_RISK)) {
    return { wallet: fill.maker, role: 'TAKER_AGGREGATE' };
  }
  if (makerWatched) return { wallet: fill.maker, role: 'MAKER_LEG' };
  if (takerWatched) return { wallet: fill.taker, role: 'TAKER_LEG_REDUNDANT' };
  return null;
}

/**
 * Gross normalization (Hermes §3):
 *   BUY:  shares = takerAmountFilled / 1e6, gross price = makerAmountFilled / takerAmountFilled
 *   SELL: shares = makerAmountFilled / 1e6, gross price = takerAmountFilled / makerAmountFilled
 * Fee is kept as separate collateral units — never netted into gross identity.
 */
export function normalizeGross(fill: DecodedOrderFilled): {
  shares: string;       // 6 dp exact
  price10: string;      // 10 dp half-up
  feeUnits: string;
} {
  const { makerAmountFilled: m, takerAmountFilled: t } = fill;
  if (m <= 0n || t <= 0n) throw new Error('zero-amount fill (not a real fill)');
  if (fill.side === 'BUY') {
    return { shares: shares6(t), price10: grossPrice10(m, t), feeUnits: fill.fee.toString(10) };
  }
  return { shares: shares6(m), price10: grossPrice10(t, m), feeUnits: fill.fee.toString(10) };
}

/**
 * Cross-check an aggregate against its OrdersMatched twin:
 * same order hash, wallet, side, token, and amounts. Returns discrepancy list.
 */
export function crossCheckAggregate(
  agg: DecodedOrderFilled,
  om: DecodedOrdersMatched,
): string[] {
  const errs: string[] = [];
  if (agg.orderHash.toLowerCase() !== om.takerOrderHash.toLowerCase()) errs.push('orderHash mismatch');
  if (agg.maker !== om.takerOrderMaker) errs.push('wallet mismatch');
  if (agg.side !== om.side) errs.push('side mismatch');
  if (agg.tokenId !== om.tokenId) errs.push('tokenId mismatch');
  if (agg.makerAmountFilled !== om.makerAmountFilled) errs.push('makerAmountFilled mismatch');
  if (agg.takerAmountFilled !== om.takerAmountFilled) errs.push('takerAmountFilled mismatch');
  return errs;
}
