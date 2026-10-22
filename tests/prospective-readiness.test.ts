import {afterEach,it,expect,vi} from 'vitest';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {RestPoller} from '../src/shadow/rest-poller.js';
import {RacingStore,Reconciler} from '../src/shadow/racing.js';
import {OperationalEvidence} from '../src/shadow/operational-evidence.js';
import {WALLETS} from '../research/v2-cursor-v1/adapter.js';
import {readContinuation} from '../src/shadow/rest-continuation.js';
import {diagnosticReadiness} from '../src/compare/diagnostic-readiness.js';
import {readNdjson} from '../src/compare/ndjson.js';
const cleanup:(()=>void)[]=[];afterEach(()=>{vi.restoreAllMocks();cleanup.splice(0).reverse().forEach(f=>f());});
const wallet=WALLETS[0]!,startUtc=new Date(Date.now()-10000).toISOString();
const fixtureEpoch=Math.floor(Date.now()/1000);
const row=(n:number,age=1)=>({proxy_wallet:wallet,transaction_hash:'0x'+n.toString(16).padStart(64,'0'),token_id:'123',condition_id:'0x'+'ab'.repeat(32),title:'fixture',size:1,price:.5,timestamp:fixtureEpoch-age,side:'BUY',type:'TRADE'});
const envelope=(data:unknown[],next:string|null)=>({data,pagination:{limit:100,offset:0,has_more:next!==null,next_cursor:next}});
const reply=(body:unknown,status=200)=>({status,body,requestStartUtc:new Date().toISOString(),responseUtc:new Date().toISOString(),headers:{age:'0',cacheControl:null,etag:null,date:null}});
async function fixture(fetch:any,source:'REST_TRADES'|'REST_ACTIVITY'='REST_TRADES'){
 const dir=mkdtempSync(join(tmpdir(),'readiness-'));cleanup.push(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new RacingStore(dir);await store.initializeIndex();const op=new OperationalEvidence(dir);let closed=false;
 const close=()=>{if(!closed){closed=true;store.close();op.close();}};cleanup.push(close);
 const opts={source,endpoint:source==='REST_TRADES'?'trades' as const:'activity' as const,baseUrl:'https://data-api.polymarket.com',wallets:new Set([wallet]),intervalMs:60000,v2:true,discoveryStartUtc:startUtc};
 const make=()=>new RestPoller(opts,store,new Reconciler(store),()=>new Date(Date.now()+10).toISOString(),fetch,op);
 return{dir,store,op,opts,poller:make(),make,close};
}
const receipts=(dir:string)=>readFileSync(join(dir,'rest_poll_receipts.ndjson'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
for(const source of ['REST_TRADES','REST_ACTIVITY'] as const)it(source+': fresh page bypasses history, independent continuation survives restart and overlap preserves clocks',async()=>{
 let available=false;const urls:URL[]=[];
 const fetch=async(url:string)=>{const u=new URL(url);urls.push(u);const fresh=Number(u.searchParams.get('start'))>Math.floor(Date.now()/1000)-1000;
  if(fresh)return reply(envelope(available?[row(99)]:[],'fresh-next'));
  return reply(envelope(u.searchParams.has('cursor')?[row(2,50000),row(3,50001)]:[row(1,50000),row(2,50000)],u.searchParams.has('cursor')?'history-2':'history-1'));
 };
 const f=await fixture(fetch,source);await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');
 const original=f.store.sourceObservations();expect(original).toHaveLength(2);
 expect(readContinuation(f.dir,source,wallet)).toMatchObject({cursor:'history-1',pages:1,exhausted:false});
 expect(receipts(f.dir).at(-1)).toMatchObject({stopReason:'REQUEST_BUDGET_EXHAUSTED',continuationAvailable:true,pageCount:1,pagination:'UNKNOWN_UNPROVEN'});
 available=true;await f.poller.pollWallet(wallet);expect(f.store.sourceObservations()).toHaveLength(3);
 const fresh=f.store.sourceObservations().find(x=>x.acquisitionMode==='FRESH_DISCOVERY')!;expect(fresh.sourceTs).toBeGreaterThan(Date.parse(startUtc)/1000);
 expect(Date.parse(fresh.completedUtc)).toBeGreaterThan(Date.parse(fresh.sourceFirstSeenUtc));
 f.close();const store=new RacingStore(f.dir);await store.initializeIndex();const op=new OperationalEvidence(f.dir);cleanup.push(()=>{store.close();op.close();});
 await new RestPoller(f.opts,store,new Reconciler(store),()=>new Date(Date.now()+10).toISOString(),fetch,op).pollWallet(wallet,'HISTORICAL_CONTINUATION');
 expect(urls.at(-1)!.searchParams.get('cursor')).toBe('history-1');expect(urls.at(-1)!.searchParams.get('end')).toBe(urls[0]!.searchParams.get('end'));
 expect(store.sourceObservations()).toHaveLength(4);expect(store.sourceObservations()[1]).toEqual(original[1]);
 expect(receipts(f.dir).at(-1)).toMatchObject({alreadySeen:1,newIdentities:1,cumulativePages:2});
});
it('invalid/expired cursor explicitly reanchors without completeness or duplicate publication',async()=>{
 let reject=false;const urls:string[]=[];const f=await fixture(async(url:string)=>{urls.push(url);return reject&&new URL(url).searchParams.has('cursor')?reply({code:'invalid_cursor'},400):reply(envelope([row(1,20000)],'next'));});
 await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');reject=true;
 await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');expect(receipts(f.dir).some(r=>r.recordType==='REST_CURSOR_INVALIDATION')).toBe(true);
 await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');expect(new URL(urls.at(-1)!).searchParams.has('cursor')).toBe(false);expect(f.store.sourceObservations()).toHaveLength(1);
 const path=join(f.dir,`rest-continuation-REST_TRADES-${wallet}.json`),c=JSON.parse(readFileSync(path,'utf8'));c.savedUtc='2000-01-01T00:00:00Z';writeFileSync(path,JSON.stringify(c));
 await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');expect(receipts(f.dir).at(-1).cursorInvalidation).toContain('CURSOR_AGE_UNPROVEN');
});
it('crash after raw publication replays the same page and original clocks, never advances its cursor',async()=>{
 const f=await fixture(async()=>reply(envelope([row(1,20000)],'next')));
 vi.spyOn(f.store,'appendSourceObservation').mockImplementationOnce(()=>{throw Error('interrupt');});
 await expect(f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION')).rejects.toThrow('interrupt');
 expect(readContinuation(f.dir,'REST_TRADES',wallet)).toBe(null);const raw=f.store.restRaw()[0]!;f.close();
 const store=new RacingStore(f.dir);await store.initializeIndex();const op=new OperationalEvidence(f.dir);cleanup.push(()=>{store.close();op.close();});
 await new RestPoller(f.opts,store,new Reconciler(store),()=>new Date(Date.now()+100).toISOString(),async()=>reply(envelope([row(1,20000)],'next')),op).pollWallet(wallet,'HISTORICAL_CONTINUATION');
 expect(store.sourceObservations()).toHaveLength(1);expect(store.sourceObservations()[0]).toMatchObject({completedUtc:raw.completedUtc,sourceFirstSeenUtc:raw.firstSeenUtc,acquisitionMode:'HISTORICAL_CONTINUATION'});
});
it('new insertions and duplicate pages are not silently called complete; historical-only fresh responses remain retrospective',async()=>{
 const f=await fixture(async()=>reply(envelope([row(1,50),row(1,50)],null)));await f.poller.pollWallet(wallet);await f.make().pollWallet(wallet);
 expect(f.store.sourceObservations()).toHaveLength(1);expect(receipts(f.dir).at(-1)).toMatchObject({alreadySeen:2,newIdentities:0,stopReason:'API_EXHAUSTED',pagination:'UNKNOWN_UNPROVEN'});
 const r=await diagnosticReadiness(f.dir,{startUtc,endUtc:new Date().toISOString()},readNdjson);expect(r.rest.REST_TRADES.coverage).toBe('UNKNOWN_UNPROVEN');expect(r.matchedEventTimingSupport).toBe('UNKNOWN');
});
it('checkpoint query tampering invalidates rather than reusing cursor on a different wallet/filter',async()=>{
 const urls:string[]=[];const f=await fixture(async(url:string)=>{urls.push(url);return reply(envelope([row(1,20000)],'next'));});await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');
 const path=join(f.dir,`rest-continuation-REST_TRADES-${wallet}.json`),c=JSON.parse(readFileSync(path,'utf8'));c.query.taker_only='true';writeFileSync(path,JSON.stringify(c));await f.poller.pollWallet(wallet,'HISTORICAL_CONTINUATION');
 expect(new URL(urls.at(-1)!).searchParams.has('cursor')).toBe(false);expect(receipts(f.dir).at(-1).cursorInvalidation).toContain('CURSOR_QUERY_BINDING');
});
it('clock/readiness projection retains measured health, head gaps and budgets without asserting provider clock accuracy',async()=>{
 const f=await fixture(async()=>reply(envelope([row(1)],'next')));await f.poller.pollWallet(wallet);
 const endUtc=new Date(Date.parse(startUtc)+20000).toISOString();
 writeFileSync(join(f.dir,'clock_health.ndjson'),[startUtc,endUtc].map(observedUtc=>JSON.stringify({state:'HEALTHY',observedUtc,ntpSynchronized:true,estimatedHostOffsetSeconds:.003,rootDistanceSeconds:.004,monotonicSeconds:1})).join('\n')+'\n');
 f.op.tailProof({latestObservedHeadBlock:100,lastSuccessfullyScannedBlock:98,unscannedHeadGap:{fromBlock:99,toBlock:100},coverage:'UNKNOWN_UNPROVEN'});
 const r=await diagnosticReadiness(f.dir,{startUtc,endUtc},readNdjson);
 expect(r.matchedEventTimingSupport).toBe('OBSERVED_HOST_CLOCK_DIFFERENCES_SUPPORTED');expect(r.eventTimeLatencySupport).toContain('UNCERTAIN_PROVIDER');expect(r.chain.unscannedHeadGap).toEqual({fromBlock:99,toBlock:100});expect(r.rest.REST_TRADES.budgetStops).toBe(1);
 writeFileSync(join(f.dir,'clock_health.ndjson'),JSON.stringify({observedUtc:startUtc,state:'HEALTHY',ntpSynchronized:true,estimatedHostOffsetSeconds:10,rootDistanceSeconds:0})+'\n');
 expect((await diagnosticReadiness(f.dir,{startUtc,endUtc},readNdjson)).matchedEventTimingSupport).toBe('UNKNOWN');
});
