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
let watcher=new ChainWatcher(cfg,store,()=> '2026-01-01T00:00:00Z',(async()=>{throw Error('network forbidden');}) as any);
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
 watcher=new ChainWatcher(cfg,store);
 assert.equal(await watcher.replayIncompleteFromStore(),0,'restart terminal/tombstone replay');
 await watcher.handleLog(log(0));
 assert.equal(statSync(join(dir,'raw_logs.ndjson')).size,beforeRestart,'restart duplicate');
 const rr=new Reconciler(racing);
 assert.equal(rr.record('CHAIN','i0','g0','2026-01-02T00:00:00Z'),'FIRST');
 assert.equal(rr.record('REST_TRADES','other','g0','2026-01-02T00:00:00Z'),'CORROBORATOR');
 console.log(JSON.stringify({synthetic:true,networkCalls:0,count,rawBytes,indexBytes:statSync(join(dir,'recovery-index.sqlite')).size,samples,rssGrowth,heapGrowth,reconnect:true,reorg:true,restart:true,firstMembershipPreserved:true}));
} finally {store.close();racing.close();rmSync(dir,{recursive:true,force:true});}
