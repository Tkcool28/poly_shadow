/** Offline file handoff acceptance; synthetic custody is never source authority. */
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import { sealFencedArchiveFiles, validateFencedArchiveFile, type FenceBinding } from '../src/compare/poly2-fenced-archive.js';
import { compare } from '../src/compare/phase4.js';
import { canonical } from '../src/compare/poly2-snapshot.js';

const directory=process.argv[2]!;
const binding=JSON.parse(readFileSync(join(directory,'binding.json'),'utf8')) as FenceBinding;
const fence=join(directory,'fence.ndjson'),drain=join(directory,'drain.ndjson');
const scratch=mkdtempSync(join(tmpdir(),'poly2-native-file-e2e-'));
try {
  const output=join(scratch,'archive.json');
  const manifest=sealFencedArchiveFiles(binding,fence,drain,output);
  const archive=validateFencedArchiveFile(output,binding.cohort,binding.window,true);
  assert.equal(canonical(archive.manifest),canonical(manifest));
  const result=compare(archive,new Map(),binding.window,w=>binding.cohort.includes(w)?'CONTROLLED_OVERLAP':null,new Map());
  let checks=0;
  assert.throws(()=>validateFencedArchiveFile(output,binding.cohort,binding.window));checks++;
  assert.throws(()=>sealFencedArchiveFiles(binding,fence,drain,output));checks++;
  assert.equal(canonical(validateFencedArchiveFile(output,binding.cohort,binding.window,true)),canonical(archive));
  // Small native fixture mutations only; production file replay remains streaming.
  const original=readFileSync(output,'utf8');
  const rejected=(mutate:(value:any)=>void):void=>{
    const value=JSON.parse(original);mutate(value);
    const path=join(scratch,'negative-'+checks+'.json');writeFileSync(path,canonical(value));
    assert.throws(()=>validateFencedArchiveFile(path,binding.cohort,binding.window,true));checks++;
  };
  rejected(x=>{x.manifest.rowCount++;});
  rejected(x=>{x.rows[0].ingestedUtc='2026-01-02T00:00:00.000001Z';});
  rejected(x=>{x.evidence.fenceJournal=x.evidence.fenceJournal.filter((e:any)=>e.kind!=='ACK');});
  rejected(x=>{x.evidence.drainJournal.at(-1).perId[x.rows[0].sourceEventId].state='PENDING';});
  rejected(x=>{x.evidence.binding.evidenceKind='observational';});
  rejected(x=>{delete x.evidence.drainJournal.at(-1).perId[x.rows[0].sourceEventId].decision.sourceAudit;});
  rejected(x=>{x.evidence.drainJournal.at(-1).perId[x.rows[0].sourceEventId].decision.sourceAudit.context.signal_id=999;});
  const truncated=join(scratch,'truncated.json');writeFileSync(truncated,original.slice(0,-1));
  assert.throws(()=>validateFencedArchiveFile(truncated,binding.cohort,binding.window,true));checks++;
  console.log(JSON.stringify({handoff:'FILE_JOURNALS',ids:archive.rows.map(r=>r.sourceRecordId),decisionClocks:archive.rows.map(r=>r.decisionUtc),normalized:archive.rows.map(r=>r.normalizedUtc),comparisonPrimary:result.coverage.poly2Only,negativeReplayChecks:checks,manifest}));
} finally {rmSync(scratch,{recursive:true,force:true});}
