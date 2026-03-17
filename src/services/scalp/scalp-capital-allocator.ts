/**
 * Scalp Capital Allocator — Multi-Market Risk Budget
 *
 * When running multiple simultaneous matches (EPL + NBA + La Liga), we need to:
 *
 * 1. **Cap total exposure**: Prevent aggregate loss from exceeding our total risk budget
 * 2. **Scale per-match limits**: Divide capital across N concurrent matches
 * 3. **Prioritize by volume**: Allocate more capital to higher-volume matches
 * 4. **Respect minimums**: Each match needs enough capital to be meaningful ($5+ order size)
 *
 * The allocator is a pure function — it takes a total budget and list of matches,
 * returns per-match parameters for the launch script.
 *
 * ## Capital Model
 *
 * Total risk budget = maximum we're willing to lose across ALL concurrent matches.
 * This is NOT how much we deploy — it's our worst-case loss budget.
 *
 * Per-match allocation:
 *   - maxLoss = totalRiskBudget / numMatches (floor at -$5 for meaningful operation)
 *   - maxInventoryUsd = 2x |maxLoss| (we need inventory room to make money)
 *   - orderSize = maxInventoryUsd / 5 (target 5 layers of inventory before hitting cap)
 *   - maxInventory = maxInventoryUsd (dollar-based, not share-based for simplicity)
 *
 * Volume-weighted allocation (optional):
 *   Higher-volume matches get proportionally more capital because:
 *   - More trades = more fill opportunities = better edge capture
 *   - Higher volume = tighter spreads = less adverse selection risk
 *   - Low-volume matches may not generate any fills at all (waste of capital)
 *
 * ## Example Scenarios
 *
 * Scenario 1: 3 EPL matches only
 *   totalRiskBudget = $60, numMatches = 3
 *   Each: maxLoss=-$20, maxInvUsd=$40, orderSize=$8
 *
 * Scenario 2: 3 EPL + 1 NBA simultaneous
 *   totalRiskBudget = $60, numMatches = 4
 *   Each: maxLoss=-$15, maxInvUsd=$30, orderSize=$6
 *
 * Scenario 3: 3 EPL + 6 NBA + 1 La Liga = 10 simultaneous
 *   totalRiskBudget = $100, numMatches = 10
 *   Equal: maxLoss=-$10, maxInvUsd=$20, orderSize=$4
 *   Volume-weighted: MUN gets $15 maxLoss, NOT-FUL gets $8
 */

// ─── Types ───

export interface MatchInput {
  /** Match slug (e.g., "epl-mun-ast-2026-03-15") */
  slug: string;
  /** Estimated 24h volume in USD (from Gamma API or research). 0 = unknown. */
  estimatedVolumeUsd: number;
  /** Priority tier: 'high' for big matches, 'normal' for standard, 'low' for small */
  tier?: 'high' | 'normal' | 'low';
}

export interface MatchAllocation {
  slug: string;
  /** Max loss before halting (negative number, e.g., -15) */
  maxLoss: number;
  /** Max one-sided inventory in USD */
  maxInventoryUsd: number;
  /** Max inventory in shares (derived from maxInventoryUsd assuming ~$0.50 avg price) */
  maxInventoryShares: number;
  /** USD per side for orders */
  orderSize: number;
  /** Max allowed spread width (keep wider for low-volume matches) */
  spreadWidth: number;
  /** Queue depth estimate (higher for high-volume matches) */
  queueDepthUsd: number;
  /** Allocated share of total budget (0-1) */
  budgetShare: number;
}

export interface AllocationResult {
  totalRiskBudget: number;
  numMatches: number;
  allocations: MatchAllocation[];
  /** Summary line for logging */
  summary: string;
}

export interface AllocatorConfig {
  /** Total maximum loss across all concurrent matches (default: $60) */
  totalRiskBudget: number;
  /** Minimum per-match loss budget to be worth running (default: $5) */
  minMatchLoss: number;
  /** Inventory-to-loss ratio: maxInvUsd = ratio * |maxLoss| (default: 2.0) */
  inventoryToLossRatio: number;
  /** Order size as fraction of maxInventory (default: 0.2 = 5 layers) */
  orderSizeRatio: number;
  /** Minimum order size in USD (default: $3) */
  minOrderSize: number;
  /** Whether to use volume-weighted allocation (default: true) */
  useVolumeWeighting: boolean;
  /** Maximum share any single match can get (default: 0.4 = 40%) */
  maxSingleMatchShare: number;
  /** Default spread width (default: 0.04 = 4c) */
  defaultSpreadWidth: number;
  /** Queue depth scaling: base queue depth for $500K volume match */
  baseQueueDepthUsd: number;
}

