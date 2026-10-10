import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { sealPoly2Archive, validatePoly2Archive, type ArchiveInput } from '../src/compare/poly2-archive.js';
import { canonical, digest, inventory, type Snapshot, type CaptureReceipt } from '../src/compare/poly2-snapshot.js';
import { fixtureArchive } from './poly2-fixtures.js';
import { validatePoly2Export } from '../src/compare/phase4.js';

const window = {startUtc:'2026-01-01T00:00:00.000Z',endUtc:'2026-01-02T00:00:00.000Z'};
const cohort = Array.from({length:5},(_,i) => '0x'+String(i+1).padStart(40,'0'));
const tx = '0x'+'a'.repeat(64);
const eventId = `data-api:${tx}:${cohort[0]}:7:1:0.5:1767225600`;
function input(): ArchiveInput {
  const snapshot: Snapshot = {schemaVersion:1,kind:'historical-table-copy',snapshotIdentity:'synthetic:native-copy',asOfUtc:window.endUtc,tables:{
    wallets:cohort.map((address,i) => ({id:i+1,address,approval_state:'disabled',approved_at:null})),
    markets:[{id:1,condition_id:'condition-original'}],
    trades:[{id:19,polymarket_trade_id:eventId,wallet_id:1,market_id:1,asset_id:'7',side:'BUY',size:'1.000000',price:'0.500000',traded_at:window.startUtc,ingested_at:'2026-01-01T00:00:02.123Z'}],
    signals:[{id:11,source_trade_id:eventId,created_at:'2026-01-01T00:00:03.456Z',t1_detected_at:'2026-01-01T00:00:02.123Z',status:'skipped'}],
    paper_orders:[{id:12,signal_id:11,created_at:'2026-01-01T00:00:05.789Z',t2_decided_at:'2026-01-01T00:00:05.789Z',status:'missed',miss_reason:'stale_signal'}],
  }};
  const captureReceipt: CaptureReceipt = {schemaVersion:1,snapshotIdentity:snapshot.snapshotIdentity,transactionIdentity:'synthetic:end-txn',asOfUtc:window.endUtc,capturedUtc:window.endUtc,scope:'FULL_TABLES_UNFILTERED',inventory:inventory(snapshot)};
  return {runId:'fixture-run',shadowRunId:'fixture-shadow',poly2CodeSha:'a'.repeat(40),exportToolSha256:'b'.repeat(64),cohort,window,snapshot,captureReceipt};
}
function recapture(i: ArchiveInput) { i.captureReceipt.inventory = inventory(i.snapshot); return i; }
const dirs: string[] = [];
function dir() { const d=mkdtempSync(join(process.env.TMPDIR ?? '/root/.hermes/cache/scratch','poly2-offline-')); dirs.push(d); return d; }
afterEach(() => dirs.splice(0).forEach(d => rmSync(d,{recursive:true,force:true})));
function run(script:string,args:string[]) { return execFileSync(process.execPath,['--import','tsx',`src/compare/${script}.ts`,...args],{encoding:'utf8',stdio:'pipe'}); }

