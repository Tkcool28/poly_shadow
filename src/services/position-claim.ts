import { ethers } from 'ethers';
import { createJobLogger } from '../lib/logger';
import { config } from '../config/env';

const log = createJobLogger('position-claim');

// ─── Addresses ───────────────────────────────────────────────────────────────
const CTF_ADDRESS           = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const USDC_ADDRESS          = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const PROXY_FACTORY_ADDRESS = '0xaB45c5A4B0c941a2F231C04C3f49182e1A254052';

// ─── Minimal ABIs (inline — no external ABI files needed) ────────────────────
const CTF_ABI = [
  {
    name: 'redeemPositions',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'collateralToken', type: 'address' },
      { name: 'parentCollectionId', type: 'bytes32' },
      { name: 'conditionId', type: 'bytes32' },
      { name: 'indexSets', type: 'uint256[]' },
    ],
    outputs: [],
  },
];

// ProxyWalletFactory.proxy() — routes calls through the user's proxy wallet
const PROXY_FACTORY_ABI = [
  {
    name: 'proxy',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'calls',
        type: 'tuple[]',
        components: [
          { name: 'typeCode', type: 'uint8' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'data', type: 'bytes' },
        ],
      },
    ],
    outputs: [{ name: 'returnValues', type: 'bytes[]' }],
  },
];

// ─── Lazy state ───────────────────────────────────────────────────────────────
let provider: ethers.providers.JsonRpcProvider | null = null;
let signer: ethers.Wallet | null = null;
let serviceReady = false;
let gnosisSafeWarned = false;

// In-memory retry queue: conditionId → position
// Populated when claimOne() fails; cleared on success.
// Resets on process restart (acceptable: MATIC refill or RPC recovery likely triggers restart).
const pendingRetries = new Map<string, ClaimablePosition>();

function getProvider(): ethers.providers.JsonRpcProvider {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(config.POLYGON_RPC_URL);
  return provider;
}

function getSigner(): ethers.Wallet {
  if (!signer) {
    if (!config.PRIVATE_KEY) throw new Error('PRIVATE_KEY not configured');
    signer = new ethers.Wallet(config.PRIVATE_KEY, getProvider());
  }
  return signer;
}

async function ensureReady(): Promise<void> {
  if (serviceReady) return;
  const s = getSigner();
  const maticBal = await getProvider().getBalance(s.address);
  log.info('Position claim service ready', {
    signerAddress: s.address,
    maticBalance: ethers.utils.formatEther(maticBal),
    signatureType: config.SIGNATURE_TYPE,
    rpcUrl: config.POLYGON_RPC_URL,
  });
  serviceReady = true;
}

// ─── Public interface ─────────────────────────────────────────────────────────
export interface ClaimablePosition {
  conditionId: string;
  outcomeIndex: number;  // 0=Yes, 1=No
  netShares: number;     // for logging
  tokenId: string;       // for logging
  followAllocationId: string; // for logging
}

export async function redeemWinningPositions(positions: ClaimablePosition[]): Promise<void> {
  if (!config.AUTO_CLAIM_ENABLED || !config.PRIVATE_KEY) return;

  // GNOSIS_SAFE (type=2) needs multi-sig flow — out of scope
  if (config.SIGNATURE_TYPE === 2) {
    if (!gnosisSafeWarned) {
      log.warn('Auto-claim skipped: GNOSIS_SAFE (type=2) not supported — set AUTO_CLAIM_ENABLED=false');
      gnosisSafeWarned = true;
    }
    return;
  }

  // Merge new positions into retry queue, skipping dust below MIN_CLAIM_USD
  for (const p of positions) {
    if (p.netShares < config.MIN_CLAIM_USD) {
      log.info('Auto-claim skipped: below MIN_CLAIM_USD threshold', {
        conditionId: p.conditionId,
        netShares: p.netShares.toFixed(4),
        minClaimUsd: config.MIN_CLAIM_USD,
      });
      continue;
    }
    pendingRetries.set(p.conditionId, p);
  }

  if (pendingRetries.size === 0) return;

  await ensureReady();

  for (const pos of pendingRetries.values()) {
    await claimOne(pos);
  }
}