// ─── Defaults ───

const DEFAULT_CONFIG: AllocatorConfig = {
  totalRiskBudget: 60,
  minMatchLoss: 5,
  inventoryToLossRatio: 2.0,
  orderSizeRatio: 0.2,
  minOrderSize: 3,
  useVolumeWeighting: true,
  maxSingleMatchShare: 0.40,
  defaultSpreadWidth: 0.04,
  baseQueueDepthUsd: 100,
};

// ─── Volume reference data ───

/**
 * Known volume ranges by league. Used when estimatedVolumeUsd is 0 (unknown).
 * Values from research (SCALP_MEMORY.md).
 */
const LEAGUE_VOLUME_DEFAULTS: Record<string, number> = {
  'epl': 370_000,     // $277K-$469K avg
  'lal': 240_000,     // $148K-$331K avg
  'ucl': 380_000,     // $24K-$747K, bimodal — use median
  'sea': 220_000,     // Serie A
  'fl1': 164_000,     // Ligue 1 (slug prefix: fl1-)
  'bun': 200_000,     // Bundesliga (slug prefix: bun-)
  'uel': 150_000,     // Europa League
  'scop': 182_000,    // Scottish Prem
  'mls': 150_000,     // MLS
  'nba': 900_000,     // $460K-$1.36M avg
  'nhl': 300_000,     // NHL (estimate)
};

// ─── Allocator ───

export function allocateCapital(
  matches: MatchInput[],
  config?: Partial<AllocatorConfig>,
): AllocationResult {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  if (matches.length === 0) {
    return {
      totalRiskBudget: cfg.totalRiskBudget,
      numMatches: 0,
      allocations: [],
      summary: 'No matches to allocate.',
    };
  }

  // Step 1: Fill in missing volume estimates from league defaults
  const enriched = matches.map((m) => {
    if (m.estimatedVolumeUsd > 0) return m;

    const prefix = m.slug.split('-')[0].toLowerCase();
    const defaultVol = LEAGUE_VOLUME_DEFAULTS[prefix] ?? 200_000;
    return { ...m, estimatedVolumeUsd: defaultVol };
  });

  // Step 2: Calculate budget shares
  let shares: number[];

  if (cfg.useVolumeWeighting && enriched.some((m) => m.estimatedVolumeUsd > 0)) {
    // Volume-weighted with tier adjustments
    const volumes = enriched.map((m) => {
      let vol = m.estimatedVolumeUsd;
      // Apply tier multipliers
      if (m.tier === 'high') vol *= 1.5;
      if (m.tier === 'low') vol *= 0.6;
      return vol;
    });

    const totalVol = volumes.reduce((s, v) => s + v, 0);
    shares = volumes.map((v) => v / totalVol);
  } else {
    // Equal allocation
    shares = enriched.map(() => 1 / enriched.length);
  }

  // Cap individual shares
  const cappedShares = capShares(shares, cfg.maxSingleMatchShare);

  // Step 3: Compute per-match allocations
  const allocations: MatchAllocation[] = enriched.map((m, i) => {
    const share = cappedShares[i];
    const matchBudget = cfg.totalRiskBudget * share;
    const maxLoss = -Math.max(cfg.minMatchLoss, Math.round(matchBudget));
    const maxInventoryUsd = Math.round(Math.abs(maxLoss) * cfg.inventoryToLossRatio);
    const maxInventoryShares = Math.round(maxInventoryUsd / 0.5) * 2; // assume ~$0.50 avg price, round to even
    const orderSize = Math.max(cfg.minOrderSize, Math.round(maxInventoryUsd * cfg.orderSizeRatio));

    // Spread: wider for lower-volume matches (less adverse selection data to react to)
    const volRatio = m.estimatedVolumeUsd / 500_000; // normalize to $500K
    const spreadWidth = volRatio >= 1
      ? cfg.defaultSpreadWidth
      : Math.min(0.06, cfg.defaultSpreadWidth + (1 - volRatio) * 0.02);

    // Queue depth: scales with volume (more volume = deeper book)
    const queueDepthUsd = Math.round(cfg.baseQueueDepthUsd * Math.max(0.5, Math.min(3, volRatio)));

    return {
      slug: m.slug,
      maxLoss,
      maxInventoryUsd,
      maxInventoryShares,
      orderSize,
      spreadWidth: Math.round(spreadWidth * 1000) / 1000, // round to 0.001
      queueDepthUsd,
      budgetShare: share,
    };
  });

  // Step 4: Build summary
  const lines = allocations.map((a) =>
    `  ${a.slug.padEnd(35)} share=${(a.budgetShare * 100).toFixed(0)}% maxLoss=$${Math.abs(a.maxLoss)} inv=$${a.maxInventoryUsd} size=$${a.orderSize} spread=${(a.spreadWidth * 100).toFixed(0)}c queue=$${a.queueDepthUsd}`,
  );

  const summary = [
    `Capital allocation: $${cfg.totalRiskBudget} budget across ${matches.length} matches`,
    ...lines,
  ].join('\n');

  return {
    totalRiskBudget: cfg.totalRiskBudget,
    numMatches: matches.length,
    allocations,
    summary,
  };
}

