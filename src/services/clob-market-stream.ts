import WebSocket from 'ws';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('clob-market-stream');

const CLOB_WS_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const PING_INTERVAL_MS = 10_000;
const STALE_THRESHOLD_MS = 30_000; // no PONG/message in 30s → reconnect
const INITIAL_RECONNECT_MS = 1000;

/**
 * Trade execution event from the CLOB WebSocket `last_trade_price` event type.
 */
export interface ClobTradeEvent {
  asset_id: string;
  market: string;        // conditionId
  price: string;
  size: string;
  side: string;          // BUY or SELL
  fee_rate_bps: string;
  timestamp: string;     // milliseconds as string
  transaction_hash: string;
  event_type: 'last_trade_price';
}

export type ClobTradeCallback = (event: ClobTradeEvent) => void;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * WebSocket stream that connects to the Polymarket CLOB market channel
 * and delivers real-time trade execution events (`last_trade_price`).
 *
 * Unlike the RTDS `activity/trades` firehose (which is dead as of 2026-03),
 * this requires subscribing to specific token IDs.
 */
export class ClobMarketStream {
  private ws: WebSocket | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private onTrade: ClobTradeCallback;
  private subscribedTokenIds: string[] = [];

  // Metrics
  state: ConnectionState = 'disconnected';
  connectedAt: Date | null = null;
  messagesReceived = 0;
  tradesReceived = 0;
  lastMessageAt: Date | null = null;

  constructor(onTrade: ClobTradeCallback) {
    this.onTrade = onTrade;
  }

  /**
   * Update the token IDs to subscribe to. If connected, unsubscribes old set first
   * then re-subscribes with the new token IDs to prevent server-side accumulation.
   */
  setTokenIds(tokenIds: string[]): void {
    const previousIds = this.subscribedTokenIds;
    this.subscribedTokenIds = tokenIds;
    if (this.ws?.readyState === WebSocket.OPEN) {
      if (previousIds.length > 0) {
        this.sendUnsubscription(previousIds);
      }
      this.sendSubscription();
    }
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.state = 'connecting';
    log.info('Connecting to CLOB market WebSocket...', { url: CLOB_WS_URL });
    this.createConnection();
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
    this.state = 'disconnected';
    log.info('CLOB market stream closed');
  }

  private createConnection(): void {
    const ws = new WebSocket(CLOB_WS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'connected';
      this.connectedAt = new Date();
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;

      log.info('CLOB market WebSocket connected', { tokenCount: this.subscribedTokenIds.length });

      if (this.subscribedTokenIds.length > 0) {
        this.sendSubscription();
      }

      this.startPing(ws);
    });

    ws.on('message', (data: WebSocket.Data) => {
      const raw = data.toString();

      // CLOB WebSocket responds to "PING" with "PONG" (uppercase strings)
      if (raw === 'PONG') {
        this.lastMessageAt = new Date();
        return;
      }

      this.messagesReceived++;
      this.lastMessageAt = new Date();

      // Periodic status log
      if (this.messagesReceived % 1000 === 1) {
        log.info('CLOB stream status', {
          messagesReceived: this.messagesReceived,
          tradesReceived: this.tradesReceived,
          subscribedTokens: this.subscribedTokenIds.length,
        });
      }

      try {
        const parsed = JSON.parse(raw);
        const items: any[] = Array.isArray(parsed) ? parsed : [parsed];

        for (const item of items) {
          if (item.event_type === 'last_trade_price') {
            this.tradesReceived++;
            this.onTrade(item as ClobTradeEvent);
          } else if (item.event_type) {
            log.debug('CLOB WS non-trade event', {
              event_type: item.event_type,
              asset_id: item.asset_id,
            });
          }
        }
      } catch {
        // Non-JSON messages silently ignored (e.g. empty subscription acks)
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      this.ws = null;
      log.warn('CLOB market WebSocket closed', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('CLOB market WebSocket error', { error: err.message });
    });
  }

  private sendSubscription(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      assets_ids: this.subscribedTokenIds,
      type: 'market',
      custom_feature_enabled: true,
    });
    this.ws.send(msg);
    log.info('CLOB market subscription sent', { tokenCount: this.subscribedTokenIds.length });
  }

  private sendUnsubscription(tokenIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const msg = JSON.stringify({
      assets_ids: tokenIds,
      type: 'market',
      unsubscribe: true,
    });
    this.ws.send(msg);
  }

  private startPing(ws: WebSocket): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Stale detection: no PONG/message in threshold → force reconnect
        if (this.lastMessageAt &&
            Date.now() - this.lastMessageAt.getTime() > STALE_THRESHOLD_MS) {
          log.warn('CLOB market stream stale, forcing reconnect', {
            lastMessageAt: this.lastMessageAt.toISOString(),
          });
          ws.terminate();
          return;
        }
        ws.send('PING', (err) => {
          if (err) log.warn('CLOB PING send failed', { error: err.message });
        });
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.state = 'reconnecting';

    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, config.WS_RECONNECT_MAX_MS);

    log.info(`Reconnecting to CLOB market WebSocket in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }
}
