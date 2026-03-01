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
  .action(async (opts) => {
    const { showScores } = await import('./show-scores.js');
    await showScores({ top: parseInt(opts.top) });
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
  .action(async (opts) => {
    const { reBackfill } = await import('./re-backfill.js');
    await reBackfill({ wallet: opts.wallet, all: opts.all });
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

program.parse();
