import { prisma } from '../lib/prisma';
import { WALLET_ADDRESS_REGEX } from '../config/constants';

export async function reBackfill(options: {
  wallet?: string;
  all?: boolean;
  permanentlyFailed?: boolean;
}): Promise<void> {
  if (!options.wallet && !options.all && !options.permanentlyFailed) {
    console.log('Error: Specify --wallet <address>, --all, or --permanently-failed');
    process.exit(1);
  }

  if (options.wallet && !WALLET_ADDRESS_REGEX.test(options.wallet)) {
    console.log('Error: Invalid wallet address format');
    process.exit(1);
  }

  let where;
  if (options.wallet) {
    where = { proxyWallet: options.wallet! };
  } else if (options.permanentlyFailed) {
    where = { backfillStatus: 'PERMANENTLY_FAILED' as const };
  } else {
    where = { backfillStatus: { in: ['COMPLETED' as const, 'FAILED' as const] } };
  }

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