/**
 * Generate CLI args for launch-paper-mm.sh from an allocation.
 */
export function allocationToCliArgs(alloc: MatchAllocation): string {
  return [
    `--match=${alloc.slug}`,
    `--spread=${alloc.spreadWidth}`,
    `--size=${alloc.orderSize}`,
    `--max-inventory=${alloc.maxInventoryUsd}`,
    `--max-loss=${alloc.maxLoss}`,
    `--max-inv-usd=${alloc.maxInventoryUsd}`,
    `--max-inv-shares=${alloc.maxInventoryShares}`,
    `--queue-depth=${alloc.queueDepthUsd}`,
  ].join(' ');
}

/**
 * Generate a shell launch command for a set of allocations.
 */
export function generateLaunchScript(allocations: MatchAllocation[]): string {
  const lines: string[] = [
    '#!/bin/bash',
    '# Auto-generated multi-match launch with capital allocation',
    `# Generated at ${new Date().toISOString()}`,
    '',
    'PROJECT_DIR="/Users/mantotan/Documents/Projects/Hatolabs/polymarket-copy-trade"',
    'LOG_DIR="$PROJECT_DIR/logs/paper-mm"',
    'mkdir -p "$LOG_DIR"',
    '',
    '# ESPN leagues for soccer feeds',
    'export SCALP_SOCCER_POLL_INTERVAL_MS=5000',
    '',
    'PIDS=()',
    '',
  ];

  // Collect ESPN leagues needed
  const leagueMap: Record<string, string> = {
    'epl': 'eng.1', 'lal': 'esp.1', 'ucl': 'uefa.champions',
    'sea': 'ita.1', 'fl1': 'fra.1', 'bun': 'ger.1', 'uel': 'uefa.europa',
  };
  const leagues = new Set<string>(['eng.1']); // always include EPL
  for (const a of allocations) {
    const prefix = a.slug.split('-')[0];
    if (leagueMap[prefix]) leagues.add(leagueMap[prefix]);
  }
  lines.push(`export SCALP_SOCCER_LEAGUES="${[...leagues].join(',')}"`);
  lines.push('');

  for (const alloc of allocations) {
    const logFile = `$LOG_DIR/${alloc.slug}-$(date -u +%Y-%m-%d).log`;
    lines.push(`echo "Launching: ${alloc.slug} (share=${(alloc.budgetShare * 100).toFixed(0)}%, maxLoss=$${Math.abs(alloc.maxLoss)}, inv=$${alloc.maxInventoryUsd}, size=$${alloc.orderSize})"`);
    lines.push(`cd "$PROJECT_DIR" && npx tsx src/scripts/scalp-mm-paper.ts \\`);
    lines.push(`  ${allocationToCliArgs(alloc)} \\`);
    lines.push(`  --stats-interval=60 --warm-up=10 --max-stddev=0.03 --max-runtime=150 \\`);
    lines.push(`  2>&1 | tee "${logFile}" &`);
    lines.push(`PIDS+=($!)`);
    lines.push('sleep 1');
    lines.push('');
  }

  lines.push('echo "All ${#PIDS[@]} instances launched. PIDs: ${PIDS[*]}"');
  lines.push('echo "${PIDS[*]}" > "$LOG_DIR/pids-$(date -u +%Y-%m-%d).txt"');
  lines.push('wait');

  return lines.join('\n');
}

// ─── Helpers ───

/**
 * Cap shares so no single match exceeds maxShare, redistributing excess equally.
 */
function capShares(shares: number[], maxShare: number): number[] {
  const result = [...shares];
  let excess = 0;
  let uncappedCount = 0;

  // First pass: cap and accumulate excess
  for (let i = 0; i < result.length; i++) {
    if (result[i] > maxShare) {
      excess += result[i] - maxShare;
      result[i] = maxShare;
    } else {
      uncappedCount++;
    }
  }

  // Second pass: redistribute excess to uncapped
  if (excess > 0 && uncappedCount > 0) {
    const redistrib = excess / uncappedCount;
    for (let i = 0; i < result.length; i++) {
      if (result[i] < maxShare) {
        result[i] += redistrib;
      }
    }
  }

  return result;
}
