import WebSocket from 'ws';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('chain-trade-watcher');

// Both contracts emit OrderFilled — BTC/NegRisk markets use the second address
const CTF_EXCHANGE_ADDRESSES = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E', // standard CTFExchange
  '0xC5d563A36AE78145C45a50134d48A1215220f80a', // NegRiskCTFExchange (BTC price bands)
];
// keccak256('OrderFilled(bytes32,address,address,uint256,uint256,uint256,uint256,uint256)')
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';
const HEARTBEAT_INTERVAL_MS = 20000;
const STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3; // 60s without heartbeat response → reconnect
const INITIAL_RECONNECT_MS = 1000;

export type WalletDetectedCallback = (proxyWallet: string) => Promise<void>;
export type ChainWatcherState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class ChainTradeWatcher {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private lastHeartbeatAt: Date | null = null;
  private onWalletDetected: WalletDetectedCallback;
  private getLiveWallets: () => Set<string>; // returns only live-allocation wallets (~7)

  state: ChainWatcherState = 'disconnected';
  lastEventAt: Date | null = null;
  eventsReceived = 0;
  triggeredDetections = 0;

  constructor(onWalletDetected: WalletDetectedCallback, getLiveWallets: () => Set<string>) {
    this.onWalletDetected = onWalletDetected;
    this.getLiveWallets = getLiveWallets;
  }

  connect(): void {
    if (this.ws) return;
    this.shouldReconnect = true;
    this.state = 'connecting';
    log.info('Connecting to Polygon WS RPC...', { url: config.POLYGON_WS_RPC_URL });
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
    log.info('Connection closed');
  }

  private createConnection(): void {
    const ws = new WebSocket(config.POLYGON_WS_RPC_URL);
    this.ws = ws;

    ws.on('open', () => {
      this.state = 'connected';
      this.reconnectDelayMs = INITIAL_RECONNECT_MS;
      this.lastHeartbeatAt = new Date();
      log.info('Connected, subscribing to CTF Exchange OrderFilled events');

      // Subscribe to both standard and NegRisk CTF Exchange contracts in one call
      ws.send(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
        params: ['logs', {
          address: CTF_EXCHANGE_ADDRESSES,
          topics: [ORDER_FILLED_TOPIC],
        }],
      }));

      this.startHeartbeat(ws);
    });

    ws.on('message', (data: WebSocket.Data) => {
      try {
        const msg = JSON.parse(data.toString());

        // Heartbeat response (eth_chainId) — update liveness timestamp
        if (msg.id === 999 && (msg.result || msg.error)) {
          this.lastHeartbeatAt = new Date();
          return;
        }

        // Subscription confirmed
        if (msg.id === 1 && msg.result) {
          log.info('Subscribed to OrderFilled events', { subscriptionId: msg.result });
          return;
        }

        // Subscription event
        if (msg.method === 'eth_subscription' && msg.params?.result?.topics?.length >= 4) {
          // Skip reorg'd events (chain reorganization invalidated this log)
          if (msg.params.result.removed === true) return;

          this.eventsReceived++;
          this.lastEventAt = new Date();

          const topics: string[] = msg.params.result.topics;
          // topics[2] = maker address, topics[3] = taker address, padded to 32 bytes
          const makerAddress = '0x' + topics[2].slice(26).toLowerCase();
          const takerAddress = '0x' + topics[3].slice(26).toLowerCase();

          const liveWallets = this.getLiveWallets();
          const matchedWallet = liveWallets.has(makerAddress)
            ? makerAddress
            : liveWallets.has(takerAddress)
              ? takerAddress
              : null;

          if (matchedWallet) {
            this.triggeredDetections++;
            log.info('Live wallet OrderFilled detected', {
              wallet: matchedWallet.slice(0, 10),
              role: matchedWallet === makerAddress ? 'maker' : 'taker',
              txHash: msg.params.result.transactionHash?.slice(0, 18),
              contract: msg.params.result.address,
            });
            void this.onWalletDetected(matchedWallet).catch((err: any) =>
              log.error('Wallet detection handler error', { error: err.message }),
            );
          }
        }
      } catch {
        // Non-JSON / malformed messages ignored
      }
    });

    ws.on('pong', () => { this.lastHeartbeatAt = new Date(); });
    ws.on('ping', () => { this.lastHeartbeatAt = new Date(); });

    ws.on('close', (code: number, reason: Buffer) => {
      this.clearTimers();
      this.ws = null;
      log.warn('Connection closed', { code, reason: reason.toString() });
      this.scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log.error('Connection error', { error: err.message });
      // 'close' event fires after 'error' — handles reconnection
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Stale detection: force reconnect if no heartbeat response for STALE_THRESHOLD_MS
      if (this.lastHeartbeatAt &&
          Date.now() - this.lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS) {
        log.warn('Connection stale (no heartbeat response in 60s), forcing reconnect');
        ws.terminate(); // → 'close' event → scheduleReconnect
        return;
      }

      // Periodic status log (every 5th heartbeat = every ~100s)
      if (this.eventsReceived % 5 === 0 || this.eventsReceived < 5) {
        log.info('Chain watcher heartbeat', {
          eventsReceived: this.eventsReceived,
          triggeredDetections: this.triggeredDetections,
          liveWallets: this.getLiveWallets().size,
          lastEventAt: this.lastEventAt?.toISOString() ?? 'never',
        });
      }

      // Keepalive: Polygon WS RPC uses JSON-RPC responses, not WebSocket protocol pings
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: 999, method: 'eth_chainId', params: [] }));
    }, HEARTBEAT_INTERVAL_MS);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private clearTimers(): void {
    this.clearHeartbeat();
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;
    this.state = 'reconnecting';
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, config.WS_RECONNECT_MAX_MS);
    log.info(`Reconnecting in ${delay}ms...`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.createConnection();
    }, delay);
  }
}
