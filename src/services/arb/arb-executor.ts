import { ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize, OrderBookSummary } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createJobLogger } from '../../lib/logger';
import { config } from '../../config/env';
import {
  executeMarketOrder as sharedExecuteOrder,
  isLiveReady as sharedIsLiveReady,
} from '../trade-executor';
import { executeMarketOrder as paperExecuteOrder } from '../paper-executor';
import type { ExecuteOrderParams, ExecuteOrderResult } from '../trade-executor';

const log = createJobLogger('arb-executor');

// Arb's own CLOB client (null if using shared copy-trade client)
let ownClient: ClobClient | null = null;
let usingOwnWallet = false;

// Read-only CLOB client for paper mode order book checks (no auth needed)
let readOnlyClient: ClobClient | null = null;

// Market metadata cache (tickSize + negRisk) — pruned at 500 entries
const metadataCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>();
const METADATA_CACHE_MAX = 500;

// Order book cache — prevents redundant API calls across engines ticking in the same second
const orderBookCache = new Map<string, { data: OrderBookSummary; fetchedAt: number }>();
const ORDER_BOOK_CACHE_TTL_MS = 3000; // 3s per token

/**
 * Initialize the arb executor.
 * - If ARB wallet credentials are set → creates its own ClobClient
 * - If not → validates the shared copy-trade client is available
 * - Paper mode doesn't need any client
 */
export async function initArbExecutor(): Promise<void> {
  if (config.ARB_IS_PAPER) {
    // getOrderBook is a public GET — no signer or API keys needed
    readOnlyClient = new ClobClient('https://clob.polymarket.com', 137);
    log.info('Arb executor ready (paper mode + real order book validation)');
    return;
  }

  // Check for arb-specific wallet credentials
  if (config.ARB_PRIVATE_KEY && config.ARB_CLOB_API_KEY && config.ARB_CLOB_API_SECRET
      && config.ARB_CLOB_API_PASSPHRASE && config.ARB_FUNDER_ADDRESS) {
    // Create arb's own CLOB client
    const signer = new Wallet(config.ARB_PRIVATE_KEY);
    const creds: ApiKeyCreds = {
      key: config.ARB_CLOB_API_KEY,
      secret: config.ARB_CLOB_API_SECRET,
      passphrase: config.ARB_CLOB_API_PASSPHRASE,
    };

    ownClient = new ClobClient(
      'https://clob.polymarket.com',
      137,
      signer,
      creds,
      config.ARB_SIGNATURE_TYPE as SignatureType,
      config.ARB_FUNDER_ADDRESS,
    );

    // Validate credentials
    try {
      await ownClient.getOpenOrders();
      usingOwnWallet = true;
      log.info('Arb executor initialized with SEPARATE wallet', {
        address: signer.address,
        funder: config.ARB_FUNDER_ADDRESS,
      });
    } catch (err: any) {
      ownClient = null;
      throw new Error(`Arb CLOB credential validation failed: ${err.message}`);
    }
    return;
  }

  // No arb-specific credentials — fall back to shared copy-trade client
  if (sharedIsLiveReady()) {
    usingOwnWallet = false;
    log.info('Arb executor using SHARED copy-trade wallet');
  } else {
    throw new Error(
      'Arb live mode requires either ARB_PRIVATE_KEY + ARB_CLOB_API_* credentials, ' +
      'or a running copy-trade CLOB client (PRIVATE_KEY + CLOB_API_*)',
    );
  }
}

/** Whether the arb executor can place live orders. */
export function isArbLiveReady(): boolean {
  if (config.ARB_IS_PAPER) return true; // Paper is always ready
  return ownClient !== null || sharedIsLiveReady();
}

/** Whether arb is using its own wallet vs shared. */
export function isUsingOwnWallet(): boolean {
  return usingOwnWallet;
}

/**
 * Execute an arb order, routing to the appropriate executor.
 */
export async function arbExecuteOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  if (config.ARB_IS_PAPER) {
    // Fetch real order book for paper FOK validation (BUY only — don't gate stop-loss SELLs)
    const orderBook = params.side === 'BUY' ? await arbGetOrderBook(params.tokenId) : null;
    return paperExecuteOrder(params, orderBook);
  }

  if (ownClient) {
    return executeWithClient(ownClient, params);
  }

  // Fall back to shared executor
  return sharedExecuteOrder(params);
}

/**
 * Get order book for a token (for liquidity checks before entry).
 * Works in both live mode (ownClient) and paper mode (readOnlyClient).
 * Returns null if no CLOB client is available.
 */
export async function arbGetOrderBook(tokenId: string): Promise<OrderBookSummary | null> {
  const client = ownClient ?? readOnlyClient;
  if (!client) return null;

  // Check cache
  const cached = orderBookCache.get(tokenId);
  if (cached && Date.now() - cached.fetchedAt < ORDER_BOOK_CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const book = await client.getOrderBook(tokenId);
    orderBookCache.set(tokenId, { data: book, fetchedAt: Date.now() });

    // Prune stale entries (> 30s) when cache grows large
    if (orderBookCache.size > 100) {
      const cutoff = Date.now() - 30_000;
      for (const [key, val] of orderBookCache) {
        if (val.fetchedAt < cutoff) orderBookCache.delete(key);
      }
    }

    return book;
  } catch (err: any) {
    log.warn(`Failed to fetch order book: ${err.message}`);
    return null;
  }
}

