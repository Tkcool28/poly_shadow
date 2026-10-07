import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { RacingStore, Reconciler, tradeGroupKey } from '../src/shadow/racing.js';
import { RestPoller } from '../src/shadow/rest-poller.js';
const dirs:string[]=[];
afterEach(()=>{for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const arrival='2026-01-01T00:00:01Z', completion='2026-01-01T00:00:02Z';
const item={transactionHash:'tx',proxyWallet:'wallet',asset:'asset',size:1,price:0.5,timestamp:1,type:'TRADE',side:'BUY'};
const group=tradeGroupKey('tx','asset','1.000000');
for(const source of ['REST_TRADES','REST_ACTIVITY'] as const) for(const stage of ['raw','source','group','position'] as const) {
 it(`${source} real ${stage} trigger fail-stops and recovers before CHAIN without provider replay`,async()=>{
  const dir=mkdtempSync(join(tmpdir(),'rest-publication-'));dirs.push(dir);
  let store=new RacingStore(dir);await store.initializeIndex();
  const opts={source,endpoint:source==='REST_TRADES'?'trades':'activity',baseUrl:'https://offline.invalid',wallets:new Set(['wallet']),intervalMs:1000} as const;
  let ticks=0,calls=0;
  const fetch=(async()=>{calls++;return {status:200,headers:{age:null,cacheControl:null},body:[item]};}) as any;
  let poller=new RestPoller(opts,store,new Reconciler(store),()=> ['2026-01-01T00:00:00Z',arrival,arrival,completion][ticks++]??completion,fetch);
  const table={raw:'rest_raw',source:'identities',group:'groups',position:'positions'}[stage];
  (store as any).db.exec(`CREATE TRIGGER fail_rest BEFORE INSERT ON ${table} BEGIN SELECT RAISE(FAIL, 'rest fault'); END`);
  await expect(poller.pollWallet('wallet')).rejects.toThrow(/index invalid/);
  const files=['rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson','poll_telemetry.ndjson'];
  const bytes=()=>files.map(f=>existsSync(join(dir,f))?readFileSync(join(dir,f),'utf8'):null);
  const failed=bytes();expect(failed[0]?.trim().split('\n')).toHaveLength(1);
  for(let n=0;n<3;n++){await expect(poller.pollWallet('wallet')).rejects.toThrow(/index invalid/);expect(bytes()).toEqual(failed);}
  expect(calls).toBe(1);store.close();store=new RacingStore(dir);await store.initializeIndex();
  const reconciler=new Reconciler(store);
  expect(reconciler.record('CHAIN','new-chain',group,'2026-01-02T00:00:00Z')).toBe('CORROBORATOR');
  expect(store.restRaw()).toHaveLength(1);expect(store.sourceObservations()).toHaveLength(1);
  expect(store.sourceObservations()[0]).toMatchObject({source,sourceFirstSeenUtc:arrival,completedUtc:completion});
  expect(store.reconciliation()[0]).toMatchObject({source,position:'FIRST',atUtc:arrival});
  poller=new RestPoller(opts,store,reconciler,()=> '2026-01-02T00:00:00Z',fetch);
  await poller.pollWallet('wallet');expect(store.pollTelemetry()[0]).toMatchObject({newIdentities:0,duplicates:1});
  expect(store.restRaw()).toHaveLength(1);expect(store.sourceObservations()).toHaveLength(1);expect(store.reconciliation()).toHaveLength(2);
  const complete=bytes();store.close();store=new RacingStore(dir);await store.initializeIndex();
  expect(bytes()).toEqual(complete);store.close();
 });
}
const evidenceFiles=['rest_raw.ndjson','source_observations.ndjson','reconciliation.ndjson','poll_telemetry.ndjson'];
const evidenceBytes=(dir:string)=>evidenceFiles.map(f=>existsSync(join(dir,f))?readFileSync(join(dir,f),'utf8'):null);
const rawRow=(identity:string,completedUtc?:string)=>({source:'REST_TRADES',wallet:'wallet',identity,payload:item,sourceTs:1,firstSeenUtc:completion,completedUtc});
const sourceRow=(identity:string,groupKey=group)=>({source:'REST_ACTIVITY',identity,groupKey,sourceFirstSeenUtc:arrival,completedUtc:completion});
it('rejects legacy raw-only missing completion before any publication, even after a valid candidate',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-legacy-'));dirs.push(dir);
 writeFileSync(join(dir,'rest_raw.ndjson'),[rawRow('valid',completion),rawRow('legacy')].map(r=>JSON.stringify(r)).join('\n')+'\n');
 const before=evidenceBytes(dir);const store=new RacingStore(dir);
 await expect(store.initializeIndex()).rejects.toThrow(/missing.*completedUtc/);
 expect(evidenceBytes(dir)).toEqual(before);
 await expect(store.initializeIndex()).rejects.toThrow(/index invalid/);store.close();
});
it('recovers unambiguous raw-only and source-only gaps with actual completion evidence',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-unambiguous-'));dirs.push(dir);
 writeFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify(rawRow('new',completion))+'\n');
 writeFileSync(join(dir,'source_observations.ndjson'),JSON.stringify(sourceRow('orphan','orphan-group'))+'\n');
 const store=new RacingStore(dir);await store.initializeIndex();
 expect(store.sourceObservations().find(o=>o.identity==='new')).toMatchObject({sourceFirstSeenUtc:completion,completedUtc:completion});
 expect(store.reconciliation().filter(o=>o.position==='FIRST')).toHaveLength(2);store.close();
});
for(const rawEarlier of [false,true]) it(`rejects competing raw-only/source-only gaps without inferring commit order (rawEarlier=${rawEarlier})`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-ambiguous-'));dirs.push(dir);
 writeFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify({...rawRow('raw',completion),firstSeenUtc:rawEarlier?arrival:completion})+'\n');
 writeFileSync(join(dir,'source_observations.ndjson'),[sourceRow('unambiguous','other-group'),{...sourceRow('source'),sourceFirstSeenUtc:rawEarlier?completion:arrival}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 const before=evidenceBytes(dir);const store=new RacingStore(dir);
 await expect(store.initializeIndex()).rejects.toThrow(/ambiguous.*commit order/);
 expect(evidenceBytes(dir)).toEqual(before);
 expect(()=>new Reconciler(store).record('CHAIN','new',group,completion)).toThrow(/index invalid/);store.close();
});
for(const contender of ['raw','source','chain','corroborator-without-first'] as const) it(`fails closed for ${contender} competition without authoritative FIRST`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-no-first-'));dirs.push(dir);
 writeFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify(rawRow('pending',completion))+'\n');
 if(contender==='raw') appendFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify(rawRow('second',arrival))+'\n');
 else if(contender==='corroborator-without-first') writeFileSync(join(dir,'reconciliation.ndjson'),JSON.stringify({source:'CHAIN',identity:'other',groupKey:group,position:'CORROBORATOR',atUtc:arrival})+'\n');
 else writeFileSync(join(dir,'source_observations.ndjson'),JSON.stringify({...sourceRow('other'),source:contender==='chain'?'CHAIN':'REST_ACTIVITY'})+'\n');
 const before=evidenceBytes(dir);const store=new RacingStore(dir);
 await expect(store.initializeIndex()).rejects.toThrow(/ambiguous.*commit order/);
 expect(evidenceBytes(dir)).toEqual(before);store.close();
});
for(const missing of [undefined,null,''] as const) it(`does not infer missing source completion (${String(missing)})`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-source-clock-'));dirs.push(dir);
 writeFileSync(join(dir,'source_observations.ndjson'),JSON.stringify({...sourceRow('legacy'),completedUtc:missing})+'\n');
 const before=evidenceBytes(dir);const store=new RacingStore(dir);
 await expect(store.initializeIndex()).rejects.toThrow(/missing.*completedUtc/);
 expect(evidenceBytes(dir)).toEqual(before);store.close();
});
it('preserves an existing FIRST and repairs competing corroborators including legacy raw with saved source',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-first-'));dirs.push(dir);
 writeFileSync(join(dir,'rest_raw.ndjson'),[rawRow('raw',completion),rawRow('legacy')].map(r=>JSON.stringify(r)).join('\n')+'\n');
 writeFileSync(join(dir,'source_observations.ndjson'),[sourceRow('source'),{...sourceRow('legacy'),source:'REST_TRADES'}].map(r=>JSON.stringify(r)).join('\n')+'\n');
 const first=JSON.stringify({source:'CHAIN',identity:'original',groupKey:group,position:'FIRST',atUtc:completion})+'\n';
 writeFileSync(join(dir,'reconciliation.ndjson'),first);
 const store=new RacingStore(dir);await store.initializeIndex();
 expect(store.reconciliation()[0]).toEqual(JSON.parse(first));
 expect(store.reconciliation().slice(1).map(r=>r.position)).toEqual(['CORROBORATOR','CORROBORATOR','CORROBORATOR']);
 expect(store.sourceIdentity('REST_TRADES','legacy')?.completedUtc).toBe(completion);
 const before=evidenceBytes(dir);store.close();const reopened=new RacingStore(dir);await reopened.initializeIndex();expect(evidenceBytes(dir)).toEqual(before);reopened.close();
});
for(const stage of ['source','position'] as const) it(`recovery itself fail-stops after ${stage} append and repairs on another reopen`,async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-recovery-fault-'));dirs.push(dir);
 writeFileSync(join(dir,'reconciliation.ndjson'),JSON.stringify({source:'CHAIN',identity:'original',groupKey:group,position:'FIRST',atUtc:arrival})+'\n');
 for(let i=0;i<256;i++)appendFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify({source:'REST_TRADES',wallet:'wallet',identity:`pending-${i}`,payload:item,sourceTs:1,firstSeenUtc:arrival,completedUtc:completion})+'\n');
 let store=new RacingStore(dir);
 const initializing=store.initializeIndex(); // first streaming yield follows 256 raw rows
 (store as any).db.exec(`CREATE TRIGGER fail_recovery BEFORE INSERT ON ${stage==='source'?'identities':'positions'} BEGIN SELECT RAISE(FAIL,'recovery fault'); END`);
 await expect(initializing).rejects.toThrow('recovery fault');
 await expect(store.initializeIndex()).rejects.toThrow(/index invalid/);
 expect(()=>new Reconciler(store).record('CHAIN','new',group,completion)).toThrow(/index invalid/);
 store.close();store=new RacingStore(dir);await store.initializeIndex();
 expect(store.identityCount('REST_TRADES')).toBe(256);
 expect(store.sourceObservations()).toHaveLength(256);expect(store.reconciliation()).toHaveLength(257);
 expect(store.reconciliation().filter(r=>r.position==='FIRST')).toHaveLength(1);
 expect(new Reconciler(store).record('CHAIN','new',group,completion)).toBe('CORROBORATOR');store.close();
});
it('yields while recovering beyond array limits and preserves an already committed FIRST',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'rest-recovery-stream-'));dirs.push(dir);
 writeFileSync(join(dir,'reconciliation.ndjson'),JSON.stringify({source:'CHAIN',identity:'original',groupKey:group,position:'FIRST',atUtc:arrival})+'\n');
 for(let i=0;i<10001;i++)appendFileSync(join(dir,'rest_raw.ndjson'),JSON.stringify({source:i%2?'REST_TRADES':'REST_ACTIVITY',wallet:'wallet',identity:`pending-${i}`,payload:item,sourceTs:1,firstSeenUtc:arrival,completedUtc:completion})+'\n');
 const store=new RacingStore(dir);let turns=0;
 const timer=setInterval(()=>turns++,0);
 try {await store.initializeIndex();} finally {clearInterval(timer);}
 expect(turns).toBeGreaterThan(1);
 expect(store.identityCount('REST_TRADES')+store.identityCount('REST_ACTIVITY')).toBe(10001);
 expect(store.hasRestPublication('REST_ACTIVITY','pending-10000')).toBe(true);
 expect(store.position(`${group}|CHAIN|original`)).toBe('FIRST');
 expect(store.position(`${group}|REST_ACTIVITY|pending-10000`)).toBe('CORROBORATOR');
 expect(()=>store.sourceObservations()).toThrow(/array view limit/);store.close();
},20000);