describe('Poly2 auditable offline archive',()=>{
  it('proves full 24h five-wallet population with low timestamp max, not timestamp inference',()=>{
    const a=sealPoly2Archive(input()); expect(a.rows).toHaveLength(1); expect(a.manifest.maxTimestampUtc).toBe('2026-01-01T00:00:02.123Z');
    expect(validatePoly2Archive(a,cohort,window)).toEqual(a); expect(validatePoly2Export(a)).toBe(a);
    expect(a.manifest.completenessScope).toBe('POLY2_RECORDS_AT_FROZEN_END_NOT_UPSTREAM_REST');
    expect(a.manifest.sourceTables).toEqual(['markets','paper_orders','signals','trades','wallets']);
  });
  it('preserves native stable identities and original clocks; does not reinterpret detection as normalization',()=>{
    const r=sealPoly2Archive(input()).rows[0]! as unknown as Record<string,unknown>;
    expect(r).toMatchObject({sourceRecordId:19,sourceEventId:eventId,txHash:tx,signalRecordId:11,paperRecordId:12,ingestedUtc:'2026-01-01T00:00:02.123Z',signalUtc:'2026-01-01T00:00:03.456Z',decisionUtc:'2026-01-01T00:00:05.789Z',normalizedUtc:null,policyEligible:null,freshnessAgeSec:null,freshnessRejection:'stale_signal',paperOutcome:'missed'});
  });
  it.each(['asOfUtc','capturedUtc'] as const)('rejects prefix capture %s even when declared window/watermark reaches end',field=>{
    const i=input(); i.captureReceipt[field]='2026-01-01T23:59:59.000Z'; expect(()=>sealPoly2Archive(i)).toThrow(/prefix|frozen-end/);
  });
  it('rejects self-asserted watermark and missing population proof',()=>{
    expect(()=>validatePoly2Archive({window,rows:[],manifest:{schemaVersion:2,archiveWatermarkUtc:window.endUtc}},cohort,window)).toThrow(/watermark insufficient/);
    const i=input(); delete i.snapshot.tables.signals; expect(()=>sealPoly2Archive(i)).toThrow(/inventory/);
  });
  it('rejects prefix population deletion even with high max and end capture claim',()=>{
    const i=input(); i.snapshot.tables.trades=[]; expect(()=>sealPoly2Archive(i)).toThrow(/inventory/);
  });
  it('rejects stale receipt count, identity and table byte digests',()=>{
    for (const change of [(i:ArchiveInput)=>{i.captureReceipt.inventory.trades!.count=9;},(i:ArchiveInput)=>{i.captureReceipt.inventory.trades!.ids=[8];},(i:ArchiveInput)=>{i.snapshot.tables.trades![0]!.price='0.9';}]) {const i=input();change(i);expect(()=>sealPoly2Archive(i)).toThrow(/inventory/);}
  });
  it('rejects later-state copy and later decision facts rather than backfilling history',()=>{
    const i=input(); i.snapshot.asOfUtc='2026-01-03T00:00:00.000Z';expect(()=>sealPoly2Archive(i)).toThrow(/later-state/);
    const j=input();j.snapshot.tables.paper_orders![0]!.t2_decided_at='2026-01-03T00:00:00.000Z';expect(()=>sealPoly2Archive(recapture(j))).toThrow(/point-in-time/);
  });
  it('no policy hindsight: current approval/price config cannot create eligibility or fake freshness age',()=>{
    const i=input();i.snapshot.tables.wallets![0]!.approval_state='approved';i.snapshot.tables.wallets![0]!.approved_at=window.startUtc;
    expect(sealPoly2Archive(recapture(i)).rows).toEqual(sealPoly2Archive(input()).rows);
  });
  it('fails explicitly on missing historical mandatory fields and ambiguous joins',()=>{
    for (const change of [(i:ArchiveInput)=>{delete i.snapshot.tables.trades![0]!.ingested_at;},(i:ArchiveInput)=>{i.snapshot.tables.wallets=[];},(i:ArchiveInput)=>{i.snapshot.tables.paper_orders!.push({...i.snapshot.tables.paper_orders![0]!,id:99});}]) {const i=input();change(i);expect(()=>sealPoly2Archive(recapture(i))).toThrow(/missing|UTC|ambiguous/);}
  });
  it('filters exact cohort and inclusive interval while preserving full unfiltered inventory',()=>{
    const i=input(), t=i.snapshot.tables.trades![0]!;
    i.snapshot.tables.wallets!.push({id:6,address:'0x'+'9'.repeat(40)});
    i.snapshot.tables.trades!.push({...t,id:20,polymarket_trade_id:'native:boundary',ingested_at:window.endUtc},{...t,id:21,polymarket_trade_id:'native:before',ingested_at:'2025-12-31T23:59:59.999Z'},{...t,id:22,polymarket_trade_id:'native:after',ingested_at:'2026-01-02T00:00:00.001Z'},{...t,id:23,polymarket_trade_id:'native:other',wallet_id:6});
    const a=sealPoly2Archive(recapture(i));expect(a.rows.map(r=>(r as unknown as Record<string,unknown>).sourceRecordId)).toEqual([19,20]);expect(a.evidence.captureReceipt.inventory.trades!.count).toBe(5);
  });
  it('deterministic hashes independent of table row ordering; replay detects output/metadata/cohort mutations',()=>{
    const i=input(), a=sealPoly2Archive(i);i.snapshot.tables.wallets!.reverse();expect(canonical(sealPoly2Archive(i))).toBe(canonical(a));
    for (const change of [(a:ReturnType<typeof sealPoly2Archive>)=>{a.rows=[];},(a:ReturnType<typeof sealPoly2Archive>)=>{a.manifest.minTimestampUtc=window.endUtc;},(a:ReturnType<typeof sealPoly2Archive>)=>{a.manifest.runId='';}]) {const b=structuredClone(a);change(b);expect(()=>validatePoly2Archive(b,cohort,window)).toThrow();}
    expect(()=>validatePoly2Archive(a,cohort.slice(1),window)).toThrow(/cohort|digest/);
  });
  it('prospective checkpoints are inspectable inventory, but only final exact end snapshot seals',()=>{
    const i=input();i.snapshot.asOfUtc='2026-01-01T12:00:00.000Z';i.captureReceipt.asOfUtc=i.snapshot.asOfUtc;
    expect(inventory(i.snapshot).trades!.count).toBe(1);expect(()=>sealPoly2Archive(i)).toThrow(/prefix/);
    expect(()=>sealPoly2Archive(input())).not.toThrow();
  });
  it('CLI writes deterministic new files only, retains source bytes, and both offline export schemas reach frozen comparator',()=>{
    const d=dir(), i=input();
    writeFileSync(join(d,'snapshot.json'),JSON.stringify(i.snapshot));writeFileSync(join(d,'receipt.json'),JSON.stringify(i.captureReceipt));
    writeFileSync(join(d,'config.json'),JSON.stringify({...i,controlled:cohort}));
    const paths=['snapshot.json','receipt.json','config.json'].map(p=>join(d,p)); const before=paths.map(p=>readFileSync(p));
    const report=JSON.parse(run('poly2-export-cli',[...paths,join(d,'native.json')]));
    run('poly2-export-cli',[...paths,join(d,'native-again.json')]);expect(readFileSync(join(d,'native.json'))).toEqual(readFileSync(join(d,'native-again.json')));
    expect(report.rowCount).toBe(1);expect(report.outputSha256).toMatch(/^[a-f0-9]{64}$/);expect(paths.map(p=>readFileSync(p))).toEqual(before);
    expect(()=>run('poly2-export-cli',[...paths,join(d,'native.json')])).toThrow();
    const a=JSON.parse(readFileSync(join(d,'native.json'),'utf8'));const f=fixtureArchive(a.rows,window,cohort);
    writeFileSync(join(d,'fixture.json'),canonical(f));writeFileSync(join(d,'cohorts.json'),JSON.stringify({window,controlled:cohort}));
    writeFileSync(join(d,'source_observations.ndjson'),JSON.stringify({source:'REST_TRADES',identity:'original-shadow-id',wallet:cohort[0],side:'BUY',asset:'7',size:'1.000000',price:'0.5',sourceTs:1767225600,blockTimestamp:null,sourceFirstSeenUtc:window.startUtc,completedUtc:'2026-01-01T00:00:00.500Z',role:'UNKNOWN',groupKey:`econ:${tx}:7:1.000000`,hydration:'FULL'})+'\n');
    run('cli',[d,join(d,'native.json'),join(d,'cohorts.json'),d]);
    const result=JSON.parse(readFileSync(join(d,'comparison.json'),'utf8'));
    expect(result.coverage.matched).toBe(1);expect(result.raw.n).toBe(1);expect(result.raw.median).toBe(2.123);expect(result.usable.median).toBe(5.289);
    const productionOutput=readFileSync(join(d,'comparison.json'));let cliError:unknown;
    try{run('cli',[d,join(d,'fixture.json'),join(d,'cohorts.json'),d]);}catch(error){cliError=error;}
    expect(cliError).toBeInstanceOf(Error);
    expect(String((cliError as {stderr?:unknown}).stderr)).toContain('synthetic comparator fixtures are not production authority');
    expect(readFileSync(join(d,'comparison.json'))).toEqual(productionOutput);
  });
  it('accepts equivalent inclusive end rendering without changing original timestamp',()=>{
    const i=input();i.snapshot.tables.trades![0]!.ingested_at='2026-01-02T00:00:00Z';
    const a=sealPoly2Archive(recapture(i));
    expect(a.rows[0]!.ingestedUtc).toBe('2026-01-02T00:00:00Z');
    expect(a.evidence.clockAudit[1]!.ingestedUtc!.epochMicros).toBe('1767312000000000');
  });
  it('preserves unsupported native IDs without inventing tx hashes and rejects malformed data-api IDs',()=>{
    const i=input();i.snapshot.tables.trades![0]!.polymarket_trade_id='legacy-original:exact-ID';
    expect(sealPoly2Archive(recapture(i)).rows[0]).toMatchObject({sourceEventId:'legacy-original:exact-ID',txHash:null,normalizedUtc:null});
    const j=input();j.snapshot.tables.trades![0]!.polymarket_trade_id='data-api:truncated';expect(()=>sealPoly2Archive(recapture(j))).toThrow(/malformed/);
  });
  it('CLI rejects production aliases before reads and leaves no export on invalid capture',()=>{
    const d=dir();symlinkSync('/opt/poly2',join(d,'production'));
    expect(()=>run('poly2-export-cli',[join(d,'production/backend/no-snapshot.json'),'x','y',join(d,'bad.json')])).toThrow();
    const i=input();i.captureReceipt.inventory.trades!.count=0;
    for (const [name,value] of [['snapshot',i.snapshot],['receipt',i.captureReceipt],['config',{...i,controlled:cohort}]]) writeFileSync(join(d,name+'.json'),JSON.stringify(value));
    expect(()=>run('poly2-export-cli',['snapshot','receipt','config'].map(p=>join(d,p+'.json')).concat(join(d,'bad.json')))).toThrow();
    expect(()=>readFileSync(join(d,'bad.json'))).toThrow();
  });
});