// ─── Internal: execute order with a specific ClobClient ───

async function getMarketMetadata(client: ClobClient, tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
  const cached = metadataCache.get(tokenId);
  if (cached) return cached;

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  const metadata = { tickSize, negRisk };
  metadataCache.set(tokenId, metadata);

  // Prune oldest entries if cache exceeds limit
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

async function executeWithClient(client: ClobClient, params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  const { tokenId, side, amount, detectedPrice } = params;

  // Tight slippage for arb — max ARB_MAX_ENTRY_PRICE
  const slippagePrice = side === 'BUY'
    ? Math.min(detectedPrice, config.ARB_MAX_ENTRY_PRICE)
    : Math.max(detectedPrice, 0.01);

  log.info('Placing arb FOK order', {
    tokenId: tokenId.slice(0, 20) + '...',
    side,
    amount,
    slippagePrice,
  });

  try {
    const { tickSize, negRisk } = await getMarketMetadata(client, tokenId);

    const response = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        amount,
        price: slippagePrice,
      },
      { tickSize, negRisk },
      OrderType.FOK,
    );

    if (response?.success === false || response?.errorMsg) {
      const errorMsg: string = response.errorMsg || 'Unknown order error';

      if (errorMsg.includes('FOK_ORDER_NOT_FILLED')) {
        return {
          orderId: null,
          status: 'SKIPPED',
          filledPrice: null,
          filledSize: null,
          failReason: 'insufficient liquidity',
          transactionHashes: [],
        };
      }

      if (errorMsg.includes('NOT_ENOUGH_BALANCE')) {
        log.warn('Insufficient on-chain balance for arb order', { tokenId, side, amount });
        return {
          orderId: null,
          status: 'FAILED',
          filledPrice: null,
          filledSize: null,
          failReason: 'insufficient balance',
          transactionHashes: [],
        };
      }

      return {
        orderId: null,
        status: 'FAILED',
        filledPrice: null,
        filledSize: null,
        failReason: errorMsg.slice(0, 500),
        transactionHashes: [],
      };
    }

    const orderId = response?.orderID ?? null;
    const txHashes: string[] = response?.transactionsHashes ?? [];
    const makingAmount = parseFloat(response?.makingAmount || '0');
    const takingAmount = parseFloat(response?.takingAmount || '0');

    let filledSize: number | null;
    let filledPrice: number | null;

    if (side === 'BUY') {
      // Standard CTF markets: makingAmount = shares received, takingAmount = USDC paid.
      // NegRisk markets invert the convention. Heuristic: try standard first; if
      // price > 1.0 (impossible for prediction markets), flip to negRisk convention.
      filledSize = makingAmount > 0 ? makingAmount : null;
      filledPrice = makingAmount > 0 && takingAmount > 0
        ? takingAmount / makingAmount : null;
      if (filledPrice !== null && filledPrice > 1.0) {
        filledSize = takingAmount > 0 ? takingAmount : null;
        filledPrice = makingAmount > 0 && takingAmount > 0
          ? makingAmount / takingAmount : null;
      }
    } else {
      // SELL: makingAmount = USDC received, takingAmount = shares given
      filledSize = takingAmount > 0 ? takingAmount : null;
      filledPrice = takingAmount > 0 && makingAmount > 0
        ? makingAmount / takingAmount : null;
    }

    // Guard: ghost fill (null/zero amounts) or impossible price for a prediction market
    if (!filledSize || !filledPrice || filledPrice > 1.0) {
      log.warn('Arb ghost fill detected: CLOB success but invalid fill data', {
        orderId,
        side,
        makingAmount: response?.makingAmount,
        takingAmount: response?.takingAmount,
        filledSize,
        filledPrice,
      });
      return {
        orderId,
        status: 'FAILED',
        filledPrice: null,
        filledSize: null,
        failReason: `ghost fill: ${filledPrice != null && filledPrice > 1.0 ? `impossible price ${filledPrice}` : 'no fill amounts'}`,
        transactionHashes: txHashes,
      };
    }

    log.info('Arb order filled', { orderId, filledSize, filledPrice, txHashes: txHashes.length });

    return {
      orderId,
      status: 'FILLED',
      filledPrice,
      filledSize,
      failReason: null,
      transactionHashes: txHashes,
    };
  } catch (err: any) {
    const msg: string = err.message || String(err);

    // Rate limit — single retry
    if ((msg.includes('429') || msg.includes('rate limit')) && !params._isRetry) {
      log.warn('Arb order rate limited, retrying in 1s...');
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await executeWithClient(client, { ...params, _isRetry: true });
      } catch (retryErr: any) {
        return {
          orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
          failReason: `Rate limit retry failed: ${retryErr.message?.slice(0, 300)}`,
          transactionHashes: [],
        };
      }
    }

    return {
      orderId: null, status: 'FAILED', filledPrice: null, filledSize: null,
      failReason: msg.slice(0, 500), transactionHashes: [],
    };
  }
}
