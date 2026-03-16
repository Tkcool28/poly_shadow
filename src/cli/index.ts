import 'dotenv/config';
import { Command } from 'commander';
import { prisma } from '../lib/prisma';

const program = new Command();

program
  .name('polymarket-copytrade')
  .description('Polymarket copy-trade CLI')
  .version('1.0.0');

program
  .command('add-wallet <address>')
  .description('Add a wallet address to track')
  .action(async (address: string) => {
    const { addWallet } = await import('./add-wallet.js');
    await addWallet(address);
    await prisma.$disconnect();
  });

program
  .command('list')
  .description('List tracked traders')
  .option('-s, --sort <field>', 'Sort by: score, pnl, winRate, trades', 'score')
  .option('-l, --limit <n>', 'Number of traders to show', '50')
  .action(async (opts) => {
    const { listTraders } = await import('./list-traders.js');
    await listTraders({ sort: opts.sort, limit: parseInt(opts.limit) });
    await prisma.$disconnect();
  });

program
  .command('scores')
  .description('Show top trader scores')
  .option('-t, --top <n>', 'Number of top traders to show', '20')
  .option('-f, --filter', 'Filter: 30d PnL >= $100, WinRate >= 70%, Markets >= 100')
  .action(async (opts) => {
    const { showScores } = await import('./show-scores.js');
    await showScores({ top: parseInt(opts.top), filter: opts.filter ?? false });
    await prisma.$disconnect();
  });

program
  .command('health')
  .description('Show system health status')
  .action(async () => {
    const { showHealth } = await import('./health.js');
    await showHealth();
    await prisma.$disconnect();
  });

program
  .command('re-backfill')
  .description('Reset traders to PENDING for re-backfill')
  .option('-w, --wallet <address>', 'Re-backfill a specific wallet')
  .option('-a, --all', 'Re-backfill all COMPLETED and FAILED traders')
  .option('-p, --permanently-failed', 'Re-backfill all PERMANENTLY_FAILED traders')
  .action(async (opts) => {
    const { reBackfill } = await import('./re-backfill.js');
    await reBackfill({
      wallet: opts.wallet,
      all: opts.all,
      permanentlyFailed: opts.permanentlyFailed,
    });
    await prisma.$disconnect();
  });

program
  .command('setup-wallet')
  .description('Derive CLOB API credentials and show wallet setup instructions')
  .action(async () => {
    const { setupWallet } = await import('./setup-wallet.js');
    await setupWallet();
    await prisma.$disconnect();
  });

program
  .command('follow <username> <capital>')
  .description('Follow a trader with a capital allocation (USD)')
  .option('--paper', 'Use paper trading mode (no real orders)')
  .action(async (username: string, capital: string, opts: { paper?: boolean }) => {
    const { followTrader, parseCapital } = await import('./follow.js');
    const amount = parseCapital(capital);
    if (amount === null) {
      console.error('Capital must be a valid positive number');
      await prisma.$disconnect();
      return;
    }
    await followTrader(username, amount, opts.paper ?? false);
    await prisma.$disconnect();
  });

program
  .command('unfollow <username>')
  .description('Stop following a trader (pauses allocation)')
  .action(async (username: string) => {
    const { unfollowTrader } = await import('./follow.js');
    await unfollowTrader(username);
    await prisma.$disconnect();
  });

program
  .command('follows')
  .description('List all followed traders and their allocations')
  .action(async () => {
    const { listFollows } = await import('./follow.js');
    await listFollows();
    await prisma.$disconnect();
  });

program
  .command('update-follow <username> <capital>')
  .description('Update a trader\'s capital allocation (USD)')
  .action(async (username: string, capital: string) => {
    const { updateFollow, parseCapital } = await import('./follow.js');
    const amount = parseCapital(capital);
    if (amount === null) {
      console.error('Capital must be a valid positive number');
      await prisma.$disconnect();
      return;
    }
    await updateFollow(username, amount);
    await prisma.$disconnect();
  });

program
  .command('reset-follows')
  .description('Reset all live follow allocations to fresh capital')
  .option('-c, --capital <amount>', 'Capital per allocation (USD)', '30')
  .option('--dry-run', 'Preview changes without executing')
  .option('--reactivate', 'Re-activate inactive allocations (e.g. mmrm2)')
  .action(async (opts) => {
    const { parseCapital } = await import('./follow.js');
    const amount = parseCapital(opts.capital);
    if (amount === null) {
      console.error('Capital must be a valid positive number');
      await prisma.$disconnect();
      return;
    }
    const { resetFollows } = await import('./reset-follows.js');
    await resetFollows({
      capital: amount,
      dryRun: opts.dryRun ?? false,
      reactivate: opts.reactivate ?? false,
    });
    await prisma.$disconnect();
  });

program
  .command('reconcile')
  .description('Audit and reconcile allocation capital across all copy trades')
  .option('--fix', 'Auto-correct capital discrepancies')
  .option('--verbose', 'Show all allocations including those without discrepancies')
  .option('--full', 'Fetch wallet USDC, API positions, unclaimed settlements, and capital equation')
  .option('--claim', 'Trigger on-chain claim sweep for unclaimed settled wins')
  .option('--realign', 'Set active allocation CC to actual wallet USDC balance and zero inactive allocations')
  .action(async (opts) => {
    const { reconcileCapital } = await import('./reconcile.js');
    await reconcileCapital({
      fix: opts.fix ?? false,
      verbose: opts.verbose ?? false,
      full: opts.full ?? false,
      claim: opts.claim ?? false,
      realign: opts.realign ?? false,
    });
    await prisma.$disconnect();
  });

program
  .command('inject <trader> <amount>')
  .description('Inject deposited capital into a specific trader allocation')
  .action(async (trader: string, amountStr: string) => {
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
      console.error('Amount must be a positive number');
      process.exit(1);
    }
    const { injectCapital } = await import('./reconcile.js');
    await injectCapital(trader, amount);
    await prisma.$disconnect();
  });

program.parse();
