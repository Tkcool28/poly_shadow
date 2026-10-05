/**
 * Decoder tests against REAL production receipts (Hermes sample, 2026-10-04).
 * Fixtures: fixtures/v2_fills.json — trimmed V2 OrderFilled/OrdersMatched logs
 * from five actual Polygon transactions covering: standard + neg-risk,
 * BUY + SELL, exact + 10-dp-rounding prices, nonzero fees, and the 37-fill
 * multi-fill transaction.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  decodeV2Log, classifyFill, normalizeGross, crossCheckAggregate,
  type DecodedOrderFilled, type DecodedOrdersMatched,
} from '../src/shadow/decoder.js';
import { TOPIC_ORDER_FILLED_V2, TOPIC_ORDERS_MATCHED_V2 } from '../src/shadow/v2constants.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'fixtures', 'v2_fills.json'), 'utf8'));

describe('V2 decoder on production receipts', () => {
  for (const fx of fixtures) {
    it(`reconstructs trade ${fx.sourceTradeId} (${fx.expectedSide}, ${fx.expectedNegRisk ? 'neg-risk' : 'standard'})`, () => {
      const watched = new Set([fx.wallet]);
      const fills: { fill: DecodedOrderFilled; logIndex: number }[] = [];
      const matched: DecodedOrdersMatched[] = [];

      for (const log of fx.logs) {
        const d = decodeV2Log(log);
        expect(d, `every fixture log must decode (topic ${log.topics[0].slice(0, 10)})`).not.toBeNull();
        if (d!.kind === 'OrderFilled') fills.push({ fill: d as DecodedOrderFilled, logIndex: Number(log.logIndex) });
        else matched.push(d as DecodedOrdersMatched);
      }

      // Exactly one taker aggregate for the watched wallet
      const aggregates = fills.filter(
        ({ fill }) => classifyFill(fill, watched)?.role === 'TAKER_AGGREGATE',
      );
      expect(aggregates).toHaveLength(1);

      const agg = aggregates[0]!.fill;
      expect(agg.side).toBe(fx.expectedSide);
      expect(agg.tokenId).toBe(fx.expectedTokenId);
      expect(agg.isNegRisk).toBe(fx.expectedNegRisk);
      expect(agg.fee.toString()).toBe(fx.expectedFee);

      const norm = normalizeGross(agg);
      expect(norm.shares).toBe(fx.expectedShares);
      expect(norm.price10).toBe(fx.expectedPrice10);

      // Exactly one OrdersMatched twin, and it must agree on all fields
      expect(matched).toHaveLength(1);
      expect(crossCheckAggregate(agg, matched[0]!)).toEqual([]);
    });
  }

  it('37-fill transaction: 36 redundant legs + 1 aggregate, no double counting', () => {
    const fx = fixtures.find((f: any) => f.sourceTradeId === '55718')!;
    const watched = new Set([fx.wallet]);
    const roles = fx.logs
      .filter((l: any) => l.topics[0].toLowerCase() === TOPIC_ORDER_FILLED_V2)
      .map((l: any) => {
        const d = decodeV2Log(l)! as DecodedOrderFilled;
        return classifyFill(d, watched)?.role ?? null;
      });
    expect(roles.filter((r: string | null) => r === 'TAKER_AGGREGATE')).toHaveLength(1);
    expect(roles.filter((r: string | null) => r === 'TAKER_LEG_REDUNDANT')).toHaveLength(36);
    expect(roles.filter((r: string | null) => r === 'MAKER_LEG')).toHaveLength(0);
  });

  it('rejects foreign emitters and foreign topics without throwing', () => {
    const fake = {
      address: '0x000000000000000000000000000000000000dead',
      topics: [TOPIC_ORDER_FILLED_V2, '0x' + '00'.repeat(32), '0x' + '00'.repeat(32), '0x' + '00'.repeat(32)],
      data: '0x' + '00'.repeat(64 * 7),
      transactionHash: '0x00', logIndex: '0x0', blockNumber: '0x0',
    };
    expect(decodeV2Log(fake)).toBeNull();
    const wrongTopic = { ...fake, address: '0xe111180000d2663c0091e4f400237545b87b996b', topics: [TOPIC_ORDERS_MATCHED_V2] };
    expect(() => decodeV2Log(wrongTopic)).toThrow(); // right emitter, malformed OrdersMatched (needs 3 topics)
  });
});
