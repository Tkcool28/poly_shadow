/**
 * Test script: measure full latency pipeline
 *   CLOB order → block mined → WS log event received (via dRPC)
 *
 * Usage: npx tsx scripts/test-latency.ts
 */
import 'dotenv/config';
import { ClobClient, OrderType, Side } from '@polymarket/clob-client';
import type { ApiKeyCreds, TickSize } from '@polymarket/clob-client';
import { Wallet } from '@ethersproject/wallet';
import { JsonRpcProvider } from '@ethersproject/providers';
import WebSocket from 'ws';

// --- Config from .env ---
const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const CLOB_API_KEY = process.env.CLOB_API_KEY!;
const CLOB_API_SECRET = process.env.CLOB_API_SECRET!;
const CLOB_API_PASSPHRASE = process.env.CLOB_API_PASSPHRASE!;
const FUNDER_ADDRESS = process.env.FUNDER_ADDRESS!;
const SIGNATURE_TYPE = Number(process.env.SIGNATURE_TYPE ?? '1');
const POLYGON_HTTP_RPC = process.env.POLYGON_HTTP_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com';
const POLYGON_WS_RPC = process.env.POLYGON_WS_RPC_URL ?? 'wss://polygon-bor-rpc.publicnode.com';

// --- Market ---
const YES_TOKEN_ID = '77893140510362582253172593084218413010407941075415081594586195705930819989216';
const TICK_SIZE = '0.01' as TickSize;
const NEG_RISK = false;
const BUY_AMOUNT_USD = 1;

// CTF Exchange contracts
const CTF_EXCHANGES = [
  '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E',
  '0xC5d563A36AE78145C45a50134d48A1215220f80a',
];
const ORDER_FILLED_TOPIC = '0xd0a08e8c493f9c94f29311604c9de1b4e8c8d4c06bd0c789af57f2d65bfec0f6';

function padAddress(addr: string): string {
  return '0x' + addr.slice(2).toLowerCase().padStart(64, '0');
}

/** Subscribe to OrderFilled events for our wallet via WS, return promise that resolves on first match */
function subscribeWsOrderFilled(walletAddress: string, targetTxHash: string): Promise<{ tWsReceived: number; txHash: string }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(POLYGON_WS_RPC);
    const padded = padAddress(walletAddress);
    const subIds = new Set<string>();
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS timeout — no OrderFilled event within 120s'));
    }, 120_000);

    ws.on('open', () => {
      console.log('  [WS] Connected to', POLYGON_WS_RPC);
      // Subscribe as maker (topic[2]) and taker (topic[3])
      for (let i = 0; i < 2; i++) {
        const topics: (string | null)[] = [ORDER_FILLED_TOPIC, null, null, null];
        topics[i + 2] = padded; // maker=index 2, taker=index 3
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'eth_subscribe',
          params: ['logs', { address: CTF_EXCHANGES, topics }],
        }));
      }
    });

    ws.on('message', (raw: Buffer) => {
      const tReceived = Date.now();
      const msg = JSON.parse(raw.toString());

      // Subscription confirmation
      if (msg.id >= 100 && msg.result) {
        subIds.add(msg.result);
        console.log(`  [WS] Subscribed (id=${msg.id}, sub=${msg.result})`);
        return;
      }

      // Log event
      if (msg.method === 'eth_subscription' && subIds.has(msg.params?.subscription)) {
        const logEntry = msg.params.result;
        const txHash = logEntry.transactionHash?.toLowerCase();
        console.log(`  [WS] OrderFilled event received! tx=${txHash}`);

        if (txHash === targetTxHash.toLowerCase()) {
          clearTimeout(timeout);
          ws.close();
          resolve({ tWsReceived: tReceived, txHash });
        }
      }
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });
}

