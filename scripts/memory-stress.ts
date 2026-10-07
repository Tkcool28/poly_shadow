/** OFFLINE ONLY: synthetic <=50k unique identities, bounded 128MiB Node heap.
 * Run: node --expose-gc --max-old-space-size=128 --import tsx scripts/memory-stress.ts
 * Uses production watcher/store/reconciler, no HTTP/WS/start()/live data.
 */
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { ShadowStore } from '../src/shadow/storage.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
import { RacingStore, Reconciler } from '../src/shadow/racing.js';
const count=Number(process.argv[2] ?? 30000);
assert(Number.isInteger(count) && count>=15000 && count<=50000,'stress row cap: 15000..50000');
assert(global.gc,'run with --expose-gc');
const dir=mkdtempSync(join(tmpdir(),'poly-memory-proof-'));
const cfg={chainId:137, watchedWallets:new Set<string>(),polygonHttpRpcUrl:'https://offline.invalid',dataDir:dir} as any;
const log=(i:number)=>({address:'synthetic-unknown',transactionHash:'tx'+i,logIndex:0,blockNumber:i,blockHash:'fork-a',topics:[],data:'0x'});
let store=new ShadowStore(dir);let racing=new RacingStore(dir);
const offlineRpc=(async()=>{throw Error('network forbidden');}) as any;
globalThis.fetch=async()=>{throw Error('network forbidden');};
let watcher=new ChainWatcher(cfg,store,()=> '2026-01-01T00:00:00Z',offlineRpc);
const samples: ReturnType<ChainWatcher['memoryTelemetry']>[]=[];
try {
 const reconciler=new Reconciler(racing);
 for(let i=0;i<count;i++) {
  await watcher.handleLog(log(i));
  reconciler.record('CHAIN','i'+i,'g'+i,'2026-01-01T00:00:00Z');
  if((i+1)%5000===0) {global.gc!();samples.push(watcher.memoryTelemetry());}
 }
 const warm=samples[1]!;const tail=samples.slice(-3);
 const rssGrowth=Math.max(...tail.map(s=>s.rssBytes))-warm.rssBytes;
 const heapGrowth=Math.max(...tail.map(s=>s.heapUsedBytes))-warm.heapUsedBytes;
 assert(rssGrowth<32*1024**2,`RSS plateau exceeded: ${rssGrowth}`);
 assert(heapGrowth<8*1024**2,`heap plateau exceeded: ${heapGrowth}`);
 const rawBytes=statSync(join(dir,'raw_logs.ndjson')).size;
 await watcher.handleLog(log(0));assert.equal(statSync(join(dir,'raw_logs.ndjson')).size,rawBytes);
 assert.equal(await watcher.replayIncompleteFromStore(),0,'reconnect terminal replay');
 await watcher.handleLog({...log(0),removed:true});
 await watcher.handleLog(log(0));
 await watcher.handleLog({...log(0),blockHash:'fork-b'});
 const beforeRestart=statSync(join(dir,'raw_logs.ndjson')).size;
 store.close();racing.close();store=new ShadowStore(dir);racing=new RacingStore(dir);
 watcher=new ChainWatcher(cfg,store,()=> '2026-01-01T00:00:00Z',offlineRpc);
 assert.equal(await watcher.replayIncompleteFromStore(),0,'restart terminal/tombstone replay');
 await watcher.handleLog(log(0));
 assert.equal(statSync(join(dir,'raw_logs.ndjson')).size,beforeRestart,'restart duplicate');
 const rr=new Reconciler(racing);
 assert.equal(rr.record('CHAIN','i0','g0','2026-01-02T00:00:00Z'),'FIRST');
 assert.equal(rr.record('REST_TRADES','other','g0','2026-01-02T00:00:00Z'),'CORROBORATOR');
 // Tiny durable unfinished publication population amid lifetime terminal history.
 const arrival='2026-01-01T00:00:00Z';
 for(let i=count;i<count+2;i++) {
  const r={chainId:137,emitter:'synthetic-unknown',txHash:'tx'+i,logIndex:0,blockNumber:i,blockHash:'fork-a',topic0:'',topics:[],data:'0x',firstSeenUtc:arrival};
  store.appendRawLog(r);store.appendDisposition({...r,disposition:'PENDING',atUtc:arrival});
  store.appendObservation({eventId:'pending'+i,role:'MAKER_LEG',wallet:'offline',side:'BUY',tokenId:'1',shares:'1',price10:'1',feeUnits:'0',blockTimestamp:1,source:'CHAIN',sourceFirstSeenUtc:arrival,firstSeenUtc:arrival,evidence:r});
 }
 let fail=true,publicationAttempts=0;
 watcher=new ChainWatcher(cfg,store,()=>arrival,offlineRpc,()=>{publicationAttempts++;if(fail)throw Error('offline publication failure');});
 let rawLedgerIterations=0;
 const originalRows=store.rows.bind(store);
 store.rows=function*<T>(name:string):Generator<T>{rawLedgerIterations++;throw Error('periodic ledger iteration forbidden: '+name);};
 const dispositionBytes=statSync(join(dir,'dispositions.ndjson')).size;
 global.gc!();const pendingWarm=watcher.memoryTelemetry();
 const passes=200,pendingSamples:ReturnType<ChainWatcher['memoryTelemetry']>[]=[];
 const started=performance.now();
 for(let pass=0;pass<passes;pass++) {
  const before=watcher.memoryTelemetry().replayRows;
  await watcher.processRetries();
  assert.equal(watcher.memoryTelemetry().replayRows-before,2,'work must equal pending population');
  if((pass+1)%25===0){global.gc!();pendingSamples.push(watcher.memoryTelemetry());}
 }
 const periodicDurationMs=performance.now()-started;
 assert.equal(publicationAttempts,passes*2);assert.equal(rawLedgerIterations,0);
 assert.equal(statSync(join(dir,'dispositions.ndjson')).size,dispositionBytes,'no repeated PENDING amplification');
 const periodicRssGrowth=Math.max(...pendingSamples.map(s=>s.rssBytes))-pendingWarm.rssBytes;
 const periodicHeapGrowth=Math.max(...pendingSamples.map(s=>s.heapUsedBytes))-pendingWarm.heapUsedBytes;
 assert(periodicRssGrowth<32*1024**2);assert(periodicHeapGrowth<8*1024**2);
 fail=false;assert.equal(await watcher.replayIncompleteFromStore(),2);
 assert.equal(await watcher.replayIncompleteFromStore(),0);
 store.rows=originalRows;store.close();store=new ShadowStore(dir);
 watcher=new ChainWatcher(cfg,store,()=>arrival,offlineRpc,()=>{throw Error('completed restart publication forbidden');});
 assert.equal(await watcher.replayIncompleteFromStore(),0,'completed pending restart exactly once');
 console.log(JSON.stringify({synthetic:true,networkCalls:0,count,rawBytes,indexBytes:statSync(join(dir,'recovery-index.sqlite')).size,samples,rssGrowth,heapGrowth,reconnect:true,reorg:true,restart:true,firstMembershipPreserved:true,pendingPopulation:2,passes,periodicExamined:passes*2,publicationAttempts:passes*2,rawLedgerIterations,periodicDurationMs,periodicRssGrowth,periodicHeapGrowth,pendingSamples,noPendingAmplification:true,pendingCompletionRestart:true}));
} finally {store.close();racing.close();rmSync(dir,{recursive:true,force:true});}
