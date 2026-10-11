/** Owned synthetic stress only. Run in a fresh normal Node process (no memory flags). */
import { mkdtempSync, rmSync, appendFileSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { cohort,window,binding,fact,frame,fenceFixture } from './poly2-bounded-fixtures.js';
import { ProspectiveCapture,JOURNAL } from '../src/compare/poly2-prospective.js';
import { sealFencedArchiveFiles,validateFencedArchiveFile } from '../src/compare/poly2-fenced-archive.js';
import { journalLines } from '../src/compare/disk-index.js';
import { digest } from '../src/compare/poly2-snapshot.js';
const n=Number(process.argv[2]),kind=process.argv[3];
assert(Number.isSafeInteger(n)&&n>=3&&n<=100000);
assert(kind==='fenced'||kind==='prospective');
const dir=mkdtempSync(join(tmpdir(),'poly2-bounded-stress-'));
function hashFile(path:string):string{const hash=createHash('sha256');for(const line of journalLines(path))hash.update(line+'\n');return hash.digest('hex');}
try {
  if(kind==='fenced'){
    const f=fenceFixture(dir,n),out=join(dir,'archive.json');
    const before=hashFile(f.fencePath),manifest=sealFencedArchiveFiles(f.b,f.fencePath,f.drainPath,out);
    const replay=validateFencedArchiveFile(out,cohort,window,true);
    assert.deepEqual(replay.manifest,manifest);assert.equal(replay.rows.length,1);assert.equal(replay.rows[0]!.ingestedUtc,fact.ingestedUtc);
    assert.equal(before,hashFile(f.fencePath));
    console.log(JSON.stringify({kind,n,sourceBytes:statSync(f.fencePath).size,drainBytes:statSync(f.drainPath).size,outputBytes:statSync(out).size,manifest,sourceSha256:before,rowsSha256:digest(replay.rows),...process.memoryUsage()}));
  }else{
    let c=new ProspectiveCapture(dir,binding,{append(p,s){appendFileSync(p,s);},publish(p,s){writeFileSync(p,s);}});
    try {
      c.accept(frame(1,'ACTIVATION'));c.accept(frame(2,'COMMIT',{trades:[fact]}));
      for(let i=3;i<=n;i++)c.accept(frame(i,'COMMIT'));
      const health=c.health(),before=hashFile(join(dir,JOURNAL));c.close();c=new ProspectiveCapture(dir,binding);
      assert.deepEqual(c.health(),health);assert.equal(c.accept(frame(2,'COMMIT',{trades:[fact]})),false);
      assert.equal(hashFile(join(dir,JOURNAL)),before);
      const decision={sourceEventId:fact.sourceEventId,paperRecordId:2,sourceIngestedUtc:fact.ingestedUtc,decisionUtc:'2026-01-03T00:00:00.000001Z',rejectionReason:null};
      c.accept(frame(n+1,'COMMIT',{decisions:[decision]}));c.accept(frame(n+2,'END_FENCE'));
      const out=join(dir,'archive.json'),manifest=c.sealToFile(out),replay=ProspectiveCapture.validateFile(out,cohort,window,true);
      assert.deepEqual(replay.manifest,manifest);assert.equal(replay.rows.length,1);assert.equal(replay.rows[0]!.decisionUtc,decision.decisionUtc);
      console.log(JSON.stringify({kind,n,sourceBytes:statSync(join(dir,JOURNAL)).size,outputBytes:statSync(out).size,manifest,sourceSha256:hashFile(join(dir,JOURNAL)),rowsSha256:digest(replay.rows),...process.memoryUsage()}));
    }finally{c.close();}
  }
}finally{rmSync(dir,{recursive:true,force:true});}