async function main() {
  console.log('Initializing CLOB client...');
  const signer = new Wallet(PRIVATE_KEY);
  const creds: ApiKeyCreds = {
    key: CLOB_API_KEY,
    secret: CLOB_API_SECRET,
    passphrase: CLOB_API_PASSPHRASE,
  };

  const client = new ClobClient(
    'https://clob.polymarket.com',
    137,
    signer,
    creds,
    SIGNATURE_TYPE,
    FUNDER_ADDRESS,
  );

  await client.getOpenOrders();
  console.log('CLOB client ready. Wallet:', signer.address);
  const proxyWallet = FUNDER_ADDRESS;
  console.log('Proxy/funder wallet:', proxyWallet);

  // Fetch orderbook
  const book = await client.getOrderBook(YES_TOKEN_ID);
  const bestAsk = book.asks?.[0]?.price ?? 'N/A';
  const bestBid = book.bids?.[book.bids.length - 1]?.price ?? 'N/A';
  console.log(`Orderbook — Best bid: ${bestBid}, Best ask: ${bestAsk}`);

  const askPrice = parseFloat(String(bestAsk));
  if (isNaN(askPrice)) {
    console.error('No asks available — cannot buy');
    process.exit(1);
  }
  const limitPrice = Math.min(askPrice + 0.02, 0.99);

  // ---- Set up WS listener BEFORE placing order ----
  // We need the tx hash first, so we'll start WS subscription for ANY OrderFilled for our wallet
  // and filter by tx hash after we get it from CLOB
  console.log('\nSetting up WS subscription for OrderFilled events...');
  const wsReady = new Promise<WebSocket>((resolve) => {
    const ws = new WebSocket(POLYGON_WS_RPC);
    const padded = padAddress(proxyWallet);
    let subsReceived = 0;

    ws.on('open', () => {
      console.log('  [WS] Connected to', POLYGON_WS_RPC);
      for (let i = 0; i < 2; i++) {
        const topics: (string | null)[] = [ORDER_FILLED_TOPIC, null, null, null];
        topics[i + 2] = padded;
        ws.send(JSON.stringify({
          jsonrpc: '2.0',
          id: 100 + i,
          method: 'eth_subscribe',
          params: ['logs', { address: CTF_EXCHANGES, topics }],
        }));
      }
    });

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.id >= 100 && msg.result) {
        subsReceived++;
        console.log(`  [WS] Subscribed (id=${msg.id}, sub=${msg.result})`);
        if (subsReceived >= 2) resolve(ws);
      }
    });
  });

  const ws = await wsReady;
  console.log('  [WS] Both subscriptions active — ready to trade.\n');

  // ---- Place order ----
  console.log(`Placing $${BUY_AMOUNT_USD} FAK BUY @ limit ${limitPrice.toFixed(2)}...`);
  const t0 = Date.now();
  const response = await client.createAndPostMarketOrder(
    {
      tokenID: YES_TOKEN_ID,
      side: Side.BUY,
      amount: BUY_AMOUNT_USD,
      price: limitPrice,
    },
    { tickSize: TICK_SIZE, negRisk: NEG_RISK },
    OrderType.FAK,
  );
  const tClobDone = Date.now();

  console.log('\n--- CLOB Response ---');
  console.log('  orderID:', response?.orderID);
  console.log('  status:', response?.status);
  console.log('  makingAmount:', response?.makingAmount);
  console.log('  takingAmount:', response?.takingAmount);
  console.log('  transactionsHashes:', response?.transactionsHashes);
  console.log(`  CLOB round-trip: ${tClobDone - t0}ms`);

  const txHashes: string[] = response?.transactionsHashes ?? [];
  const makingAmt = parseFloat(response?.makingAmount || '0');
  const takingAmt = parseFloat(response?.takingAmount || '0');

  if (txHashes.length === 0 || (makingAmt === 0 && takingAmt === 0)) {
    console.log('\nOrder was NOT filled (FAK unmatched). No tx to track.');
    ws.close();
    process.exit(0);
  }

  const filledShares = makingAmt;
  const filledUsd = takingAmt;
  const avgPrice = filledShares > 0 ? filledUsd / filledShares : 0;
  console.log(`\nFilled: ${filledShares.toFixed(4)} shares @ $${avgPrice.toFixed(4)} = $${filledUsd.toFixed(4)}`);

  const targetTxHash = txHashes[0].toLowerCase();

  // ---- Wait for WS event ----
  console.log('\nWaiting for WS OrderFilled event...');
  const wsEventPromise = new Promise<number>((resolve, reject) => {
    const timeout = setTimeout(() => {
      ws.close();
      reject(new Error('WS timeout — no matching OrderFilled within 120s'));
    }, 120_000);

    ws.on('message', (raw: Buffer) => {
      const tReceived = Date.now();
      const msg = JSON.parse(raw.toString());
      if (msg.method === 'eth_subscription' && msg.params?.result) {
        const logEntry = msg.params.result;
        const eventTxHash = logEntry.transactionHash?.toLowerCase();
        console.log(`  [WS] OrderFilled event! tx=${eventTxHash} block=${parseInt(logEntry.blockNumber, 16)}`);
        if (eventTxHash === targetTxHash) {
          clearTimeout(timeout);
          resolve(tReceived);
        }
      }
    });
  });

  // ---- Also poll for receipt in parallel ----
  console.log('Also polling HTTP RPC for receipt...');
  const provider = new JsonRpcProvider(POLYGON_HTTP_RPC);
  const receiptPromise = (async () => {
    const receipt = await provider.waitForTransaction(targetTxHash, 1, 120_000);
    const tConfirmed = Date.now();
    const block = await provider.getBlock(receipt.blockNumber);
    return { tConfirmed, receipt, blockTimestamp: block.timestamp * 1000 };
  })();

  // Wait for both
  const [tWsReceived, { tConfirmed, receipt, blockTimestamp }] = await Promise.all([
    wsEventPromise,
    receiptPromise,
  ]);

  ws.close();

  // ---- Results ----
  console.log('\n========================================');
  console.log('         LATENCY RESULTS');
  console.log('========================================');
  console.log(`  Block number:                 ${receipt.blockNumber}`);
  console.log(`  Block timestamp (UTC):        ${new Date(blockTimestamp).toISOString()}`);
  console.log(`  Our clock at order start:     ${new Date(t0).toISOString()}`);
  console.log(`  Our clock at CLOB done:       ${new Date(tClobDone).toISOString()}`);
  console.log(`  Our clock at WS event:        ${new Date(tWsReceived).toISOString()}`);
  console.log(`  Our clock at HTTP confirmed:  ${new Date(tConfirmed).toISOString()}`);
  console.log('');
  console.log('  [1] CLOB API round-trip:              %dms', tClobDone - t0);
  console.log('  [2] CLOB done → block mined:          %dms  (block_time - clob_done)', blockTimestamp - tClobDone);
  console.log('  [3] Block mined → WS event received:  %dms  (ws_received - block_time)', tWsReceived - blockTimestamp);
  console.log('  [4] Block mined → HTTP poll confirmed: %dms  (http_confirmed - block_time)', tConfirmed - blockTimestamp);
  console.log('');
  console.log('  WS total (order → WS event):          %dms', tWsReceived - t0);
  console.log('  HTTP total (order → HTTP confirmed):   %dms', tConfirmed - t0);
  console.log('  WS advantage over HTTP polling:        %dms', tConfirmed - tWsReceived);
  console.log('========================================');

  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
