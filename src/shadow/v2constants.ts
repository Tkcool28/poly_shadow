/**
 * Poly-Shadow — verified Polymarket CTF Exchange V2 constants (Polygon, chainId 137).
 *
 * Sources (Hermes POLY2_ONCHAIN_SOURCE_FEASIBILITY_V1, 2026-10-04):
 * - Official docs + pinned official repo Polymarket/ctf-exchange-v2
 *   @ ccc0596074f4dfd62c944fbca4de252893b82b4b
 * - PolygonScan-verified deployed source, byte-identical to pinned repo
 * - Matched against actual production receipts (fixtures/v2_fills.json)
 *
 * The third Envio-configured address 0xe2222d002000ba0053cef3375333610f64600036
 * is NOT included: its role was never independently established.
 */

export const CHAIN_ID = 137;

export const EXCHANGE_V2_STANDARD = '0xe111180000d2663c0091e4f400237545b87b996b';
export const EXCHANGE_V2_NEG_RISK = '0xe2222d279d744050d28e00520010520000310f59';

/** All recognized V2 emitters (lowercase). */
export const V2_EXCHANGES: ReadonlySet<string> = new Set([
  EXCHANGE_V2_STANDARD,
  EXCHANGE_V2_NEG_RISK,
]);

/**
 * event OrderFilled(bytes32 indexed orderHash, address indexed maker,
 *   address indexed taker, uint8 side, uint256 tokenId,
 *   uint256 makerAmountFilled, uint256 takerAmountFilled,
 *   uint256 fee, bytes32 builder, bytes32 metadata);
 */
export const TOPIC_ORDER_FILLED_V2 =
  '0xd543adfd945773f1a62f74f0ee55a5e3b9b1a28262980ba90b1a89f2ea84d8ee';

/**
 * event OrdersMatched(bytes32 indexed takerOrderHash,
 *   address indexed takerOrderMaker, uint8 side, uint256 tokenId,
 *   uint256 makerAmountFilled, uint256 takerAmountFilled);
 * Cross-check only — must NEVER produce a trade record.
 */
export const TOPIC_ORDERS_MATCHED_V2 =
  '0x174b3811690657c217184f89418266767c87e4805d09680c39fc9c031c0cab7c';

/** Subscribed topic0 set (full emitter+topic0 mode; see PHASE1_ASSESSMENT §4). */
export const V2_SUBSCRIBE_TOPICS: readonly string[] = [
  TOPIC_ORDER_FILLED_V2,
  TOPIC_ORDERS_MATCHED_V2,
];

/** Side enum encoding on-chain. */
export const SIDE_BUY = 0;
export const SIDE_SELL = 1;
