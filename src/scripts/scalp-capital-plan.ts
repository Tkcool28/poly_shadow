/**
 * Scalp Capital Plan — Generate capital allocation for tonight's matches
 *
 * Usage:
 *   npx tsx src/scripts/scalp-capital-plan.ts                      # Default: all scheduled matches
 *   npx tsx src/scripts/scalp-capital-plan.ts --budget=100          # Custom budget
 *   npx tsx src/scripts/scalp-capital-plan.ts --matches=epl-mun-ast-2026-03-15,nba-gsw-nyk-2026-03-15
 *   npx tsx src/scripts/scalp-capital-plan.ts --scenario=tonight    # Pre-defined scenario
 */

import {
  allocateCapital,
  allocationToCliArgs,
  generateLaunchScript,
  type MatchInput,
} from '../services/scalp/scalp-capital-allocator';

// ─── CLI Args ───

const args = process.argv.slice(2);

function getArg(name: string): string | undefined {
  const arg = args.find((a) => a.startsWith(`--${name}=`));
  return arg?.split('=').slice(1).join('=');
}

const budget = parseFloat(getArg('budget') ?? '60');
const scenario = getArg('scenario') ?? 'tonight';

// ─── Predefined scenarios ───

const SCENARIOS: Record<string, MatchInput[]> = {
  // Tonight 2026-03-15: EPL 14:00 UTC + NBA 17:00-00:00 UTC + La Liga 20:15 UTC
  tonight: [
    // EPL 14:00 UTC (concurrent)
    { slug: 'epl-mun-ast-2026-03-15', estimatedVolumeUsd: 469_000, tier: 'high' },
    { slug: 'epl-cry-lee-2026-03-15', estimatedVolumeUsd: 277_000, tier: 'normal' },
    { slug: 'epl-not-ful-2026-03-15', estimatedVolumeUsd: 277_000, tier: 'normal' },
    // EPL 16:30 UTC (separate batch, EPL matches above will be done by then)
    { slug: 'epl-liv-tot-2026-03-15', estimatedVolumeUsd: 469_000, tier: 'high' },
    // La Liga 20:15 UTC (overlaps with NBA)
    { slug: 'lal-bar-sev-2026-03-15', estimatedVolumeUsd: 331_000, tier: 'normal' },
    // NBA 17:00 UTC
    { slug: 'nba-min-okc-2026-03-15', estimatedVolumeUsd: 900_000, tier: 'normal' },
    // NBA 19:30 UTC (3 concurrent)
    { slug: 'nba-dal-cle-2026-03-15', estimatedVolumeUsd: 700_000, tier: 'normal' },
    { slug: 'nba-det-tor-2026-03-15', estimatedVolumeUsd: 460_000, tier: 'low' },
    { slug: 'nba-ind-mil-2026-03-15', estimatedVolumeUsd: 600_000, tier: 'normal' },
    // NBA 22:00 UTC
    { slug: 'nba-por-phi-2026-03-15', estimatedVolumeUsd: 460_000, tier: 'low' },
    // NBA 00:00 UTC (March 16)
    { slug: 'nba-gsw-nyk-2026-03-16', estimatedVolumeUsd: 1_360_000, tier: 'high' },
  ],

  // Only EPL 14:00 batch (3 concurrent matches)
  'epl-14': [
    { slug: 'epl-mun-ast-2026-03-15', estimatedVolumeUsd: 469_000, tier: 'high' },
    { slug: 'epl-cry-lee-2026-03-15', estimatedVolumeUsd: 277_000, tier: 'normal' },
    { slug: 'epl-not-ful-2026-03-15', estimatedVolumeUsd: 277_000, tier: 'normal' },
  ],

  // NBA 19:30 batch + La Liga (4 concurrent)
  'nba-1930-laliga': [
    { slug: 'nba-dal-cle-2026-03-15', estimatedVolumeUsd: 700_000, tier: 'normal' },
    { slug: 'nba-det-tor-2026-03-15', estimatedVolumeUsd: 460_000, tier: 'low' },
    { slug: 'nba-ind-mil-2026-03-15', estimatedVolumeUsd: 600_000, tier: 'normal' },
    { slug: 'lal-bar-sev-2026-03-15', estimatedVolumeUsd: 331_000, tier: 'normal' },
  ],

  // UCL Tuesday Mar 17 — 4 matches (MCI-RMA is the monster)
  // Actual slugs & volumes from Gamma API (checked 2026-03-15)
  'ucl-mar17': [
    { slug: 'ucl-mnc1-rma1-2026-03-17', estimatedVolumeUsd: 747_413, tier: 'high' },
    { slug: 'ucl-spo1-bog1-2026-03-17', estimatedVolumeUsd: 434_583, tier: 'normal' },
    { slug: 'ucl-ars-lev-2026-03-17', estimatedVolumeUsd: 147_791, tier: 'normal' },
    { slug: 'ucl-cfc1-psg1-2026-03-17', estimatedVolumeUsd: 142_555, tier: 'normal' },
  ],

  // UCL Wednesday Mar 18 — 4 matches
  'ucl-mar18': [
    { slug: 'ucl-liv1-gal-2026-03-18', estimatedVolumeUsd: 124_068, tier: 'high' },
    { slug: 'ucl-fcb1-new-2026-03-18', estimatedVolumeUsd: 77_900, tier: 'high' },
    { slug: 'ucl-tot-atm1-2026-03-18', estimatedVolumeUsd: 45_121, tier: 'normal' },
    { slug: 'ucl-bay1-ata1-2026-03-18', estimatedVolumeUsd: 23_456, tier: 'low' },
  ],
};

