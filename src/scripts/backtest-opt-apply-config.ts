#!/usr/bin/env tsx
/**
 * Backtest Optimizer — Apply Config to FollowAllocation
 *
 * Creates, updates, or unfollows paper FollowAllocations via raw pg.
 * Uses the same SSH tunnel as backtest scripts (port 15438).
 *
 * Safety: HARD REJECTS any operation on non-paper allocations.
 *
 * Usage:
 *   # Create new paper allocation with config
 *   npx tsx src/scripts/backtest-opt-apply-config.ts \
 *     --trader FloatyBoi --create --capital 30 \
 *     --copy-percent 0.10 --max-trade 8 --max-pred 30 \
 *     --min-buy-price 0.60 --gate 175 --follow-sells --both-sides
 *
 *   # Update existing paper allocation config
 *   npx tsx src/scripts/backtest-opt-apply-config.ts \
 *     --trader FloatyBoi --max-pred 50 --min-buy-price 0.40
 *
 *   # Disable follow-sells on existing allocation
 *   npx tsx src/scripts/backtest-opt-apply-config.ts \
 *     --trader FloatyBoi --no-follow-sells --no-both-sides
 *
 *   # Unfollow (deactivate) paper allocation
 *   npx tsx src/scripts/backtest-opt-apply-config.ts \
 *     --trader FloatyBoi --unfollow
 */

import { parseArgs } from 'util';
import { randomBytes } from 'crypto';
import { connectBacktestDb } from './lib/backtest-db';

const { values: args } = parseArgs({
  options: {
    trader: { type: 'string', default: '' },
    create: { type: 'boolean', default: false },
    unfollow: { type: 'boolean', default: false },
    capital: { type: 'string' },
    'copy-percent': { type: 'string' },
    'max-trade': { type: 'string' },
    'max-pred': { type: 'string' },
    'min-buy-price': { type: 'string' },
    gate: { type: 'string' },
    'follow-sells': { type: 'boolean', default: false },
    'no-follow-sells': { type: 'boolean', default: false },
    'both-sides': { type: 'boolean', default: false },
    'no-both-sides': { type: 'boolean', default: false },
    'exclude-slugs': { type: 'string' },
  },
});

// Whitelist of valid FollowAllocation columns for UPDATE
const VALID_COLUMNS = new Set([
  'copyTradePercent', 'maxPositionUsd', 'maxPredictionPositionUsd',
  'minBuyPrice', 'majorityOnlyMode', 'copySells', 'committedSideLock',
  'excludeEventSlugPatterns', 'initialCapital', 'currentCapital',
]);

function generateCuid(): string {
  const ts = Date.now().toString(36);
  const rand = randomBytes(8).toString('hex').slice(0, 8);
  return `c${ts}${rand}`;
}

