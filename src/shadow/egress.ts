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

/** Result of a read-only REST GET through the egress boundary. */
export interface RestGetResult {
  status: number;
  /** Freshness/cache headers when exposed (CDN cache behavior is measured). */
  headers: { age: string | null; cacheControl: string | null; etag: string | null; date: string | null };
  body: unknown;
  /** Full bounded body arrival, sampled before JSON parsing. */
  responseUtc?: string;
  requestStartUtc?: string;
  parseError?: string;
  bodyError?: { outcome: 'TIMEOUT' | 'HTTP_FAILURE'; message: string };
}

/** Read-only REST GET through the egress boundary (allowlisted hosts only). */
export const REST_MAX_BODY_BYTES = 16 * 1024 * 1024;
export async function restGet(url: string, timeoutMs = 15_000, maxBodyBytes = REST_MAX_BODY_BYTES, _deadline = Infinity): Promise<RestGetResult> {
  assertAllowedUrl(url, []);
  if (!Number.isInteger(maxBodyBytes) || maxBodyBytes < 1 || maxBodyBytes > REST_MAX_BODY_BYTES) throw Error('REST body budget');
  const requestStartUtc = new Date().toISOString();
  const res = await fetch(url, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  // Bound transport memory too: page/item validation alone happens too late.
  const reader=res.body?.getReader();
  const boundedBody=Buffer.alloc(maxBodyBytes);let bytes=0,body:unknown=null,parseError:string|undefined;
  let bodyError:RestGetResult['bodyError'];
  let responseUtc: string | undefined;
  if(reader){
    try {
      while(true){const part=await reader.read();if(part.done)break;bytes+=part.value.byteLength;
        if(bytes>maxBodyBytes){parseError='malformed REST response: body byte limit exceeded';await reader.cancel();break;}
        boundedBody.set(part.value,bytes-part.value.byteLength);
      }
      responseUtc = new Date().toISOString();
      if(!parseError){try{body=JSON.parse(boundedBody.subarray(0,bytes).toString('utf8'));}catch(err){parseError=`malformed REST JSON: ${String(err).slice(0,256)}`;}}
    }catch(err){const message=String(err).slice(0,512);bodyError={outcome:/timeout|abort/i.test(message)?'TIMEOUT':'HTTP_FAILURE',message};}
    finally{reader.releaseLock();}
  }else parseError='malformed REST missing response body';
  return {
    status: res.status,
    responseUtc,
    requestStartUtc,
    headers: {
      age: res.headers.get('age'),
      cacheControl: res.headers.get('cache-control'),
      etag: res.headers.get('etag'),
      date: res.headers.get('date'),
    },
    body,
    ...(parseError ? {parseError} : {}),
    ...(bodyError ? {bodyError} : {}),
  };
}

/** Scheduling limits are receipted as skips, never provider failures. */
export class RestRequestSkipped extends Error {}

/** Shared legacy+v2 budget: one HTTP request at a time, >=500ms start
 * spacing, <=60 starts/minute. Reserve 40 starts for existing legacy cadences;
 * supplemental cursors may use at most 20. No retries after host denial. */
export function pacedV2RestGet() {
  let tail=Promise.resolve(), stopped=false, last=-Infinity;
  let starts:{at:number;v2:boolean}[]=[];
  return async (url:string,timeoutMs=15000,maxBodyBytes=REST_MAX_BODY_BYTES,deadline=Date.now()+timeoutMs+8000):Promise<RestGetResult> => {
    let release!:()=>void;
    const turn=new Promise<void>(r=>{release=r;}),previous=tail;
    tail=previous.then(()=>turn);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try {
      await Promise.race([previous,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RestRequestSkipped('QUEUE_DEADLINE')),Math.max(0,deadline-Date.now()));})]);
      if(timer)clearTimeout(timer);
      if(stopped)throw new RestRequestSkipped('HOST_STOPPED');
      const wait=Math.max(0,last+500-Date.now());
      if(Date.now()+wait+timeoutMs>deadline)throw new RestRequestSkipped('TIME_BUDGET');
      if(wait)await new Promise(r=>setTimeout(r,wait));
      const now=Date.now(),v2=new URL(url).pathname.startsWith('/v2/');
      starts=starts.filter(t=>now-t.at<60000);
      if(starts.length>=60 || v2&&starts.filter(t=>t.v2).length>=20)throw new RestRequestSkipped('REQUEST_BUDGET');
      starts.push({at:now,v2});last=now;
      const reply=await restGet(url,timeoutMs,maxBodyBytes);
      if([403,429,503].includes(reply.status))stopped=true;
      return reply;
    }finally{if(timer)clearTimeout(timer);release();}
  };
}