// Poll for a transaction receipt directly instead of relying on ethers block-event listeners,
// which break when the RPC has a block-height skew (e.g. some public nodes lag by millions of blocks).
async function pollReceipt(
  txHash: string,
  timeoutMs = 300_000,
  intervalMs = 4_000,
): Promise<ethers.providers.TransactionReceipt> {
  const p = getProvider();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const receipt = await p.getTransactionReceipt(txHash);
    if (receipt) {
      if (receipt.status === 0) throw new Error(`Tx ${txHash} reverted on-chain`);
      return receipt;
    }
    await new Promise(r => setTimeout(r, intervalMs));
  }
  throw new Error(`Tx ${txHash} not mined within ${timeoutMs / 1000}s`);
}

async function claimOne(pos: ClaimablePosition): Promise<void> {
  const indexSets = [1 << pos.outcomeIndex]; // Yes=0→[1], No=1→[2]
  const s = getSigner();

  // Polygon requires a minimum priority fee of 25 gwei.
  // ethers v5 default (1.5 gwei) is too low, and hardcoded maxFeePerGas can undershoot
  // when the baseFee spikes. Fetch current network fees and apply a 2× buffer.
  const feeData = await getProvider().getFeeData();
  const priorityFee = feeData.maxPriorityFeePerGas?.gt(ethers.utils.parseUnits('30', 'gwei'))
    ? feeData.maxPriorityFeePerGas
    : ethers.utils.parseUnits('30', 'gwei');
  const baseFee = feeData.lastBaseFeePerGas ?? ethers.utils.parseUnits('100', 'gwei');
  const maxFee = baseFee.mul(2).add(priorityFee); // 2× buffer over current baseFee
  const gasOverrides = { maxPriorityFeePerGas: priorityFee, maxFeePerGas: maxFee };

  try {
    let txHash: string;

    if (config.SIGNATURE_TYPE === 0) {
      // EOA is the funder — call CTF directly
      const ctf = new ethers.Contract(CTF_ADDRESS, CTF_ABI, s);
      const tx = await ctf.redeemPositions(
        USDC_ADDRESS, ethers.constants.HashZero, pos.conditionId, indexSets,
        { gasLimit: 200_000, ...gasOverrides },
      );
      txHash = tx.hash;
      await pollReceipt(txHash);
    } else {
      // POLY_PROXY (type=1): route through ProxyWalletFactory
      const ctfIface = new ethers.utils.Interface(CTF_ABI);
      const redeemData = ctfIface.encodeFunctionData('redeemPositions', [
        USDC_ADDRESS, ethers.constants.HashZero, pos.conditionId, indexSets,
      ]);
      const factory = new ethers.Contract(PROXY_FACTORY_ADDRESS, PROXY_FACTORY_ABI, s);
      const tx = await factory.proxy(
        [{ typeCode: 1, to: CTF_ADDRESS, value: 0, data: redeemData }],
        { gasLimit: 500_000, ...gasOverrides },
      );
      txHash = tx.hash;
      await pollReceipt(txHash);
    }

    // Remove from retry queue on success
    pendingRetries.delete(pos.conditionId);

    log.info('Auto-claim success', {
      conditionId: pos.conditionId,
      outcomeIndex: pos.outcomeIndex,
      netShares: pos.netShares.toFixed(4),
      txHash,
      pendingRetries: pendingRetries.size,
    });
  } catch (err: any) {
    // Non-fatal: DB is already settled. Position stays in pendingRetries for next sweep.
    log.warn('Auto-claim failed (kept in retry queue)', {
      conditionId: pos.conditionId,
      tokenId: pos.tokenId.slice(0, 20),
      error: err.message?.slice(0, 300),
      pendingRetries: pendingRetries.size,
    });
  }
}
