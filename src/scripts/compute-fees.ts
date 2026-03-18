/**
 * Compute total fees paid to Polymarket on live copy trades.
 * Fetches trade data from CLOB API using our order IDs.
 */
import { ClobClient, SignatureType } from '@polymarket/clob-client';
import type { ApiKeyCreds } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { config } from '../config/env';
import { prisma } from '../lib/prisma';

async function main() {
  // Get all live filled trades with order IDs
  const trades = await prisma.copyTrade.findMany({
    where: {
      isPaper: false,
      status: { in: ['FILLED', 'SETTLED'] },
      orderId: { not: null },
    },
    select: {
      id: true,
      orderId: true,
      tokenId: true,
      side: true,
      requestedAmount: true,
      filledPrice: true,
      filledSize: true,
      createdAt: true,
    },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`Found ${trades.length} live filled trades\n`);

  // Initialize authenticated CLOB client
  const signer = new Wallet(config.PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: config.CLOB_API_KEY,
    secret: config.CLOB_API_SECRET,
    passphrase: config.CLOB_API_PASSPHRASE,
  };
  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer,
    creds,
    config.SIGNATURE_TYPE as SignatureType,
    config.FUNDER_ADDRESS || undefined,
  );

  // Get unique tokenIds and fetch fee rates
  const tokenIds = [...new Set(trades.map(t => t.tokenId))];
  console.log(`Unique token IDs: ${tokenIds.length}`);

  const feeRates: Record<string, number> = {};
  let fetched = 0;
  for (const tokenId of tokenIds) {
    try {
      const rate = await client.getFeeRateBps(tokenId);
      feeRates[tokenId] = rate;
      fetched++;
      if (rate > 0) {
        console.log(`  Token ${tokenId.slice(0, 20)}... feeRate=${rate} bps`);
      }
    } catch (err: any) {
      // Market may no longer exist
      feeRates[tokenId] = 0;
      console.log(`  Token ${tokenId.slice(0, 20)}... error: ${err.message?.slice(0, 80)}`);
    }
    // Rate limit
    if (fetched % 10 === 0) await new Promise(r => setTimeout(r, 500));
  }

  // Compute fees for each trade using Polymarket formula:
  // fee = shares × feeRate_decimal × (price × (1 - price))
  // feeRate_decimal = feeRateBps / 10000
  let totalFeeUsd = 0;
  let totalBuyFeeUsd = 0;
  let totalSellFeeUsd = 0;
  let tradesWithFees = 0;
  let totalVolume = 0;

  const dailyFees: Record<string, number> = {};

  for (const t of trades) {
    const feeRateBps = feeRates[t.tokenId] ?? 0;
    const feeRate = feeRateBps / 10000;
    const price = t.filledPrice!;
    const size = t.filledSize!;

    // Polymarket fee formula: C × feeRate × (p × (1-p))
    // where C = shares for BUY, or shares for SELL
    const feeShares = size * feeRate * (price * (1 - price));
    const feeUsd = feeShares * price;

    const volume = price * size;
    totalVolume += volume;

    if (feeUsd > 0) {
      totalFeeUsd += feeUsd;
      tradesWithFees++;
      if (t.side === 'BUY') totalBuyFeeUsd += feeUsd;
      else totalSellFeeUsd += feeUsd;

      const day = t.createdAt.toISOString().slice(0, 10);
      dailyFees[day] = (dailyFees[day] ?? 0) + feeUsd;
    }
  }

  console.log('\n═══════════════════════════════════════');
  console.log('  POLYMARKET FEE SUMMARY (Live Trades)');
  console.log('═══════════════════════════════════════');
  console.log(`Total trades:         ${trades.length}`);
  console.log(`Trades with fees:     ${tradesWithFees}`);
  console.log(`Total volume:         $${totalVolume.toFixed(2)}`);
  console.log(`Total fees paid:      $${totalFeeUsd.toFixed(4)}`);
  console.log(`  BUY side fees:      $${totalBuyFeeUsd.toFixed(4)}`);
  console.log(`  SELL side fees:     $${totalSellFeeUsd.toFixed(4)}`);
  console.log(`Fee as % of volume:   ${((totalFeeUsd / totalVolume) * 100).toFixed(4)}%`);

  if (Object.keys(dailyFees).length > 0) {
    console.log('\nDaily breakdown:');
    for (const [day, fee] of Object.entries(dailyFees).sort()) {
      console.log(`  ${day}: $${fee.toFixed(4)}`);
    }
  }

  // Cross-reference: fetch trades from CLOB API by maker_address to get actual fee data
  console.log('\n--- Cross-reference: Trades from CLOB API (by maker_address) ---');
  const funderAddr = config.FUNDER_ADDRESS || signer.address;
  console.log(`Fetching trades for address: ${funderAddr}`);
  try {
    const apiTrades = await client.getTrades({ maker_address: funderAddr });
    console.log(`API returned ${apiTrades.length} trades`);
    if (apiTrades.length > 0) {
      let apiFeeTotal = 0;
      for (const at of apiTrades) {
        const bps = parseInt(at.fee_rate_bps || '0');
        const size = parseFloat(at.size || '0');
        const price = parseFloat(at.price || '0');
        const feeUsd = size * price * (bps / 10000) * price * (1 - price);
        apiFeeTotal += feeUsd;
      }
      console.log(`Sum of API-reported fees: $${apiFeeTotal.toFixed(4)} (from ${apiTrades.length} trades)`);
      // Show a few samples
      for (const at of apiTrades.slice(0, 5)) {
        console.log(`  id=${at.id?.slice(0, 16)}... side=${at.side} size=${at.size} price=${at.price} fee_bps=${at.fee_rate_bps}`);
      }
    }
  } catch (err: any) {
    console.log(`API error: ${err.message?.slice(0, 200)}`);
  }

  await prisma.$disconnect().catch(() => {});
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
