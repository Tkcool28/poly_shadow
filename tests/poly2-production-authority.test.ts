import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { authorityCanonical, authorityDigest, authenticatedBytes, loadAuthority, producerFingerprint, validateAuthority } from '../src/compare/production-authority.js';
import { sealFencedArchive, sealFencedArchiveFiles, validateFencedArchive, validateFencedArchiveFile } from '../src/compare/poly2-fenced-archive.js';
import { epochMicros } from '../src/compare/exact-clock.js';
import { compare } from '../src/compare/phase4.js';
let dir:string, input:any, external:any, archive:any;
const clone=(x:any)=>JSON.parse(JSON.stringify(x));
const run=(argv:string[])=>spawnSync(argv[0]!,argv.slice(1),{cwd:process.cwd(),encoding:'utf8',env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
beforeAll(()=>{
  dir=mkdtempSync(join(tmpdir(),'poly2-authority-test-'));
  const p=run(['python3','tests/poly2_authority_fixture.py',dir]);expect(p.status,p.stdout+p.stderr).toBe(0);
  external=loadAuthority(join(dir,'authority.json'),readFileSync(join(dir,'pin'),'utf8'));
  input={binding:JSON.parse(readFileSync(join(dir,'handoff/binding.json'),'utf8')),fenceJournal:readFileSync(join(dir,'handoff/fence.ndjson'),'utf8').trim().split('\n').map(l=>JSON.parse(l)),drainJournal:readFileSync(join(dir,'handoff/drain.ndjson'),'utf8').trim().split('\n').map(l=>JSON.parse(l))};
  archive=sealFencedArchive(input,external);
  writeFileSync(join(dir,'cohorts.json'),JSON.stringify({window:input.binding.window,controlled:input.binding.cohort}));
});
afterAll(()=>rmSync(dir,{recursive:true,force:true}));
const unkeyedRepair=(v:any)=>{
  const b=v.binding;let prev:any=null;
  for(const e of v.fenceJournal){e.bindingSha256=authorityDigest(b);e.previousSha256=prev?authorityDigest(prev):null;e.signedPayload=authenticatedBytes(e,b,external.authority,'fence');prev=e;}
  let previous:any=null;for(const d of v.drainJournal){d.bindingSha256=authorityDigest(b);d.previousSha256=previous?authorityDigest(previous):null;d.sourceFactsSha256=authorityDigest(d.sourceFacts);d.frozenIdsSha256=authorityDigest(d.frozenIds);d.perIdSha256=authorityDigest(d.perId);d.signedPayload=authenticatedBytes(d,b,external.authority,'drain');previous=d;}
};
// Re-sign with a NEW disposable key and independently reconstruct external approval.
// This reaches semantic enrollment/order checks instead of a stale signature check.
const legitimateSigningContext=(v:any)=>{
 const pair=generateKeyPairSync('ed25519');v.binding.sourcePublicKey=pair.publicKey.export({type:'spki',format:'pem'}).toString();
 const a=clone(external.authority);a.binding=clone(v.binding);a.producerFingerprint=producerFingerprint(v.binding.sourcePublicKey);
 let prev:any=null;for(let i=0;i<v.fenceJournal.length;i++){
  const e=v.fenceJournal[i];e.seq=i+1;e.previousSha256=prev?authorityDigest(prev):null;e.bindingSha256=authorityDigest(v.binding);
  if(e.kind==='ARM')e.payload=clone(v.binding);
  if(e.kind==='COMMITTED')e.payload.witness.bindingSha256=authorityDigest(v.binding);
  const bytes=authenticatedBytes(e,v.binding,a,'fence');e.signedPayload=bytes;e.signature=sign(null,Buffer.from(bytes),pair.privateKey).toString('base64');prev=e;
 }
 return {authority:a,pin:authorityDigest(a)};
};
describe('v5 independent observational authority',()=>{
 it('Python/TS JCS, binding, signed bytes/signature, clock, writer/sequence and complete journal hash vectors',()=>{
  const v=JSON.parse(readFileSync(join(dir,'vectors.json'),'utf8'));
  expect(authorityCanonical(v.value)).toBe(v.canonical);expect(authorityDigest(input.binding)).toBe(v.bindingDigest);
  expect(authenticatedBytes(v.record,input.binding,external.authority,'fence')).toBe(v.signedBytes);
  expect(authorityDigest(input.fenceJournal)).toBe(v.journalHash);expect(epochMicros(input.fenceJournal.find((e:any)=>e.kind==='COMMITTED').payload.witness.trades[0].ingestedUtc).toString()).toBe(v.clockMicros);
  expect(input.fenceJournal.map((e:any)=>e.seq)).toEqual(input.fenceJournal.map((_:any,i:number)=>i+1));
  expect(input.drainJournal[0].cursor).toBe(1);expect(input.binding.expectedWorkers).toEqual(['backend:test','bot:test','bot:second']);
  expect(()=>validateFencedArchive(archive,input.binding.cohort,input.binding.window,false,external)).not.toThrow();
 });
 it('full Python observational lifecycle, disk replay and official CLI without synthetic override; frozen output parity',()=>{
  const path=join(dir,'archive.json');sealFencedArchiveFiles(input.binding,join(dir,'handoff/fence.ndjson'),join(dir,'handoff/drain.ndjson'),path,external);
  expect(validateFencedArchiveFile(path,input.binding.cohort,input.binding.window,false,external).rows).toEqual(archive.rows);
  const data=join(dir,'shadow');mkdirSync(data);writeFileSync(join(dir,'cohorts.json'),JSON.stringify({window:input.binding.window,controlled:input.binding.cohort}));
  const p=run(['node','--import','tsx','src/compare/cli.ts',data,path,join(dir,'cohorts.json'),join(dir,'out'),join(dir,'authority.json'),external.pin]);expect(p.status,p.stdout+p.stderr).toBe(0);
  const result=JSON.parse(readFileSync(join(dir,'out/comparison.json'),'utf8'));
  expect(result).toEqual(compare(archive,new Map(),input.binding.window,(w:string)=>input.binding.cohort.includes(w)?'CONTROLLED_OVERLAP':null,new Map()));
 });
 it.each(['no authority','self-declared key only','wrong independent pin','wrong external key'])('%s rejected',name=>{
  const e=clone(external);if(name==='wrong independent pin')e.pin='0'.repeat(64);
  if(name==='wrong external key'){e.authority.binding.sourcePublicKey=generateKeyPairSync('ed25519').publicKey.export({type:'spki',format:'pem'}).toString();e.pin=authorityDigest(e.authority);}
  expect(()=>sealFencedArchive(input,name==='no authority'||name==='self-declared key only'?undefined:e)).toThrow();
 });
 it.each(['runId','shadowRunId','generationId','poly2CodeSha','shadowCodeSha','componentSha256','protocolDigest','cohort','window','expectedWorkers'])('external %s binding mismatch',field=>{
  const v=clone(input);if(field==='cohort')v.binding.cohort[0]='0x'+'9'.repeat(40);else if(field==='window')v.binding.window.endUtc='2026-01-02T00:00:00.000001Z';else if(field==='expectedWorkers')v.binding.expectedWorkers.pop();else v.binding[field]='f'.repeat(v.binding[field].length);
  unkeyedRepair(v);expect(()=>sealFencedArchive(v,external)).toThrow(/external binding/);
 });
 it.each(['ARM','ENROLL','ATTEMPT','COMMITTED','CLOSE','ACK','FENCE','FREEZE','ARCHIVE'])('altered authenticated %s with repaired outer hashes',kind=>{
  const v=clone(input),e=v.fenceJournal.find((e:any)=>e.kind===kind);e.observedUtc='2025-12-31T23:31:00Z';
  if(kind==='COMMITTED')e.payload.witness.trades[0].size=101;
  if(kind==='FREEZE')e.payload.sourceFacts[0].size=101;
  if(kind==='ACK')e.payload.epoch=2;
  if(kind==='FENCE')e.payload.committed=99;
  unkeyedRepair(v);expect(()=>sealFencedArchive(v,external)).toThrow(/producer signature/);
 });
 it('altered authenticated decision/drain with repaired per-ID/source hashes',()=>{
  const v=clone(input);v.drainJournal[0].perId[Object.keys(v.drainJournal[0].perId)[0]!].decision.decisionUtc='2026-01-03T00:00:01Z';unkeyedRepair(v);
  expect(()=>sealFencedArchive(v,external)).toThrow(/producer signature/);
 });
 it.each(['backend:test','bot:test','bot:second'])('each approved instance %s must enroll before first admission',worker=>{
  const v=clone(input);v.fenceJournal=v.fenceJournal.filter((e:any)=>e.kind!=='ENROLL'||e.payload.worker!==worker);
  const context=legitimateSigningContext(v);expect(()=>sealFencedArchive(v,context)).toThrow(/all approved instances/);
 });
 it('unexpected signed writer and late signed enrollment rejected semantically',()=>{
  for(const late of [false,true]){const v=clone(input),e=v.fenceJournal.find((e:any)=>e.kind==='ENROLL');if(late)e.observedUtc=input.binding.window.startUtc;else e.payload.worker='bot:unexpected';
   const context=legitimateSigningContext(v);expect(()=>sealFencedArchive(v,context)).toThrow(/enrollment/);}
 });
 it.each(['reorder','duplicate','conflicting duplicate','truncate'])('authenticated journal %s rejected after unkeyed repair',kind=>{
  const v=clone(input);if(kind==='reorder')[v.fenceJournal[1],v.fenceJournal[2]]=[v.fenceJournal[2],v.fenceJournal[1]];
  if(kind.includes('duplicate')){const e=clone(v.fenceJournal[1]);if(kind.startsWith('conflicting'))e.payload.worker='bot:test';v.fenceJournal.splice(2,0,e);}
  if(kind==='truncate')v.fenceJournal.pop();unkeyedRepair(v);expect(()=>sealFencedArchive(v,external)).toThrow();
 });
 it('altered SQL checkpoint with recomputed signed bytes and outer hashes cannot authenticate',()=>{
  const v=clone(input);v.fenceJournal.find((e:any)=>e.kind==='FREEZE').payload.query.sourceSQLCheckpoint.snapshot='2:3:';unkeyedRepair(v);
  expect(()=>sealFencedArchive(v,external)).toThrow(/producer signature/);
 });
 it.each(['backend','bot'])('approved authority missing required %s service is denied even with fresh independent pin',service=>{
  const a=clone(external.authority);a.binding.expectedWorkers=a.binding.expectedWorkers.filter((w:string)=>!w.startsWith(service+':'));
  for(const w of Object.keys(a.installations))if(w.startsWith(service+':'))delete a.installations[w];
  expect(()=>validateAuthority({authority:a,pin:authorityDigest(a)},a.binding)).toThrow(/complete approved/);
 });
 it.each(['backend:test','bot:test','bot:second'])('each signed generation ACK %s is individually required',worker=>{
  const v=clone(input);v.fenceJournal=v.fenceJournal.filter((e:any)=>e.kind!=='ACK'||e.payload.worker!==worker);
  const context=legitimateSigningContext(v);expect(()=>sealFencedArchive(v,context)).toThrow(/all workers/);
 });
 it.each(['missing installation','non24h window','wrong cohort digest','late approval'])('independently pinned malformed authority %s rejected',kind=>{
  const a=clone(external.authority);
  if(kind==='missing installation')delete a.installations['bot:second'];
  if(kind==='non24h window')a.binding.window.endUtc='2026-01-02T00:00:00.000001Z';
  if(kind==='wrong cohort digest')a.cohortSha256='0'.repeat(64);
  if(kind==='late approval')a.approvedUtc=a.binding.window.startUtc;
  expect(()=>validateAuthority({authority:a,pin:authorityDigest(a)},a.binding)).toThrow();
 });
 it('observational through synthetic-only validator is denied',()=>expect(()=>validateFencedArchive(archive,input.binding.cohort,input.binding.window,true)).toThrow(/evidence kind boundary/));
 it.each(['missing','changed','synthetic','torn'])('production CLI %s input creates no output',kind=>{
  const path=join(dir,'negative-'+kind+'.json');let value=clone(archive);
  if(kind==='synthetic'){value.evidence.binding.evidenceKind='synthetic';value.manifest.binding.evidenceKind='synthetic';}
  const text=JSON.stringify(value);writeFileSync(path,kind==='torn'?text.slice(0,-1):text);
  const out=join(dir,'denied-'+kind);const args=['node','--import','tsx','src/compare/cli.ts',join(dir,'never-read-shadow'),path,join(dir,'cohorts.json'),out];
  if(kind!=='missing')args.push(join(dir,'authority.json'),kind==='changed'?'0'.repeat(64):external.pin);
  const p=run(args);expect(p.status).not.toBe(0);expect(existsSync(out)).toBe(false);
 });
});
