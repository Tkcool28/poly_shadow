import { AssetType, ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { getMidFromCache } from './midpoint-cache';

const log = createJobLogger('trade-executor');

export interface ExecuteOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // BUY: USD amount, SELL: shares
  detectedPrice: number; // price from detected trade (for slippage calc)
  detectionSource?: string; // 'CHAIN', 'POLL', 'WS' — used to skip stale-signal API for fresh signals
  _isRetry?: boolean; // internal: prevent infinite retry recursion
}

export interface ExecuteOrderResult {
  orderId: string | null;
  status: 'FILLED' | 'FAILED' | 'SKIPPED';
  filledPrice: number | null;
  filledSize: number | null;
  failReason: string | null;
  transactionHashes: string[];
  estimatedFee?: number; // paper trades only: estimated fee in USD
}

// Market metadata cache (tickSize + negRisk don't change per market)
const metadataCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>();

let client: ClobClient | null = null;

let consecutiveBalanceFailures = 0;
let balancePaused = false;
const BALANCE_PAUSE_THRESHOLD = 3;

export function isLiveReady(): boolean {
  return client !== null;
}

export function isBalancePaused(): boolean {
  return balancePaused;
}

export function resetBalancePause(): void {
  if (balancePaused) {
    log.info('Balance pause cleared — resuming live trade execution');
  }
  balancePaused = false;
  consecutiveBalanceFailures = 0;
}

export function getClient(): ClobClient | null {
  return client;
}

export async function getWalletBalance(): Promise<{ balance: number } | null> {
  if (!client) return null;
  try {
    const result = await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    return { balance: parseFloat(result?.balance ?? '0') / 1_000_000 };
  } catch (err: any) {
    log.warn(`Failed to fetch wallet balance: ${err.message}`);
    return null;
  }
}

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

/** Pre-warm metadata cache for a batch of tokenIds (parallel, fail-safe). */
export async function preWarmMetadata(tokenIds: string[]): Promise<void> {
  if (!client) return;
  const uncached = tokenIds.filter(id => !metadataCache.has(id));
  if (uncached.length === 0) return;
  await Promise.allSettled(uncached.map(id => getMarketMetadata(id).catch(() => {})));
}

function calculateSlippagePrice(detectedPrice: number, side: 'BUY' | 'SELL'): number {
  if (side === 'BUY') {
    // Fractional: sacrifice a fraction of remaining upside (distance to $1) for execution certainty
    const fractionalSlippage = (1 - detectedPrice) * config.SLIPPAGE_UPSIDE_FRACTION;
    // Absolute floor: ensures minimum tolerance even at high prices where fractional is tiny
    // (e.g., at 0.90 with fraction=0.05: fractional=0.5¢, floor=1¢ → uses 1¢)
    const slippage = Math.max(fractionalSlippage, config.SLIPPAGE_MIN_ABSOLUTE);
    const limit = detectedPrice + slippage;
    return Math.min(limit, 0.99);
  }
  // SELL: accept any market price — we want to exit whenever the signal says sell.
  return 0.01; // CLOB minimum — effectively market order behavior
}

export const CLOB_MIN_ORDER_USD = 1.0; // Polymarket hard minimum per live order