async function main() {
  const traderInput = args.trader ?? '';
  if (!traderInput) {
    throw new Error('--trader is required');
  }

  const db = await connectBacktestDb();

  try {
    // Resolve trader
    const traderRes = await db.query(
      `SELECT "proxyWallet", "userName" FROM "Trader"
       WHERE "userName" ILIKE $1 OR "proxyWallet" LIKE $2
       LIMIT 1`,
      [traderInput, `%${traderInput}%`],
    );

    if (traderRes.rows.length === 0) {
      throw new Error(`Trader "${traderInput}" not found`);
    }

    const { proxyWallet, userName } = traderRes.rows[0];
    const displayName = userName || proxyWallet.slice(0, 10);
    console.log(`Trader: ${displayName} (${proxyWallet})`);

    if (args.unfollow) {
      // --- UNFOLLOW MODE ---
      const allocRes = await db.query(
        `SELECT id, "isPaper", "isActive" FROM "FollowAllocation" WHERE "proxyWallet" = $1`,
        [proxyWallet],
      );
      if (allocRes.rows.length === 0) {
        throw new Error('No allocation found');
      }
      const alloc = allocRes.rows[0];
      if (!alloc.isPaper) {
        throw new Error('SAFETY: Cannot unfollow non-paper allocation via this script');
      }
      await db.query(
        `UPDATE "FollowAllocation" SET "isActive" = false, "updatedAt" = NOW() WHERE id = $1`,
        [alloc.id],
      );
      console.log(`Unfollowed ${displayName} (allocation ${alloc.id})`);
      return;
    }

    if (args.create) {
      // --- CREATE MODE ---
      const capital = parseFloat(args.capital ?? '30');
      if (!Number.isFinite(capital) || capital <= 0) {
        throw new Error('--capital must be a positive number');
      }

      const gate = args.gate ? parseInt(args.gate, 10) : 175;
      const configData = {
        copyTradePercent: args['copy-percent'] ? parseFloat(args['copy-percent']) : null,
        maxPositionUsd: args['max-trade'] ? parseFloat(args['max-trade']) : null,
        maxPredictionPositionUsd: args['max-pred'] ? parseFloat(args['max-pred']) : null,
        minBuyPrice: args['min-buy-price'] ? parseFloat(args['min-buy-price']) : null,
        majorityOnlyMode: gate > 0,
        copySells: args['follow-sells'] ?? false,
        committedSideLock: !(args['both-sides'] ?? false),
        excludeEventSlugPatterns: args['exclude-slugs'] ?? 'updown-5m,updown-15m',
      };

      // Check for existing allocation (active or inactive)
      const existingRes = await db.query(
        `SELECT id, "isActive", "isPaper" FROM "FollowAllocation" WHERE "proxyWallet" = $1`,
        [proxyWallet],
      );

      if (existingRes.rows.length > 0) {
        const existing = existingRes.rows[0];
        if (existing.isActive) {
          throw new Error(`Active allocation already exists: ${existing.id} (isPaper=${existing.isPaper})`);
        }
        // Reactivate inactive allocation with new config
        await db.query(
          `UPDATE "FollowAllocation" SET
            "initialCapital" = $2, "currentCapital" = $2, "deployedCapital" = 0,
            "isPaper" = true, "isActive" = true,
            "copyTradePercent" = $3, "maxPositionUsd" = $4, "maxPredictionPositionUsd" = $5,
            "minBuyPrice" = $6, "majorityOnlyMode" = $7, "copySells" = $8, "committedSideLock" = $9,
            "excludeEventSlugPatterns" = $10, "copyMakerFills" = false, "updatedAt" = NOW()
          WHERE id = $1`,
          [
            existing.id, capital,
            configData.copyTradePercent, configData.maxPositionUsd, configData.maxPredictionPositionUsd,
            configData.minBuyPrice, configData.majorityOnlyMode, configData.copySells, configData.committedSideLock,
            configData.excludeEventSlugPatterns,
          ],
        );
        console.log(`Reactivated PAPER allocation ${existing.id}`);
      } else {
        // Fresh insert
        const id = generateCuid();
        await db.query(
          `INSERT INTO "FollowAllocation" (
            id, "proxyWallet", "initialCapital", "currentCapital", "deployedCapital",
            "isPaper", "isActive",
            "copyTradePercent", "maxPositionUsd", "maxPredictionPositionUsd",
            "minBuyPrice", "majorityOnlyMode", "copySells", "committedSideLock",
            "excludeEventSlugPatterns", "copyMakerFills",
            "createdAt", "updatedAt"
          ) VALUES ($1, $2, $3, $3, 0, true, true, $4, $5, $6, $7, $8, $9, $10, $11, false, NOW(), NOW())`,
          [
            id, proxyWallet, capital,
            configData.copyTradePercent, configData.maxPositionUsd, configData.maxPredictionPositionUsd,
            configData.minBuyPrice, configData.majorityOnlyMode, configData.copySells, configData.committedSideLock,
            configData.excludeEventSlugPatterns,
          ],
        );
        console.log(`Created PAPER allocation ${id}`);
      }

      // Ensure trader is monitored
      await db.query(
        `UPDATE "Trader" SET "isMonitored" = true WHERE "proxyWallet" = $1`,
        [proxyWallet],
      );

      console.log(`  Capital: $${capital.toFixed(2)}`);
      console.log(`  Config: copyPercent=${configData.copyTradePercent ?? 'default'} maxTrade=${configData.maxPositionUsd ?? 'default'} maxPred=${configData.maxPredictionPositionUsd ?? 'default'}`);
      console.log(`  Filters: minBuyPrice=${configData.minBuyPrice ?? 'default'} gate=${gate} followSells=${configData.copySells} bothSides=${!configData.committedSideLock}`);
      console.log(`  Slugs: ${configData.excludeEventSlugPatterns}`);
      return;
    }

    // --- UPDATE MODE ---
    const allocRes = await db.query(
      `SELECT * FROM "FollowAllocation" WHERE "proxyWallet" = $1`,
      [proxyWallet],
    );
    if (allocRes.rows.length === 0) {
      throw new Error('No allocation found. Use --create to create one.');
    }
    const alloc = allocRes.rows[0];

    if (!alloc.isPaper) {
      throw new Error('SAFETY: Cannot modify non-paper allocation via this script');
    }

    const updates: string[] = [];
    const params: any[] = [];
    let paramIdx = 1;

    function addUpdate(col: string, val: any) {
      if (!VALID_COLUMNS.has(col)) throw new Error(`Invalid column: ${col}`);
      if (val !== undefined && val !== null) {
        updates.push(`"${col}" = $${paramIdx++}`);
        params.push(val);
      }
    }

    if (args['copy-percent']) addUpdate('copyTradePercent', parseFloat(args['copy-percent']));
    if (args['max-trade']) addUpdate('maxPositionUsd', parseFloat(args['max-trade']));
    if (args['max-pred']) addUpdate('maxPredictionPositionUsd', parseFloat(args['max-pred']));
    if (args['min-buy-price']) addUpdate('minBuyPrice', parseFloat(args['min-buy-price']));
    if (args.gate) addUpdate('majorityOnlyMode', parseInt(args.gate, 10) > 0);
    if (args['follow-sells']) addUpdate('copySells', true);
    if (args['no-follow-sells']) addUpdate('copySells', false);
    if (args['both-sides']) addUpdate('committedSideLock', false);
    if (args['no-both-sides']) addUpdate('committedSideLock', true);
    if (args['exclude-slugs']) addUpdate('excludeEventSlugPatterns', args['exclude-slugs']);
    if (args.capital) {
      const cap = parseFloat(args.capital);
      addUpdate('initialCapital', cap);
      addUpdate('currentCapital', cap);
    }

    if (updates.length === 0) {
      console.log('No config changes specified');
      return;
    }

    updates.push(`"updatedAt" = NOW()`);
    params.push(alloc.id);

    await db.query(
      `UPDATE "FollowAllocation" SET ${updates.join(', ')} WHERE id = $${paramIdx}`,
      params,
    );

    console.log(`Updated PAPER allocation ${alloc.id}`);
    console.log(`  Changes: ${updates.filter(u => !u.includes('updatedAt')).join(', ')}`);
  } finally {
    await db.end();
  }
}

main().catch(e => { console.error(e.message ?? e); process.exit(1); });