// ─── Main ───

function main() {
  const matches = SCENARIOS[scenario];
  if (!matches) {
    console.error(`Unknown scenario: ${scenario}. Available: ${Object.keys(SCENARIOS).join(', ')}`);
    process.exit(1);
  }

  console.log('='.repeat(80));
  console.log(`SCALP CAPITAL PLAN — scenario: ${scenario}`);
  console.log('='.repeat(80));
  console.log('');

  // For "tonight", we need to think about concurrent groups, not all 11 matches at once.
  // Group by time slot to compute concurrent capital allocation properly.
  if (scenario === 'tonight') {
    console.log('Tonight has 5 time slots with varying concurrency:');
    console.log('');

    const slots: { name: string; time: string; matches: MatchInput[] }[] = [
      {
        name: 'EPL 14:00 batch',
        time: '14:00-16:00 UTC',
        matches: matches.filter((m) => ['epl-mun-ast', 'epl-cry-lee', 'epl-not-ful'].some((p) => m.slug.startsWith(p))),
      },
      {
        name: 'LIV vs TOT',
        time: '16:30-18:30 UTC',
        matches: matches.filter((m) => m.slug.startsWith('epl-liv-tot')),
      },
      {
        name: 'MIN vs OKC',
        time: '17:00-19:30 UTC',
        matches: matches.filter((m) => m.slug.startsWith('nba-min-okc')),
      },
      {
        name: 'NBA 19:30 + La Liga',
        time: '19:30-22:00 UTC',
        matches: matches.filter((m) =>
          ['nba-dal', 'nba-det', 'nba-ind', 'lal-bar'].some((p) => m.slug.startsWith(p)),
        ),
      },
      {
        name: 'NBA late',
        time: '22:00-02:00 UTC',
        matches: matches.filter((m) =>
          ['nba-por', 'nba-gsw'].some((p) => m.slug.startsWith(p)),
        ),
      },
    ];

    // Identify max concurrent windows
    // 17:00-18:30: LIV-TOT + MIN-OKC = 2 matches, budget $60 = $30 each
    // 19:30-22:00: DAL-CLE + DET-TOR + IND-MIL + BAR-SEV = 4, budget $60 = dynamic
    // Overlaps between slots are the key concern

    console.log('─── Concurrent Windows ───');
    console.log('');

    // Window 1: EPL 14:00 batch (3 matches, no overlap)
    const w1 = allocateCapital(slots[0].matches, { totalRiskBudget: budget });
    console.log(`Window 1 — ${slots[0].name} (${slots[0].time}):`);
    console.log(w1.summary);
    console.log('');
    for (const a of w1.allocations) {
      console.log(`  CLI: ${allocationToCliArgs(a)}`);
    }
    console.log('');

    // Window 2: LIV-TOT + MIN-OKC overlap (16:30-19:30 = 2 matches)
    const w2matches = [...slots[1].matches, ...slots[2].matches];
    const w2 = allocateCapital(w2matches, { totalRiskBudget: budget });
    console.log(`Window 2 — LIV-TOT + MIN-OKC overlap (16:30-19:30 UTC):`);
    console.log(w2.summary);
    console.log('');
    for (const a of w2.allocations) {
      console.log(`  CLI: ${allocationToCliArgs(a)}`);
    }
    console.log('');

    // Window 3: NBA 19:30 batch + La Liga (4 matches, highest concurrency)
    const w3 = allocateCapital(slots[3].matches, { totalRiskBudget: budget });
    console.log(`Window 3 — ${slots[3].name} (${slots[3].time}):`);
    console.log(w3.summary);
    console.log('');
    for (const a of w3.allocations) {
      console.log(`  CLI: ${allocationToCliArgs(a)}`);
    }
    console.log('');

    // Window 4: NBA late (2 sequential, full budget each)
    const w4 = allocateCapital(slots[4].matches, { totalRiskBudget: budget });
    console.log(`Window 4 — ${slots[4].name} (${slots[4].time}):`);
    console.log(w4.summary);
    console.log('');
    for (const a of w4.allocations) {
      console.log(`  CLI: ${allocationToCliArgs(a)}`);
    }
    console.log('');

    // Summary: peak concurrent risk
    const peakConcurrent = Math.max(
      w1.allocations.length,
      w2.allocations.length,
      w3.allocations.length,
      w4.allocations.length,
    );
    console.log('─── Risk Summary ───');
    console.log(`Total risk budget: $${budget}`);
    console.log(`Peak concurrency: ${peakConcurrent} matches`);
    console.log(`Worst-case total loss: $${budget} (if all matches hit maxLoss simultaneously)`);
    console.log('Note: actual concurrent risk is lower because not all time slots overlap.');
    console.log('The budget is reusable — EPL 14:00 losses/gains reset before NBA 19:30.');
    console.log('');

  } else {
    // Simple: all matches are concurrent
    const result = allocateCapital(matches, { totalRiskBudget: budget });
    console.log(result.summary);
    console.log('');

    console.log('─── CLI Args Per Match ───');
    for (const a of result.allocations) {
      console.log(`  ${a.slug}: ${allocationToCliArgs(a)}`);
    }
    console.log('');

    console.log('─── Launch Script ───');
    console.log(generateLaunchScript(result.allocations));
  }
}

main();
