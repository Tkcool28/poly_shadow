/** Offline replay of the locally-authored authoritative fence adapter. No DB/network. */
import { canonical, digest, utc } from './poly2-snapshot.js';
import { createHash } from 'node:crypto';
import { DiskIndex, DiskMap, journalLines } from './disk-index.js';
import { openSync, closeSync, writeSync, fsyncSync, linkSync, unlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonCursor } from './json-cursor.js';
import { inWindow, clockEvidence } from './exact-clock.js';
import { validatePoly2Export, type Poly2Export } from './phase4.js';
import type { Binding, TradeFact, DecisionFact } from './poly2-prospective.js';

export type FenceBinding = Binding & { expectedWorkers: string[] };
type Event = { seq: number; previousSha256: string | null; bindingSha256: string; observedUtc: string; kind: string; payload: any };
type Attempt = { transactionId: string; worker: string; epoch: number; retryOf: string | null; state: string; witness?: { transactionId: string; bindingSha256: string; worker: string; epoch: number; trades: TradeFact[] } };
type Drain = { bindingSha256: string; cursor: number; previousSha256: string | null; frozenIds: (string|number)[]; frozenIdsSha256: string; sourceFacts: TradeFact[]; sourceFactsSha256: string; perId: Record<string,{state:string;decision:DecisionFact|null}>; perIdSha256: string; counts: Record<string,number>; state:string; error:string|null; comparisonEligible:boolean; incompleteProperty:string|null; signature:null; query: { isolation:string; observedUtc:string; tradesSha256:string; decisionsSha256:string; tradeCount:number; decisionCount:number; sourceSQLCheckpoint:any }; [key:string]: unknown };
export interface FenceSealInput { binding: FenceBinding; fenceJournal: Event[]; drainJournal: Drain[] }
export interface FencedArchive extends Poly2Export {
  rows: (Poly2Export['rows'][number] & { sourceRecordId:string|number; sourceEventId:string; paperRecordId:string|number })[];
  manifest: { schemaVersion: 5; version: 'poly2-fenced-v1'; binding: FenceBinding; bindingSha256:string; fenceJournalSha256:string; populationReceiptSha256:string; fenceReceiptSha256:string; decisionJournalSha256:string; decisionReceiptSha256:string; payloadSha256:string; rowCount:number; completenessScope:'COMMITTED_ORIGINAL_INGESTIONS_FIXED_ID_INITIAL_DECISIONS' };
  evidence: FenceSealInput;
}
const check = (v:unknown, error:string):void => { if (!v) throw new Error(`fenced archive: ${error}`); };
const equal = (a:unknown,b:unknown):boolean => canonical(a) === canonical(b);
const validSignalIdentity = (v:unknown): v is string|number =>
  (typeof v==='string'&&v.length>0&&v.trim()===v)||(typeof v==='number'&&Number.isSafeInteger(v));
