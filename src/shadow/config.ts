/**
 * Fail-closed shadow configuration.
 *
 * The shadow is observation-only. If ANY credential-shaped environment
 * variable is present, the process refuses to start. This is deletion-backed
 * isolation: no signing/trading code exists in this repository, and the
 * config layer treats injected key material as a hard error rather than
 * ignoring it.
 */

const BANNED_ENV_VARS = [
  'PRIVATE_KEY',
  'CLOB_API_KEY',
  'CLOB_API_SECRET',
  'CLOB_API_PASSPHRASE',
  'FUNDER_ADDRESS',
  'RELAYER_API_KEY',
  'RELAYER_API_KEY_ADDRESS',
] as const;

const BANNED_PREFIXES = ['ARB_', 'SCALP_'] as const;

export class CredentialGuardError extends Error {
  constructor(public readonly offenders: string[]) {
    super(
      'Credential material detected in shadow environment — refusing to start: ' +
        offenders.join(', '),
    );
    this.name = 'CredentialGuardError';
  }
}

/**
 * Throws CredentialGuardError if any banned variable is PRESENT — including
 * set-but-empty. Presence is the signal: an empty PRIVATE_KEY still means
 * someone attempted to inject credential material into this process.
 */
export function assertNoCredentials(env: NodeJS.ProcessEnv = process.env): void {
  const offenders: string[] = [];
  for (const name of BANNED_ENV_VARS) {
    if (name in env && env[name] !== undefined) offenders.push(name);
  }
  for (const key of Object.keys(env)) {
    if (BANNED_PREFIXES.some((p) => key.startsWith(p)) && env[key] !== undefined) {
      offenders.push(key);
    }
  }
  if (offenders.length > 0) throw new CredentialGuardError(offenders);
}

export interface ShadowConfig {
  chainId: number;
  polygonHttpRpcUrl: string;
  polygonWsRpcUrl: string;
  /** Secondary provider for hash cross-verification (optional). */
  polygonHttpRpcUrlB: string | null;
  watchedWallets: ReadonlySet<string>; // lowercase
  dataDir: string;
  heartbeatMs: number;
  staleMs: number;
  verifyIntervalMs: number;
  backfillChunkBlocks: number;
}

function parseWallets(csv: string | undefined): Set<string> {
  const set = new Set<string>();
  for (const raw of (csv ?? '').split(',')) {
    const w = raw.trim().toLowerCase();
    if (w === '') continue;
    if (!/^0x[0-9a-f]{40}$/.test(w)) throw new Error(`invalid watched wallet: ${raw}`);
    set.add(w);
  }
  return set;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ShadowConfig {
  assertNoCredentials(env);

  const watchedWallets = parseWallets(env.SHADOW_WATCHED_WALLETS);
  if (watchedWallets.size === 0) {
    throw new Error('SHADOW_WATCHED_WALLETS is empty — nothing to observe');
  }

  return {
    chainId: 137,
    polygonHttpRpcUrl: env.POLYGON_HTTP_RPC_URL ?? 'https://polygon-bor-rpc.publicnode.com',
    polygonWsRpcUrl: env.POLYGON_WS_RPC_URL ?? 'wss://polygon-bor-rpc.publicnode.com',
    polygonHttpRpcUrlB: env.POLYGON_HTTP_RPC_URL_B ?? null,
    watchedWallets,
    dataDir: env.SHADOW_DATA_DIR ?? './shadow-data',
    heartbeatMs: Number(env.SHADOW_HEARTBEAT_MS ?? 10_000),
    staleMs: Number(env.SHADOW_STALE_MS ?? 25_000),
    verifyIntervalMs: Number(env.SHADOW_VERIFY_INTERVAL_MS ?? 60_000),
    backfillChunkBlocks: Number(env.SHADOW_BACKFILL_CHUNK_BLOCKS ?? 200),
  };
}
