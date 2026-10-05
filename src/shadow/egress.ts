/**
 * Egress boundary — APPLICATION-LEVEL rule, not a network-enforced control.
 *
 * Every outbound request in the shadow goes through this module. Allowed:
 *   - configured Polygon RPC endpoints (HTTP + WSS)
 *   - data-api.polymarket.com (read-only public REST)
 *   - gamma-api.polymarket.com (read-only public REST)
 * Explicitly forbidden: clob.polymarket.com (trading), relayer, anything else.
 *
 * Backing controls (per PHASE2_REMOVAL_PLAN §3): no other network-client
 * construction sites may exist in src/ (CI static check), and any deployed
 * shadow must additionally sit behind real network/container egress
 * restrictions (deployment-time control, outside this repo).
 */

const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  'data-api.polymarket.com',
  'gamma-api.polymarket.com',
]);

export class EgressBlockedError extends Error {
  constructor(url: string) {
    super(`egress blocked: ${url}`);
    this.name = 'EgressBlockedError';
  }
}

export function assertAllowedUrl(url: string, rpcUrls: readonly string[]): URL {
  const u = new URL(url);
  const rpcHosts = rpcUrls.map((r) => new URL(r).host);
  if (ALLOWED_HOSTS.has(u.host) || rpcHosts.includes(u.host)) return u;
  throw new EgressBlockedError(url);
}

/** JSON-RPC POST through the egress boundary. */
export async function rpcCall<T>(
  rpcUrl: string,
  method: string,
  params: unknown[],
  timeoutMs = 15_000,
): Promise<T> {
  assertAllowedUrl(rpcUrl, [rpcUrl]);
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`RPC HTTP ${res.status} for ${method}`);
  const json = (await res.json()) as { result?: T; error?: { message: string } };
  if (json.error) throw new Error(`RPC error for ${method}: ${json.error.message}`);
  return json.result as T;
}
