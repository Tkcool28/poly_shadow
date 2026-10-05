import { describe, expect, it } from 'vitest';
import {
  canonicalTradeId,
  compareToPoly2,
  toPoly2CanonicalKey,
} from '../src/compare/poly2-adapter.js';
import type { ObservationRow } from '../src/shadow/storage.js';

const obs: ObservationRow = {
  eventId: '137:0xe111180000d2663c0091e4f400237545b87b996b:0x446845c37e85c37b91419c6d201250d6df7df471de2dd680d2cd09f4ca08805b:42',
  role: 'TAKER_AGGREGATE',
  wallet: '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029',
  side: 'BUY',
  tokenId: '12345',
  shares: '680.780000',
  price10: '0.5600000000',
  feeUnits: '0',
  blockTimestamp: 1791143962,
  source: 'CHAIN',
  firstSeenUtc: '2026-01-01T00:00:00.000Z',
  evidence: {
    chainId: 137,
    emitter: '0xe111180000d2663c0091e4f400237545b87b996b',
    txHash: '0x446845c37e85c37b91419c6d201250d6df7df471de2dd680d2cd09f4ca08805b',
    logIndex: 42,
    blockHash: '0xabc',
  },
};

describe('Poly2 comparison adapter (Phase 4; never imported by the collector)', () => {
  it('builds data-api keys with block timestamp (formula unchanged from Poly2)', () => {
    const key = canonicalTradeId({
      transactionHash: '0x446845c37e85c37b91419c6d201250d6df7df471de2dd680d2cd09f4ca08805b',
      proxyWallet: '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029',
      asset: '12345',
      shares: '680.780000',
      price10: '0.5600000000',
      blockTimestamp: 1791143962,
    });
    expect(key).toBe(
      'data-api:0x446845c37e85c37b91419c6d201250d6df7df471de2dd680d2cd09f4ca08805b:' +
      '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029:12345:680.78:0.56:1791143962',
    );
  });

  it('maps an observation to the same candidate key', () => {
    expect(toPoly2CanonicalKey(obs)).toBe(canonicalTradeId({
      transactionHash: obs.evidence.txHash,
      proxyWallet: obs.wallet,
      asset: obs.tokenId,
      shares: obs.shares,
      price10: obs.price10,
      blockTimestamp: obs.blockTimestamp,
    }));
  });

  it('MATCHED when Poly2 recorded the same identity', () => {
    const keys = new Set([toPoly2CanonicalKey(obs)]);
    const v = compareToPoly2(obs, keys);
    expect(v.status).toBe('MATCHED');
    expect(v.eventId).toBe(obs.eventId);
  });

  it('UNMATCHED stays visible, never discarded', () => {
    const v = compareToPoly2(obs, new Set());
    expect(v.status).toBe('UNMATCHED');
    if (v.status === 'UNMATCHED') expect(v.reason).toBe('NO_POLY2_RECORD');
    expect(v.eventId).toBe(obs.eventId); // the Shadow record survives unmatched
  });
});
