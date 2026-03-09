import { ethers } from 'ethers';
import { config } from '../config/env';

const CTF_ADDRESS = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';

const CTF_READ_ABI = [
  'function payoutDenominator(bytes32 conditionId) view returns (uint256)',
  'function payoutNumerators(bytes32 conditionId, uint256 index) view returns (uint256)',
];

const RPC_TIMEOUT_MS = 15_000; // 15s per RPC call — fail fast, retry next sweep

let provider: ethers.providers.JsonRpcProvider | null = null;

function getProvider(): ethers.providers.JsonRpcProvider {
  if (!provider) provider = new ethers.providers.JsonRpcProvider(config.POLYGON_RPC_URL);
  return provider;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`RPC timeout: ${label} after ${ms}ms`)), ms)
    ),
  ]);
}

export interface OnChainResolution {
  resolved: boolean;
  payouts: number[];  // settlement price per outcome (e.g., [1, 0] or [0, 1])
}

export async function checkOnChainResolution(
  conditionId: string,
  outcomeCount = 2,
): Promise<OnChainResolution> {
  const ctf = new ethers.Contract(CTF_ADDRESS, CTF_READ_ABI, getProvider());
  const denom: ethers.BigNumber = await withTimeout(
    ctf.payoutDenominator(conditionId),
    RPC_TIMEOUT_MS,
    'payoutDenominator',
  );
  if (denom.eq(0)) return { resolved: false, payouts: [] };

  const payouts: number[] = [];
  for (let i = 0; i < outcomeCount; i++) {
    const num: ethers.BigNumber = await withTimeout(
      ctf.payoutNumerators(conditionId, i),
      RPC_TIMEOUT_MS,
      `payoutNumerators[${i}]`,
    );
    payouts.push(num.toNumber() / denom.toNumber());
  }
  return { resolved: true, payouts };
}
