/**
 * Canonical trade identity — formula preserved unchanged from Poly2:
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

import { trimDecimal } from './decimal.js';

export interface CanonicalInput {
  transactionHash: string;
  proxyWallet: string;
  asset: string;      // tokenId decimal string
  shares: string;     // fixed-decimal string (6 dp)
  price10: string;    // fixed-decimal string (10 dp)
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
