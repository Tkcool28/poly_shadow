import WebSocket from 'ws';
import { config } from '../config/env';
import { createJobLogger } from '../lib/logger';

const log = createJobLogger('midpoint-cache');

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const STALE_THRESHOLD_MS = 30_000;
const INITIAL_RECONNECT_MS = 1000;
const PRUNE_INTERVAL_MS = 300_000; // 5 min

interface CacheEntry {
  mid: number;
  updatedAt: number;
}

/**
 * WebSocket-backed midpoint cache that listens for `best_bid_ask` events
 * from the CLOB Market WebSocket. Provides synchronous O(1) midpoint lookups
 * to eliminate the REST getMidpoint() call in the stale-signal guard.
 *
 * Falls back to null (→ API fallback) when:
 * - Cache miss (token not yet received a best_bid_ask event)
 * - Stale entry (older than MIDPOINT_CACHE_MAX_AGE_MS)
 * - Instance not initialized
 */
export class MidpointCache {
  private ws: WebSocket | null = null;
  private cache = new Map<string, CacheEntry>();
  private subscribedTokenIds: string[] = [];
  private tokenLastRequested = new Map<string, number>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pruneTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private lastMessageAt: Date | null = null;

  // Metrics (readable for health checks)
  cacheHits = 0;
  cacheMisses = 0;

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.createConnection();
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = setInterval(() => this.pruneStaleSubscriptions(), PRUNE_INTERVAL_MS);
  }

  close(): void {
    this.shouldReconnect = false;
    this.clearTimers();
    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
        this.ws.close(1000, 'Shutting down');
      }
      this.ws = null;
    }
    log.info('Midpoint cache closed', {
      cacheHits: this.cacheHits,
      cacheMisses: this.cacheMisses,
    });
  }

  /**
   * Merge new tokenIds into subscription set. Only re-sends subscription
   * when genuinely new tokenIds appear (avoids unnecessary WS messages).
   */
  ensureSubscribed(tokenIds: string[]): void {
    const now = Date.now();
    let hasNew = false;
    for (const id of tokenIds) {
      if (!this.tokenLastRequested.has(id)) hasNew = true;
      this.tokenLastRequested.set(id, now);
    }
    if (hasNew) {
      this.subscribedTokenIds = [...this.tokenLastRequested.keys()];
      if (!this.ws) {
        // WS was closed (idle prune or never started) — full restart
        log.info('Midpoint cache: re-arming WS connection', { tokens: this.subscribedTokenIds.length });
        this.connect(); // resets shouldReconnect, reconnectDelay, starts pruneTimer
      } else {
        this.sendSubscription();
      }
    }
  }

  /**
   * Synchronous O(1) midpoint lookup. Returns null on miss or stale entry.
   */
  getMid(tokenId: string): number | null {
    const entry = this.cache.get(tokenId);
    if (!entry) {
      this.cacheMisses++;
      this.maybeLogStats();
      return null;
    }
    if (Date.now() - entry.updatedAt > config.MIDPOINT_CACHE_MAX_AGE_MS) {
      this.cacheMisses++;
      this.maybeLogStats();
      return null;
    }
    this.cacheHits++;
    this.maybeLogStats();
    return entry.mid;
  }

  private maybeLogStats(): void {
    const total = this.cacheHits + this.cacheMisses;
    if (total > 0 && total % 100 === 0) {
      const hitRate = ((this.cacheHits / total) * 100).toFixed(1);
      log.info('Midpoint cache stats', {
        hits: this.cacheHits,
        misses: this.cacheMisses,
        hitRate: `${hitRate}%`,
        cacheSize: this.cache.size,
        subscriptions: this.subscribedTokenIds.length,
      });
    }
  }

  // --- Internal: WS lifecycle (mirrors ClobMarketStream pattern) ---

  private createConnection(): void {
    const ws = new WebSocket(CLOB_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      this.cache.clear(); // stale entries from before reconnect
      log.info('Midpoint cache WS connected', { tokens: this.subscribedTokenIds.length });
      if (this.subscribedTokenIds.length > 0) this.sendSubscription();
      this.startPing(ws);
    });

    ws.on('message', (data: WebSocket.Data) => {
      const raw = data.toString();
      if (raw === 'PONG') {
        this.lastMessageAt = new Date();
        return;
      }
      this.lastMessageAt = new Date();

      try {
        const parsed = JSON.parse(raw);
        const items: any[] = Array.isArray(parsed) ? parsed : [parsed];
        for (const item of items) {
          if (item.event_type === 'best_bid_ask' && item.asset_id) {
            this.onBestBidAsk(item);
          } else if (item.event_type === 'book' && item.asset_id) {
            this.onBook(item);
          } else if (item.event_type === 'price_change' && item.price_changes) {
            this.onPriceChange(item);
          } else if (item.event_type === 'last_trade_price' && item.asset_id) {
            this.onLastTradePrice(item);
          }
        }
      } catch { /* non-JSON silently ignored */ }
    });

    ws.on('close', (code: number) => {
      this.clearPingTimer();
      this.ws = null;
      log.warn('Midpoint cache WS closed', { code });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('Midpoint cache WS error', { error: err.message });
    });
  }

  private onBestBidAsk(event: { asset_id: string; best_bid: string; best_ask: string }): void {
    const bid = parseFloat(event.best_bid);
    const ask = parseFloat(event.best_ask);
    if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) return;
    this.cache.set(event.asset_id, { mid: (bid + ask) / 2, updatedAt: Date.now() });
  }

  /**
   * Seed cache from initial book snapshot. Uses explicit max/min to avoid
   * relying on Polymarket's sort order of bids/asks arrays.
   */
  private onBook(event: { asset_id: string; bids: { price: string }[]; asks: { price: string }[] }): void {
    if (!event.bids?.length || !event.asks?.length) return;
    // Only seed if no entry yet (best_bid_ask updates take precedence)
    if (this.cache.has(event.asset_id)) return;
    let bestBid = 0;
    for (const b of event.bids) {
      const p = parseFloat(b.price);
      if (p > bestBid) bestBid = p;
    }
    let bestAsk = Infinity;
    for (const a of event.asks) {
      const p = parseFloat(a.price);
      if (p < bestAsk) bestAsk = p;
    }
    if (bestBid <= 0 || bestAsk === Infinity) return;
    this.cache.set(event.asset_id, { mid: (bestBid + bestAsk) / 2, updatedAt: Date.now() });
  }

  /**
   * Extract best_bid/best_ask from price_change entries. Same data quality as
   * onBestBidAsk — these are post-event bid/ask snapshots per fill.
   */
  private onPriceChange(event: { price_changes?: { asset_id: string; best_bid?: string; best_ask?: string }[] }): void {
    if (!event.price_changes) return;
    for (const pc of event.price_changes) {
      if (!pc.asset_id || !pc.best_bid || !pc.best_ask) continue;
      const bid = parseFloat(pc.best_bid);
      const ask = parseFloat(pc.best_ask);
      if (isNaN(bid) || isNaN(ask) || bid <= 0 || ask <= 0) continue;
      this.cache.set(pc.asset_id, { mid: (bid + ask) / 2, updatedAt: Date.now() });
    }
  }

  /**
   * Use last_trade_price as tertiary fallback. Less accurate than bid/ask
   * midpoint (single execution price), so only write when no fresh entry exists.
   */
  private onLastTradePrice(event: { asset_id: string; price: string }): void {
    const price = parseFloat(event.price);
    if (isNaN(price) || price <= 0 || price > 1.0) return;
    const existing = this.cache.get(event.asset_id);
    if (existing && (Date.now() - existing.updatedAt) < config.MIDPOINT_CACHE_MAX_AGE_MS / 2) return;
    this.cache.set(event.asset_id, { mid: price, updatedAt: Date.now() });
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      assets_ids: this.subscribedTokenIds,
      type: 'market',
      custom_feature_enabled: true,
    }));
    log.info('Midpoint cache subscription sent', { tokenCount: this.subscribedTokenIds.length });
  }

  private startPing(ws: WebSocket): void {
    this.clearPingTimer();
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        if (this.lastMessageAt && Date.now() - this.lastMessageAt.getTime() > STALE_THRESHOLD_MS) {
          log.warn('Midpoint cache WS stale, forcing reconnect');
          ws.terminate();
          return;
        }
        ws.send('PING', (err) => {
          if (err) log.warn('Midpoint cache PING failed', { error: err.message });
        });
      }
    }, PING_INTERVAL_MS);
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    if (this.subscribedTokenIds.length === 0) {
      log.info('Midpoint cache: skipping reconnect (no subscriptions)');
      return;
    }
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, 30_000);
    log.info(`Midpoint cache reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }

  private pruneStaleSubscriptions(): void {
    const cutoff = Date.now() - config.MIDPOINT_CACHE_PRUNE_MS;
    let changed = false;
    for (const [tokenId, lastReq] of this.tokenLastRequested) {
      if (lastReq < cutoff) {
        this.tokenLastRequested.delete(tokenId);
        this.cache.delete(tokenId);
        changed = true;
      }
    }
    if (changed) {
      this.subscribedTokenIds = [...this.tokenLastRequested.keys()];
      if (this.subscribedTokenIds.length === 0) {
        // All tokens pruned — fully quiesce: close WS + stop all timers.
        // ensureSubscribed() will call connect() to restart everything.
        log.info('Midpoint cache: all subscriptions pruned, closing idle WS');
        this.shouldReconnect = false; // prevent on-close handler from re-arming
        if (this.ws) {
          this.ws.removeAllListeners();
          if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
            this.ws.close(1000, 'No subscriptions');
          }
          this.ws = null;
        }
        this.clearTimers(); // stop ping, prune, and any pending reconnect
        return;
      }
      this.sendSubscription();
      log.info('Midpoint cache pruned stale subscriptions', { remaining: this.subscribedTokenIds.length });
    }
  }

  private clearPingTimer(): void {
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private clearTimers(): void {
    this.clearPingTimer();
    if (this.pruneTimer) { clearInterval(this.pruneTimer); this.pruneTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }
}

// Singleton — null-safe for callers that don't init (arb-worker, etc.)
let instance: MidpointCache | null = null;

export function initMidpointCache(): void {
  instance = new MidpointCache();
  instance.connect();
}

export function closeMidpointCache(): void {
  instance?.close();
  instance = null;
}

export function ensureSubscribed(tokenIds: string[]): void {
  instance?.ensureSubscribed(tokenIds);
}

export function getMidFromCache(tokenId: string): number | null {
  return instance?.getMid(tokenId) ?? null;
}