const REQUIRED_WRITER_SERVICES=['backend','bot'] as const;
function validateWriterRoster(workers:unknown): asserts workers is string[] {
  if(!Array.isArray(workers)||!workers.length||!workers.every((w:unknown)=>typeof w==='string'&&/^(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(w))||new Set(workers).size!==workers.length)throw new Error('fenced archive: worker instance identity');
  const services=new Set((workers as string[]).map(w=>w.slice(0,w.indexOf(':'))));
  check(services.size===REQUIRED_WRITER_SERVICES.length&&REQUIRED_WRITER_SERVICES.every(s=>services.has(s)),'complete backend/bot writer-service inventory');
}
/** Synthetic-only until independent source installation/enrollment/custody review.
 * Replay proves recorded lifecycle and comparator mapping, not deployment authenticity. */
export function sealFencedArchive(input: FenceSealInput): FencedArchive { return replayFencedArchive(input); }
type StreamingSealInput = {binding:FenceBinding; fenceJournal:Iterable<Event>; drainJournal:Iterable<Drain>};
function replayFencedArchive(input: StreamingSealInput): FencedArchive {
  const { binding:b, fenceJournal:events, drainJournal:drains } = input;
  check(b?.evidenceKind === 'synthetic', 'UNINSTALLED observational producer; no authority fabricated');
  check(b.cohort.length === 5 && new Set(b.cohort).size === 5 && b.cohort.every(w=>/^0x[a-f0-9]{40}$/.test(w)), 'exact wallet inventory');
  validateWriterRoster(b.expectedWorkers);
  check(b.runId && b.shadowRunId && /^[a-f0-9]{40}$/.test(b.poly2CodeSha) && /^[a-f0-9]{64}$/.test(b.componentSha256) && utc(b.window.startUtc)<utc(b.window.endUtc), 'run/revision/window binding');
  const index = new DiskIndex();
  try {
  const enrolled = new Set<string>(), acks = new Set<string>(), attempts = new DiskMap<string,Attempt>(index,'attempts');
  const checkpoint = (q:any, f:TradeFact[], fixedIds:(string|number)[]|null, decisionsHash?:string):void => {
    let predicate='w.address IN ('+b.cohort.map(()=>'%s').join(',')+') AND t.ingested_at >= %s AND t.ingested_at <= %s';
    const params:(string|number)[]=[...b.cohort,b.window.startUtc,b.window.endUtc];
    if (fixedIds!==null) { predicate+=fixedIds.length?' AND t.id IN ('+fixedIds.map(()=>'%s').join(',')+')':' AND 1=0'; params.push(...fixedIds); }
    check(q&&q.isolation==='repeatable read'&&q.readOnly==='on'&&/^\d+:\d+:(?:\d+(?:,\d+)*)?$/.test(q.snapshot)&&q.sourceFactsSha256===digest(f)&&equal(q.sourceRecordIds,f.map(t=>t.sourceRecordId))&&q.querySha256===digest({predicate,params}), 'actual SQL snapshot/query/fact checkpoint');
    if (decisionsHash) check(q.decisionsSha256===decisionsHash,'SQL initial decisions digest');
  };
  let epoch = 0, close:Event|null = null, fence:Event|null = null, population:Event|null = null;
  const facts = ():TradeFact[] => {
    const rows:TradeFact[]=[];
    for (const a of attempts.values()) if (a.state==='COMMITTED') for (const t of a.witness!.trades) if (b.cohort.includes(t.wallet)&&inWindow(t.ingestedUtc,b.window)) rows.push(t);
    check(new Set(rows.map(t=>canonical(t.sourceRecordId))).size===rows.length && new Set(rows.map(t=>t.sourceEventId)).size===rows.length, 'duplicate source stable IDs');
    return rows.sort((a,c)=>canonical(a.sourceRecordId)<canonical(c.sourceRecordId)?-1:1);
  };
  const receipt = () => {
    let admitted=0,committed=0,rolledBack=0,outstanding=0;
    for (const a of attempts.values()) if (a.epoch===0) {admitted++; if(a.state==='COMMITTED')committed++;else if(a.state==='ROLLED_BACK')rolledBack++;else if(a.state==='OUTSTANDING')outstanding++;}
    return {protocol:'source-epoch-inflight-v1',runId:b.runId,endpointUtc:b.window.endUtc,closingEpoch:0,requiredWriterServices:[...REQUIRED_WRITER_SERVICES],expectedWorkers:[...b.expectedWorkers].sort(),acknowledgements:[...acks].sort(),admitted,committed,rolledBack,outstanding,highWaterMark:close?.seq??null};
  };
  let i=0, previousEvent:Event|undefined;
  const fenceHash=createHash('sha256').update('[');
  for (const e of events) {
    fenceHash.update((i?',':'')+canonical(e));
    check(e.seq===i+1 && e.previousSha256===(previousEvent?digest(previousEvent):null)&&e.bindingSha256===digest(b), 'journal chain/binding');
    previousEvent=e; i++;
    utc(e.observedUtc); const p=e.payload;
    if (i===1) { check(e.kind==='ARM'&&equal(p,b)&&utc(e.observedUtc)<=utc(b.window.startUtc),'pre-start ARM'); continue; }
    if (e.kind==='ENROLL') { check(!close&&b.expectedWorkers.includes(p.worker)&&!enrolled.has(p.worker),'worker enrollment'); enrolled.add(p.worker); }
    else if (e.kind==='ATTEMPT') {
      check(enrolled.has(p.worker)&&!attempts.has(p.transactionId)&&p.epoch===epoch,'admission generation/identity');
      check(p.retryOf===null||attempts.get(p.retryOf)?.state==='ROLLED_BACK','unknown outcome retry');
      attempts.set(p.transactionId,{...p,state:'OUTSTANDING'});
    } else if (e.kind==='CLOSE') { check(!close&&equal(p,{closingEpoch:epoch,nextEpoch:epoch+1})&&utc(e.observedUtc)>utc(b.window.endUtc),'inclusive endpoint/close race'); close=e; epoch++; }
    else if (e.kind==='ACK') { check(close&&enrolled.has(p.worker)&&p.epoch===epoch&&equal(p,{worker:p.worker,epoch}),'worker generation ACK'); acks.add(p.worker); }
    else if (e.kind==='COMMITTED'||e.kind==='ROLLED_BACK') {
      const a=attempts.get(p.transactionId); check(a&&a.state==='OUTSTANDING','transaction terminal conflict');
      if (e.kind==='COMMITTED') {
        const w=p.witness; check(w&&w.transactionId===a!.transactionId&&w.worker===a!.worker&&w.epoch===a!.epoch&&w.bindingSha256===digest(b),'actual source witness identity');
        check(Array.isArray(w.trades)&&new Set(w.trades.map((t:TradeFact)=>canonical(t.sourceRecordId))).size===w.trades.length&&new Set(w.trades.map((t:TradeFact)=>t.sourceEventId)).size===w.trades.length,'duplicate witness facts');
        for (const t of w.trades as TradeFact[]) {
          check(t.clockEvidence&&equal(t.clockEvidence,clockEvidence(t as unknown as Record<string,unknown>,['ingestedUtc','tradedAtUtc'])),'original timestamp evidence');
          check(a!.epoch===0||utc(t.ingestedUtc)>utc(b.window.endUtc),'postepoch old original ingestion clock');
        }
        a!.witness=w;
      }
      a!.state=e.kind; attempts.set(p.transactionId,a!);
    } else if (e.kind==='ERROR') throw new Error('fenced archive: retained capture/source failure '+p.error);
    else if (e.kind==='FENCE') { const r=receipt(); check(!fence&&close&&equal(p,r)&&r.outstanding===0&&equal([...acks].sort(),[...b.expectedWorkers].sort()),'all workers/preepoch outcomes not drained'); fence=e; }
    else if (e.kind==='FREEZE') {
      const f=facts(), ids=f.map(t=>t.sourceRecordId);
      check(fence&&!population&&equal(p.sourceFacts,f)&&p.sourceFactsSha256===digest(f)&&equal(p.frozenIds,ids)&&p.frozenIdsSha256===digest(ids)&&p.count===f.length&&p.fenceReceiptSha256===digest(fence),'postfence canonical population');
      check(p.query.isolation==='REPEATABLE_READ_READ_ONLY'&&p.query.sourceFactsSha256===digest(f)&&utc(p.query.observedUtc)>=utc(fence!.observedUtc),'consistent source checkpoint'); population=e;
      checkpoint(p.query.sourceSQLCheckpoint,f,null);
    } else throw new Error('fenced archive: unknown journal event');
  }
  check(fence&&population,'no completed fence/population');
  const frozen = population!.payload.sourceFacts as TradeFact[], ids=frozen.map(t=>t.sourceRecordId), eventIds=frozen.map(t=>t.sourceEventId);
  let previous:Drain|undefined, drainCount=0;
  const drainHash=createHash('sha256').update('[');
  for (const d of drains) {
    const i=drainCount++; drainHash.update((i?',':'')+canonical(d));
    check(d.bindingSha256===digest(b)&&d.cursor===i+1&&d.previousSha256===(previous?digest(previous):null)&&d.signature===null,'decision chain/binding');
    check(equal(d.sourceFacts,frozen)&&equal(d.frozenIds,ids)&&d.sourceFactsSha256===digest(frozen)&&d.frozenIdsSha256===digest(ids)&&equal(Object.keys(d.perId).sort(),[...eventIds].sort())&&d.perIdSha256===digest(d.perId),'fixed ID decision population/digests');
    const counts={DECISION_RECORDED:0,NO_INITIAL_DECISION_EXPECTED:0,PENDING:0,CAPTURE_ERROR:0};
    for (const t of frozen) {
      const terminal=d.perId[t.sourceEventId]!;
      check(['DECISION_RECORDED','PENDING','CAPTURE_ERROR'].includes(terminal.state),'no no-decision terminal');
      counts[terminal.state as keyof typeof counts]++;
      const dec=terminal.decision;
      if (terminal.state==='DECISION_RECORDED') {
        check(dec&&dec.sourceEventId===t.sourceEventId&&dec.sourceIngestedUtc===t.ingestedUtc&&dec.decisionUtc!==null,'actual initial decision required');
        utc(dec!.decisionUtc);
        check(dec!.clockEvidence&&equal(dec!.clockEvidence,clockEvidence(dec as unknown as Record<string,unknown>,['sourceIngestedUtc','decisionUtc'])),'actual decision clock');
        const audit=dec!.sourceAudit as {recordId:number;action:string;createdUtc:string;context:Record<string,unknown>}|undefined;
        const expectedAction=dec!.rejectionReason===null?'paper_order_executed':'signal_skipped';
        const signalRecordId=dec!.signalRecordId, auditedSignalId=audit?.context?.signal_id;
        check(Number.isSafeInteger(audit?.recordId)&&audit!.recordId>0&&audit!.action===expectedAction
          &&validSignalIdentity(signalRecordId)&&validSignalIdentity(auditedSignalId)&&auditedSignalId===signalRecordId
          &&audit!.context?.source_trade_id===t.sourceEventId,
          'original source decision audit linkage');
        utc(audit!.createdUtc);
      } else check(dec===null,'nonterminal decision fact');
      if (previous?.perId[t.sourceEventId]?.state==='DECISION_RECORDED') check(equal(previous.perId[t.sourceEventId],terminal),'original decision conflict/restart');
    }
    const complete=counts.PENDING===0&&counts.CAPTURE_ERROR===0;
    check(equal(d.counts,counts)&&!d.error&&d.state===(complete?'COMPLETE':'DRAINING')&&d.comparisonEligible===complete&&d.incompleteProperty===null,'decision completeness equation');
    const decisions=frozen.flatMap(t=>d.perId[t.sourceEventId]!.decision?[d.perId[t.sourceEventId]!.decision]:[]);
    check(d.query.isolation==='REPEATABLE_READ_READ_ONLY'&&d.query.tradesSha256===digest(frozen)&&d.query.tradeCount===frozen.length&&d.query.decisionsSha256===digest(decisions)&&d.query.decisionCount===decisions.length&&utc(d.query.observedUtc)>=utc(population!.observedUtc),'decision SQL checkpoint hash/count');
    checkpoint(d.query.sourceSQLCheckpoint,frozen,ids,digest(decisions));
    check(!previous||previous.state!=='COMPLETE','decision terminal transition'); previous=d;
  }
  check(previous?.state==='COMPLETE','pending/error initial decisions cannot seal');
  const rows=frozen.map(t=>{
    const d=previous!.perId[t.sourceEventId]!.decision!, p=t.sourceEventId.split(':');
    return {wallet:t.wallet,txHash:p[0]==='data-api'?p[1]!:null,asset:t.asset,conditionId:t.conditionId,side:t.side,size:t.size,price:null,sourceTs:t.sourceTs,sourceEpochMicros:t.tradedAtUtc===null?null:utc(t.tradedAtUtc).toString(),tradedAtUtc:t.tradedAtUtc,ingestedUtc:t.ingestedUtc,normalizedUtc:null,decisionUtc:d.decisionUtc,signalUtc:null,source:p[0]!,freshnessAgeSec:null,freshnessRejection:d.rejectionReason==='stale_signal'?'stale_signal':null,policyEligible:null,copyabilityOutcome:null,rejectionReason:d.rejectionReason,paperOutcome:null,sourceRecordId:t.sourceRecordId,sourceEventId:t.sourceEventId,paperRecordId:d.paperRecordId};
  });
  const payload={window:b.window,rows}; validatePoly2Export(payload);
  return {...payload,evidence:input as FenceSealInput,manifest:{schemaVersion:5,version:'poly2-fenced-v1',binding:b,bindingSha256:digest(b),fenceJournalSha256:fenceHash.update(']').digest('hex'),populationReceiptSha256:digest(population),fenceReceiptSha256:digest(fence),decisionJournalSha256:drainHash.update(']').digest('hex'),decisionReceiptSha256:digest(previous),payloadSha256:digest(payload),rowCount:rows.length,completenessScope:'COMMITTED_ORIGINAL_INGESTIONS_FIXED_ID_INITIAL_DECISIONS'}};
  } finally {index.close();}
}
/** Bounded in journal length: replay full authority, then serialize evidence directly
 * from disk. One complete frame/frozen population remains the schema-sized unit. */
export function sealFencedArchiveFiles(binding:FenceBinding, fencePath:string, drainPath:string, outputPath:string):FencedArchive['manifest'] {
  function* records<T>(path:string):Generator<T> {for(const line of journalLines(path)) yield JSON.parse(line) as T;}
  const result=replayFencedArchive({binding,fenceJournal:records<Event>(fencePath),drainJournal:records<Drain>(drainPath)});
  const fd=openSync(outputPath+'.pending','wx',0o600);
  const write=(text:string):void=>{const b=Buffer.from(text);let n=0;while(n<b.length){const k=writeSync(fd,b,n,b.length-n);if(k<=0)throw new Error('short archive write');n+=k;}};
  const array=(path:string,expected:string):void=>{write('[');const hash=createHash('sha256').update('[');let first=true;for(const line of journalLines(path)){const text=(first?'':',')+canonical(JSON.parse(line));hash.update(text);write(text);first=false;}write(']');check(hash.update(']').digest('hex')===expected,'authority changed during archive serialization');};
  try {write('{"window":'+canonical(result.window)+',"rows":'+canonical(result.rows)+',"manifest":'+canonical(result.manifest)+',"evidence":{"binding":'+canonical(binding)+',"fenceJournal":');array(fencePath,result.manifest.fenceJournalSha256);write(',"drainJournal":');array(drainPath,result.manifest.decisionJournalSha256);write('}}');fsyncSync(fd);}
  finally {closeSync(fd);}
  linkSync(outputPath+'.pending',outputPath);
  // Do not report success for a merely visible, unsynced directory entry.
  // Preserve evidence on error and retain exclusive no-overwrite retry semantics.
  const syncDirectory=():void=>{const dirfd=openSync(join(outputPath,'..'),'r');try{fsyncSync(dirfd);}finally{closeSync(dirfd);}};
  syncDirectory();
  unlinkSync(outputPath+'.pending');
  syncDirectory();
  return result.manifest;
}
/** File replay retains one receipt rather than JSON.parse-ing full evidence history. */
export function validateFencedArchiveFile(path:string, cohort:string[], window:Binding['window'], allowSynthetic=false):Omit<FencedArchive,'evidence'> {
  check(allowSynthetic,'UNINSTALLED: synthetic fence is not production authority');
  const dir=mkdtempSync(join(tmpdir(),'poly2-fenced-replay-')), cursor=new JsonCursor(path);
  let binding:FenceBinding|undefined, manifest:FencedArchive['manifest']|undefined, archiveWindow:Binding['window']|undefined;
  const rows:FencedArchive['rows']=[];
  const journals={fenceJournal:join(dir,'fence.ndjson'),drainJournal:join(dir,'drain.ndjson')};
  try {
    cursor.object(key=>{
      if(key==='window')archiveWindow=cursor.value() as Binding['window'];
      else if(key==='manifest')manifest=cursor.value() as FencedArchive['manifest'];
      else if(key==='rows')cursor.array(row=>rows.push(row as FencedArchive['rows'][number]));
      else if(key==='evidence')cursor.object(field=>{
        if(field==='binding')binding=cursor.value() as FenceBinding;
        else if(field==='fenceJournal'||field==='drainJournal'){
          const fd=openSync(journals[field],'wx',0o600);
          try {cursor.array(record=>{const b=Buffer.from(canonical(record)+'\n');let n=0;while(n<b.length)n+=writeSync(fd,b,n,b.length-n);});} finally {closeSync(fd);}
        } else throw new Error('fenced archive: unexpected evidence field');
      });
      else throw new Error('fenced archive: unexpected archive field');
    });cursor.finish();
    check(binding&&manifest&&archiveWindow,'v5 full lifecycle evidence required');
    check(equal(archiveWindow,window)&&equal([...binding!.cohort].sort(),[...cohort].sort()),'frozen window/cohort');
    function* records<T>(path:string):Generator<T>{for(const line of journalLines(path))yield JSON.parse(line) as T;}
    const expected=replayFencedArchive({binding:binding!,fenceJournal:records<Event>(journals.fenceJournal),drainJournal:records<Drain>(journals.drainJournal)});
    check(equal(manifest,expected.manifest)&&equal(rows,expected.rows)&&equal(archiveWindow,expected.window),'archive replay manifest/journal/payload SHA/count mismatch');
    return {window:expected.window,rows:expected.rows,manifest:expected.manifest};
  } finally {cursor.close();rmSync(dir,{recursive:true,force:true});}
}
export function validateFencedArchive(value:unknown, cohort:string[], window:Binding['window'], allowSynthetic=false):FencedArchive {
  const a=value as FencedArchive;
  check(a?.manifest?.schemaVersion===5&&a.evidence,'v5 full lifecycle evidence required');
  check(allowSynthetic,'UNINSTALLED: synthetic fence is not production authority');
  check(equal(a.window,window)&&equal([...a.manifest.binding.cohort].sort(),[...cohort].sort()),'frozen window/cohort');
  const expected=sealFencedArchive(a.evidence);
  check(equal(a,expected),'archive replay manifest/journal/payload SHA/count mismatch');
  return a;
}
