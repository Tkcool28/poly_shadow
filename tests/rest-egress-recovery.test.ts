import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {pacedV2RestGet,restGet,rpcCall,RestRequestSkipped} from '../src/shadow/egress.js';
const legacy='https://data-api.polymarket.com/trades',v2='https://data-api.polymarket.com/v2/trades';
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(new Date('2026-10-17T00:00:00Z'));vi.spyOn(Math,'random').mockReturnValue(.5);});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();vi.useRealTimers();});
function network(statuses:number[],headers:Record<string,string>={}){
 const calls=vi.fn(async()=>new Response('[]',{status:statuses.shift()??200,headers}));vi.stubGlobal('fetch',calls);return calls;
}
async function send(get:ReturnType<typeof pacedV2RestGet>,url=legacy){const p=get(url);await vi.advanceTimersByTimeAsync(500);return p;}
it('429 skips queued and fresh requests, permits one fresh recovery probe, and keeps CHAIN independent',async()=>{
 let finish!:()=>void;
 const calls=network([429]);const get=pacedV2RestGet();
 const queued=Promise.allSettled([get(legacy),get(v2),get(legacy)]);
 await vi.advanceTimersByTimeAsync(0);
 const rows=await queued;expect(rows[0]).toMatchObject({status:'fulfilled',value:{status:429,scheduling:{state:'THROTTLED',recoveryAttempt:false}}});
 expect(rows.slice(1).every(r=>r.status==='rejected'&&r.reason instanceof RestRequestSkipped)).toBe(true);
 await expect(get(v2)).rejects.toMatchObject({message:'THROTTLED'});expect(calls).toHaveBeenCalledTimes(1);
 vi.stubGlobal('fetch',vi.fn(async()=>new Response('{"result":42}')));expect(await rpcCall('https://rpc.example','eth_blockNumber',[])).toBe(42);
 await vi.advanceTimersByTimeAsync(30000);
 const probe=vi.fn(async()=>{await new Promise<void>(r=>{finish=r;});return new Response('[]');});vi.stubGlobal('fetch',probe);
 const recovered=get(legacy);await vi.advanceTimersByTimeAsync(0);
 await expect(get(v2)).rejects.toMatchObject({message:'THROTTLED'});expect(probe).toHaveBeenCalledTimes(1);
 finish();expect(await recovered).toMatchObject({scheduling:{state:'RECOVERY',recoveryAttempt:true}});
 const next=get(v2);await vi.advanceTimersByTimeAsync(499);expect(probe).toHaveBeenCalledTimes(1);
 await vi.advanceTimersByTimeAsync(1);finish();await next;expect(probe).toHaveBeenCalledTimes(2);
});
it('repeated 429 and 503 use exponential jittered cooldown capped at five minutes',async()=>{
 network([429,503,429,429,429,429]);const get=pacedV2RestGet();
 for(const delay of [30000,60000,120000,240000,300000,300000]){
  const start=Date.now();const reply=await send(get);expect(Date.parse(reply.scheduling!.cooldownUntilUtc!)-start).toBe(delay);
  await expect(get(legacy)).rejects.toBeInstanceOf(RestRequestSkipped);
  await vi.advanceTimersByTimeAsync(delay-500);
 }
 expect(await send(get)).toMatchObject({status:200,scheduling:{state:'RECOVERY',recoveryAttempt:true}});
});
it.each(['120','Sat, 17 Oct 2026 00:02:00 GMT'])('honors Retry-After %s including longer than fallback',async retry=>{
 network([429],{'retry-after':retry});const get=pacedV2RestGet();const reply=await send(get);
 expect(reply.rateLimitHeaders).toEqual({'retry-after':retry});expect(reply.scheduling!.cooldownUntilUtc).toBe('2026-10-17T00:02:00.000Z');
 await vi.advanceTimersByTimeAsync(119499);await expect(get(legacy)).rejects.toMatchObject({message:'THROTTLED'});
 await vi.advanceTimersByTimeAsync(1);expect((await send(get)).status).toBe(200);
});
it.each(['bogus','-1','1.5','9'.repeat(256)])('invalid Retry-After %s falls back without permanent shutdown',async retry=>{
 network([503],{'retry-after':retry});const get=pacedV2RestGet();const reply=await send(get);
 expect(reply.scheduling!.cooldownUntilUtc).toBe('2026-10-17T00:00:30.000Z');
});
it('server cooldown beyond five minutes is honored; 403 stays terminal indefinitely',async()=>{
 network([429],{'retry-after':'600'});const get=pacedV2RestGet();expect((await send(get)).scheduling!.cooldownUntilUtc).toBe('2026-10-17T00:10:00.000Z');
 const calls=network([403]);const denied=pacedV2RestGet();expect((await send(denied)).scheduling!.state).toBe('TERMINAL');
 await vi.advanceTimersByTimeAsync(3600000);await expect(denied(legacy)).rejects.toMatchObject({message:'HOST_STOPPED'});expect(calls).toHaveBeenCalledTimes(1);
});
it('shared rolling budget remains 60 total and 20 v2, with no extra recovery allowance',async()=>{
 const calls=network([429],{'retry-after':'0'});const get=pacedV2RestGet();
 for(let i=0;i<60;i++)await send(get,i<20?v2:legacy);
 for(const url of [v2,legacy]){const denied=expect(get(url)).rejects.toMatchObject({message:'REQUEST_BUDGET'});await vi.advanceTimersByTimeAsync(500);await denied;}
 expect(calls).toHaveBeenCalledTimes(60);await vi.advanceTimersByTimeAsync(60000);expect((await send(get,v2)).status).toBe(200);
});
it('rate-limit headers are allowlisted and bounded; successful transport start is sampled at fetch',async()=>{
 network([],{'retry-after':'1','x-ratelimit-remaining':'x'.repeat(1000),'authorization':'secret'});
 const r=await restGet(legacy);expect(r.requestStartUtc).toBe(new Date().toISOString());
 expect(r.rateLimitHeaders).toEqual({'retry-after':'1','x-ratelimit-remaining':'x'.repeat(256)});
});
it('a delayed spacing wake never starts transport beyond its request deadline',async()=>{
 const calls=network([]);const get=pacedV2RestGet();await get(legacy);
 const rejected=expect(get(legacy,1000,1024,Date.now()+1500)).rejects.toMatchObject({message:'TIME_BUDGET'});
 vi.setSystemTime(Date.now()+2000);await vi.advanceTimersByTimeAsync(500);await rejected;expect(calls).toHaveBeenCalledTimes(1);
});
it('recovery transport failure continues bounded cooldown and preserves its start identity',async()=>{
 network([503]);const get=pacedV2RestGet();await send(get);await vi.advanceTimersByTimeAsync(29500);
 vi.stubGlobal('fetch',vi.fn(async()=>{throw Error('transport failed');}));
 const failed=get(legacy);const rejected=expect(failed).rejects.toMatchObject({requestStartUtc:'2026-10-17T00:00:30.000Z',scheduling:{state:'THROTTLED',recoveryAttempt:true,cooldownUntilUtc:'2026-10-17T00:01:30.000Z'}});
 await vi.advanceTimersByTimeAsync(0);await rejected;await expect(get(legacy)).rejects.toMatchObject({message:'THROTTLED'});
});
it('past Retry-After dates permit only one paced probe rather than replaying queued work',async()=>{
 network([429],{'retry-after':'Fri, 16 Oct 2026 23:59:59 GMT'});const get=pacedV2RestGet();
 const queued=Promise.allSettled([get(legacy),get(v2)]);await vi.advanceTimersByTimeAsync(0);const result=await queued;
 expect(result[0]).toMatchObject({status:'fulfilled',value:{scheduling:{cooldownUntilUtc:'2026-10-17T00:00:00.000Z'}}});expect(result[1].status).toBe('rejected');
 expect((await send(get)).scheduling).toMatchObject({state:'RECOVERY',recoveryAttempt:true});
});

it.each([[0,24000],[1,36000]])('fallback jitter draw %s yields bounded initial cooldown %s',async(draw,delay)=>{
 vi.mocked(Math.random).mockReturnValue(draw);network([429]);const get=pacedV2RestGet();
 expect(Date.parse((await send(get)).scheduling!.cooldownUntilUtc!)-Date.parse('2026-10-17T00:00:00Z')).toBe(delay);
});
