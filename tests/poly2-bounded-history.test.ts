import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { canonical, digest } from '../src/compare/poly2-snapshot.js';
import { clockEvidence } from '../src/compare/exact-clock.js';
import { sealFencedArchive, sealFencedArchiveFiles, validateFencedArchiveFile, type FenceBinding, type FenceSealInput } from '../src/compare/poly2-fenced-archive.js';
import { ProspectiveCapture, JOURNAL, type Binding, type SourceFrame, type TradeFact } from '../src/compare/poly2-prospective.js';
import { archiveSchemaVersion, JsonCursor } from '../src/compare/json-cursor.js';
import { cohort, window, binding, fact, frame, fenceFixture } from './poly2-bounded-fixtures.js';
describe('bounded complete journal replay',()=>{
  it('streamed JSON handles unicode, escaped newlines, block boundaries and rejects truncation/duplicate keys',()=>{
    const dir=mkdtempSync(join(tmpdir(),'poly2-json-test-'));try{
      const path=join(dir,'data.json'),value='𐀀\\\n"'+ 'x'.repeat(100000);writeFileSync(path,JSON.stringify({manifest:{schemaVersion:5},evidence:{journal:value}}));
      expect(archiveSchemaVersion(path)).toBe(5);const c=new JsonCursor(path);let out='';try{c.object(k=>{if(k==='evidence')c.object(()=>{for(const s of c.stringChunks())out+=s;});else c.skipValue();});c.finish();}finally{c.close();}expect(out).toBe(value);
      writeFileSync(path,'{"manifest":{},"manifest":{}}');expect(()=>archiveSchemaVersion(path)).toThrow(/duplicate/);
      writeFileSync(path,'{"evidence":"unterminated');expect(()=>archiveSchemaVersion(path)).toThrow(/incomplete/);
    }finally{rmSync(dir,{recursive:true,force:true});}
  });
  it('prospective 12000 distinct transactions: early gaps, paginated counts, disk replay, late original decision, file seal/hash/audit',()=>{
    const dir=mkdtempSync(join(tmpdir(),'poly2-bounded-capture-'));let c:ProspectiveCapture|undefined;
    try{
      c=new ProspectiveCapture(dir,binding,{append(p,s){appendFileSync(p,s);},publish(p,s){writeFileSync(p,s);}});
      c.accept(frame(1,'ACTIVATION'));c.accept(frame(2,'COMMIT',{trades:[fact]}));
      for(let i=0;i<151;i++)c.gap('cursor-publication:'+String(i).padStart(4,'0'),'pending');
      for(let i=3;i<=12000;i++)c.accept(frame(i,'COMMIT'));
      const health=c.health(),journalHash=createHash('sha256').update(readFileSync(join(dir,JOURNAL))).digest('hex');
      expect(health).toMatchObject({cursor:12000,count:1,gapCount:151,gapsTruncated:true,failures:151});expect(health.gaps).toHaveLength(100);
      let after:string|null=null;const ids:string[]=[];for(;;){const page=c.gapPage(after,37);if(!page.length)break;ids.push(...page);after=page.at(-1)!;}expect(ids).toHaveLength(151);
      c.close();c=new ProspectiveCapture(dir,binding);expect(c.health()).toEqual(health);expect(c.accept(frame(2,'COMMIT',{trades:[fact]}))).toBe(false);
      for(const id of ids)c.resolveCursorPublication(id,[2]);
      const decision={sourceEventId:fact.sourceEventId,paperRecordId:2,sourceIngestedUtc:fact.ingestedUtc,decisionUtc:'2026-01-03T00:00:00.000001Z',rejectionReason:null};
      c.accept(frame(12001,'COMMIT',{decisions:[decision]}));c.accept(frame(12002,'END_FENCE'));
      const out=join(dir,'sealed.json'),manifest=c.sealToFile(out);expect(manifest.sourceCursor).toBe(12002);expect(manifest.rowCount).toBe(1);
      const replay=ProspectiveCapture.validateFile(out,cohort,window,true);expect(replay.manifest).toEqual(manifest);expect(replay.rows[0]).toMatchObject({ingestedUtc:fact.ingestedUtc,decisionUtc:decision.decisionUtc,normalizedUtc:null});
      expect(()=>c!.sealToFile(out)).toThrow();expect(ProspectiveCapture.validateFile(out,cohort,window,true).manifest).toEqual(manifest);
      expect(()=>ProspectiveCapture.validateFile(out,cohort,window)).toThrow(/synthetic/);
      console.log(JSON.stringify({case:'prospective_large',journalBytes:statSync(join(dir,JOURNAL)).size,archiveBytes:statSync(out).size,earlyJournalSha256:journalHash,manifest,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss}));
    }finally{c?.close();rmSync(dir,{recursive:true,force:true});}
  },120000);
  it('filters 12000 distinct off-cohort/post-end disk trades during iteration and preserves exact originals',()=>{
    const dir=mkdtempSync(join(tmpdir(),'poly2-bounded-population-'));
    const b={...binding,cohort:[...cohort]};let c:ProspectiveCapture|undefined;
    try {
      c=new ProspectiveCapture(dir,b,{append(p,s){appendFileSync(p,s);},publish(p,s){writeFileSync(p,s);}});
      c.accept(frame(1,'ACTIVATION'));
      const original:TradeFact={...fact,ingestedUtc:'2026-01-02T01:00:00.000000+01:00',tradedAtUtc:'2026-01-01T01:00:00.000001+01:00',clockEvidence:undefined};
      original.clockEvidence=clockEvidence(original as unknown as Record<string,unknown>,['ingestedUtc','tradedAtUtc']);
      c.accept(frame(2,'COMMIT',{trades:[original]}));
      let cursor=3;
      for(let batch=0;batch<120;batch++) {
        const trades=Array.from({length:100},(_,offset):TradeFact=>{
          const id=batch*100+offset+2;
          const t:TradeFact={...fact,sourceRecordId:id,sourceEventId:'source:excluded:'+id,
            wallet:offset%2===0?'0x'+'f'.repeat(40):cohort[0]!,
            ingestedUtc:offset%2===0?window.startUtc:'2026-01-02T00:00:00.000001Z',clockEvidence:undefined};
          t.clockEvidence=clockEvidence(t as unknown as Record<string,unknown>,['ingestedUtc','tradedAtUtc']);return t;
        });
        c.accept(frame(cursor++,'COMMIT',{trades}));
      }
      expect(c.health().count).toBe(1);
      // Assert filter/iteration interleaving, not a fragile RSS threshold: spreading
      // all values first would reach the first predicate with yielded===12001.
      const trades=(c as unknown as {trades:{values():Generator<TradeFact>}}).trades;
      const values=trades.values.bind(trades),includes=b.cohort.includes.bind(b.cohort);
      let yielded=0,filtered=0;
      const iteration=vi.spyOn(trades,'values').mockImplementation(function*(){for(const t of values()){yielded++;yield t;}});
      const membership=vi.spyOn(b.cohort,'includes').mockImplementation(wallet=>{filtered++;expect(yielded).toBe(filtered);return includes(wallet);});
      try {
        expect(c.rows()).toHaveLength(1);expect(yielded).toBe(12001);expect(filtered).toBe(12001);
      } finally {iteration.mockRestore();membership.mockRestore();}
      c.accept(frame(cursor,'END_FENCE'));
      const out=join(dir,'population.json');c.sealToFile(out);
      const replay=ProspectiveCapture.validateFile(out,cohort,window,true);
      expect(replay.rows).toHaveLength(1);expect(replay.rows[0]).toMatchObject({sourceRecordId:original.sourceRecordId,sourceEventId:original.sourceEventId,
        ingestedUtc:original.ingestedUtc,tradedAtUtc:original.tradedAtUtc,sourceEpochMicros:'1767225600000001'});
      expect(readFileSync(join(dir,JOURNAL),'utf8')).toContain(original.ingestedUtc);
    } finally {c?.close();rmSync(dir,{recursive:true,force:true});}
  },120000);
  it('requires the fixed backend/bot writer set and a generation ACK from every declared instance',()=>{
    const dir=mkdtempSync(join(tmpdir(),'poly2-writer-roster-'));
    try {
      const fixture=fenceFixture(dir,0);
      for(const workers of [['bot:runtime-A'],['bot:runtime-A','backend:'],['bot:runtime-A','backend:runtime B'],['bot:runtime-A','backend:runtime-B','watchdog:one']]) {
        expect(()=>sealFencedArchive({binding:{...fixture.b,expectedWorkers:workers},fenceJournal:[],drainJournal:[]} as any)).toThrow(/worker instance identity|complete backend\/bot writer-service inventory/);
      }
      const events=readFileSync(fixture.fencePath,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x));
      const rechain=(records:any[])=>{let previous:string|null=null,fenceReceipt:string|undefined;return records.map((e:any,i:number)=>{const payload={...e.payload};if(e.kind==='FREEZE'&&fenceReceipt)payload.fenceReceiptSha256=fenceReceipt;const out={...e,payload,seq:i+1,previousSha256:previous,bindingSha256:digest(fixture.b)};previous=digest(out);if(e.kind==='FENCE')fenceReceipt=previous;return out;});};
      const drains=readFileSync(fixture.drainPath,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x));
      const botAck=events.findIndex((e:any)=>e.kind==='ACK'&&e.payload.worker==='bot:runtime-A');
      const duplicate=rechain([...events.slice(0,botAck+1),events[botAck],...events.slice(botAck+1)]);
      expect(()=>sealFencedArchive({binding:fixture.b,fenceJournal:duplicate,drainJournal:drains})).not.toThrow();
      const conflict=events.map((e:any)=>e.kind==='ACK'&&e.payload.worker==='bot:runtime-A'?{...e,payload:{...e.payload,epoch:0}}:e);
      expect(()=>sealFencedArchive({binding:fixture.b,fenceJournal:rechain(conflict),drainJournal:drains})).toThrow(/worker generation ACK/);
      for(const missing of fixture.b.expectedWorkers) {
        const incomplete=rechain(events.filter((e:any)=>e.kind!=='ACK'||e.payload.worker!==missing));
        expect(()=>sealFencedArchive({binding:fixture.b,fenceJournal:incomplete,drainJournal:[]})).toThrow(/all workers\/preepoch outcomes not drained/);
      }
      const rechainDrains=(records:any[])=>{let previous:string|null=null;return records.map((d:any,i:number)=>{
        const perId=JSON.parse(JSON.stringify(d.perId));
        const decisions=Object.values(perId).flatMap((v:any)=>v.decision?[v.decision]:[]),decisionsSha256=digest(decisions);
        const query={...d.query,decisionsSha256,sourceSQLCheckpoint:{...d.query.sourceSQLCheckpoint,decisionsSha256}};
        const out={...d,cursor:i+1,previousSha256:previous,perId,perIdSha256:digest(perId),query};
        previous=digest(out);return out;
      });};
      for(const omit of [
        (d:any)=>{delete d.signalRecordId;},
        (d:any)=>{delete d.sourceAudit.context.signal_id;},
        (d:any)=>{delete d.signalRecordId;delete d.sourceAudit.context.signal_id;},
      ]) {
        const altered=JSON.parse(JSON.stringify(drains));let targeted=false;
        for(const d of altered)for(const item of Object.values(d.perId) as any[])if(item.decision){omit(item.decision);targeted=true;}
        expect(targeted).toBe(true);
        expect(()=>sealFencedArchive({binding:fixture.b,fenceJournal:events,drainJournal:rechainDrains(altered)})).toThrow(/original source decision audit linkage/);
      }
    } finally {rmSync(dir,{recursive:true,force:true});}
  });
  it('fenced file replay retains early pending through 16000 retries and post-end attempts; hashes agree with array ABI on small fixture',()=>{
    const dir=mkdtempSync(join(tmpdir(),'poly2-bounded-fenced-'));
    try{
      const small=join(dir,'small');writeFileSync(small,'');rmSync(small); // exclusively owned fixture path
      const f=fenceFixture(dir,3),input={binding:f.b,fenceJournal:readFileSync(f.fencePath,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x)),drainJournal:readFileSync(f.drainPath,'utf8').trimEnd().split('\n').map(x=>JSON.parse(x))} as FenceSealInput;
      const expected=sealFencedArchive(input),smallOutput=join(dir,'small.json');sealFencedArchiveFiles(f.b,f.fencePath,f.drainPath,smallOutput);
      expect(JSON.parse(readFileSync(smallOutput,'utf8'))).toEqual(expected);expect(validateFencedArchiveFile(smallOutput,cohort,window,true)).toEqual({window:expected.window,rows:expected.rows,manifest:expected.manifest});
      const large=fenceFixture(dir,16000),out=join(dir,'large.json'),manifest=sealFencedArchiveFiles(large.b,large.fencePath,large.drainPath,out);
      const replay=validateFencedArchiveFile(out,cohort,window,true);expect(replay.manifest).toEqual(manifest);expect(replay.rows).toEqual(expected.rows);expect(manifest.rowCount).toBe(1);
      expect(()=>validateFencedArchiveFile(out,cohort,window)).toThrow(/UNINSTALLED/);
      console.log(JSON.stringify({case:'fenced_large',journalBytes:statSync(large.fencePath).size,archiveBytes:statSync(out).size,manifest,heapUsed:process.memoryUsage().heapUsed,rss:process.memoryUsage().rss}));
    }finally{rmSync(dir,{recursive:true,force:true});}
  },120000);
});
