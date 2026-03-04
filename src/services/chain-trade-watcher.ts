import WebSocket from 'ws';
import { ethers } from 'ethers';
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
const HEARTBEAT_INTERVAL_MS = 45_000;  // keepalive cadence (was 20s; reduced to save dRPC CU)
const STALE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 3; // 135s without heartbeat response → reconnect
const INITIAL_RECONNECT_MS = 1000;

// ABI types for decoding OrderFilled event data (non-indexed params only)
// [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled, fee]
const ORDER_FILLED_DATA_TYPES = ['uint256', 'uint256', 'uint256', 'uint256', 'uint256'];

/** Left-pad 20-byte address to 32-byte indexed-topic value */
function padAddress(addr: string): string {
  return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

export interface ChainTradeData {
  proxyWallet: string;
  tokenId: string;       // conditional token ERC1155 ID
  side: 'BUY' | 'SELL';
  size: number;          // shares (6-decimal precision)
  price: number;         // USDC per share
  transactionHash: string;
  isNegRisk: boolean;
  contract: string;      // exchange contract address
}

export type ChainTradeCallback = (data: ChainTradeData) => Promise<void>;
export type ChainWatcherState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export class ChainTradeWatcher {
  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelayMs = INITIAL_RECONNECT_MS;
  private shouldReconnect = true;
  private lastHeartbeatAt: Date | null = null;
  private onTradeDetected: ChainTradeCallback;
  private getLiveWallets: () => Set<string>; // returns only live-allocation wallets (~7)
  private subscribedWallets: Set<string> = new Set();
  private recentTxHashes: Set<string> = new Set(); // dedup across maker/taker subs
  private heartbeatCount = 0;

  state: ChainWatcherState = 'disconnected';
  lastEventAt: Date | null = null;
  eventsReceived = 0;
  triggeredDetections = 0;

  constructor(onTradeDetected: ChainTradeCallback, getLiveWallets: () => Set<string>) {
    this.onTradeDetected = onTradeDetected;
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

      this.subscribe(ws);
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

        // Subscription confirmed (id=1 maker, id=2 taker)
        if ((msg.id === 1 || msg.id === 2) && msg.result) {
          log.info('Subscribed to OrderFilled events', {
            subscriptionId: msg.result,
            filter: msg.id === 1 ? 'maker' : 'taker',
          });
          return;
        }

        // Subscription error
        if ((msg.id === 1 || msg.id === 2) && msg.error) {
          log.error('Subscription failed — falling back to REST polling only', {
            filter: msg.id === 1 ? 'maker' : 'taker',
            error: msg.error,
          });
          return;
        }

        // Subscription event
        if (msg.method === 'eth_subscription' && msg.params?.result?.topics?.length >= 4) {
          // Skip reorg'd events (chain reorganization invalidated this log)
          if (msg.params.result.removed === true) return;

          // Dedup: both maker/taker subs can deliver the same event for self-trades
          const dedupKey = `${msg.params.result.transactionHash}:${msg.params.result.logIndex}`;
          if (this.recentTxHashes.has(dedupKey)) return;
          this.recentTxHashes.add(dedupKey);
          if (this.recentTxHashes.size > 200) {
            this.recentTxHashes.delete(this.recentTxHashes.values().next().value!);
          }

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

            // Decode non-indexed params from data field to extract trade details
            try {
              const decoded = ethers.utils.defaultAbiCoder.decode(
                ORDER_FILLED_DATA_TYPES,
                msg.params.result.data,
              );
              const [makerAssetId, takerAssetId, makerAmountFilled, takerAmountFilled] = decoded;
              const makerAmt = parseFloat(ethers.utils.formatUnits(makerAmountFilled, 6));
              const takerAmt = parseFloat(ethers.utils.formatUnits(takerAmountFilled, 6));
              const isMaker = matchedWallet === makerAddress;
              const makerIsUsdc = makerAssetId.isZero();
              const takerIsUsdc = takerAssetId.isZero();
              const isNegRisk = msg.params.result.address.toLowerCase() ===
                '0xc5d563a36ae78145c45a50134d48a1215220f80a';

              // Guard: both non-zero means token-to-token swap — not a standard CTF fill
              if (!makerIsUsdc && !takerIsUsdc) {
                log.warn('Unexpected token-to-token fill (no USDC side), skipping', {
                  wallet: matchedWallet.slice(0, 10),
                  makerAssetId: makerAssetId.toString().slice(0, 16),
                  takerAssetId: takerAssetId.toString().slice(0, 16),
                });
                return;
              }

              let side: 'BUY' | 'SELL';
              let tokenId: string;
              let size: number;  // shares
              let price: number; // USDC per share

              if (isMaker) {
                // Maker offered makerAsset, received takerAsset
                side = makerIsUsdc ? 'BUY' : 'SELL';
                tokenId = makerIsUsdc ? takerAssetId.toString() : makerAssetId.toString();
                // BUY: paid USDC (makerAmt), received shares (takerAmt) → price = USDC/shares
                // SELL: gave shares (makerAmt), received USDC (takerAmt) → price = USDC/shares
                size = makerIsUsdc ? takerAmt : makerAmt;
                price = size > 0
                  ? (makerIsUsdc ? makerAmt / takerAmt : takerAmt / makerAmt)
                  : 0;
              } else {
                // Taker offered takerAsset, received makerAsset
                side = takerIsUsdc ? 'BUY' : 'SELL';
                tokenId = takerIsUsdc ? makerAssetId.toString() : takerAssetId.toString();
                // BUY: paid USDC (takerAmt), received shares (makerAmt) → price = USDC/shares
                // SELL: gave shares (takerAmt), received USDC (makerAmt) → price = USDC/shares
                size = takerIsUsdc ? makerAmt : takerAmt;
                price = size > 0
                  ? (takerIsUsdc ? takerAmt / makerAmt : makerAmt / takerAmt)
                  : 0;
              }

              log.info('OrderFilled decoded', {
                wallet: matchedWallet.slice(0, 10),
                side,
                tokenId: tokenId.slice(0, 16),
                size: size.toFixed(4),
                price: price.toFixed(4),
                txHash: msg.params.result.transactionHash?.slice(0, 18),
                contract: isNegRisk ? 'NegRisk' : 'Standard',
              });

              void this.onTradeDetected({
                proxyWallet: matchedWallet,
                tokenId,
                side,
                size,
                price,
                transactionHash: msg.params.result.transactionHash,
                isNegRisk,
                contract: msg.params.result.address,
              }).catch((err: any) =>
                log.error('Trade detection handler error', { error: err.message }),
              );
            } catch (err: any) {
              log.warn('Failed to decode OrderFilled data, skipping', {
                wallet: matchedWallet.slice(0, 10),
                error: err.message,
                txHash: msg.params.result.transactionHash?.slice(0, 18),
              });
            }
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

  /** Subscribe with wallet-specific topic filters so dRPC only delivers our events */
  private subscribe(ws: WebSocket): void {
    const wallets = this.getLiveWallets();
    this.subscribedWallets = new Set(wallets);
    const paddedWallets = [...wallets].map(padAddress);

    if (paddedWallets.length === 0) {
      log.warn('No live wallets to watch — skipping subscription');
      return;
    }

    // Sub 1: our wallets as maker (topics[2])
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'eth_subscribe',
      params: ['logs', {
        address: CTF_EXCHANGE_ADDRESSES,
        topics: [ORDER_FILLED_TOPIC, null, paddedWallets],
      }],
    }));

    // Sub 2: our wallets as taker (topics[3])
    ws.send(JSON.stringify({
      jsonrpc: '2.0', id: 2, method: 'eth_subscribe',
      params: ['logs', {
        address: CTF_EXCHANGE_ADDRESSES,
        topics: [ORDER_FILLED_TOPIC, null, null, paddedWallets],
      }],
    }));

    log.info('Subscribed to OrderFilled for live wallets', {
      walletCount: paddedWallets.length,
      wallets: [...wallets].map(w => w.slice(0, 10)),
    });
  }

  private startHeartbeat(ws: WebSocket): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;

      // Stale detection: force reconnect if no heartbeat response for STALE_THRESHOLD_MS
      if (this.lastHeartbeatAt &&
          Date.now() - this.lastHeartbeatAt.getTime() > STALE_THRESHOLD_MS) {
        log.warn(`Connection stale (no heartbeat response in ${STALE_THRESHOLD_MS / 1000}s), forcing reconnect`);
        ws.terminate(); // → 'close' event → scheduleReconnect
        return;
      }

      // Periodic status log (every 5th heartbeat ≈ every ~225s)
      this.heartbeatCount++;
      if (this.heartbeatCount % 5 === 1) {
        log.info('Chain watcher heartbeat', {
          eventsReceived: this.eventsReceived,
          triggeredDetections: this.triggeredDetections,
          liveWallets: this.getLiveWallets().size,
          lastEventAt: this.lastEventAt?.toISOString() ?? 'never',
        });
      }

      // Detect wallet set changes → reconnect with updated topic filters
      const currentWallets = this.getLiveWallets();
      if (!setsEqual(currentWallets, this.subscribedWallets)) {
        log.info('Live wallet set changed, reconnecting with new filters', {
          oldCount: this.subscribedWallets.size,
          newCount: currentWallets.size,
        });
        ws.terminate(); // → 'close' → scheduleReconnect with new wallet filters
        return;
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
