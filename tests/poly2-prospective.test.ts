import { afterEach, describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { canonical, digest } from '../src/compare/poly2-snapshot.js';
import { JOURNAL, ProspectiveCapture, type Binding, type SourceFrame, type TradeFact, type IO } from '../src/compare/poly2-prospective.js';
import { buildShadowGroups, compare } from '../src/compare/phase4.js';
import type { SourceObservationRow } from '../src/shadow/racing.js';
const root = process.env['TMPDIR'] ?? '/root/.hermes/cache/scratch';
const dirs: string[] = [];
const dir = () => { const d = mkdtempSync(join(root, 'prospective-capture-test-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const cohort = ['a','b','c','d','e'].map(c => '0x' + c.repeat(40));
const window = { startUtc: '2026-01-01T00:00:00.000Z', endUtc: '2026-01-02T00:00:00.000Z' };
const binding = (): Binding => ({runId:'synthetic-capture',shadowRunId:'synthetic-shadow',poly2CodeSha:'a'.repeat(40),componentSha256:'b'.repeat(64),cohort,window,evidenceKind:'synthetic',sourcePublicKey:null});
const tx = '0x' + '1'.repeat(64);
function trade(over: Partial<TradeFact> = {}): TradeFact {
  return {sourceRecordId:1,sourceEventId:`data-api:${tx}:${cohort[0]}:7:100:0.5:1767261600`, wallet:cohort[0]!, asset:'7', conditionId:'market', side:'BUY',size:100,tradedAtUtc:'2026-01-01T10:00:00.000Z',sourceTs:Date.parse('2026-01-01T10:00:00.000Z')/1000,ingestedUtc:'2026-01-01T10:00:10.000Z',...over};
}
function frame(b: Binding, cursor: number, kind: SourceFrame['kind'], over: Partial<SourceFrame> = {}): SourceFrame {
  return {version:1,bindingSha256:digest(b),cursor,previousCursor:cursor-1,transactionId:`synthetic-tx-${cursor}`, observedUtc:kind === 'ACTIVATION' ? window.startUtc : kind === 'END_FENCE' ? window.endUtc : '2026-01-01T10:00:21.000Z',kind,trades:[],decisions:[],commitBeforeUtc:kind === 'COMMIT' ? '2026-01-01T10:00:19.000Z' : null,commitAfterUtc:kind === 'COMMIT' ? '2026-01-01T10:00:21.000Z' : null,fence:kind === 'END_FENCE' ? {protocol:'all-writers-transaction-drain-v1',registeredWriters:['ingestion','execution'],outstandingTransactions:0,unresolvedFailures:0,throughCursor:cursor-1} : null,signature:null,...over};
}
function active(io?: IO) { const b = binding(), d=dir(), c=new ProspectiveCapture(d,b,io); c.accept(frame(b,1,'ACTIVATION')); return {b,d,c}; }
function complete() { const x=active(); x.c.accept(frame(x.b,2,'COMMIT',{trades:[trade()],decisions:[{sourceEventId:trade().sourceEventId,paperRecordId:2,decisionUtc:'2026-01-01T10:00:20.000Z',rejectionReason:'stale_signal',sourceIngestedUtc:trade().ingestedUtc}]})); x.c.accept(frame(x.b,3,'END_FENCE')); return x; }
const plainIO: IO = {append(p,s){appendFileSync(p,s);},publish(p,s){writeFileSync(p,s);}};

describe('prospective capture authority / frozen mechanical map', () => {
  it('prospective original microsecond/offset endpoints survive journal restart and archive replay', () => {
    const {b,c,d}=active();
    const clocks=['2025-12-31T23:59:59.999999Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00.000001Z','2026-01-01T23:59:59.999999Z','2026-01-02T01:00:00+01:00','2026-01-02T00:00:00.000001Z'];
    c.accept(frame(b,2,'COMMIT',{trades:clocks.map((ingestedUtc,i)=>trade({sourceRecordId:i+1,sourceEventId:'original:'+i,ingestedUtc}))}));
    c.accept(frame(b,3,'END_FENCE'));
    const a=c.seal();
    expect(a.rows.map(r=>r.ingestedUtc)).toEqual(clocks.slice(1,5));
    expect(a.evidence.clockAudit.some(x=>x.ingestedUtc?.original===clocks[2] && x.ingestedUtc?.epochMicros==='1767225600000001')).toBe(true);
    expect(new ProspectiveCapture(d,b).seal()).toEqual(a);
    expect(ProspectiveCapture.validate(a,cohort,window,true)).toEqual(a);
    const tampered=structuredClone(a); tampered.evidence.clockAudit[0]!.startUtc!.epochMicros='0';
    expect(()=>ProspectiveCapture.validate(tampered,cohort,window,true)).toThrow(/replay/);
  });

  it('actual Python source hook -> locked worker -> sealed offline archive -> unchanged scientific comparator', () => {
    const d=dir();
    execFileSync('python3',['tests/poly2_prospective_capture_test.py','--fixture',d],{cwd:process.cwd()});
    execFileSync('python3',['scripts/poly2-comparison-capture-worker.py',join(d,'binding.json'),join(d,'source'),join(d,'capture'),'--archive',join(d,'sealed.json')],{cwd:process.cwd()});
    const a=ProspectiveCapture.validate(JSON.parse(readFileSync(join(d,'sealed.json'),'utf8')),cohort,window,true);
    const o: SourceObservationRow={source:'REST_TRADES',identity:'synthetic-source-first',wallet:cohort[0]!,side:'BUY',asset:'7',size:'100.000000',price:'0.5',sourceTs:trade().sourceTs,blockTimestamp:null,sourceFirstSeenUtc:'2026-01-01T10:00:00.000Z',completedUtc:'2026-01-01T10:00:05.000Z',role:'UNKNOWN',groupKey:`econ:${tx}:7:100.000000`,hydration:'FULL'};
    const of=(w:string)=>cohort.includes(w) ? 'CONTROLLED_OVERLAP' as const : null;
    const r=compare(a,buildShadowGroups([o],of,window),window,of);
    expect(r.coverage.matched).toBe(1);expect(r.records[0]?.rawDeltaSec).toBe(10);expect(r.records[0]?.usableDeltaSec).toBe(15);expect(r.policy.staleRejected).toBe(1);
    const source=readFileSync(join(d,'source/poly2_source_receipts.ndjson'),'utf8');
    expect(a.evidence.journal).toContain('END_FENCE');expect(source).toContain('throughCursor');
    const out=join(d,'must-not-compare');
    writeFileSync(join(d,'cohorts.json'),JSON.stringify({window,controlled:cohort}));
    let errorText='';
    try { execFileSync('node',['--import','tsx','src/compare/cli.ts',join(d,'empty-shadow'),join(d,'sealed.json'),join(d,'cohorts.json'),out],{cwd:process.cwd(),stdio:'pipe'}); }
    catch (error) { errorText=String((error as {stderr:Buffer}).stderr); }
    expect(errorText).toContain('synthetic receipts are not producer proof');expect(existsSync(out)).toBe(false);
  });
  it('ARMED ACTIVE SEALED, minimal schema, exact match/raw/usable/coverage/policy without outcome hindsight', () => {
    const {b,c}=complete(), a=c.seal();
    expect(a.manifest.rowCount).toBe(1); expect(a.manifest.sourceCursor).toBe(3);
    expect(a.rows[0]).toMatchObject({normalizedUtc:null,signalUtc:null,policyEligible:null,paperOutcome:null,copyabilityOutcome:null,price:null,sourceRecordId:1});
    const o: SourceObservationRow={source:'REST_TRADES',identity:'synthetic-shadow',wallet:cohort[0]!,side:'BUY',asset:'7',size:'100.000000',price:'0.5',sourceTs:trade().sourceTs,blockTimestamp:null,sourceFirstSeenUtc:'2026-01-01T10:00:00.000Z',completedUtc:'2026-01-01T10:00:05.000Z',role:'UNKNOWN',groupKey:`econ:${tx}:7:100.000000`,hydration:'FULL'};
    const cohortOf=(w:string)=>b.cohort.includes(w) ? 'CONTROLLED_OVERLAP' as const : null;
    const result=compare(a,buildShadowGroups([o],cohortOf,window),window,cohortOf);
    expect(result.records[0]).toMatchObject({match:'MATCHED_HIGH_CONFIDENCE',rawDeltaSec:10,usableDeltaSec:15,decision:'EARLIER_BUT_POLICY_INELIGIBLE'});
    expect(result.coverage).toEqual({matched:1,shadowOnly:0,poly2Only:0,ambiguous:0,shadowUnionCoveragePct:1,poly2UnionCoveragePct:1});
    expect(result.policy).toEqual({staleRejected:1,staleRejectedShadowSawWithin300s:1,rejectionReasons:{stale_signal:1}});
    expect(ProspectiveCapture.validate(a,cohort,window,true)).toEqual(a);
    expect(()=>ProspectiveCapture.validate(a,cohort,window)).toThrow('synthetic receipts are not producer proof');
  });
  it('idempotent duplicate / restart / cursor cache before journal durability ignored',()=>{
    const {b,d,c}=complete(); const a=c.seal();
    writeFileSync(join(d,'poly2_capture_cursor.json'),canonical({cursor:999,journalSha256:'forged'}));
    const resumed=new ProspectiveCapture(d,b); expect(resumed.health()).toMatchObject({state:'SEALED',cursor:3,count:1});
    expect(resumed.accept(frame(b,1,'ACTIVATION'))).toBe(false); expect(resumed.seal()).toEqual(a);
    expect(JSON.parse(readFileSync(join(d,'poly2_capture_cursor.json'),'utf8')).cursor).toBe(3);
    expect(()=>resumed.accept(frame(b,4,'COMMIT'))).toThrow('after sealed fence');
  });
  it('outwindow / noncohort stay in source journal but do not enter metric rows; original clocks preserved',()=>{
    const {b,c}=active(); const t=trade();
    c.accept(frame(b,2,'COMMIT',{trades:[t,trade({sourceRecordId:3,sourceEventId:'other:3',ingestedUtc:'2025-12-31T23:59:59.000Z'}),trade({sourceRecordId:4,sourceEventId:'other:4',wallet:'0x'+'f'.repeat(40)})]}));
    c.accept(frame(b,3,'END_FENCE')); const a=c.seal(); expect(a.rows).toHaveLength(1); expect(a.rows[0]?.ingestedUtc).toBe(t.ingestedUtc); expect(a.evidence.journal).toContain('other:4');
  });
  it('late persisted in-window ingestion and postend committed original decision included',()=>{
    const {b,c}=active(); const t=trade({ingestedUtc:window.endUtc});
    c.accept(frame(b,2,'COMMIT',{observedUtc:'2026-01-02T00:00:03.000Z',commitBeforeUtc:'2026-01-02T00:00:01.000Z',commitAfterUtc:'2026-01-02T00:00:02.000Z',trades:[t],decisions:[{sourceEventId:t.sourceEventId,paperRecordId:2,decisionUtc:'2026-01-01T23:59:59.000Z',rejectionReason:'stale_signal',sourceIngestedUtc:t.ingestedUtc}]}));
    expect(()=>c.seal()).toThrow('incomplete'); c.accept(frame(b,3,'END_FENCE',{observedUtc:'2026-01-02T00:00:04.000Z'}));
    expect(c.seal().rows[0]).toMatchObject({ingestedUtc:window.endUtc,decisionUtc:'2026-01-01T23:59:59.000Z',rejectionReason:'stale_signal'});
  });
  it.each([
    ['late activation',(b:Binding)=>frame(b,1,'ACTIVATION',{observedUtc:'2026-01-01T00:00:00.001Z'})],
    ['missing activation',(b:Binding)=>frame(b,1,'COMMIT')],
    ['malformed cursor',(b:Binding)=>frame(b,2,'COMMIT')],
    ['malformed original clock',(b:Binding)=>frame(b,1,'ACTIVATION',{observedUtc:'invalid'})],
  ] as const)('%s fails visibly',(_label,make)=>{
    const b=binding(), c=new ProspectiveCapture(dir(),b); expect(()=>c.accept(make(b))).toThrow(); expect(c.health()).toMatchObject({quality:'AT_RISK',failures:1,cursor:0}); expect(()=>c.seal()).toThrow();
  });
  it.each(['missing fence','pending transaction','failed source','early end','cursor mismatch','unregistered writer'])('%s cannot become end coverage', kind=>{
    const {b,c}=active(), f=frame(b,2,'END_FENCE');
    if(kind==='missing fence') f.fence=null;
    if(kind==='pending transaction') f.fence!.outstandingTransactions=1;
    if(kind==='failed source') f.fence!.unresolvedFailures=1;
    if(kind==='early end') f.observedUtc=window.startUtc;
    if(kind==='cursor mismatch') f.fence!.throughCursor=777;
    if(kind==='unregistered writer') f.fence!.registeredWriters=['ingestion'];
    expect(()=>c.accept(f)).toThrow(); expect(c.health().endCoverage).toBe(false); expect(()=>c.seal()).toThrow();
  });
  it('decision commit straddle is not scientific exclusion; irrelevant straddle does not poison',()=>{
    const {b,c}=active(), t=trade();
    c.accept(frame(b,2,'COMMIT',{trades:[t],decisions:[{sourceEventId:t.sourceEventId,paperRecordId:2,decisionUtc:window.endUtc,rejectionReason:null,sourceIngestedUtc:t.ingestedUtc},{sourceEventId:'irrelevant',paperRecordId:3,decisionUtc:null,rejectionReason:null,sourceIngestedUtc:'2025-12-31T23:59:59.000Z'}],commitBeforeUtc:'2026-01-01T23:59:59.999Z',commitAfterUtc:'2026-01-02T00:00:00.001Z',observedUtc:'2026-01-02T00:00:00.001Z'}));
    expect(c.health().gaps).toEqual([]); expect(c.rows()[0]?.decisionUtc).toBe(window.endUtc);
  });
  it('unresolved source gap survives restart and source MAX is never coverage',()=>{
    const {b,d,c}=complete(); c.gap('source-lost','uncaptured commit');
    const r=new ProspectiveCapture(d,b); expect(r.health().gaps).toEqual(['source-lost']); expect(r.health().endCoverage).toBe(false); expect(()=>r.seal()).toThrow('incomplete');
    expect(()=>r.resolveCursorPublication('source-lost',[2])).toThrow('independently reviewed');
  });
  it('conflicting duplicate rows and duplicate transaction ordering reject rather than mutate identity',()=>{
    const {b,c}=active(); c.accept(frame(b,2,'COMMIT',{trades:[trade()]}));
    expect(()=>c.accept(frame(b,2,'COMMIT',{trades:[trade({size:101})]}))).toThrow('conflicting replay');
    expect(()=>c.accept(frame(b,3,'COMMIT',{transactionId:'synthetic-tx-2'}))).toThrow('duplicate transaction');
    expect(c.rows()[0]?.size).toBe(100);
  });
  it.each(['before-append','post-append','partial-append','cursor-publication'])('actual %s failure latches; no cursor ahead of durable append; restart replay exact once',kind=>{
    let armed=false; const error=new Error(kind); const d=dir(), b=binding();
    const io:IO={append(p,s){ if(armed){ if(kind==='post-append')appendFileSync(p,s); if(kind==='partial-append')appendFileSync(p,s.slice(0,20)); if(kind!=='cursor-publication')throw error; } plainIO.append(p,s); },publish(p,s){if(armed&&kind==='cursor-publication'&&p.endsWith('poly2_capture_cursor.json'))throw error;plainIO.publish(p,s);}};
    const c=new ProspectiveCapture(d,b,io); c.accept(frame(b,1,'ACTIVATION')); const before=readFileSync(join(d,JOURNAL),'utf8'); armed=true;
    expect(()=>c.accept(frame(b,2,'COMMIT',{trades:[trade()]}))).toThrow(error); expect(c.health()).toMatchObject({state:'FAILED',quality:'AT_RISK'}); expect(()=>c.accept(frame(b,3,'END_FENCE'))).toThrow();
    const bytes=readFileSync(join(d,JOURNAL),'utf8');
    if(kind==='before-append') expect(bytes).toBe(before);
    if(kind==='partial-append'){expect(()=>new ProspectiveCapture(d,b)).toThrow('torn journal');return;}
    const resumed=new ProspectiveCapture(d,b); resumed.accept(frame(b,2,'COMMIT',{trades:[trade()]})); expect(resumed.health()).toMatchObject({cursor:2,count:1});
    resumed.accept(frame(b,3,'END_FENCE')); expect(resumed.seal().manifest.rowCount).toBe(1);
  });
  it('archive tampering, cohort/run/window mutation and journal torn tail reject',()=>{
    const {b,d,c}=complete(), a=c.seal();
    for(const mutate of [(x:typeof a)=>{x.rows.pop();},(x:typeof a)=>{x.manifest.rowCount++;},(x:typeof a)=>{x.manifest.binding.runId='other';},(x:typeof a)=>{x.evidence.journal=x.evidence.journal.slice(0,-1);}]){
      const x=structuredClone(a);mutate(x);expect(()=>ProspectiveCapture.validate(x,cohort,window,true)).toThrow();
    }
    expect(()=>new ProspectiveCapture(d,{...b,shadowRunId:'other'})).toThrow('binding mismatch');
    expect(()=>ProspectiveCapture.validate(a,cohort.slice(1),window,true)).toThrow();
  });
  it.each(['missing certificate','wrong inventory','false retention','future inserts','future decisions','pre-end closure','checkpoint hash','checkpoint cursor','checkpoint before closure'])('%s cannot certify checkpoint closure', kind=>{
    const b={...binding(),terminalAuthority:{inventorySha256:'c'.repeat(64),contractSha256:'d'.repeat(64)}}, c=new ProspectiveCapture(dir(),b);
    c.accept(frame(b,1,'ACTIVATION'));
    const checkpoint=frame(b,2,'CHECKPOINT',{observedUtc:window.endUtc}); c.accept(checkpoint);
    const end=frame(b,3,'END_FENCE'); end.fence!.certificate={...b.terminalAuthority,closedUtc:window.endUtc,noFutureInWindowInsertions:true,noFutureRelevantDecisions:true,insertionFactsRetained:true,outstandingTransactions:0,unresolvedFailures:0,registeredWriters:['ingestion','execution'],finalCheckpointCursor:2,finalCheckpointSha256:digest(checkpoint)};
    if(kind==='missing certificate') delete end.fence!.certificate;
    if(kind==='wrong inventory') end.fence!.certificate!.inventorySha256='e'.repeat(64);
    if(kind==='false retention') Object.assign(end.fence!.certificate!,{insertionFactsRetained:false});
    if(kind==='future inserts') Object.assign(end.fence!.certificate!,{noFutureInWindowInsertions:false});
    if(kind==='future decisions') Object.assign(end.fence!.certificate!,{noFutureRelevantDecisions:false});
    if(kind==='pre-end closure') end.fence!.certificate!.closedUtc=window.startUtc;
    if(kind==='checkpoint hash') end.fence!.certificate!.finalCheckpointSha256='e'.repeat(64);
    if(kind==='checkpoint cursor') end.fence!.certificate!.finalCheckpointCursor=1;
    if(kind==='checkpoint before closure') end.fence!.certificate!.closedUtc='2026-01-02T00:00:00.001Z';
    expect(()=>c.accept(end)).toThrow('certificate'); expect(c.health().endCoverage).toBe(false); expect(()=>c.seal()).toThrow();
  });
  it('signed source receipts require externally pinned binding; Python-style numeric serialization authenticates raw bytes',()=>{
    const keys=generateKeyPairSync('ed25519'), b={...binding(),terminalAuthority:{inventorySha256:'c'.repeat(64),contractSha256:'d'.repeat(64)},evidenceKind:'observational' as const,sourcePublicKey:keys.publicKey.export({type:'spki',format:'pem'}).toString()}, c=new ProspectiveCapture(dir(),b);
    function signed(f:SourceFrame):SourceFrame { const {signature,...payload}=f;const text=canonical(payload).replace('"size":100','"size":100.0');return {...payload,signedPayload:text,signature:sign(null,Buffer.from(text),keys.privateKey).toString('base64')}; }
    c.accept(signed(frame(b,1,'ACTIVATION'))); c.accept(signed(frame(b,2,'COMMIT',{trades:[trade()]})));
    const checkpoint=signed(frame(b,3,'CHECKPOINT',{observedUtc:window.endUtc})); c.accept(checkpoint);
    const fence=frame(b,4,'END_FENCE'); fence.fence!.certificate={...b.terminalAuthority,closedUtc:window.endUtc,noFutureInWindowInsertions:true,noFutureRelevantDecisions:true,insertionFactsRetained:true,outstandingTransactions:0,unresolvedFailures:0,registeredWriters:['ingestion','execution'],finalCheckpointCursor:3,finalCheckpointSha256:digest(checkpoint)};
    c.accept(signed(fence)); const a=c.seal();
    expect(()=>ProspectiveCapture.validate(a,cohort,window)).toThrow('independently pinned'); expect(ProspectiveCapture.validate(a,cohort,window,false,b)).toEqual(a);
    const corrupted=structuredClone(a);corrupted.evidence.journal=corrupted.evidence.journal.replace('100.0','101.0');expect(()=>ProspectiveCapture.validate(corrupted,cohort,window,false,b)).toThrow();
  });
});