export async function executeMarketOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  if (!client) throw new Error('CLOB client not initialized');

  const { tokenId, side, amount, detectedPrice, detectionSource } = params;

  // Guard: BUY USD amount must meet Polymarket's $1 minimum order size
  if (side === 'BUY' && amount < CLOB_MIN_ORDER_USD) {
    return {
      orderId: null,
      status: 'SKIPPED',
      filledPrice: null,
      filledSize: null,
      failReason: `amount too small for CLOB: $${amount.toFixed(4)} < $${CLOB_MIN_ORDER_USD} minimum`,
      transactionHashes: [],
    };
  }

  // Guard: SELL share amount must be non-zero — floating-point residuals can survive
  // the > 0 check in copy-trade-worker but round to 0 in CLOB integer conversion.
  if (side === 'SELL' && amount < 0.000001) {
    return {
      orderId: null,
      status: 'SKIPPED',
      filledPrice: null,
      filledSize: null,
      failReason: `dust position (${amount.toExponential(2)} shares): CLOB would receive 0 amount`,
      transactionHashes: [],
    };
  }

  // Near-certainty guard (BUY only): signals at ≥ 0.99 have no ask-side liquidity.
  // Our slippage limit caps at 0.99; sellers won't offer at 99¢ when outcome is
  // near-certain. Every FOK at this price fails unconditionally — skip immediately.
  if (side === 'BUY' && detectedPrice >= 0.99) {
    return {
      orderId: null,
      status: 'SKIPPED',
      filledPrice: null,
      filledSize: null,
      failReason: 'near-certainty price (>=0.99): no ask-side liquidity available',
      transactionHashes: [],
    };
  }

  const slippagePrice = calculateSlippagePrice(detectedPrice, side);

  // Stale-signal guard (BUY only): skip if the market has clearly collapsed.
  // Two conditions — either triggers a skip:
  //   1. currentMid <= 0.01: market at near-zero floor (expiring/outcome determined)
  //   2. currentMid < detectedPrice * 0.30: price has fallen >70% from signal
  // Threshold lowered from 0.05 to 0.005 to protect penny-price signals.
  // Fail-open: getMidpoint errors proceed with the order normally.
  if (side === 'BUY' && detectedPrice > 0.005) {
    try {
      // Tier 1: WebSocket cache (0ms)
      let currentMid = getMidFromCache(tokenId);
      let midSource: 'cache' | 'api' | 'chain-skip' = 'cache';

      // Tier 2: API fallback if cache miss or stale
      if (currentMid === null) {
        if (detectionSource === 'CHAIN' || detectionSource === 'CHAIN_MAKER') {
          // CHAIN signals are <2s old — skip 50-100ms API roundtrip (fail-open)
          midSource = 'chain-skip';
        } else {
          midSource = 'api';
          const midpointResp = await client.getMidpoint(tokenId);
          currentMid = parseFloat(midpointResp?.mid ?? '1');
        }
      }

      if (currentMid !== null && (currentMid <= 0.01 || currentMid < detectedPrice * 0.30)) {
        log.warn('Stale signal: market price at floor or collapsed vs signal — skipping', {
          detectedPrice,
          currentMid,
          midSource,
          detectionSource,
          dropPct: (((detectedPrice - currentMid) / detectedPrice) * 100).toFixed(1),
        });
        return {
          orderId: null,
          status: 'SKIPPED',
          filledPrice: null,
          filledSize: null,
          failReason: currentMid <= 0.01
            ? `stale signal: market mid ${currentMid.toFixed(4)} at near-zero floor (market expiring)`
            : `stale signal: market mid ${currentMid.toFixed(4)} is ${(((detectedPrice - currentMid) / detectedPrice) * 100).toFixed(0)}% below signal ${detectedPrice.toFixed(4)}`,
          transactionHashes: [],
        };
      }
    } catch {
      // Midpoint check failed — proceed with order (fail-open)
    }
  }

  log.info('Placing FAK market order', {
    tokenId: tokenId.slice(0, 20) + '...',
    side,
    amount,
    detectedPrice,
    slippagePrice,
  });

  const t0 = Date.now();
  let t1: number | null = null;
  try {
    const { tickSize, negRisk } = await getMarketMetadata(tokenId);
    t1 = Date.now();

    const response = await client.createAndPostMarketOrder(
      {
        tokenID: tokenId,
        side: side === 'BUY' ? Side.BUY : Side.SELL,
        amount,
        price: slippagePrice,
      },
      { tickSize, negRisk },
      OrderType.FAK,
    );
    const t2 = Date.now();

    log.info('Executor timing', {
      metadataMs: t1! - t0,
      clobOrderMs: t2 - t1!,
      totalMs: t2 - t0,
      side,
      tokenId: tokenId.slice(0, 20) + '...',
    });

    if (response?.success === false || response?.errorMsg) {
      const errorMsg: string = response.errorMsg || 'Unknown order error';

      // Defensive: FAK orders won't trigger this, but kept as a safety net
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
        consecutiveBalanceFailures++;
        if (consecutiveBalanceFailures >= BALANCE_PAUSE_THRESHOLD) {
          balancePaused = true;
          log.error('LIVE TRADING PAUSED: consecutive NOT_ENOUGH_BALANCE failures', {
            threshold: BALANCE_PAUSE_THRESHOLD,
            consecutiveFailures: consecutiveBalanceFailures,
          });
        } else {
          log.warn('Insufficient balance for copy trade', {
            tokenId, side, amount, consecutiveFailures: consecutiveBalanceFailures,
          });
        }
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

    let filledSize: number | null;
    let filledPrice: number | null;

    if (side === 'BUY') {
      // Standard CTF markets: makingAmount = shares received, takingAmount = USDC paid.
      // NegRisk markets (e.g. Bitcoin price bands) invert the convention.
      // Heuristic: try standard first; if price > 1.0 (impossible for prediction markets),
      // flip to negRisk convention (makingAmount = USDC paid, takingAmount = shares received).
      filledSize = makingAmount > 0 ? makingAmount : null;
      filledPrice = makingAmount > 0 && takingAmount > 0
        ? takingAmount / makingAmount : null;
      if (filledPrice !== null && filledPrice > 1.0) {
        filledSize = takingAmount > 0 ? takingAmount : null;
        filledPrice = makingAmount > 0 && takingAmount > 0
          ? makingAmount / takingAmount : null;
      }
    } else {
      // SELL: standard convention: makingAmount = USDC received, takingAmount = shares given.
      // NegRisk markets invert this: makingAmount = shares given, takingAmount = USDC received.
      filledSize = takingAmount > 0 ? takingAmount : null;
      filledPrice = takingAmount > 0 && makingAmount > 0
        ? makingAmount / takingAmount : null;
      if (filledPrice !== null && filledPrice > 1.0) {
        // NegRisk SELL: swap convention
        filledSize = makingAmount > 0 ? makingAmount : null;
        filledPrice = makingAmount > 0 && takingAmount > 0
          ? takingAmount / makingAmount : null;
      }
    }

    // NegRisk normalization: raw CLOB token counts → standard share denomination.
    // After convention swap, NegRisk fills can still have very low price with very high
    // share count (e.g. 222 shares @ $0.009 instead of 3.85 @ $0.52).
    // At settlement, raw counts would compute 222 × $1.0 = $222 instead of $3.85.
    if (negRisk && filledPrice !== null && filledSize !== null
        && filledPrice < 0.05 && detectedPrice >= 0.05) {
      const rawUsdCost = filledSize * filledPrice;
      const normalizedSize = rawUsdCost / detectedPrice;
      log.info('NegRisk normalization applied', {
        rawSize: filledSize, rawPrice: filledPrice,
        normalizedSize: normalizedSize.toFixed(6), normalizedPrice: detectedPrice,
        usdCost: rawUsdCost.toFixed(4),
      });
      filledSize = normalizedSize;
      filledPrice = detectedPrice;
    }

    // Guard: FAK order submitted but not matched (no fill amounts) — treat as SKIPPED
    if (!filledSize || !filledPrice) {
      log.info('FAK order unmatched (no fill amounts)', {
        orderId,
        side,
        makingAmount: response?.makingAmount,
        takingAmount: response?.takingAmount,
      });
      return {
        orderId,
        status: 'SKIPPED',
        filledPrice: null,
        filledSize: null,
        failReason: 'no matching orders (FAK unmatched)',
        transactionHashes: txHashes,
      };
    }

    // Guard: impossible price for a prediction market (should not reach here after NegRisk flip)
    if (filledPrice > 1.0) {
      log.warn('Ghost fill: impossible price', { orderId, side, filledPrice });
      return {
        orderId,
        status: 'FAILED',
        filledPrice: null,
        filledSize: null,
        failReason: `ghost fill: impossible price ${filledPrice.toFixed(6)}`,
        transactionHashes: txHashes,
      };
    }

    // Sanity: implied USD should be within 3x of requested amount
    // (filledPrice and filledSize are guaranteed non-null here — FAK guard above returns otherwise)
    const impliedUsd = filledPrice * filledSize;
    const requestedUsd = side === 'BUY' ? amount : amount * detectedPrice;
    if (requestedUsd > 0 && impliedUsd / requestedUsd > 3.0) {
      log.error('SUSPECT FILL: impliedUsd diverges from requestedUsd', {
        orderId, side, filledPrice, filledSize, impliedUsd, requestedUsd,
        negRisk, makingAmount, takingAmount,
      });
      return {
        orderId, status: 'FAILED', filledPrice: null, filledSize: null,
        failReason: `suspect fill: implied $${impliedUsd.toFixed(2)} vs requested $${requestedUsd.toFixed(2)}`,
        transactionHashes: txHashes,
      };
    }

    // Background phantom verification (non-blocking — saves ~300ms on critical path).
    // Safety: hourly auditPhantomPositions() catches any phantom that slips through.
    // This matches existing fail-open behavior where getOrder() errors already let
    // fills through unverified.
    if (orderId && filledSize && filledPrice) {
      const capturedOrderId = orderId;
      const capturedCtx = { side, filledPrice, filledSize, makingAmount, takingAmount, negRisk };
      const verifyInBackground = async () => {
        try {
          if (!client) return;
          const order = await client.getOrder(capturedOrderId);
          if (!order) {
            log.error('PHANTOM FILL DETECTED (background)', {
              orderId: capturedOrderId, ...capturedCtx,
            });
          }
        } catch (err: any) {
          log.warn('Background phantom verification failed', {
            orderId: capturedOrderId, error: err.message,
          });
        }
      };
      setTimeout(() => { verifyInBackground().catch(() => {}); }, 500);
    }

    resetBalancePause(); // clear any prior balance failure count on successful fill

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
    const tErr = Date.now();
    log.info('Executor timing (error path)', {
      metadataMs: t1 ? t1 - t0 : null,
      totalMs: tErr - t0,
      side,
      tokenId: tokenId.slice(0, 20) + '...',
      error: (err.message || String(err)).slice(0, 80),
    });

    const msg: string = err.message || String(err);

    // Expired orderbook — market closed, tokenId no longer valid.
    // Use exact string; broad 400 match would swallow legitimate CLOB errors.
    if (msg.includes('orderbook does not exist')) {
      metadataCache.delete(tokenId); // clear stale cache entry
      log.info('Market expired: orderbook does not exist', { tokenId: tokenId.slice(0, 20) });
      return {
        orderId: null,
        status: 'SKIPPED',
        filledPrice: null,
        filledSize: null,
        failReason: 'market expired: orderbook does not exist',
        transactionHashes: [],
      };
    }

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
