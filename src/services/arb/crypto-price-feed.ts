import WebSocket from 'ws';
import { createJobLogger } from '../../lib/logger';
import { config } from '../../config/env';

const INITIAL_RECONNECT_MS = 1000;

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

/**
 * Real-time price feed for a crypto asset via Binance trade stream.
 * Supports any USDT pair: btc, eth, sol, xrp, etc.
 */
export class CryptoPriceFeed {
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private log;
  private wsUrl: string;

  readonly symbol: string; // e.g. "btc", "eth"

  // Price tracking
  private _lastPrice = 0;
  private _lastUpdateMs = 0;

  // Per-candle snapshots (keyed by candle duration to support multiple engines)
  private candleOpenPrices = new Map<number, number>();

  // Metrics
  state: ConnectionState = 'disconnected';
  connectedAt: Date | null = null;
  messagesReceived = 0;

  constructor(symbol: string) {
    this.symbol = symbol.toLowerCase();
    this.wsUrl = `wss://stream.binance.com:9443/ws/${this.symbol}usdt@trade`;
    this.log = createJobLogger(`price-feed-${this.symbol}`);
  }

  get lastPrice(): number {
    return this._lastPrice;
  }

  get lastUpdateMs(): number {
    return this._lastUpdateMs;
  }

  /** Age of the last price update in milliseconds. */
  get priceAge(): number {
    return this._lastUpdateMs > 0 ? Date.now() - this._lastUpdateMs : Infinity;
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.state = 'connecting';
    this.log.info(`Connecting to Binance ${this.symbol.toUpperCase()} trade stream...`, { url: this.wsUrl });
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
    this.log.info(`${this.symbol.toUpperCase()} price feed closed`);
  }

  /**
   * Snapshot the current price as the candle open for a given duration.
   * Each engine calls this with its own candleDurationMs.
   */
  markCandleOpen(candleDurationMs: number): void {
    this.candleOpenPrices.set(candleDurationMs, this._lastPrice);
  }

  /**
   * Get the candle open price for a given duration.
   */
  getCandleOpenPrice(candleDurationMs: number): number {
    return this.candleOpenPrices.get(candleDurationMs) ?? 0;
  }

  /**
   * Determine price direction relative to the candle open for a specific duration.
   */
  getDirection(candleDurationMs: number, minChange: number): 'UP' | 'DOWN' | 'FLAT' {
    const openPrice = this.candleOpenPrices.get(candleDurationMs);
    if (!openPrice || openPrice <= 0 || this._lastPrice <= 0) return 'FLAT';
    const change = (this._lastPrice - openPrice) / openPrice;
    if (Math.abs(change) < minChange) return 'FLAT';
    return change > 0 ? 'UP' : 'DOWN';
  }

  private createConnection(): void {
    const ws = new WebSocket(this.wsUrl);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'connected';
      this.connectedAt = new Date();
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      this.log.info(`Binance ${this.symbol.toUpperCase()} trade stream connected`);
    });

    ws.on('message', (data: WebSocket.Data) => {
      this.messagesReceived++;
      try {
        const msg = JSON.parse(data.toString());
        if (msg.p) {
          this._lastPrice = parseFloat(msg.p);
          this._lastUpdateMs = Date.now();
        }
      } catch {
        // Ignore parse errors
      }
    });

    ws.on('close', (code: number, reason: Buffer) => {
      this.ws = null;
      this.log.warn(`Binance ${this.symbol.toUpperCase()} stream closed`, { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      this.log.error(`Binance ${this.symbol.toUpperCase()} stream error`, { error: err.message });
      // 'close' event fires after 'error', handles reconnection
    });
  }

  private clearTimers(): void {
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

    this.log.info(`Reconnecting to Binance in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }
}
