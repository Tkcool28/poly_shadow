import { prisma } from '../lib/prisma';
import { WALLET_ADDRESS_REGEX } from '../config/constants';

export async function reBackfill(options: { wallet?: string; all?: boolean }): Promise<void> {
  if (!options.wallet && !options.all) {
    console.log('Error: Specify --wallet <address> or --all');
    process.exit(1);
  }

  if (options.wallet && !WALLET_ADDRESS_REGEX.test(options.wallet)) {
    console.log('Error: Invalid wallet address format');
    process.exit(1);
  }

  const where = options.all
    ? { backfillStatus: { in: ['COMPLETED' as const, 'FAILED' as const] } }
    : { proxyWallet: options.wallet! };

  const result = await prisma.trader.updateMany({
    where,
    data: {
      backfillStatus: 'PENDING',
      backfillRetries: 0,
      backfillLockedAt: null,
      backfillError: null,
    },
  });

  console.log(`Reset ${result.count} trader(s) to PENDING for re-backfill`);
}
