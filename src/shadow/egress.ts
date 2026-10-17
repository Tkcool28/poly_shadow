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
  rateLimitHeaders?: Record<string, string>;
  scheduling?: RestScheduleEvidence;
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
  let res: Response;
  try { res = await fetch(url, {
    method: 'GET',
    redirect: 'error',
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  }); } catch (error) { throw new RestTransportError(String(error).slice(0,512), requestStartUtc); }
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
    rateLimitHeaders: rateLimitHeaders(res.headers),
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

/** Only fixed provider rate-limit fields, at most 9 x 256 characters. */
export function rateLimitHeaders(headers: Headers): Record<string,string> {
  const result: Record<string,string> = {};
  for (const name of ['retry-after','ratelimit-limit','ratelimit-remaining','ratelimit-reset',
    'ratelimit-policy','x-ratelimit-limit','x-ratelimit-remaining','x-ratelimit-reset','x-ratelimit-reset-after']) {
    const value=headers.get(name);
    if(value!==null)result[name]=value.slice(0,256);
  }
  return result;
}

export interface RestScheduleEvidence {
  state: 'NORMAL' | 'THROTTLED' | 'RECOVERY' | 'TERMINAL';
  recoveryAttempt: boolean;
  cooldownUntilUtc: string | null;
  reason: string | null;
}
export class RestTransportError extends Error {
  scheduling?:RestScheduleEvidence;
  constructor(message:string,readonly requestStartUtc:string){super(message);}
}
/** Scheduling skips never denote transport attempts or provider observations. */
export class RestRequestSkipped extends Error {
  constructor(message:string,readonly scheduling?:RestScheduleEvidence){super(message);}
}

function retryAfterMs(value:string|undefined,now:number):number|null {
  if(value===undefined)return null;
  const text=value.trim();
  // Delta seconds or HTTP-date; reject permissive Date.parse numeric strings.
  const delay=/^\d+$/.test(text)?Number(text)*1000:
    /^(?:Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?|Sun(?:day)?)[, ]/i.test(text)?Math.max(0,Date.parse(text)-now):NaN;
  return Number.isFinite(delay)&&delay>=0&&now+delay<=8.64e15?delay:null;
}

/** Shared legacy+v2 limits stay fixed: serial transport, >=500ms spacing,
 * <=60 starts/minute total, <=20 v2. Cooldown skips rather than queues work;
 * exactly one fresh poll may probe recovery. Old queued polls never replay. */
export function pacedV2RestGet() {
  let tail=Promise.resolve(), terminal=false, last=-Infinity;
  let starts:{at:number;v2:boolean}[]=[];
  let cooldownUntil=0, failures=0, generation=0, recovering=false;
  const evidence=(state:RestScheduleEvidence['state'],recoveryAttempt=false,reason:string|null=null):RestScheduleEvidence=>
    ({state,recoveryAttempt,cooldownUntilUtc:failures?new Date(cooldownUntil).toISOString():null,reason});
  const throttle=(reply?:RestGetResult)=>{
    failures=Math.min(failures+1,32);generation++;
    const fallback=Math.min(300000,30000*2**Math.min(failures-1,4)*(.8+.4*Math.random()));
    cooldownUntil=Date.now()+(retryAfterMs(reply?.rateLimitHeaders?.['retry-after'],Date.now())??fallback);
  };
  return async (url:string,timeoutMs=15000,maxBodyBytes=REST_MAX_BODY_BYTES,deadline=Date.now()+timeoutMs+8000):Promise<RestGetResult> => {
    if(terminal)throw new RestRequestSkipped('HOST_STOPPED',evidence('TERMINAL',false,'HTTP_403'));
    if(recovering || Date.now()<cooldownUntil)throw new RestRequestSkipped('THROTTLED',evidence('THROTTLED',false,'COOLDOWN'));
    const recoveryAttempt=failures>0, admittedGeneration=generation;
    if(recoveryAttempt)recovering=true;
    let release!:()=>void;
    const turn=new Promise<void>(r=>{release=r;}),previous=tail;
    tail=previous.then(()=>turn);
    let timer:ReturnType<typeof setTimeout>|undefined;
    let started=false;
    try {
      await Promise.race([previous,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new RestRequestSkipped('QUEUE_DEADLINE')),Math.max(0,deadline-Date.now()));})]);
      if(timer)clearTimeout(timer);
      const check=()=>{
        if(terminal)throw new RestRequestSkipped('HOST_STOPPED',evidence('TERMINAL',false,'HTTP_403'));
        if(admittedGeneration!==generation || Date.now()<cooldownUntil)
          throw new RestRequestSkipped('THROTTLED',evidence('THROTTLED',false,'STALE_QUEUE_OR_COOLDOWN'));
      };
      check();
      const wait=Math.max(0,last+500-Date.now());
      if(Date.now()+wait+timeoutMs>deadline)throw new RestRequestSkipped('TIME_BUDGET');
      if(wait)await new Promise(r=>setTimeout(r,wait));
      check();
      if(Date.now()+timeoutMs>deadline)throw new RestRequestSkipped('TIME_BUDGET');
      const now=Date.now(),v2=new URL(url).pathname.startsWith('/v2/');
      starts=starts.filter(t=>now-t.at<60000);
      if(starts.length>=60 || v2&&starts.filter(t=>t.v2).length>=20)throw new RestRequestSkipped('REQUEST_BUDGET');
      starts.push({at:now,v2});last=now;started=true;
      const reply=await restGet(url,timeoutMs,maxBodyBytes);
      if(reply.requestStartUtc){last=Date.parse(reply.requestStartUtc);starts[starts.length-1]!.at=last;}
      if(reply.status===403){terminal=true;generation++;reply.scheduling=evidence('TERMINAL',recoveryAttempt,'HTTP_403');}
      else if(reply.status===429 || reply.status===503 || recoveryAttempt&&(reply.status<200||reply.status>=300||reply.bodyError)){
        throttle(reply);reply.scheduling=evidence('THROTTLED',recoveryAttempt,`HTTP_${reply.status}`);
      }else{
        reply.scheduling=evidence(recoveryAttempt?'RECOVERY':'NORMAL',recoveryAttempt);
        failures=0;cooldownUntil=0;
      }
      return reply;
    }catch(error){
      if(started && error instanceof RestTransportError){last=Date.parse(error.requestStartUtc);starts[starts.length-1]!.at=last;}
      if(recoveryAttempt && started && !(error instanceof RestRequestSkipped)){
        throttle();
        if(error instanceof RestTransportError)error.scheduling=evidence('THROTTLED',true,'RECOVERY_TRANSPORT_FAILURE');
      }
      throw error;
    }finally{if(timer)clearTimeout(timer);if(recoveryAttempt)recovering=false;release();}
  };
}
