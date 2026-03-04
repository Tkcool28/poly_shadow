import WebSocket from 'ws';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('ws-trade-stream');

const RTDS_URL = 'wss://ws-live-data.polymarket.com';
const HEARTBEAT_INTERVAL_MS = 5000;
const INITIAL_RECONNECT_MS = 1000;

export interface RtdsTradePayload {
  asset: string;
  conditionId: string;
  eventSlug: string;
  icon?: string;
  name: string;
  outcome: string;
  outcomeIndex: number;
  price: string;
  profileImage?: string;
  proxyWallet: string;
  pseudonym?: string;
  side: string; // BUY or SELL
  size: string;
  slug: string;
  timestamp: number;
  title: string;
  transactionHash: string;
}

export type TradeCallback = (payload: RtdsTradePayload) => void;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class RtdsTradeStream {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private onTrade: TradeCallback;

  // Metrics
  state: ConnectionState = 'disconnected';
  connectedAt: Date | null = null;
  messagesReceived = 0;
  lastMessageAt: Date | null = null;

  constructor(onTrade: TradeCallback) {
    this.onTrade = onTrade;
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.state = 'connecting';
    log.info('Connecting to RTDS...', { url: RTDS_URL });
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
    log.info('RTDS connection closed');
  }

  private createConnection(): void {
    const ws = new WebSocket(RTDS_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'connected';
      this.connectedAt = new Date();
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;

      log.info('RTDS connected, subscribing to activity/trades');

      // Subscribe to all trades
      ws.send(
        JSON.stringify({
          action: 'subscribe',
          subscriptions: [{ topic: 'activity', type: 'trades' }],
        }),
      );

      // Start heartbeat
      this.startHeartbeat(ws);
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.messagesReceived++;
      this.lastMessageAt = new Date();

      // Periodic status log (every 500th message) to track RTDS health
      if (this.messagesReceived % 500 === 1) {
        log.info('RTDS message status', {
          messagesReceived: this.messagesReceived,
          lastMessageAt: this.lastMessageAt?.toISOString(),
        });
      }

      try {
        const raw = data.toString();
        const msg = JSON.parse(raw);
        if (msg.topic === 'activity' && msg.type === 'trades' && msg.payload) {
          this.onTrade(msg.payload as RtdsTradePayload);
        }
      } catch {
        // Non-JSON messages (server-specific text frames) are ignored
      }
    });

    // Protocol-level pong: server acknowledges our ws.ping() — update liveness timestamp
    ws.on('pong', () => {
      this.lastMessageAt = new Date();
    });

    // Protocol-level ping from server: ws library auto-replies with pong, just track liveness
    ws.on('ping', () => {
      this.lastMessageAt = new Date();
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      this.ws = null;
      log.warn('RTDS connection closed', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('RTDS connection error', { error: err.message });
      // 'close' event will fire after 'error', which handles reconnection
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        // Detect stale connection: no pong/message/ping in 3 heartbeat intervals
        if (this.lastMessageAt &&
            Date.now() - this.lastMessageAt.getTime() > HEARTBEAT_INTERVAL_MS * 3) {
          log.warn('RTDS connection stale (no activity in 15s), forcing reconnect');
          ws.terminate(); // force-close → 'close' event → scheduleReconnect
          return;
        }
        // Use WebSocket protocol-level ping — server responds with protocol pong (not text)
        ws.ping();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
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

    log.info(`Reconnecting to RTDS in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }
}
