/**
 * REST source pollers — Phase 3 independent sources:
 *   REST_TRADES   — Data API GET /trades?user=…&takerOnly=false
 *   REST_ACTIVITY — Data API GET /activity?user=…
 *
 * Independence rules (handoff §4/§7):
 * - Each poll preserves RAW payload + per-request telemetry (timing, cache
 *   headers, newest source timestamp, new/duplicate counts, errors).
 * - NO freshness rejection: a late record is still recorded; its lateness
 *   is measured (sourceTs vs firstSeenUtc), never used to discard.
 * - Dedup identity is source-native (racing.ts), seeded from durable
 *   storage at startup — restart delivery is idempotent.
 * - Polling cadence is independently chosen (config), never Poly2's.
 */

import { restGet } from './egress.js';
import type {
  ActivityPayload, RacingStore, Reconciler, RestRawRow,
} from './racing.js';
import { activityIdentity, tradeGroupKey, tradesIdentity } from './racing.js';
import type { TradesPayload } from './racing.js';

type FetchFn = typeof restGet;

export interface RestPollerOpts {
  source: 'REST_TRADES' | 'REST_ACTIVITY';
  endpoint: 'trades' | 'activity';
  baseUrl: string;
  wallets: ReadonlySet<string>;
  intervalMs: number;
  limit?: number;
}

export class RestPoller {
  private timer: ReturnType<typeof setInterval> | null = null;
  private seen = new Set<string>();
  private polling = false;

  constructor(
    private opts: RestPollerOpts,
    private store: RacingStore,
    private reconciler: Reconciler,
    private nowIso: () => string = () => new Date().toISOString(),
    private fetchFn: FetchFn = restGet,
  ) {
    // Restart idempotence: previously committed identities are never
    // re-recorded after a process restart.
    this.seen = store.identityIndex(opts.source);
  }

  start(): void {
    if (this.timer) return;
    void this.pollAll();
    this.timer = setInterval(() => void this.pollAll(), this.opts.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Number of source-native identities already committed (tests). */
  get seenCount(): number { return this.seen.size; }

  private url(wallet: string): string {
    const base = `${this.opts.baseUrl}/${this.opts.endpoint}?user=${wallet}`
      + `&limit=${this.opts.limit ?? 100}`;
    // takerOnly=false: /trades otherwise defaults to taker-only, which would
    // silently drop the maker population this project exists to study.
    return this.opts.endpoint === 'trades' ? `${base}&takerOnly=false` : base;
  }

  async pollAll(): Promise<void> {
    if (this.polling) return; // never overlap polls of the same source
    this.polling = true;
    try {
      for (const wallet of this.opts.wallets) {
        await this.pollWallet(wallet.toLowerCase());
      }
    } finally {
      this.polling = false;
    }
  }

  /** One bounded poll cycle for one wallet. Errors are telemetry, never
   *  swallowed; a failed poll records zero new identities and moves on. */
  async pollWallet(wallet: string): Promise<void> {
    const requestStartUtc = this.nowIso();
    let status: number | null = null;
    let age: string | null = null;
    let cacheControl: string | null = null;
    let error: string | null = null;
    let items: Record<string, unknown>[] = [];
    let responseUtc: string | null = null;

    try {
      const res = await this.fetchFn(this.url(wallet));
      responseUtc = this.nowIso();
      status = res.status;
      age = res.headers.age;
      cacheControl = res.headers.cacheControl;
      if (res.status !== 200 || !Array.isArray(res.body)) {
        error = `HTTP ${res.status} or non-array body`;
      } else {
        items = res.body as Record<string, unknown>[];
      }
    } catch (err) {
      responseUtc = this.nowIso();
      error = String(err);
    }

    let newCount = 0;
    let dupCount = 0;
    let newestTs: number | null = null;

    for (const item of items) {
      const identity = this.opts.source === 'REST_TRADES'
        ? tradesIdentity(item as TradesPayload)
        : activityIdentity(item as ActivityPayload);
      const sourceTs = typeof item['timestamp'] === 'number' ? item['timestamp'] : null;
      if (sourceTs !== null && (newestTs === null || sourceTs > newestTs)) newestTs = sourceTs;
      if (this.seen.has(identity)) { dupCount++; continue; }
      this.seen.add(identity);
      newCount++;
      this.commit(wallet, identity, item, sourceTs, {
        requestStartUtc, responseUtc: responseUtc ?? this.nowIso(),
        httpStatus: status ?? 0, ageHeader: age, cacheControl,
      });
    }

    this.store.appendPollTelemetry({
      source: this.opts.source, wallet, requestStartUtc, responseUtc,
      httpStatus: status, ageHeader: age, cacheControl,
      newestSourceTs: newestTs, returned: items.length,
      newIdentities: newCount, duplicates: dupCount,
      intervalMs: this.opts.intervalMs, error, atUtc: this.nowIso(),
    });
  }

  /** Commit one raw evidence row + one normalized source observation +
   *  reconciliation membership. Order: raw first (evidence before meaning). */
  private commit(
    wallet: string,
    identity: string,
    item: Record<string, unknown>,
    sourceTs: number | null,
    http: { requestStartUtc: string; responseUtc: string; httpStatus: number; ageHeader: string | null; cacheControl: string | null },
  ): void {
    const firstSeenUtc = this.nowIso();
    const raw: RestRawRow = {
      source: this.opts.source as RestRawRow['source'], wallet, identity,
      payload: item, requestStartUtc: http.requestStartUtc,
      responseUtc: http.responseUtc, httpStatus: http.httpStatus,
      ageHeader: http.ageHeader, cacheControl: http.cacheControl,
      sourceTs, firstSeenUtc,
    };
    this.store.appendRestRaw(raw);

    const tx = String(item['transactionHash'] ?? '').toLowerCase();
    const asset = item['asset'] != null && item['asset'] !== '' ? String(item['asset']) : null;
    const size6 = typeof item['size'] === 'number' ? (item['size'] as number).toFixed(6) : null;
    const side = item['side'] === 'BUY' || item['side'] === 'SELL' ? item['side'] : null;
    // Hydration: market metadata (title/slug/conditionId) present or not.
    // A PARTIAL row is still a complete observation — raw evidence is kept.
    const hydration = item['title'] && item['conditionId'] ? 'FULL' : 'PARTIAL';
    // Group key only when the economic-trade fields exist; non-TRADE
    // activity (MERGE/SPLIT/REDEEM) has no asset and stays UNMATCHED-visible.
    const groupKey = tx && asset && size6
      ? tradeGroupKey(tx, asset, size6)
      : `ungrouped:${identity}`;

    this.store.appendSourceObservation({
      source: this.opts.source, identity, wallet, side, asset,
      size: size6,
      price: typeof item['price'] === 'number' ? (item['price'] as number).toFixed(4) : null,
      sourceTs, blockTimestamp: null,
      sourceFirstSeenUtc: firstSeenUtc, completedUtc: this.nowIso(),
      // /trades does not label maker vs taker per row — UNKNOWN is honest.
      role: 'UNKNOWN',
      groupKey, hydration,
    });
    this.reconciler.record(this.opts.source, identity, groupKey, firstSeenUtc);
  }
}
