import { Client } from 'pg';
import { config } from '../config/env';
import { createJobLogger } from './logger';

const log = createJobLogger('pg-listen');

export class PgListener {
  private client: Client | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closed = false;
  private onNotification: (payload: string) => void;
  private channel: string;

  constructor(channel: string, onNotification: (payload: string) => void) {
    this.channel = channel;
    this.onNotification = onNotification;
  }

  async connect(): Promise<void> {
    this.closed = false;
    await this._connect();
  }

  private async _connect(): Promise<void> {
    try {
      this.client = new Client({ connectionString: config.DATABASE_URL });
      this.client.on('error', (err) => {
        log.warn(`PG listener error: ${err.message}`);
        this._scheduleReconnect();
      });
      this.client.on('end', () => {
        if (!this.closed) this._scheduleReconnect();
      });
      this.client.on('notification', (msg) => {
        if (msg.channel === this.channel && msg.payload) {
          this.onNotification(msg.payload);
        }
      });
      await this.client.connect();
      await this.client.query(`LISTEN ${this.channel}`);
      this.attempt = 0;
      log.info(`Listening on channel "${this.channel}"`);
    } catch (err: any) {
      log.warn(`PG listener connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  private _scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer) return;
    const delay = Math.min(1000 * 2 ** this.attempt, 30000) + Math.random() * 500;
    this.attempt++;
    log.info(`Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.attempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try { this.client?.end().catch(() => {}); } catch {}
      await this._connect();
    }, delay);
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    try { await this.client?.end(); } catch {}
  }
}
