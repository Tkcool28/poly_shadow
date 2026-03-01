import { ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('trade-executor');

export interface ExecuteOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // BUY: USD amount, SELL: shares
  detectedPrice: number; // price from detected trade (for slippage calc)
  _isRetry?: boolean; // internal: prevent infinite retry recursion
}

export interface ExecuteOrderResult {
  orderId: string | null;
  status: 'FILLED' | 'FAILED' | 'SKIPPED';
  filledPrice: number | null;
  filledSize: number | null;
  failReason: string | null;
  transactionHashes: string[];
}

// Market metadata cache (tickSize + negRisk don't change per market)
const metadataCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>();

let client: ClobClient | null = null;

export async function initialize(): Promise<void> {
  if (!config.PRIVATE_KEY || !config.CLOB_API_KEY || !config.CLOB_API_SECRET || !config.CLOB_API_PASSPHRASE || !config.FUNDER_ADDRESS) {
    throw new Error(
      'Copy-trade requires PRIVATE_KEY, CLOB_API_KEY, CLOB_API_SECRET, CLOB_API_PASSPHRASE, and FUNDER_ADDRESS',
    );
  }

  const signer = new Wallet(config.PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: config.CLOB_API_KEY,
    secret: config.CLOB_API_SECRET,
    passphrase: config.CLOB_API_PASSPHRASE,
  };

  client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer,
    creds,
    config.SIGNATURE_TYPE as SignatureType,
    config.FUNDER_ADDRESS,
  );

  // Validate credentials with a lightweight call
  try {
    await client.getOpenOrders();
    log.info('CLOB client initialized', {
      address: signer.address,
      funder: config.FUNDER_ADDRESS,
      signatureType: config.SIGNATURE_TYPE,
    });
  } catch (err: any) {
    throw new Error(`CLOB client credential validation failed: ${err.message}`);
  }
}

async function getMarketMetadata(tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
  const cached = metadataCache.get(tokenId);
  if (cached) return cached;

  if (!client) throw new Error('CLOB client not initialized');

  const [tickSize, negRisk] = await Promise.all([
    client.getTickSize(tokenId),
    client.getNegRisk(tokenId),
  ]);

  const metadata = { tickSize, negRisk };
  metadataCache.set(tokenId, metadata);
  return metadata;
}

function calculateSlippagePrice(detectedPrice: number, side: 'BUY' | 'SELL'): number {
  const slippageMultiplier = config.SLIPPAGE_BPS / 10000;
  if (side === 'BUY') {
    return Math.min(detectedPrice * (1 + slippageMultiplier), 0.99);
  }
  return Math.max(detectedPrice * (1 - slippageMultiplier), 0.01);
}

export async function executeMarketOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  if (!client) throw new Error('CLOB client not initialized');

  const { tokenId, side, amount, detectedPrice } = params;
  const slippagePrice = calculateSlippagePrice(detectedPrice, side);

  log.info('Placing FOK market order', {
    tokenId: tokenId.slice(0, 20) + '...',
    side,
    amount,
    detectedPrice,
    slippagePrice,
  });

  try {
    const { tickSize, negRisk } = await getMarketMetadata(tokenId);

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
        log.warn('Insufficient balance for copy trade', { tokenId, side, amount });
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

    // Parse fill info from response
    const orderId = response?.orderID ?? null;
    const txHashes: string[] = response?.transactionsHashes ?? [];
    const makingAmount = parseFloat(response?.makingAmount || '0');
    const takingAmount = parseFloat(response?.takingAmount || '0');

    // For BUY: filledSize = makingAmount (shares received), filledPrice = takingAmount/makingAmount
    // For SELL: filledSize = takingAmount (USDC received), filledPrice = takingAmount/makingAmount
    const filledSize = makingAmount > 0 ? makingAmount : null;
    const filledPrice = makingAmount > 0 && takingAmount > 0 ? takingAmount / makingAmount : null;

    log.info('Order filled', {
      orderId,
      status: response?.status,
      filledSize,
      filledPrice,
      txHashes: txHashes.length,
    });

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

    // Rate limit — retry once (non-recursive to avoid infinite loop)
    if ((msg.includes('429') || msg.includes('rate limit')) && !params._isRetry) {
      log.warn('Rate limited on order placement, retrying in 1s...');
      await new Promise((r) => setTimeout(r, 1000));
      try {
        return await executeMarketOrder({ ...params, _isRetry: true });
      } catch (retryErr: any) {
        return {
          orderId: null,
          status: 'FAILED',
          filledPrice: null,
          filledSize: null,
          failReason: `Rate limit retry failed: ${retryErr.message?.slice(0, 300)}`,
          transactionHashes: [],
        };
      }
    }

    return {
      orderId: null,
      status: 'FAILED',
      filledPrice: null,
      filledSize: null,
      failReason: msg.slice(0, 500),
      transactionHashes: [],
    };
  }
}
