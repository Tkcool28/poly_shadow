import pLimit from 'p-limit';
import { AssetType, ClobClient, OrderType, Side, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';
import { getMidFromCache, getBBAFromCache } from './midpoint-cache';

const log = createJobLogger('trade-executor');

export interface ExecuteOrderParams {
  tokenId: string;
  side: 'BUY' | 'SELL';
  amount: number; // BUY: USD amount, SELL: shares
  detectedPrice: number; // price from detected trade (for slippage calc)
  detectionSource?: string; // 'CHAIN', 'POLL', 'WS' — used to skip stale-signal API for fresh signals
  signalAgeMs?: number; // ms since block timestamp (or detection time on cache miss)
  _isRetry?: boolean; // internal: prevent infinite retry recursion
}

export interface ExecuteOrderResult {
  orderId: string | null;
  status: 'FILLED' | 'FAILED' | 'SKIPPED' | 'DELAYED';
  filledPrice: number | null;
  filledSize: number | null;
  failReason: string | null;
  transactionHashes: string[];
  estimatedFee?: number; // paper trades only: estimated fee in USD
  delayedReason?: 'sports' | 'gtc_fallback'; // distinguishes DELAYED cause for caller routing
}

// Market metadata cache (tickSize + negRisk don't change per market)
const metadataCache = new Map<string, { tickSize: TickSize; negRisk: boolean }>();
const metadataLimit = pLimit(5);

// Fee rate cache: tokenId → baseFee in basis points (from CLOB /fee-rate endpoint)
const feeRateCache = new Map<string, number>();

/**
 * Calculate taker fee in shares.
 * Polymarket fee formula (matching paper-executor.ts and docs):
 *   fee = shares × feeRate × (price × (1 - price))^exponent
 *
 * Fee tiers by baseFee from CLOB /fee-rate endpoint:
 *   Crypto (baseFee=1000): feeRate=0.25, exponent=2 → peak 1.56% at p=0.50
 *   Sports (baseFee=700):  feeRate=0.0175, exponent=1 → peak 0.44% at p=0.50
 *   No fees (baseFee=0):   0%
 */
function calculateTakerFeeShares(grossShares: number, price: number, baseFee: number): number {
  if (baseFee <= 0 || price <= 0 || price >= 1) return 0;
  // Map baseFee to (feeRate, exponent) matching Polymarket's tiered fee structure
  let feeRate: number;
  let exponent: number;
  if (baseFee >= 1000) {
    feeRate = 0.25;
    exponent = 2;
  } else if (baseFee >= 700) {
    feeRate = 0.0175;
    exponent = 1;
  } else {
    feeRate = baseFee / 10000;
    exponent = 1;
  }
  return grossShares * feeRate * Math.pow(price * (1 - price), exponent);
}

const FEE_CACHE_TTL_MS = 3600_000; // 1 hour

async function getCachedFeeRate(tokenId: string): Promise<number> {
  const cached = feeRateCache.get(tokenId);
  if (cached !== undefined) return cached;
  try {
    if (!client) return 0;
    const baseFee = await client.getFeeRateBps(tokenId);
    feeRateCache.set(tokenId, baseFee);
    // Expire cache entry after TTL
    setTimeout(() => feeRateCache.delete(tokenId), FEE_CACHE_TTL_MS);
    return baseFee;
  } catch {
    return 0; // fail-open: 0 = no fee deduction
  }
}

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

export async function getMarketMetadata(tokenId: string): Promise<{ tickSize: TickSize; negRisk: boolean }> {
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
  await Promise.allSettled(uncached.map(id => metadataLimit(() => getMarketMetadata(id).catch(() => {}))));
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

// --- FAK unmatched diagnostics (zero-latency) ---

type BBA = { bestBid: number; bestAsk: number; mid: number };

function diagnoseFakUnmatched(
  side: string, slippagePrice: number, detectedPrice: number,
  pre: BBA | null, post: BBA | null,
): string {
  const bba = post ?? pre; // prefer post-order snapshot
  if (!bba) return 'NO_CACHE: no WS bid/ask data available';

  if (side === 'BUY') {
    if (bba.bestAsk > slippagePrice) {
      const gapCents = ((bba.bestAsk - slippagePrice) * 100).toFixed(1);
      return `PRICE_GAP: bestAsk ${bba.bestAsk} > limit ${slippagePrice} — gap ${gapCents}c`;
    }
    return `BOOK_SWEPT: bestAsk ${bba.bestAsk} <= limit ${slippagePrice} but no fill`;
  }

  // SELL: slippagePrice is always $0.01, so compare against detectedPrice
  if (bba.bestBid <= 0) return `NO_BIDS: bestBid ${bba.bestBid} — no buy-side liquidity`;
  if (bba.bestBid < detectedPrice * 0.5) {
    return `SELL_PRICE_GAP: bestBid ${bba.bestBid} far below signal ${detectedPrice}`;
  }
  return `SELL_SWEPT: bestBid ${bba.bestBid} near signal ${detectedPrice} but no fill`;
}

const bookSnapshotDebounce = new Map<string, number>();

function fireAsyncBookSnapshot(tokenId: string, orderId: string | null, side: string, limitPrice: number): void {
  const now = Date.now();
  const lastFetch = bookSnapshotDebounce.get(tokenId) ?? 0;
  if (now - lastFetch < 5000) return; // 5s per-tokenId debounce
  bookSnapshotDebounce.set(tokenId, now);

  // Prune stale debounce entries to prevent unbounded Map growth
  if (bookSnapshotDebounce.size > 100) {
    for (const [key, ts] of bookSnapshotDebounce) {
      if (now - ts > 60_000) bookSnapshotDebounce.delete(key);
    }
  }

  // Follow existing pattern from background phantom verification (line ~476)
  setTimeout(() => {
    (async () => {
      if (!client) return;
      const book = await client.getOrderBook(tokenId);
      const topBids = (book.bids ?? []).slice(0, 3).map((b: any) => ({ price: b.price, size: b.size }));
      const topAsks = (book.asks ?? []).slice(0, 3).map((a: any) => ({ price: a.price, size: a.size }));
      const totalAskDepthUsd = (book.asks ?? []).reduce((sum: number, a: any) =>
        sum + parseFloat(a.price) * parseFloat(a.size), 0);
      const totalBidDepthUsd = (book.bids ?? []).reduce((sum: number, b: any) =>
        sum + parseFloat(b.price) * parseFloat(b.size), 0);
      log.info('post-unmatched orderbook snapshot', {
        tokenId: tokenId.slice(0, 16), orderId, side, limitPrice,
        topBids, topAsks,
        totalAskDepthUsd: totalAskDepthUsd.toFixed(2),
        totalBidDepthUsd: totalBidDepthUsd.toFixed(2),
        askLevels: book.asks?.length ?? 0,
        bidLevels: book.bids?.length ?? 0,
      });
    })().catch(() => {}); // fail silently — purely diagnostic
  }, 0);
}

export const CLOB_MIN_ORDER_USD = 1.0; // Polymarket hard minimum per live order

const STALE_SIGNAL_THRESHOLD_MS = 30_000;   // 30s — signals older than this get price-checked
const STALE_PRICE_DROP_FRACTION = 0.10;     // 10% — skip if mid dropped more than this from signal

export async function executeMarketOrder(params: ExecuteOrderParams): Promise<ExecuteOrderResult> {
  if (!client) throw new Error('CLOB client not initialized');

  const { tokenId, side, amount, detectedPrice, detectionSource, signalAgeMs } = params;

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

      // Tier 2: API fallback if cache miss
      if (currentMid === null) {
        const isChain = detectionSource === 'CHAIN' || detectionSource === 'CHAIN_MAKER';
        const isStale = signalAgeMs != null && signalAgeMs >= STALE_SIGNAL_THRESHOLD_MS;
        if (isChain && !isStale) {
          // Fresh CHAIN signals (<30s): skip 50-100ms API roundtrip (fail-open)
          midSource = 'chain-skip';
        } else {
          // Non-CHAIN or stale CHAIN: worth the API call to check price
          midSource = 'api';
          const midpointResp = await client.getMidpoint(tokenId);
          currentMid = parseFloat(midpointResp?.mid ?? '1');
        }
      }

      // Stale signal + adverse price movement guard (BUY only)
      // If signal is >=30s old and current price dropped >10% from signal → skip
      // If price is same or higher → let FAK try (handles its own fill/no-fill)
      if (currentMid !== null && signalAgeMs != null && signalAgeMs >= STALE_SIGNAL_THRESHOLD_MS) {
        const dropFromSignal = (detectedPrice - currentMid) / detectedPrice;
        if (dropFromSignal > STALE_PRICE_DROP_FRACTION) {
          log.warn('Stale signal: price dropped >10% since signal — skipping', {
            detectedPrice,
            currentMid,
            midSource,
            signalAgeSec: (signalAgeMs / 1000).toFixed(1),
            dropPct: (dropFromSignal * 100).toFixed(1),
          });
          return {
            orderId: null,
            status: 'SKIPPED',
            filledPrice: null,
            filledSize: null,
            failReason: `stale signal: mid ${currentMid.toFixed(4)} is ${(dropFromSignal * 100).toFixed(0)}% below signal ${detectedPrice.toFixed(4)} after ${(signalAgeMs / 1000).toFixed(0)}s`,
            transactionHashes: [],
          };
        }
        log.debug('Stale signal but price held — proceeding with FAK', {
          detectedPrice, currentMid, signalAgeSec: (signalAgeMs / 1000).toFixed(1),
        });
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

  const preOrderBBA = getBBAFromCache(tokenId);

  log.info('Placing FAK market order', {
    tokenId: tokenId.slice(0, 20) + '...',
    side,
    amount,
    detectedPrice,
    slippagePrice,
    preOrderBid: preOrderBBA?.bestBid ?? null,
    preOrderAsk: preOrderBBA?.bestAsk ?? null,
    preOrderMid: preOrderBBA?.mid ?? null,
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

    // Detect CLOB client error response (HTTP 4xx/5xx returns {error, status} instead of throwing)
    if (response?.error || (response?.status != null && typeof response.status === 'number' && response.status >= 400)) {
      let errorDetail: string;
      if (typeof response.error === 'string') {
        errorDetail = response.error;
      } else {
        try {
          const { error, status: s, orderID, errorMsg, success } = response;
          errorDetail = JSON.stringify({ error: String(error), status: s, orderID, errorMsg, success }).slice(0, 400);
        } catch {
          errorDetail = String(response.error ?? response.errorMsg ?? 'unknown');
        }
      }
      const httpStatus = typeof response.status === 'number' ? response.status : 'unknown';

      if (errorDetail.includes('orderbook does not exist')) {
        metadataCache.delete(tokenId);
        return {
          orderId: null, status: 'SKIPPED',
          filledPrice: null, filledSize: null,
          failReason: `market expired: orderbook does not exist (HTTP ${httpStatus})`,
          transactionHashes: [],
        };
      }

      // SELL balance/allowance — actionable: likely NegRisk approval gap or tokenId mismatch
      if (side === 'SELL' && (errorDetail.includes('not enough balance') || errorDetail.includes('not enough allowance'))) {
        log.warn('SELL balance/allowance failure', {
          httpStatus, side, tokenId: tokenId.slice(0, 20), amount, negRisk,
          hint: negRisk ? 'check NegRisk CTF Exchange approval (0xC5d563A3...)' : 'check on-chain balance',
        });
        return {
          orderId: null, status: 'SKIPPED',
          filledPrice: null, filledSize: null,
          failReason: `SELL rejected (HTTP ${httpStatus}): ${errorDetail.slice(0, 150)}${negRisk ? ' [NegRisk — check approval]' : ''}`,
          transactionHashes: [],
        };
      }

      log.warn('CLOB order rejected (HTTP error response)', {
        httpStatus, errorDetail: errorDetail.slice(0, 300),
        side, tokenId: tokenId.slice(0, 20), amount,
      });

      return {
        orderId: null, status: 'SKIPPED',
        filledPrice: null, filledSize: null,
        failReason: `CLOB rejected (HTTP ${httpStatus}): ${errorDetail.slice(0, 200)}`,
        transactionHashes: [],
      };
    }

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
      // Sports markets impose a 3-second matching delay on marketable orders.
      // The CLOB returns status="delayed" with empty amounts — the order fills ~3s later.
      // Return DELAYED so callers can keep the record PENDING (visible to cap checks)
      // and resolve via background poll.
      if (orderId && response?.status === 'delayed') {
        log.info('FAK order accepted with delayed matching (sports market)', {
          orderId, side, amount, tokenId: tokenId.slice(0, 20),
        });
        return {
          orderId, status: 'DELAYED',
          filledPrice: null, filledSize: null,
          failReason: null, transactionHashes: txHashes,
          delayedReason: 'sports',
        };
      }

      // Background ghost-fill verification (non-blocking — saves ~1,100ms on critical path).
      // If the CLOB accepted the order (orderId present), the fill may be propagating
      // asynchronously. Schedule a background check that logs detection.
      // Safety net: reconcileSkippedGhostFills() runs hourly and recovers capital.
      // Data: 2/1167 FAK trades (0.17%) are actual ghost fills over 7 days.
      if (orderId && client) {
        const capturedOrderId = orderId;
        const capturedSide = side;
        const capturedDetectedPrice = detectedPrice;
        const bgVerify = async () => {
          try {
            if (!client) return;
            const order = await client.getOrder(capturedOrderId);
            if (order?.status === 'MATCHED') {
              const sizeMatched = parseFloat(order.size_matched || '0');
              const orderPrice = parseFloat(order.price || '0');
              const recoveredPrice = (capturedSide === 'SELL') ? capturedDetectedPrice : orderPrice;
              if (sizeMatched > 0 && recoveredPrice > 0 && recoveredPrice <= 1.0) {
                log.warn('FAK ghost fill detected in background — reconciler will recover', {
                  orderId: capturedOrderId, sizeMatched, recoveredPrice, orderPrice,
                  side: capturedSide,
                });
              }
            }
          } catch {
            // Fail-safe: reconcileSkippedGhostFills() will catch it on next hourly sweep
          }
        };
        setTimeout(() => { bgVerify().catch(() => {}); }, 1500);
      }

      const postOrderBBA = getBBAFromCache(tokenId);
      const diagnosis = diagnoseFakUnmatched(side, slippagePrice, detectedPrice, preOrderBBA, postOrderBBA);
      log.warn('FAK order unmatched — CLOB diagnostic', {
        orderId, side, amount,
        slippagePrice, detectedPrice,
        responseStatus: response?.status,
        responseErrorMsg: response?.errorMsg ?? null,
        makingAmount: response?.makingAmount,
        takingAmount: response?.takingAmount,
        preOrderBid: preOrderBBA?.bestBid ?? null,
        preOrderAsk: preOrderBBA?.bestAsk ?? null,
        postOrderBid: postOrderBBA?.bestBid ?? null,
        postOrderAsk: postOrderBBA?.bestAsk ?? null,
        diagnosis,
        metadataMs: t1! - t0,
        clobMs: Date.now() - t1!,
      });
      fireAsyncBookSnapshot(tokenId, orderId, side, slippagePrice);

      // ── GTC Fallback: flag eligible for async resting limit order ──
      // The actual GTC placement happens in the caller's async handler (zero latency impact).
      if (config.GTC_FALLBACK_ENABLED && side === 'BUY') {
        log.info('GTC fallback: eligible — FAK unmatched, will place async', {
          side, amount, detectedPrice, slippagePrice,
          tokenId: tokenId.slice(0, 20), restMs: config.GTC_FALLBACK_REST_MS,
        });
        return {
          orderId, status: 'DELAYED',
          filledPrice: null, filledSize: null,
          failReason: null, transactionHashes: txHashes,
          delayedReason: 'gtc_fallback',
        };
      }

      return {
        orderId, status: 'SKIPPED',
        filledPrice: null, filledSize: null,
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

    // ── Taker fee deduction: adjust filledSize to NET shares (what we actually hold on-chain) ──
    // The CLOB returns gross amounts but the CTF Exchange contract deducts taker fees in shares.
    let estimatedFee: number | undefined;
    if (filledSize && filledPrice && filledSize > 0) {
      try {
        const baseFee = await getCachedFeeRate(tokenId);
        if (baseFee > 0) {
          const grossShares = filledSize;
          const grossPrice = filledPrice;

          if (side === 'BUY') {
            // BUY: fee deducted in shares — we receive fewer shares than CLOB reports
            const feeShares = calculateTakerFeeShares(grossShares, grossPrice, baseFee);
            const feeUsd = feeShares * grossPrice;
            filledSize = grossShares - feeShares;
            // Recalculate effective price: same USD paid, fewer shares received
            const totalPaid = grossShares * grossPrice; // original USD amount
            filledPrice = filledSize > 0 ? totalPaid / filledSize : grossPrice;
            estimatedFee = feeUsd;

            log.info('Taker fee (BUY)', {
              grossShares: grossShares.toFixed(4), feeShares: feeShares.toFixed(6),
              netShares: filledSize.toFixed(4), feeUsd: feeUsd.toFixed(4),
              grossPrice: grossPrice.toFixed(4), effectivePrice: filledPrice.toFixed(4),
              baseFee, feePct: ((feeUsd / totalPaid) * 100).toFixed(2) + '%',
            });
          } else {
            // SELL: fee deducted in USDC — we receive less USDC than CLOB reports
            const feeUsd = calculateTakerFeeShares(grossShares, grossPrice, baseFee) * grossPrice;
            filledPrice = grossPrice - (feeUsd / grossShares); // effective price lower
            estimatedFee = feeUsd;

            log.info('Taker fee (SELL)', {
              shares: grossShares.toFixed(4), feeUsd: feeUsd.toFixed(4),
              grossPrice: grossPrice.toFixed(4), effectivePrice: filledPrice.toFixed(4),
              baseFee,
            });
          }
        }
      } catch (err: any) {
        // Fail-open: if fee calc fails, use gross amounts (current behavior)
        log.warn('Taker fee calculation failed, using gross amounts', { error: err.message });
      }
    }

    log.info('Order filled', {
      orderId,
      status: response?.status,
      filledSize,          // NET shares (after fee deduction)
      filledPrice,         // effective price per net share
      grossShares: makingAmount || null,  // original CLOB response
      grossPrice: (makingAmount > 0 && takingAmount > 0) ? (side === 'BUY' ? takingAmount / makingAmount : makingAmount / takingAmount) : null,
      estimatedFee: estimatedFee?.toFixed(4) ?? null,
      txHashes: txHashes.length,
    });

    return {
      orderId,
      status: 'FILLED',
      filledPrice,
      filledSize,
      failReason: null,
      transactionHashes: txHashes,
      estimatedFee,
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

    // Circular JSON crash: CLOB client's errorHandling() calls JSON.stringify on
    // axios response.config containing TLSSocket circular refs. Original error is
    // a transient network failure. Retry once, then SKIPPED (not FAILED).
    if (msg.includes('Converting circular structure to JSON')) {
      if (!params._isRetry) {
        log.warn('CLOB client circular JSON crash (transient network error), retrying in 1s...', {
          tokenId: tokenId.slice(0, 20), side, amount,
        });
        await new Promise((r) => setTimeout(r, 1000));
        try {
          return await executeMarketOrder({ ...params, _isRetry: true });
        } catch {
          // Retry also failed — fall through to SKIPPED below
        }
      }
      return {
        orderId: null,
        status: 'SKIPPED',
        filledPrice: null,
        filledSize: null,
        failReason: 'transient network error (CLOB client circular JSON)',
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
