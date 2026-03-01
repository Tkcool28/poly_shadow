import { prisma } from '../lib/prisma';
import { WALLET_ADDRESS_REGEX } from '../config/constants';

export async function addWallet(address: string) {
  if (!WALLET_ADDRESS_REGEX.test(address)) {
    console.error(`Invalid wallet address: ${address}`);
    console.error('Expected format: 0x followed by 40 hex characters');
    process.exit(1);
  }

  const existing = await prisma.trader.findUnique({
    where: { proxyWallet: address },
  });

  if (existing) {
    console.log(`Wallet ${address} already tracked (status: ${existing.backfillStatus})`);
    return;
  }

  await prisma.trader.create({
    data: {
      proxyWallet: address,
      source: 'MANUAL',
    },
  });

  console.log(`Added wallet ${address} for tracking`);
  console.log('Backfill will start automatically on next backfiller cycle');
}
