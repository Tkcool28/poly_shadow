import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { ShadowStore, EvidenceIndexError, type RawLogRow, type Disposition } from '../src/shadow/storage.js';
import { ChainWatcher } from '../src/shadow/watcher.js';
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const arrival='2026-01-01T00:00:00Z';
const raw=(i:number):RawLogRow=>({chainId:137,emitter:'synthetic-unknown',txHash:'tx'+i,logIndex:0,blockNumber:i,blockHash:'fork-a',topic0:'',topics:[],data:'0x',firstSeenUtc:arrival});
function setup(){const dir=mkdtempSync(join(tmpdir(),'pending-only-'));dirs.push(dir);const store=new ShadowStore(dir);const cfg={chainId:137,watchedWallets:new Set<string>(),polygonHttpRpcUrl:'https://offline.invalid',dataDir:dir} as any;return {dir,store,cfg};}
const terminal:Disposition[]=['OBSERVED','COMPLETED_NO_OBSERVATION','TERMINAL_QUARANTINE','REMOVED_INVALID'];
function disposition(store:ShadowStore,r:RawLogRow,d:Disposition){store.appendDisposition({...r,disposition:d,atUtc:arrival});}
it('periodic replay examines only two incomplete identities among 12000 terminal rows; tombstones dominate',async()=>{
 const {store,cfg}=setup();await store.initializeIndex();
 for(let i=0;i<12000;i++){const r=raw(i);store.appendRawLog(r);disposition(store,r,terminal[i%4]!);}
 for(let i=12000;i<12003;i++){const r=raw(i);store.appendRawLog(r);disposition(store,r,'PENDING');}
 store.appendTombstone({...raw(12002),reason:'REMOVED_FLAG',removedAtUtc:arrival});
 const rows=vi.spyOn(store,'rows').mockImplementation(()=>{throw Error('periodic ledger iteration forbidden');});
 const watcher=new ChainWatcher(cfg,store,()=>arrival,async()=>{throw Error('network forbidden');});
 const queries:string[]=[];const prepare=(store as any).prepare.bind(store);
 vi.spyOn(store as any,'prepare').mockImplementation((sql:unknown)=>{queries.push(sql as string);return prepare(sql);});
 const handle=vi.spyOn(watcher,'handleLog');
 await watcher.processRetries();
 expect(handle).toHaveBeenCalledTimes(2);
 expect(handle.mock.calls.map(c=>c[0].transactionHash)).toEqual(['tx12000','tx12001']);
 expect(handle.mock.calls.every(c=>c[1]===arrival)).toBe(true);
 expect(watcher.memoryTelemetry().replayRows).toBe(2);
 await watcher.processRetries();expect(handle).toHaveBeenCalledTimes(2);expect(rows).not.toHaveBeenCalled();
 const query=queries.find(q=>q.includes('AND raw_seq>?'))!;
 const plan=(store as any).db.prepare('EXPLAIN QUERY PLAN '+query).all(-1,12003);
 expect(plan.map((r:any)=>r.detail).join(' ')).toMatch(/SEARCH identities USING INDEX incomplete_raw/);
 expect(plan.map((r:any)=>r.detail).join(' ')).not.toMatch(/TEMP B-TREE|SCAN identities/);
 const validation=queries.filter(q=>q.includes('SELECT 1 FROM identities INDEXED BY incomplete_raw'));
 expect(validation).toHaveLength(4); // start/end only, not once per payload
 for(const sql of validation) {
  const details=(store as any).db.prepare('EXPLAIN QUERY PLAN '+sql).all(12003,12003).map((r:any)=>r.detail).join(' ');
  expect(details).toMatch(/SCAN identities USING INDEX incomplete_raw/);
  expect(details).not.toMatch(/TEMP B-TREE|SCAN identities(?:$|\s+(?!USING INDEX incomplete_raw))/);
  expect(sql).toMatch(/LIMIT 1/);
 }
 expect(queries.filter(q=>q.includes('AND raw_seq>?'))).toHaveLength(4);
 store.close();
},30000);
it('restart rebuild recovers legacy and pending exactly once with exact first raw payload and arrival',async()=>{
 const {dir,store,cfg}=setup();const first=raw(1);store.appendRawLog(first);
 store.appendRawLog({...first,data:'later duplicate',firstSeenUtc:'2026-01-02T00:00:00Z'});disposition(store,first,'PENDING');
 store.appendRawLog(raw(2));store.close();
 let reopened=new ShadowStore(dir);await reopened.initializeIndex();
 const watcher=new ChainWatcher(cfg,reopened);const handle=vi.spyOn(watcher,'handleLog');
 vi.spyOn(reopened,'rows').mockImplementation(()=>{throw Error('periodic ledger iteration forbidden');});
 expect(await watcher.replayIncompleteFromStore()).toBe(2);
 expect(handle.mock.calls[0]![0].data).toBe(first.data);expect(handle.mock.calls[0]![1]).toBe(arrival);
 const before=statSync(join(dir,'dispositions.ndjson')).size;reopened.close();
 reopened=new ShadowStore(dir);expect(await new ChainWatcher(cfg,reopened).replayIncompleteFromStore()).toBe(0);
 expect(statSync(join(dir,'dispositions.ndjson')).size).toBe(before);reopened.close();
});
it('repeated pending publication failures do not amplify PENDING rows',async()=>{
 const {dir,store,cfg}=setup();await store.initializeIndex();const r=raw(1);store.appendRawLog(r);disposition(store,r,'PENDING');
 const obs={eventId:'event',role:'MAKER_LEG',wallet:'wallet',side:'BUY',tokenId:'1',shares:'1',price10:'1',feeUnits:'0',blockTimestamp:1,source:'CHAIN',sourceFirstSeenUtc:arrival,firstSeenUtc:arrival,evidence:r} as const;
 store.appendObservation(obs);
 const watcher=new ChainWatcher(cfg,store,()=>arrival,async()=>{throw Error('network forbidden');},()=>{throw Error('publication retry');});
 const before=statSync(join(dir,'dispositions.ndjson')).size;
 for(let i=0;i<5;i++)expect(await watcher.replayIncompleteFromStore()).toBe(1);
 expect(statSync(join(dir,'dispositions.ndjson')).size).toBe(before);store.close();
});
it('a missing pending raw row or lost SQLite index fails closed without ledger fallback',async()=>{
 for(const missing of ['raw','index']) {
  const {store,cfg}=setup();await store.initializeIndex();
  if(missing==='index')store.appendRawLog(raw(1));
  disposition(store,raw(1),'PENDING');
  if(missing==='index')(store as any).db.exec('DROP INDEX incomplete_raw');
  const rows=vi.spyOn(store,'rows').mockImplementation(()=>{throw Error('ledger fallback forbidden');});
  await expect(new ChainWatcher(cfg,store).processRetries()).rejects.toBeInstanceOf(EvidenceIndexError);
  expect(rows).not.toHaveBeenCalled();expect(store.indexTelemetry().indexInvalid).toBe(true);store.close();
 }
});
it('one pass does not chase new pending identities appended during an await',async()=>{
 const {store,cfg}=setup();await store.initializeIndex();store.appendRawLog(raw(1));disposition(store,raw(1),'PENDING');
 const watcher=new ChainWatcher(cfg,store);let added=false;
 const original=watcher.handleLog.bind(watcher);
 vi.spyOn(watcher,'handleLog').mockImplementation(async(log,arrived)=>{
  if(!added){added=true;store.appendRawLog(raw(2));disposition(store,raw(2),'PENDING');}
  await original(log,arrived);
 });
 expect(await watcher.replayIncompleteFromStore()).toBe(1);
 expect(await watcher.replayIncompleteFromStore()).toBe(1);
 expect(await watcher.replayIncompleteFromStore()).toBe(0);store.close();
});
for(const mutation of ['raw_row=NULL','raw_row=\'{}\'','arrival=NULL','raw_digest=NULL','raw_seq=0','last_raw_seq=0','raw=0','raw_seq=-2','raw_seq=2','raw_seq=1.5',"raw_seq='bad'",'raw_seq=9007199254740992','last_raw_seq=2','last_raw_seq=1.5',"last_raw_seq='bad'"])it(`missing/corrupt pending metadata ${mutation} fails closed and latches`,async()=>{
 const {store,cfg}=setup();await store.initializeIndex();store.appendRawLog(raw(1));disposition(store,raw(1),'PENDING');
 (store as any).db.exec(`UPDATE identities SET ${mutation}`);
 const watcher=new ChainWatcher(cfg,store);const handle=vi.spyOn(watcher,'handleLog');
 await expect(watcher.replayIncompleteFromStore()).rejects.toBeInstanceOf(EvidenceIndexError);
 expect(handle).not.toHaveBeenCalled();expect(store.indexTelemetry().indexInvalid).toBe(true);
 await expect(watcher.processRetries()).rejects.toBeInstanceOf(EvidenceIndexError);store.close();
 await expect(store.initializeIndex()).rejects.toBeInstanceOf(EvidenceIndexError);
});
it('pending positions corrupted beyond the snapshot during an await fail closed at pass end',async()=>{
 const {store,cfg}=setup();await store.initializeIndex();store.appendRawLog(raw(1));disposition(store,raw(1),'PENDING');
 const watcher=new ChainWatcher(cfg,store);const original=watcher.handleLog.bind(watcher);
 vi.spyOn(watcher,'handleLog').mockImplementation(async(log,arrived)=>{
  await original(log,arrived);
  store.appendRawLog(raw(2));disposition(store,raw(2),'PENDING');
  (store as any).db.exec("UPDATE identities SET raw_seq=3 WHERE disposition='PENDING'");
 });
 await expect(watcher.replayIncompleteFromStore()).rejects.toBeInstanceOf(EvidenceIndexError);
 expect(store.indexTelemetry().indexInvalid).toBe(true);
 store.close();await expect(store.initializeIndex()).rejects.toBeInstanceOf(EvidenceIndexError);
});
it('a duplicate appended during an await may advance last position past the frozen snapshot',async()=>{
 const {store}=setup();await store.initializeIndex();store.appendRawLog(raw(1));disposition(store,raw(1),'PENDING');
 const pass=store.incompleteRawLogs();expect(pass.next().value).toEqual(raw(1));
 store.appendRawLog({...raw(1),firstSeenUtc:'2026-01-02T00:00:00Z'});
 expect(pass.next().done).toBe(true);expect(store.indexTelemetry().indexInvalid).toBe(false);
 expect([...store.incompleteRawLogs()]).toEqual([raw(1)]);store.close();
});
it('the real schema rejects null append positions without silently excluding pending evidence',async()=>{
 const {store}=setup();await store.initializeIndex();store.appendRawLog(raw(1));disposition(store,raw(1),'PENDING');
 for(const column of ['raw_seq','last_raw_seq'])expect(()=>(store as any).db.exec(`UPDATE identities SET ${column}=NULL`)).toThrow(/NOT NULL/);
 expect([...store.incompleteRawLogs()]).toEqual([raw(1)]);store.close();
});
