import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, expect, it, vi } from 'vitest';
import { RestPoller, type RestPollerOpts } from '../src/shadow/rest-poller.js';
import { RacingStore, Reconciler, tradesIdentity } from '../src/shadow/racing.js';
import { OperationalEvidence } from '../src/shadow/operational-evidence.js';
import { runtimeHealthSnapshot } from '../src/shadow/runtime-health.js';
const clean:(()=>void)[]=[];
afterEach(()=>{for(const f of clean.splice(0).reverse())f();});
const item=(i:number)=>({transactionHash:`tx-${i}`,proxyWallet:'wallet',asset:'asset',size:1,price:.5,timestamp:1000-i,type:'TRADE',side:'BUY'});
const rows=(dir:string,name='rest_poll_receipts.ndjson'):any[]=>existsSync(join(dir,name))?readFileSync(join(dir,name),'utf8').trim().split('\n').filter(Boolean).map(s=>JSON.parse(s)):[];
const response=(body:unknown,status=200)=>({body,status,headers:{age:'3',cacheControl:'max-age=5',etag:'tag',date:'date'}});
async function fixture(fetch:any,overrides:Partial<RestPollerOpts>={},opOpts:any={}){
 const dir=mkdtempSync(join(tmpdir(),'rest-pagination-'));clean.push(()=>rmSync(dir,{recursive:true,force:true}));
 const store=new RacingStore(dir);await store.initializeIndex();clean.push(()=>store.close());
 const op=new OperationalEvidence(dir,undefined,opOpts);let opClosed=false;const closeOperational=()=>{if(!opClosed){opClosed=true;op.close();}};clean.push(closeOperational);
 const opts:RestPollerOpts={source:'REST_TRADES',endpoint:'trades',baseUrl:'https://offline.invalid',wallets:new Set(['wallet']),intervalMs:1000,...overrides};
 const poller=new RestPoller(opts,store,new Reconciler(store),()=>new Date().toISOString(),fetch,op);clean.push(()=>poller.stop());
 return {dir,store,op,poller,opts,closeOperational};
}
for(const source of ['REST_TRADES','REST_ACTIVITY'] as const)it(`${source}: capped100 continuation, exact overlap and linked complete receipts stay UNPROVEN`,async()=>{
 const data=Array.from({length:105},(_,i)=>item(i)),urls:string[]=[];
 const fetch=vi.fn(async(url:string)=>{urls.push(url);const q=new URL(url).searchParams;const offset=Number(q.get('offset'));return response(data.slice(offset,offset+100));});
 const f=await fixture(fetch,{source,endpoint:source==='REST_TRADES'?'trades':'activity',pagination:{maxPages:3,overlap:2}});
 await f.poller.pollWallet('wallet');
 const receipts=rows(f.dir),pages=receipts.filter(r=>r.recordType==='REST_PAGE'),poll=receipts.at(-1);
 expect(pages).toHaveLength(2);expect(new Set(receipts.map(r=>r.pollId)).size).toBe(1);
 expect(pages[0]).toMatchObject({outcome:'SUCCESS_NONEMPTY',nextOffset:98,itemCount:100,newIdentities:100,alreadySeen:0,publication:'SUCCESS',identityVectorComplete:true});
 expect(pages[1]).toMatchObject({offset:98,itemCount:7,alreadySeen:2,newIdentities:5,overlap:'MATCHED',stopReason:'SHORT_PAGE',nextOffset:null,pagination:'UNKNOWN_UNPROVEN'});
 expect(poll).toMatchObject({recordType:'REST_POLL',pageCount:2,itemCount:107,newIdentities:105,alreadySeen:2});
 expect(poll.vectorScope).toBe('LAST_PAGE_ONLY; per-page vector hashes and first/last identity/timestamp metadata are in linked REST_PAGE receipts; full vectors are not stored');
 expect(pages[0].requestParams).toEqual(source==='REST_TRADES'?{user:'wallet',limit:'100',takerOnly:'false',offset:'0'}:{user:'wallet',limit:'100',offset:'0'});
 expect(pages[0].cacheHeaders).toEqual({age:'3',cacheControl:'max-age=5',etag:'tag',date:'date'});
 expect(pages[0].firstTimestamp).toBe(1000);expect(pages[0].lastTimestamp).toBe(901);
 if(source==='REST_TRADES')expect(pages[0].identityVectorSha256).toBe(createHash('sha256').update(data.slice(0,100).map(tradesIdentity).join('\n')).digest('hex'));
 expect(f.store.restRaw()).toHaveLength(105);expect(urls.every(u=>!u.includes('/v2/'))).toBe(true);
 expect(f.op.restQuality()).toEqual({restAtPageLimit:true,restCompletenessUnproven:true});
 const q=rows(f.dir,'quarantine_v2.ndjson')[0];expect(pages[0].quarantineIds).toContain(q.quarantineId);expect(q.pollId).toBe(poll.pollId);
 const snap=runtimeHealthSnapshot({memoryTelemetry:()=>({})},{indexTelemetry:()=>({})},f.op,()=>null);expect(snap.restCompleteness).toMatchObject({pages:2,polls:1,state:'UNKNOWN_UNPROVEN'});
});
it('default wiring keeps acquisition one-page and reports cap, not complete',async()=>{
 const fetch=vi.fn(async()=>response(Array.from({length:100},(_,i)=>item(i))));const f=await fixture(fetch);
 await f.poller.pollWallet('wallet');expect(fetch).toHaveBeenCalledTimes(1);expect(fetch.mock.calls[0]).toEqual(['https://offline.invalid/trades?user=wallet&limit=100&takerOnly=false']);
 expect(rows(f.dir)[0]).toMatchObject({stopReason:'PAGINATION_DISABLED',nextOffset:null,pagination:'UNKNOWN_UNPROVEN'});
});
for(const kind of ['missing','moving','empty'] as const)it(`${kind} overlap stops traversal without inferring coverage or empty recovery`,async()=>{
 let n=0;const fetch=vi.fn(async()=>response(n++===0?[item(0),item(1),item(2)]:kind==='empty'?[]:kind==='missing'?[item(4),item(5),item(6)]:[item(1),item(2),item(3)]));
 const f=await fixture(fetch,{limit:3,pagination:{maxPages:4,overlap:1}});await f.poller.pollWallet('wallet');
 expect(fetch).toHaveBeenCalledTimes(2);expect(rows(f.dir)[1]).toMatchObject({overlap:'MISSING_OR_MOVED',stopReason:'UNSTABLE_OVERLAP',nextOffset:null,pagination:'UNKNOWN_UNPROVEN'});
 expect(f.op.restCompletenessState()).toMatchObject({unstablePages:1});expect(f.op.unresolvedQuarantineCount()).toBeGreaterThan(0);
});
it('request budget exhaustion is durable and never cleared by later empty pages or restart',async()=>{
 let empty=false;const fetch=vi.fn(async(url:string)=>{const offset=Number(new URL(url).searchParams.get('offset'));return response(empty?[]:Array.from({length:3},(_,i)=>item(offset+i)));});
 const f=await fixture(fetch,{limit:3,pagination:{maxPages:2,overlap:1}});await f.poller.pollWallet('wallet');
 expect(rows(f.dir)[1]).toMatchObject({stopReason:'REQUEST_BUDGET_EXHAUSTED',nextOffset:null});empty=true;
 for(let i=0;i<130;i++)await f.poller.pollWallet('wallet');
 const state=f.op.restCompletenessState();expect(state).toMatchObject({budgetExhaustions:1,pages:132,polls:131});f.closeOperational();
 const db=new DatabaseSync(join(f.dir,'operational-index.sqlite'));db.prepare("UPDATE meta SET v=? WHERE k='rest_completeness'").run(JSON.stringify({...state,budgetExhaustions:0}));db.close();
 const restarted=new OperationalEvidence(f.dir);expect(restarted.indexStatus().rebuildReason).toBe('SEMANTIC_MISMATCH');expect(restarted.restCompletenessState()).toEqual(state);restarted.close();
 rmSync(join(f.dir,'operational-index.sqlite'));const rebuilt=new OperationalEvidence(f.dir);expect(rebuilt.restCompletenessState()).toEqual(state);rebuilt.close();
});
it('documented activity offset cap is never exceeded',async()=>{
 const fetch=vi.fn(async(url:string)=>{const offset=Number(new URL(url).searchParams.get('offset'));return response(Array.from({length:500},(_,i)=>item(offset+i)));});
 const f=await fixture(fetch,{source:'REST_ACTIVITY',endpoint:'activity',limit:500,pagination:{maxPages:16,overlap:1}});await f.poller.pollWallet('wallet');
 const pages=rows(f.dir).filter(r=>r.recordType==='REST_PAGE');expect(pages.at(-1)).toMatchObject({stopReason:'OFFSET_CAP_EXHAUSTED',offset:4990,nextOffset:null});
 expect(fetch.mock.calls.every(([u])=>Number(new URL(u).searchParams.get('offset'))<=5000)).toBe(true);
},20000);
for(const [name,body,status,outcome] of [['429',[],429,'HTTP_FAILURE'],['503',[],503,'HTTP_FAILURE'],['nonarray',{},200,'PARSE_FAILURE'],['null',null,200,'PARSE_FAILURE'],['empty',[],200,'SUCCESS_EMPTY']] as const)it(`${name} gets truthful page and poll receipts`,async()=>{
 const f=await fixture(async()=>response(body,status));await f.poller.pollWallet('wallet');const r=rows(f.dir);expect(r).toHaveLength(2);expect(r.every(x=>x.outcome===outcome)).toBe(true);
 expect(r.every(x=>x.identityVectorComplete===(outcome==='SUCCESS_EMPTY'))).toBe(true);
 expect(r[0].publication).toBe(outcome==='SUCCESS_EMPTY'?'SUCCESS':'NOT_ATTEMPTED');expect(f.store.restRaw()).toHaveLength(0);
});
for(const error of [Error('timeout'),new SyntaxError('bad JSON')])it(`thrown ${error.name} is not an empty success`,async()=>{
 const f=await fixture(async()=>{throw error;});await f.poller.pollWallet('wallet');expect(rows(f.dir)[0]).toMatchObject({outcome:error instanceof SyntaxError?'PARSE_FAILURE':'TIMEOUT',publication:'NOT_ATTEMPTED',newIdentities:0,identityVectorComplete:false});
});
for(const bad of [null,{}, {timestamp:'bad'},[],{...item(0),proxyWallet:42}])it(`malformed item ${JSON.stringify(bad)} is receipted before rejection`,async()=>{
 const f=await fixture(async()=>response([item(0),bad]));await expect(f.poller.pollWallet('wallet')).rejects.toThrow('malformed REST');expect(f.store.restRaw()).toHaveLength(0);
 expect(rows(f.dir)[0]).toMatchObject({outcome:'PARSE_FAILURE',publication:'NOT_ATTEMPTED',identityVectorComplete:false});
});
it('overflow is fail closed without publishing or retaining oversized vectors',async()=>{
 const f=await fixture(async()=>response([item(0),item(1),item(2)]),{limit:2});await expect(f.poller.pollWallet('wallet')).rejects.toThrow('overflow');
 expect(rows(f.dir)[0]).toMatchObject({outcome:'PARSE_FAILURE',atApiLimit:true,identityVectorComplete:false,newIdentities:0});expect(f.store.restRaw()).toHaveLength(0);
});
it('publication failure receipt links quarantine; only later exact committed identity resolves it',async()=>{
 const f=await fixture(async()=>response([item(0)]));const fault=vi.spyOn(f.store,'appendRestRaw').mockImplementationOnce(()=>{throw Error('publish failed');});
 await expect(f.poller.pollWallet('wallet')).rejects.toThrow('publish failed');const page=rows(f.dir)[0];expect(page).toMatchObject({outcome:'PUBLICATION_FAILURE',publication:'FAILURE',newIdentities:0});
 const q=rows(f.dir,'quarantine_v2.ndjson')[0];expect(page.quarantineIds).toEqual([q.quarantineId]);expect(f.op.unresolvedQuarantineCount()).toBe(1);fault.mockRestore();
 await f.poller.pollWallet('wallet');expect(f.op.quarantineState()).toMatchObject({recovered:1,unresolved:0});expect(rows(f.dir,'quarantine_resolutions.ndjson')[0]).toMatchObject({quarantineId:q.quarantineId,recoveryState:'RECOVERED',terminalDisposition:'PUBLICATION_CONFIRMED'});
});
it('restart-repaired publication preserves first clocks and resolves only on exact confirmation',async()=>{
 const f=await fixture(async()=>response([item(0)]));(f.store as any).db.exec("CREATE TRIGGER fail_rest BEFORE INSERT ON identities BEGIN SELECT RAISE(FAIL,'rest fault'); END");
 await expect(f.poller.pollWallet('wallet')).rejects.toThrow();expect(rows(f.dir)[0]).toMatchObject({outcome:'PUBLICATION_FAILURE',publication:'FAILURE'});
 const raw=rows(f.dir,'rest_raw.ndjson')[0];f.store.close();f.closeOperational();const store=new RacingStore(f.dir);await store.initializeIndex();const op=new OperationalEvidence(f.dir);clean.push(()=>{store.close();op.close();});
 expect(op.unresolvedQuarantineCount()).toBe(1);const p=new RestPoller(f.opts,store,new Reconciler(store),()=> '2099-01-01T00:00:00Z',async()=>response([item(0)]),op);
 await p.pollWallet('wallet');expect(store.sourceObservations()[0]!.sourceFirstSeenUtc).toBe(raw.firstSeenUtc);expect(op.quarantineState()).toMatchObject({recovered:1,unresolved:0});
});
it('overlapping direct and scheduled polls produce SKIPPED without additional requests',async()=>{
 let release!:(value:any)=>void;const fetch=vi.fn(()=>new Promise(r=>{release=r;}));const f=await fixture(fetch);
 const pending=f.poller.pollAll();await vi.waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));await f.poller.pollAll();await f.poller.pollWallet('wallet');
 expect(rows(f.dir).map(r=>r.outcome)).toEqual(['SKIPPED','SKIPPED']);release(response([]));await pending;expect(fetch).toHaveBeenCalledTimes(1);expect(f.op.restCompletenessState()).toMatchObject({skipped:2,polls:3,pages:1});
});
for(const source of ['REST_TRADES','REST_ACTIVITY'] as const)it(`${source}: scheduled multiwallet cycles isolate receipted malformed pages and retry the full cohort`,async()=>{
 vi.useFakeTimers();clean.push(()=>vi.useRealTimers());
 let malformed=true;
 const fetch=vi.fn(async(url:string)=>{
  const wallet=new URL(url).searchParams.get('user')!;
  return response(wallet==='first'&&malformed?[null]:[{...item(wallet==='first'?0:wallet==='second'?1:2),proxyWallet:wallet}]);
 });
 const f=await fixture(fetch,{source,endpoint:source==='REST_TRADES'?'trades':'activity',wallets:new Set(['first','second','third'])});
 f.poller.start();await vi.advanceTimersByTimeAsync(0);
 await vi.advanceTimersByTimeAsync(1000);
 expect(fetch.mock.calls.map(([url])=>new URL(url).searchParams.get('user'))).toEqual(['first','second','third','first','second','third']);
 const failedCycles=rows(f.dir);
 expect(failedCycles.map(r=>[r.wallet,r.recordType,r.outcome])).toEqual(Array.from({length:2},()=>[
  ['first','REST_PAGE','PARSE_FAILURE'],['first','REST_POLL','PARSE_FAILURE'],
  ['second','REST_PAGE','SUCCESS_NONEMPTY'],['second','REST_POLL','SUCCESS_NONEMPTY'],
  ['third','REST_PAGE','SUCCESS_NONEMPTY'],['third','REST_POLL','SUCCESS_NONEMPTY'],
 ]).flat());
 expect(new Set(failedCycles.filter(r=>r.recordType==='REST_POLL').map(r=>r.pollId)).size).toBe(6);
 for(let i=0;i<failedCycles.length;i+=2){
  expect(failedCycles[i].pollId).toBe(failedCycles[i+1].pollId);
  expect(failedCycles[i+1]).toMatchObject({pageCount:1,itemCount:1,pagination:'UNKNOWN_UNPROVEN'});
 }
 expect(rows(f.dir,'quarantine_v2.ndjson')).toHaveLength(2);
 expect(failedCycles.filter(r=>r.wallet==='first').every(r=>r.quarantineIds.length===1)).toBe(true);
 expect(f.op.restCompletenessState()).toMatchObject({pages:6,polls:6,skipped:0});
 expect(f.store.restRaw()).toHaveLength(2);
 malformed=false;await vi.advanceTimersByTimeAsync(1000);
 expect(fetch).toHaveBeenCalledTimes(9);
 const recoveredCycle=rows(f.dir).slice(12);
 expect(recoveredCycle.map(r=>[r.wallet,r.recordType,r.newIdentities,r.alreadySeen])).toEqual([
  ['first','REST_PAGE',1,0],['first','REST_POLL',1,0],
  ['second','REST_PAGE',0,1],['second','REST_POLL',0,1],
  ['third','REST_PAGE',0,1],['third','REST_POLL',0,1],
 ]);
 expect(f.store.restRaw()).toHaveLength(3);expect(f.op.unresolvedQuarantineCount()).toBe(2);
 expect(f.op.restCompletenessState()).toMatchObject({pages:9,polls:9,skipped:0,state:'UNKNOWN_UNPROVEN'});
});
for(const faultKind of ['page-sink','poll-sink','malformed-page-sink','malformed-poll-sink','malformed-index-telemetry','index-publication','index-preflight'] as const)it(`scheduled multiwallet ${faultKind} remains globally fail-closed across later ticks`,async()=>{
 vi.useFakeTimers();clean.push(()=>vi.useRealTimers());
 const failure=Error(`unsafe ${faultKind}`);
 const fetch=vi.fn(async()=>response(faultKind.startsWith('malformed')?[null]:[item(0)]));
 const f=await fixture(fetch,{wallets:new Set(['first','second','third'])},{fault:(point:string,name:string,row:any)=>{
  if(point==='after-authoritative-append'&&name==='rest_poll_receipts.ndjson'&&
    (faultKind.endsWith('page-sink')&&row.recordType==='REST_PAGE'||faultKind.endsWith('poll-sink')&&row.recordType==='REST_POLL'))throw failure;
 }});
 if(faultKind==='index-publication')(f.store as any).db.exec("CREATE TRIGGER fail_rest BEFORE INSERT ON identities BEGIN SELECT RAISE(FAIL,'unsafe index'); END");
 if(faultKind==='malformed-index-telemetry'){
  const indexRow=(f.store as any).indexRow.bind(f.store);
  vi.spyOn(f.store as any,'indexRow').mockImplementation((...args:unknown[])=>{if(args[0]==='poll_telemetry.ndjson')throw failure;return indexRow(...args);});
 }
 if(faultKind==='index-preflight')vi.spyOn(f.store,'initializeIndex').mockRejectedValue(failure);
 f.poller.start();await vi.advanceTimersByTimeAsync(0);
 expect(fetch).toHaveBeenCalledTimes(faultKind==='index-preflight'?0:1);
 const receipts=rows(f.dir);
 expect(receipts.every(r=>r.wallet==='first')).toBe(true);
 expect(receipts.map(r=>r.recordType)).toEqual(faultKind.endsWith('page-sink')?['REST_PAGE']:faultKind==='index-preflight'?['REST_POLL']:['REST_PAGE','REST_POLL']);
 if(faultKind.includes('index'))expect(receipts.at(-1)).toMatchObject({outcome:'PUBLICATION_FAILURE',publication:'FAILURE',pageCount:faultKind==='index-preflight'?0:1});
 else expect(f.op.isUsable()).toBe(false);
 if(faultKind==='index-publication'||faultKind==='malformed-index-telemetry')expect(()=>f.store.assertUsable()).toThrow('index invalid');
 const before=readFileSync(join(f.dir,'rest_poll_receipts.ndjson'),'utf8');
 await vi.advanceTimersByTimeAsync(3000);
 expect(fetch).toHaveBeenCalledTimes(faultKind==='index-preflight'?0:1);
 expect(readFileSync(join(f.dir,'rest_poll_receipts.ndjson'),'utf8')).toBe(before);
 expect((f.poller as any).timer).toBeNull();
});
it('receipt sink failure prevents later continuation and all-source publication',async()=>{
 const failure=Error('ENOSPC');const fetch=vi.fn(async()=>response([item(0),item(1),item(2)]));const f=await fixture(fetch,{limit:3,pagination:{maxPages:3,overlap:1}},{fault:(point:string,name:string)=>{if(point==='after-authoritative-append'&&name==='rest_poll_receipts.ndjson')throw failure;}});
 await expect(f.poller.pollWallet('wallet')).rejects.toBe(failure);expect(fetch).toHaveBeenCalledTimes(1);await expect(f.poller.pollAll()).rejects.toBe(failure);
 expect(()=>new Reconciler(f.store).record('CHAIN','later','group','utc')).toThrow(failure);
 const op=new OperationalEvidence(f.dir);expect(op.restCompletenessState()).toMatchObject({pages:1,polls:0,state:'UNKNOWN_UNPROVEN'});op.close();
});
it('body-read timeout retains status/cache metadata in actual poll receipts',async()=>{
 const f=await fixture(async()=>({...response(null),bodyError:{outcome:'TIMEOUT',message:'body timeout'}}));
 await f.poller.pollWallet('wallet');expect(rows(f.dir)[0]).toMatchObject({outcome:'TIMEOUT',httpStatus:200,cacheHeaders:{age:'3',etag:'tag'},publication:'NOT_ATTEMPTED'});
});
it('rejects invalid page budgets and endpoint substitution',async()=>{
 const f=await fixture(async()=>response([]));for(const pagination of [{maxPages:17,overlap:1},{maxPages:1,overlap:100},{maxPages:1,overlap:0}])expect(()=>new RestPoller({...f.opts,pagination},f.store,new Reconciler(f.store))).toThrow('budget');
 expect(()=>new RestPoller({...f.opts,endpoint:'activity'},f.store,new Reconciler(f.store))).toThrow('endpoint mismatch');
});
