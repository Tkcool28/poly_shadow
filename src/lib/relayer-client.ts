/**
 * Polymarket Relayer API Client — gasless on-chain operations.
 *
 * Uses Relayer API Key authentication (not Builder API).
 * Supports: redeem positions, split, merge, token approvals — all without MATIC gas.
 *
 * API reference: https://docs.polymarket.com/relayer/submit-a-transaction
 */

import { ethers } from 'ethers';
import { createJobLogger } from './logger';
import { config } from '../config/env';

const log = createJobLogger('relayer');

const PROXY_FACTORY_ADDRESS = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

// Transaction states
export type RelayerState =
  | 'STATE_NEW'
  | 'STATE_EXECUTED'
  | 'STATE_MINED'
  | 'STATE_CONFIRMED'
  | 'STATE_FAILED'
  | 'STATE_INVALID';

export interface RelayerTransaction {
  id: string;
  state: RelayerState;
  transactionHash?: string;
}

let signer: ethers.Wallet | null = null;
let signerAddress: string | null = null;

export function initRelayer(): boolean {
  if (!config.RELAYER_API_KEY || !config.RELAYER_ENABLED) {
    log.info('Relayer disabled (RELAYER_ENABLED=false or no API key)');
    return false;
  }
  if (!config.PRIVATE_KEY) {
    log.warn('Relayer: PRIVATE_KEY required for signing relay transactions');
    return false;
  }

  signer = new ethers.Wallet(config.PRIVATE_KEY);
  signerAddress = signer.address;
  log.info('Relayer initialized', {
    address: signerAddress,
    relayerUrl: config.RELAYER_URL,
  });
  return true;
}

export function isRelayerReady(): boolean {
  return signer !== null && !!config.RELAYER_API_KEY;
}

/**
 * Execute transactions via relayer (gasless).
 * The relayer submits the TX on-chain and pays gas.
 */
export async function relayerExecute(
  transactions: Array<{ to: string; data: string; value?: string }>,
  metadata?: string,
): Promise<RelayerTransaction> {
  if (!signer || !signerAddress || !config.RELAYER_API_KEY) {
    throw new Error('Relayer not initialized');
  }

  // Get nonce from relayer
  const nonceResp = await relayerFetch('GET', `/nonce?address=${signerAddress}&type=PROXY`);
  const nonce = nonceResp.nonce;
  const relayerAddress = nonceResp.address || (await relayerFetch('GET', '/address')).address;

  // Build proxy transaction
  // For POLY_PROXY: wrap each TX in a proxy call via ProxyWalletFactory
  const proxyFactory = new ethers.Contract(PROXY_FACTORY_ADDRESS, [
    'function proxy(address to, bytes data) external',
  ]);

  // If single TX, use direct proxy call. If batch, need multisend.
  let txTo: string;
  let txData: string;

  if (transactions.length === 1) {
    const tx = transactions[0];
    txData = proxyFactory.interface.encodeFunctionData('proxy', [tx.to, tx.data]);
    txTo = PROXY_FACTORY_ADDRESS;
  } else {
    // For batch: encode multisend (not implemented yet — single TX is sufficient for redeem)
    throw new Error('Batch relay transactions not yet implemented');
  }

  // Sign the relay message
  const message = ethers.utils.solidityKeccak256(
    ['address', 'uint256', 'bytes', 'uint256'],
    [txTo, 0, txData, nonce],
  );
  const signature = await signer.signMessage(ethers.utils.arrayify(message));

  // Submit to relayer
  const payload = {
    type: 'PROXY',
    from: signerAddress,
    to: txTo,
    data: txData,
    signature,
    metadata: metadata || 'polymarket-copytrade',
  };

  const resp = await relayerFetch('POST', '/submit', payload);

  log.info('Relay transaction submitted', {
    transactionId: resp.transactionID,
    state: resp.state,
    metadata,
  });

  return {
    id: resp.transactionID,
    state: resp.state as RelayerState,
    transactionHash: resp.transactionHash,
  };
}

/**
 * Poll until transaction reaches a terminal state.
 */
export async function waitForRelay(
  transactionId: string,
  timeoutMs: number = 120_000,
  pollMs: number = 3_000,
): Promise<RelayerTransaction> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const txns = await relayerFetch('GET', `/transaction/${transactionId}`);
    const tx = Array.isArray(txns) ? txns[0] : txns;

    if (!tx) {
      await sleep(pollMs);
      continue;
    }

    const state = tx.state as RelayerState;
    if (state === 'STATE_CONFIRMED' || state === 'STATE_FAILED' || state === 'STATE_INVALID') {
      log.info('Relay transaction completed', {
        transactionId,
        state,
        transactionHash: tx.transactionHash,
      });
      return { id: transactionId, state, transactionHash: tx.transactionHash };
    }

    await sleep(pollMs);
  }

  log.warn('Relay transaction timed out', { transactionId, timeoutMs });
  return { id: transactionId, state: 'STATE_NEW' };
}

// ─── Helpers ───

async function relayerFetch(method: string, path: string, body?: object): Promise<any> {
  const url = `${config.RELAYER_URL.replace(/\/$/, '')}${path}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'RELAYER_API_KEY': config.RELAYER_API_KEY!,
    'RELAYER_API_KEY_ADDRESS': config.RELAYER_API_KEY_ADDRESS || signerAddress || '',
  };

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Relayer API ${method} ${path}: ${resp.status} ${text}`);
  }

  return resp.json();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
