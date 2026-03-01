import { prisma } from '../lib/prisma';
import { refreshSingleTrader } from '../services/portfolio-cache';

async function resolveTrader(identifier: string) {
  // Try by userName (case-insensitive)
  let trader = await prisma.trader.findFirst({
    where: { userName: { equals: identifier, mode: 'insensitive' } },
  });
  if (trader) return trader;

  // Try by proxyWallet
  trader = await prisma.trader.findFirst({
    where: { proxyWallet: identifier },
  });
  return trader;
}

export function parseCapital(value: string): number | null {
  const n = parseFloat(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

export async function followTrader(identifier: string, capital: number, isPaper = false): Promise<void> {
  if (!Number.isFinite(capital) || capital <= 0) {
    console.error('Capital must be a positive number');
    return;
  }

  const trader = await resolveTrader(identifier);
  if (!trader) {
    console.error(`Trader "${identifier}" not found. Add them first with: cli add-wallet <address>`);
    return;
  }

  const displayName = trader.userName ?? trader.proxyWallet.slice(0, 10);
  const modeLabel = isPaper ? 'PAPER' : 'LIVE';

  // Upsert FollowAllocation
  const existing = await prisma.followAllocation.findUnique({
    where: { proxyWallet: trader.proxyWallet },
  });

  if (existing) {
    // Block mode switch — must unfollow first to change paper/live
    if (existing.isPaper !== isPaper) {
      const currentMode = existing.isPaper ? 'PAPER' : 'LIVE';
      const requestedMode = isPaper ? 'PAPER' : 'LIVE';
      console.error(`Error: ${displayName} is currently followed as ${currentMode}. Unfollow first to switch to ${requestedMode}.`);
      return;
    }

    // Re-follow or re-activate: reset capital, recalculate deployedCapital from open positions
    const deployedCapital = await recalcDeployedCapital(existing.id, isPaper);

    await prisma.followAllocation.update({
      where: { proxyWallet: trader.proxyWallet },
      data: {
        initialCapital: capital,
        currentCapital: capital - deployedCapital,
        deployedCapital,
        isActive: true,
      },
    });

    const verb = existing.isActive ? 'Updated follow for' : 'Re-activated follow for';
    console.log(`${verb} ${displayName} [${modeLabel}]`);
    console.log(`  Mode: ${modeLabel}`);
    console.log(`  Initial capital: $${capital.toFixed(2)}`);
    console.log(`  Deployed (open positions): $${deployedCapital.toFixed(2)}`);
    console.log(`  Available capital: $${(capital - deployedCapital).toFixed(2)}`);
  } else {
    // New follow
    await prisma.followAllocation.create({
      data: {
        proxyWallet: trader.proxyWallet,
        initialCapital: capital,
        currentCapital: capital,
        deployedCapital: 0,
        isActive: true,
        isPaper,
      },
    });

    console.log(`Now following ${displayName} with $${capital.toFixed(2)} [${modeLabel}]`);
    console.log(`  Mode: ${modeLabel}`);
  }

  // Ensure trader is monitored for WS detection
  await prisma.trader.update({
    where: { proxyWallet: trader.proxyWallet },
    data: { isMonitored: true },
  });

  // Fetch portfolio value
  console.log('Fetching trader portfolio value...');
  const value = await refreshSingleTrader(trader.proxyWallet);
  if (value !== null) {
    console.log(`  Trader portfolio value: $${value.toFixed(2)}`);
  } else {
    console.log('  Warning: Could not fetch portfolio value. Will retry on next cache refresh.');
  }

  console.log('\nNote: WebSocket detection will start within 60s (wallet cache refresh interval).');
}

export async function unfollowTrader(identifier: string): Promise<void> {
  const trader = await resolveTrader(identifier);
  if (!trader) {
    console.error(`Trader "${identifier}" not found.`);
    return;
  }

  const allocation = await prisma.followAllocation.findUnique({
    where: { proxyWallet: trader.proxyWallet },
  });

  if (!allocation || !allocation.isActive) {
    console.error(`Not currently following ${trader.userName ?? trader.proxyWallet.slice(0, 10)}`);
    return;
  }

  await prisma.followAllocation.update({
    where: { proxyWallet: trader.proxyWallet },
    data: { isActive: false },
  });

  const pnl = allocation.currentCapital + allocation.deployedCapital - allocation.initialCapital;
  const pnlSign = pnl >= 0 ? '+' : '';

  const modeLabel = allocation.isPaper ? 'PAPER' : 'LIVE';
  console.log(`Unfollowed ${trader.userName ?? trader.proxyWallet.slice(0, 10)} [${modeLabel}]`);
  console.log(`  Mode: ${modeLabel}`);
  console.log(`  Initial capital:  $${allocation.initialCapital.toFixed(2)}`);
  console.log(`  Current capital:  $${allocation.currentCapital.toFixed(2)}`);
  console.log(`  Deployed capital: $${allocation.deployedCapital.toFixed(2)}`);
  console.log(`  P&L: ${pnlSign}$${pnl.toFixed(2)}`);
}

export async function listFollows(): Promise<void> {
  const allocations = await prisma.followAllocation.findMany({
    include: {
      trader: { select: { userName: true, proxyWallet: true } },
    },
    orderBy: { createdAt: 'asc' },
  });

  if (allocations.length === 0) {
    console.log('No followed traders. Use: cli follow <username> <capital>');
    return;
  }

  const header = [
    'Username'.padEnd(15),
    'Mode'.padEnd(7),
    'Status'.padEnd(8),
    'Initial'.padStart(10),
    'Current'.padStart(10),
    'Deployed'.padStart(10),
    'P&L'.padStart(10),
    'Portfolio'.padStart(12),
  ].join('  ');

  console.log('');
  console.log(`  ${header}`);
  console.log('  ' + '-'.repeat(header.length));

  for (const alloc of allocations) {
    const name = (alloc.trader.userName ?? alloc.trader.proxyWallet.slice(0, 10)).slice(0, 15);
    const mode = alloc.isPaper ? 'PAPER' : 'LIVE';
    const status = alloc.isActive ? 'ACTIVE' : 'PAUSED';
    const pnl = alloc.currentCapital + alloc.deployedCapital - alloc.initialCapital;
    const pnlStr = (pnl >= 0 ? '+' : '') + pnl.toFixed(2);
    const portfolioStr = alloc.traderPortfolioValue
      ? `$${alloc.traderPortfolioValue.toFixed(0)}`
      : 'N/A';

    const row = [
      name.padEnd(15),
      mode.padEnd(7),
      status.padEnd(8),
      `$${alloc.initialCapital.toFixed(2)}`.padStart(10),
      `$${alloc.currentCapital.toFixed(2)}`.padStart(10),
      `$${alloc.deployedCapital.toFixed(2)}`.padStart(10),
      pnlStr.padStart(10),
      portfolioStr.padStart(12),
    ].join('  ');

    console.log(`  ${row}`);
  }
  console.log('');
}

export async function updateFollow(identifier: string, newCapital: number): Promise<void> {
  if (!Number.isFinite(newCapital) || newCapital <= 0) {
    console.error('Capital must be a positive number');
    return;
  }

  const trader = await resolveTrader(identifier);
  if (!trader) {
    console.error(`Trader "${identifier}" not found.`);
    return;
  }

  const allocation = await prisma.followAllocation.findUnique({
    where: { proxyWallet: trader.proxyWallet },
  });

  if (!allocation) {
    console.error(`Not following ${trader.userName ?? trader.proxyWallet.slice(0, 10)}. Use: cli follow <username> <capital>`);
    return;
  }

  // Adjust currentCapital proportionally
  const ratio = newCapital / allocation.initialCapital;
  const newCurrentCapital = allocation.currentCapital * ratio;

  await prisma.followAllocation.update({
    where: { proxyWallet: trader.proxyWallet },
    data: {
      initialCapital: newCapital,
      currentCapital: newCurrentCapital,
    },
  });

  const modeLabel = allocation.isPaper ? 'PAPER' : 'LIVE';
  console.log(`Updated allocation for ${trader.userName ?? trader.proxyWallet.slice(0, 10)} [${modeLabel}]`);
  console.log(`  Mode: ${modeLabel}`);
  console.log(`  Initial capital: $${allocation.initialCapital.toFixed(2)} → $${newCapital.toFixed(2)}`);
  console.log(`  Current capital: $${allocation.currentCapital.toFixed(2)} → $${newCurrentCapital.toFixed(2)}`);
  console.log(`  Deployed capital: $${allocation.deployedCapital.toFixed(2)} (unchanged)`);
}

async function recalcDeployedCapital(allocationId: string, isPaper: boolean): Promise<number> {
  const [buySum, sellSum] = await Promise.all([
    prisma.copyTrade.aggregate({
      where: { followAllocationId: allocationId, side: 'BUY', status: 'FILLED', isPaper },
      _sum: { requestedAmount: true },
    }),
    prisma.copyTrade.aggregate({
      where: { followAllocationId: allocationId, side: 'SELL', status: 'FILLED', isPaper },
      _sum: { requestedAmount: true },
    }),
  ]);

  const buys = buySum._sum.requestedAmount ?? 0;
  const sells = sellSum._sum.requestedAmount ?? 0;
  return Math.max(buys - sells, 0);
}
