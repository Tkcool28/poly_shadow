import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,expect,it,vi} from 'vitest';
import {RestPoller} from '../src/shadow/rest-poller.js';
import {RacingStore,Reconciler,tradesIdentity,activityIdentity,normalizeRestRaw} from '../src/shadow/racing.js';
import {OperationalEvidence} from '../src/shadow/operational-evidence.js';
import {readShadowGroups} from '../src/compare/evidence.js';
import {buildShadowGroups,compare} from '../src/compare/phase4.js';
import {WALLETS,decode} from '../research/v2-cursor-v1/adapter.js';
import {loadConfig} from '../src/shadow/config.js';

const clean:(()=>void)[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const fn of clean.splice(0).reverse())fn();});
const wallet=WALLETS[0]!;
const row=(n=1)=>({proxy_wallet:wallet,transaction_hash:'0x'+n.toString(16).padStart(64,'0'),token_id:'123',condition_id:'0x'+'ab'.repeat(32),title:'fixture',size:1,price:.5,timestamp:Math.floor(Date.now()/1000)-1,side:'BUY',type:'TRADE'});
const envelope=(data:unknown[],next:string|null=null)=>({data,pagination:{limit:100,offset:0,has_more:next!==null,next_cursor:next}});
const reply=(body:unknown)=>({status:200,body,requestStartUtc:new Date().toISOString(),responseUtc:new Date().toISOString(),headers:{age:'0',cacheControl:null,etag:null,date:null}});
const journal=(dir:string,name='rest_poll_receipts.ndjson')=>readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s));
async function fixture(fetch:any,source:'REST_TRADES'|'REST_ACTIVITY'='REST_TRADES'){
 const dir=mkdtempSync(join(tmpdir(),'prospective-v2-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new RacingStore(dir);await store.initializeIndex();let closed=false;
 const op=new OperationalEvidence(dir);
 const close=()=>{if(!closed){closed=true;store.close();op.close();}};clean.push(close);
 const opts={source,endpoint:source==='REST_TRADES'?'trades' as const:'activity' as const,baseUrl:'https://data-api.polymarket.com',wallets:new Set([wallet]),intervalMs:60000,v2:true};
 const poller=new RestPoller(opts,store,new Reconciler(store),()=>new Date(Date.now()+5).toISOString(),fetch,op);
 return {dir,store,op,poller,opts,close};
}
for(const source of ['REST_TRADES','REST_ACTIVITY'] as const)it(`${source}: live pages publish native identity and independent clocks into the normal journals; restart is idempotent`,async()=>{
 const a=row(1),b=row(2),c=row(3);let page=0;
 const fetch=vi.fn(async(_url:string)=>reply(page++%2===0?envelope([a,b],'opaque+cursor/='):envelope([b,c])));
 const f=await fixture(fetch,source);await f.poller.pollWallet(wallet);
 expect(fetch).toHaveBeenCalledTimes(2);
 const u=new URL(fetch.mock.calls[1]![0]);expect(u.pathname).toBe('/v2/'+f.opts.endpoint);expect(u.searchParams.get('cursor')).toBe('opaque+cursor/=');
 expect(u.searchParams.has('offset')).toBe(false);
 if(source==='REST_TRADES')expect(u.searchParams.get('taker_only')).toBe('false');
 const raw=f.store.restRaw(),observations=f.store.sourceObservations();expect(raw).toHaveLength(3);expect(observations).toHaveLength(3);
 const payload=decode(f.opts.endpoint,a,wallet),identity=source==='REST_TRADES'?tradesIdentity(payload):activityIdentity(payload);
 expect(raw[0]!.sourcePayload).toEqual(a);expect(observations[0]!.identity).toBe(identity);
 expect(observations[0]).toMatchObject(normalizeRestRaw(raw[0]!));
 for(const r of raw){expect(Date.parse(r.requestStartUtc)).toBeLessThanOrEqual(Date.parse(r.responseUtc));expect(r.firstSeenUtc).toBe(r.responseUtc);expect(Date.parse(r.completedUtc!)).toBeGreaterThan(Date.parse(r.responseUtc));}
 expect(journal(f.dir)[1]).toMatchObject({recordType:'REST_PAGE',alreadySeen:1,newIdentities:1,publication:'SUCCESS',stopReason:'API_EXHAUSTED',pagination:'UNKNOWN_UNPROVEN'});
 expect(f.op.unresolvedQuarantineCount()).toBe(0);
 const before=readFileSync(join(f.dir,'source_observations.ndjson'),'utf8');f.close();
 const store=new RacingStore(f.dir);await store.initializeIndex();const op=new OperationalEvidence(f.dir);clean.push(()=>{store.close();op.close();});
 await new RestPoller(f.opts,store,new Reconciler(store),undefined,fetch,op).pollWallet(wallet);
 expect(readFileSync(join(f.dir,'source_observations.ndjson'),'utf8')).toBe(before);
 expect(journal(f.dir).at(-1)).toMatchObject({newIdentities:0,alreadySeen:4});
});
it('three-page cap remains a coverage limitation, not a quarantine or completeness claim',async()=>{
 let n=0;const f=await fixture(async()=>reply(envelope([row(++n)],'cursor-'+n)));
 await f.poller.pollWallet(wallet);expect(f.store.restRaw()).toHaveLength(3);
 expect(journal(f.dir).at(-1)).toMatchObject({pageCount:3,stopReason:'REQUEST_BUDGET_EXHAUSTED',pagination:'UNKNOWN_UNPROVEN'});
 expect(f.op.unresolvedQuarantineCount()).toBe(0);expect(f.op.restCompletenessState().state).toBe('UNKNOWN_UNPROVEN');
});
for(const kind of ['cursor','order','wallet','identity','response-clock'] as const)it(`${kind} failure cannot publish an invalid page and retains original response time`,async()=>{
 let n=0;let responseUtc='';
 const f=await fixture(async()=>{
  n++;const a=row(n);if(kind==='wallet')a.proxy_wallet=WALLETS[1]!;if(kind==='identity')a.token_id='bad';if(kind==='order')a.timestamp+=100;
  const r=reply(envelope([a],kind==='cursor'?'repeated':null));responseUtc=r.responseUtc;
  if(kind==='response-clock')r.requestStartUtc=new Date(Date.parse(r.responseUtc)+100).toISOString();return r;
 });
 await f.poller.pollWallet(wallet);
 expect(f.store.restRaw()).toHaveLength(kind==='cursor'?1:0);
 const pages=journal(f.dir).filter(r=>r.recordType==='REST_PAGE');
 expect(pages.at(-1)).toMatchObject({outcome:'PARSE_FAILURE',publication:'NOT_ATTEMPTED',responseUtc,pagination:'UNKNOWN_UNPROVEN'});
 expect(f.op.unresolvedQuarantineCount()).toBe(1);
});
it('raw publication survives a failed normalized append and restart repairs only the original clocks',async()=>{
 const f=await fixture(async()=>reply(envelope([row()])));
 vi.spyOn(f.store,'appendSourceObservation').mockImplementationOnce(()=>{throw Error('fixture interrupted append');});
 await expect(f.poller.pollWallet(wallet)).rejects.toThrow('fixture interrupted append');
 const original=f.store.restRaw()[0]!;f.close();
 const store=new RacingStore(f.dir);await store.initializeIndex();const op=new OperationalEvidence(f.dir);clean.push(()=>{store.close();op.close();});
 expect(store.sourceObservations()[0]).toMatchObject({identity:original.identity,sourceFirstSeenUtc:original.firstSeenUtc,completedUtc:original.completedUtc});
 expect(op.unresolvedQuarantineCount()).toBe(1);
 await new RestPoller(f.opts,store,new Reconciler(store),undefined,async()=>reply(envelope([original.sourcePayload])),op).pollWallet(wallet);
 expect(op.unresolvedQuarantineCount()).toBe(0);expect(store.sourceObservations()).toHaveLength(1);
});
it('ordinary evidence reader and frozen comparator retain exclusions, CHAIN corroboration and policy UNKNOWN',async()=>{
 const f=await fixture(async()=>reply(envelope([row()])));await f.poller.pollWallet(wallet);
 const o=f.store.sourceObservations()[0]!,startUtc=new Date(Date.now()-10000).toISOString(),endUtc=new Date(Date.now()+10000).toISOString();
 f.store.appendSourceObservation({...o,source:'CHAIN',identity:'chain-fixture',role:'MAKER_LEG'});
 f.store.appendSourceObservation({...o,identity:'off-wallet',groupKey:'off-wallet',wallet:WALLETS[1]!});
 f.store.appendSourceObservation({...o,identity:'off-window',groupKey:'off-window',sourceFirstSeenUtc:new Date(Date.now()+100000).toISOString()});
 const cohort=(w:string)=>w===wallet?'CONTROLLED_OVERLAP' as const:null,window={startUtc,endUtc};
 const groups=await readShadowGroups(f.dir,cohort,window);
 const expected=buildShadowGroups(f.store.sourceObservations(),cohort,window);
 const exportData={window,rows:[]};
 expect(compare(exportData,groups,window,cohort)).toEqual(compare(exportData,expected,window,cohort));
 expect(groups.size).toBe(1);expect(groups.get(o.groupKey)!.rawUtc).toBe(o.sourceFirstSeenUtc);
 expect(groups.get(o.groupKey)!.usableUtc).toBe(o.completedUtc);
 expect(groups.get(o.groupKey)!.sources.has('CHAIN')).toBe(true);
 expect(f.op.restCompletenessState().state).toBe('UNKNOWN_UNPROVEN');
});
it('v2 startup accepts exactly the frozen five wallets and no alternate booleans',()=>{
 expect(loadConfig({SHADOW_V2_CURSOR:'true',SHADOW_WATCHED_WALLETS:WALLETS.join(',')}).v2Cursor).toBe(true);
 expect(()=>loadConfig({SHADOW_V2_CURSOR:'true',SHADOW_WATCHED_WALLETS:wallet})).toThrow('five-wallet');
 expect(()=>loadConfig({SHADOW_V2_CURSOR:'yes',SHADOW_WATCHED_WALLETS:wallet})).toThrow('Invalid');
});

it('shared legacy/v2 transport serializes requests, preserves legacy capacity and receipts skips without quarantine',async()=>{
 const {pacedV2RestGet,RestRequestSkipped}=await import('../src/shadow/egress.js');
 vi.useFakeTimers();
 try{
  const network=vi.fn(async()=>new Response(JSON.stringify(envelope([])),{status:200}));vi.stubGlobal('fetch',network);
  const get=pacedV2RestGet();
  for(let i=0;i<20;i++){
   const pending=get('https://data-api.polymarket.com/v2/trades',3000,1048576,Date.now()+8000);
   await vi.advanceTimersByTimeAsync(500);await pending;
  }
  const denied=get('https://data-api.polymarket.com/v2/activity',3000,1048576,Date.now()+8000);
  const assertion=expect(denied).rejects.toBeInstanceOf(RestRequestSkipped);
  await vi.advanceTimersByTimeAsync(500);await assertion;expect(network).toHaveBeenCalledTimes(20);
  const legacy=get('https://data-api.polymarket.com/trades');await vi.advanceTimersByTimeAsync(500);await legacy;
  expect(network).toHaveBeenCalledTimes(21);
 }finally{vi.unstubAllGlobals();vi.useRealTimers();}
});
it('a scheduling skip cannot become a failed provider poll or recover a quarantine',async()=>{
 const {RestRequestSkipped}=await import('../src/shadow/egress.js');
 const f=await fixture(async()=>{throw new RestRequestSkipped('REQUEST_BUDGET');});
 await f.poller.pollWallet(wallet);
 expect(journal(f.dir)).toHaveLength(1);
 expect(journal(f.dir)[0]).toMatchObject({recordType:'REST_POLL',outcome:'SKIPPED',stopReason:'REQUEST_BUDGET',pageCount:0,publication:'NOT_ATTEMPTED',pagination:'UNKNOWN_UNPROVEN'});
 expect(f.op.unresolvedQuarantineCount()).toBe(0);expect(f.store.restRaw()).toHaveLength(0);
});
