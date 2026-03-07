import { ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize, OrderBookSummary } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createJobLogger } from '../../lib/logger';
import { config } from '../../config/env';
import type { ExecuteOrderResult } from '../trade-executor';

const log = createJobLogger('scalp-executor');

// Own CLOB client for live mode
let liveClient: ClobClient | null = null;

// Read-only CLOB client for paper mode (no auth needed)
let readOnlyClient: ClobClient | null = null;

// Market metadata cache (tickSize + negRisk)
const metadataCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>();
const METADATA_CACHE_MAX = 500;

// Order book cache (3s TTL)
const orderBookCache = new Map<string, { data: OrderBookSummary; fetchedAt: number }>();
const ORDER_BOOK_CACHE_TTL_MS = 3000;

export interface ScalpOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // USD for BUY, shares for SELL
  price: number;  // limit price
  negRisk?: boolean;
  tickSize?: TickSize;
}

/**
 * Initialize the scalp executor.
 * - Paper mode: readOnlyClient only (no auth)
 * - Live mode: creates ClobClient with SCALP_* or ARB_* credentials
 */
export async function initScalpExecutor(): Promise<void> {
  // Always create read-only client for orderbook reads
  readOnlyClient = new ClobClient('https://clob.polymarket.com', 137);

  if (config.SCALP_IS_PAPER) {
    log.info('Scalp executor ready (paper mode + real orderbook validation)');
    return;
  }

  // Live mode: try SCALP_* credentials first, fall back to ARB_*
  const privateKey = config.SCALP_PRIVATE_KEY || config.ARB_PRIVATE_KEY;
  const apiKey = config.SCALP_CLOB_API_KEY || config.ARB_CLOB_API_KEY;
  const apiSecret = config.SCALP_CLOB_API_SECRET || config.ARB_CLOB_API_SECRET;
  const apiPassphrase = config.SCALP_CLOB_API_PASSPHRASE || config.ARB_CLOB_API_PASSPHRASE;
  const funderAddress = config.SCALP_FUNDER_ADDRESS || config.ARB_FUNDER_ADDRESS;
  const sigType = config.SCALP_SIGNATURE_TYPE;

  if (!privateKey || !apiKey || !apiSecret || !apiPassphrase || !funderAddress) {
    throw new Error(
      'Scalp live mode requires SCALP_* or ARB_* CLOB credentials (PRIVATE_KEY, CLOB_API_KEY, etc.)',
    );
  }

  const signer = new Wallet(privateKey);
  const creds: ApiKeyCreds = { key: apiKey, secret: apiSecret, passphrase: apiPassphrase };

  liveClient = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer,
    creds,
    sigType as SignatureType,
    funderAddress,
  );

  // Validate credentials
  try {
    await liveClient.getOpenOrders();
    log.info('Scalp executor initialized (live mode)', {
      address: signer.address,
      funder: funderAddress,
      credSource: config.SCALP_PRIVATE_KEY ? 'SCALP' : 'ARB',
    });
  } catch (err: any) {
    liveClient = null;
    throw new Error(`Scalp CLOB credential validation failed: ${err.message}`);
  }
}

/**
 * Get order book for a token. Works in both paper and live mode.
 */
export async function scalpGetOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  const client = liveClient ?? readOnlyClient;
  if (!client) return null;

  // Check cache
  const cached = orderBookCache.get(tokenId);
  if (cached && Date.now() - cached.fetchedAt < ORDER_BOOK_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const book = await client.getOrderBook(tokenId);
    orderBookCache.set(tokenId, { data: book, fetchedAt: Date.now() });

    // Prune stale entries
    if (orderBookCache.size > 100) {
      const cutoff = Date.now() - 30_000;
      for (const [key, val] of orderBookCache) {
        if (val.fetchedAt < cutoff) orderBookCache.delete(key);
      }
    }

    return book;
  } catch (err: any) {
    log.warn(`Failed to fetch orderbook: ${err.message}`);
    return null;
  }
}

/**
 * Execute a scalp order (paper or live based on SCALP_IS_PAPER).
 */
export async function scalpExecuteOrder(params: ScalpOrderParams): Promise<ExecuteOrderResult> {
  if (config.SCALP_IS_PAPER) {
    return paperExecuteOrder(params);
  }
  return liveExecuteOrder(params);
}

// ─── Paper execution ───

