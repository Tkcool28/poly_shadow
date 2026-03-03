import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import type { OrderBookSummary } from '@polymarket/clob-client';
import type { ExecuteOrderParams, ExecuteOrderResult } from './trade-executor';

const log = createJobLogger('paper-executor');

export async function initialize(): Promise<void> {
  log.info('Paper executor ready (no wallet credentials needed)');
}

/**
 * Simulate fill price: BUY fills at half the upside-fraction tolerance (expected average).
 * SELL fills at detected price — no slippage floor, consistent with live executor.
 */
function simulateSlippagePrice(detectedPrice: number, side: 'BUY' | 'SELL'): number {
  if (side === 'BUY') {
    const avgFraction = config.SLIPPAGE_UPSIDE_FRACTION / 2;
    const limit = detectedPrice + (1 - detectedPrice) * avgFraction;
    return Math.min(limit, 0.99);
  }
  // SELL: simulate filling at detected price (no downward slippage — exit at signal price)
  return detectedPrice;
}

/**
 * Calculate Polymarket taker fee using their formula:
 *   fee = shares × feeRate × (price × (1 - price))^exponent
 *
 * Most markets have 0 fees. Fee-bearing markets:
 *   Sports (NCAAB, Serie A): feeRate=0.0175, exponent=1 (peak 0.44% at p=0.50)
 *   Crypto (5/15-min):       feeRate=0.25,   exponent=2 (peak 1.56% at p=0.50)
 */
function calculateFee(shares: number, price: number): number {
  if (config.PAPER_TRADE_FEE_RATE <= 0) return 0;
  return shares * config.PAPER_TRADE_FEE_RATE * Math.pow(price * (1 - price), config.PAPER_TRADE_FEE_EXPONENT);
}

export async function executeMarketOrder(
  params: ExecuteOrderParams,
  orderBook?: OrderBookSummary | null,
): Promise<ExecuteOrderResult> {
  const { tokenId, side, amount, detectedPrice } = params;

  // Paper FOK validation: check real order book liquidity before filling
  if (side === 'BUY' && orderBook) {
    const maxPrice = detectedPrice;
    const availableShares = (orderBook.asks ?? [])
      .filter((a) => parseFloat(a.price) <= maxPrice)
      .reduce((sum, a) => sum + parseFloat(a.size), 0);

    const requiredShares = amount / maxPrice;
    if (availableShares < requiredShares) {
      log.info('Paper FOK rejected: insufficient liquidity', {
        tokenId: tokenId.slice(0, 20) + '...',
        side, amount, detectedPrice,
        availableShares: availableShares.toFixed(0),
        requiredShares: requiredShares.toFixed(0),
      });
      return {
        orderId: null,
        status: 'SKIPPED',
        filledPrice: null,
        filledSize: null,
        failReason: `paper FOK: insufficient liquidity (${availableShares.toFixed(0)} < ${requiredShares.toFixed(0)} shares at ≤$${maxPrice})`,
        transactionHashes: [],
      };
    }
  }

  const simulatedPrice = simulateSlippagePrice(detectedPrice, side);

  let filledSize: number;
  let filledPrice: number;
  let estimatedFee: number;

  if (side === 'BUY') {
    // BUY: amount is USD. Shares = amount / price, minus fee shares.
    const grossShares = amount / simulatedPrice;
    const feeShares = calculateFee(grossShares, simulatedPrice);
    const netShares = grossShares - feeShares;

    filledSize = netShares;
    filledPrice = amount / netShares; // effective price per share (higher due to fee)
    estimatedFee = feeShares * simulatedPrice; // fee in USD terms
  } else {
    // SELL: amount is shares. USD received = shares × price, minus fee in USDC.
    const grossUsd = amount * simulatedPrice;
    const feeUsd = calculateFee(amount, simulatedPrice) * simulatedPrice;

    filledSize = amount; // shares sold
    filledPrice = (grossUsd - feeUsd) / amount; // effective price (lower due to fee)
    estimatedFee = feeUsd;
  }

  log.info('Paper trade executed', {
    tokenId: tokenId.slice(0, 20) + '...',
    side,
    amount,
    detectedPrice,
    simulatedPrice,
    filledSize,
    filledPrice,
    estimatedFee: estimatedFee > 0 ? estimatedFee : undefined,
  });

  return {
    orderId: `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'FILLED',
    filledPrice,
    filledSize,
    failReason: null,
    transactionHashes: [],
    estimatedFee,
  };
}
