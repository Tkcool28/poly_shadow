/**
 * Poly2 comparison adapter — Phase 4 ONLY.
 *
 * This module is the ONLY place where Poly2's canonical trade identity
 * exists in Poly-Shadow. It is a one-way mapping used by the offline
 * comparison milestone:
 *
 *   Shadow observation  ->  candidate Poly2 canonical key  ->  MATCHED | UNMATCHED
 *
 * Independence rules (Phase 2 review clarification):
 * - The collector (src/shadow/) NEVER imports this module. Shadow's primary
 *   storage and dedup key is the native chain event identity
 *   (chainId:emitter:txHash:logIndex), not Poly2's formula.
 * - An observation that cannot be mapped to a Poly2 record stays visible as
 *   an UNMATCHED observation. It is never discarded, never "repaired".
 * - MAKER_LEG observations map through the same formula; whether Poly2
 *   records them at all is one of the things the comparison exists to find
 *   out.
 *
 * Canonical formula preserved unchanged from Poly2:
 *
 *   data-api:{transactionHash}:{proxyWallet}:{asset}:{size}:{price}:{timestamp}
 *
 * - timestamp = containing block timestamp (Unix seconds), never the V2
 *   order-creation timestamp.
 * - size = shares, price = gross price, rendered via the injectable formatter.
 *
 * OPEN CONTRACT POINT: the exact string rendering of size/price must match
 * Poly2's production `canonical_trade_id` helper byte-for-byte. The default
 * formatter trims trailing zeros (680.780000 -> "680.78"). Before Phase 4
 * comparison goes live, port the production helper's exact formatting from
 * Poly2's read-only exported source and lock it behind fixture tests.
 * Never append logIndex or alter the namespace to resolve collisions —
 * collisions go to quarantine.
 */

import { trimDecimal } from '../shadow/decimal.js';
import type { ObservationRow } from '../shadow/storage.js';

export interface CanonicalInput {
  transactionHash: string;
  proxyWallet: string;
  asset: string;          // tokenId decimal string
  shares: string;         // fixed-decimal string (6 dp)
  price10: string;        // fixed-decimal string (10 dp)
  blockTimestamp: number; // seconds
}

export type FieldFormatter = (fixedDecimal: string) => string;

export function canonicalTradeId(
  input: CanonicalInput,
  fmt: FieldFormatter = trimDecimal,
): string {
  return [
    'data-api',
    input.transactionHash,
    input.proxyWallet,
    input.asset,
    fmt(input.shares),
    fmt(input.price10),
    String(input.blockTimestamp),
  ].join(':');
}

/** Map a stored Shadow observation to its candidate Poly2 canonical key. */
export function toPoly2CanonicalKey(
  obs: ObservationRow,
  fmt: FieldFormatter = trimDecimal,
): string {
  return canonicalTradeId({
    transactionHash: obs.evidence.txHash,
    proxyWallet: obs.wallet,
    asset: obs.tokenId,
    shares: obs.shares,
    price10: obs.price10,
    blockTimestamp: obs.blockTimestamp,
  }, fmt);
}

export type ComparisonVerdict =
  | { status: 'MATCHED'; eventId: string; poly2Key: string }
  | { status: 'UNMATCHED'; eventId: string; poly2Key: string; reason: string };

/**
 * Compare one observation against a set of Poly2 canonical keys (from a
 * read-only Poly2 export). UNMATCHED is a first-class result: the record
 * remains visible as an additional Shadow observation, never dropped.
 */
export function compareToPoly2(
  obs: ObservationRow,
  poly2Keys: ReadonlySet<string>,
  fmt: FieldFormatter = trimDecimal,
): ComparisonVerdict {
  const key = toPoly2CanonicalKey(obs, fmt);
  if (poly2Keys.has(key)) {
    return { status: 'MATCHED', eventId: obs.eventId, poly2Key: key };
  }
  return { status: 'UNMATCHED', eventId: obs.eventId, poly2Key: key, reason: 'NO_POLY2_RECORD' };
}