function paperExecuteOrder(params: ScalpOrderParams): ExecuteOrderResult {
  const { tokenId, side, amount, price } = params;

  // Simulate slippage
  const slippagePrice = side === 'BUY'
    ? Math.min(price + (1 - price) * (config.SCALP_PAPER_SLIPPAGE_FRACTION / 2), 0.99)
    : Math.max(price - price * (config.SCALP_PAPER_SLIPPAGE_FRACTION / 2), 0.01);

  let filledSize: number;
  let filledPrice: number;
  let estimatedFee: number;

  if (side === 'BUY') {
    const grossShares = amount / slippagePrice;
    const feeShares = paperCalculateFee(grossShares, slippagePrice);
    const netShares = grossShares - feeShares;

    filledSize = netShares;
    filledPrice = amount / netShares;
    estimatedFee = feeShares * slippagePrice;
  } else {
    const grossUsd = amount * slippagePrice;
    const feeUsd = paperCalculateFee(amount, slippagePrice) * slippagePrice;

    filledSize = amount;
    filledPrice = (grossUsd - feeUsd) / amount;
    estimatedFee = feeUsd;
  }

  log.info('Paper scalp order', {
    tokenId: tokenId.slice(0, 20) + '...',
    side, amount, price, slippagePrice, filledSize, filledPrice, estimatedFee,
  });

  return {
    orderId: `scalp-paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    status: 'FILLED',
    filledPrice,
    filledSize,
    failReason: null,
    transactionHashes: [],
    estimatedFee,
  };
}

function paperCalculateFee(shares: number, price: number): number {
  if (config.SCALP_PAPER_FEE_RATE <= 0) return 0;
  return shares * config.SCALP_PAPER_FEE_RATE * Math.pow(price * (1 - price), config.SCALP_PAPER_FEE_EXPONENT);
}

// ─── Live execution ───

async function getMarketMetadata(tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
  const cached = metadataCache.get(tokenId);
  if (cached) return cached;

  const client = liveClient ?? readOnlyClient;
  if (!client) return { tickSize: '0.01' as TickSize, negRisk: false };

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  const metadata = { tickSize, negRisk };
  metadataCache.set(tokenId, metadata);

  if (metadataCache.size > METADATA_CACHE_MAX) {
    const toRemove = metadataCache.size - METADATA_CACHE_MAX;
    let removed = 0;
    for (const key of metadataCache.keys()) {
      if (removed >= toRemove) break;
      metadataCache.delete(key);
      removed++;
    }
  }

  return metadata;
}

async function liveExecuteOrder(params: ScalpOrderParams): Promise<ExecuteOrderResult> {
  if (!liveClient) {
    return {
      orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
      failReason: 'Live client not initialized', transactionHashes: [],
    };
  }

  const { tokenId, side, amount, price } = params;
  const { tickSize, negRisk } = params.tickSize && params.negRisk !== undefined
    ? { tickSize: params.tickSize as TickSize, negRisk: params.negRisk }
    : await getMarketMetadata(tokenId);

  log.info('Placing scalp FAK order', { tokenId: tokenId.slice(0, 20) + '...', side, amount, price });

  try {
    const response = await liveClient.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        amount,
        price,
      },
      { tickSize, negRisk },
      OrderType.FOK,
    );

    if (response?.success === false || response?.errorMsg) {
      const errorMsg: string = response.errorMsg || 'Unknown order error';
      if (errorMsg.includes('FOK_ORDER_NOT_FILLED')) {
        return { orderId: null, status: 'SKIPPED', filledPrice: null, filledSize: null,
          failReason: 'insufficient liquidity', transactionHashes: [] };
      }
      if (errorMsg.includes('NOT_ENOUGH_BALANCE')) {
        return { orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
          failReason: 'insufficient balance', transactionHashes: [] };
      }
      return { orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
        failReason: errorMsg.slice(0, 500), transactionHashes: [] };
    }

    const orderId = response?.orderID ?? null;
    const txHashes: string[] = response?.transactionsHashes ?? [];
    const makingAmount = parseFloat(response?.makingAmount || '0');
    const takingAmount = parseFloat(response?.takingAmount || '0');

    let filledSize: number | null;
    let filledPrice: number | null;

    if (side === 'BUY') {
      filledSize = makingAmount > 0 ? makingAmount : null;
      filledPrice = makingAmount > 0 && takingAmount > 0 ? takingAmount / makingAmount : null;
      // NegRisk inversion: if price > 1.0, flip convention
      if (filledPrice !== null && filledPrice > 1.0) {
        filledSize = takingAmount > 0 ? takingAmount : null;
        filledPrice = makingAmount > 0 && takingAmount > 0 ? makingAmount / takingAmount : null;
      }
    } else {
      filledSize = takingAmount > 0 ? takingAmount : null;
      filledPrice = takingAmount > 0 && makingAmount > 0 ? makingAmount / takingAmount : null;
      if (filledPrice !== null && filledPrice > 1.0) {
        filledSize = makingAmount > 0 ? makingAmount : null;
        filledPrice = takingAmount > 0 && makingAmount > 0 ? takingAmount / makingAmount : null;
      }
    }

    // Guard ghost fills
    if (!filledSize || !filledPrice || filledPrice > 1.0) {
      log.warn('Scalp ghost fill detected', { orderId, side, makingAmount, takingAmount });
      return { orderId, status: 'FAILED', filledPrice: null, filledSize: null,
        failReason: 'ghost fill', transactionHashes: txHashes };
    }

    log.info('Scalp order filled', { orderId, filledSize, filledPrice });
    return { orderId, status: 'FILLED', filledPrice, filledSize, failReason: null, transactionHashes: txHashes };
  } catch (err: any) {
    const msg: string = err.message || String(err);
    // Rate limit retry
    if (msg.includes('429') || msg.includes('rate limit')) {
      log.warn('Scalp order rate limited, retrying in 1s...');
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await liveExecuteOrder(params);
      } catch (retryErr: any) {
        return { orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
          failReason: `Rate limit retry failed: ${retryErr.message?.slice(0, 300)}`, transactionHashes: [] };
      }
    }
    return { orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
      failReason: msg.slice(0, 500), transactionHashes: [] };
  }
}
