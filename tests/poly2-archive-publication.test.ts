import { describe, it, expect, vi, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProspectiveCapture } from '../src/compare/poly2-prospective.js';
import { sealFencedArchiveFiles, validateFencedArchiveFile } from '../src/compare/poly2-fenced-archive.js';
import { binding, cohort, window, fact, frame, fenceFixture } from './poly2-bounded-fixtures.js';

const fault=vi.hoisted(()=>({output:'',failAt:0,checks:[] as boolean[],error:new Error('injected archive directory fsync failure')}));
vi.mock('node:fs',async importOriginal=>{
  const actual=await importOriginal<typeof import('node:fs')>();
  return {...actual,fsyncSync(fd:number){
    if(fault.output && actual.fstatSync(fd).isDirectory()) {
      // Restrict injection to publication: health/cursor directories are irrelevant.
      if(actual.existsSync(fault.output)) {
        fault.checks.push(actual.existsSync(fault.output+'.pending'));
        if(fault.checks.length===fault.failAt)throw fault.error;
      }
    }
    actual.fsyncSync(fd);
  }};
});
afterEach(()=>{fault.output='';fault.failAt=0;fault.checks=[];});

for(const kind of ['prospective','fenced'] as const)describe(kind+' durable archive publication',()=>{
  function fixture(dir:string) {
    if(kind==='fenced') {
      const f=fenceFixture(dir,2);
      return {seal:(out:string)=>sealFencedArchiveFiles(f.b,f.fencePath,f.drainPath,out),
        validate:(out:string)=>validateFencedArchiveFile(out,cohort,window,true),close:()=>{}};
    }
    const c=new ProspectiveCapture(dir,binding,{append(p,s){fs.appendFileSync(p,s);},publish(p,s){fs.writeFileSync(p,s);}});
    c.accept(frame(1,'ACTIVATION'));c.accept(frame(2,'COMMIT',{trades:[fact]}));c.accept(frame(3,'END_FENCE'));
    return {seal:(out:string)=>c.sealToFile(out),validate:(out:string)=>ProspectiveCapture.validateFile(out,cohort,window,true),close:()=>c.close()};
  }
  it('syncs the linked directory before removing pending, syncs cleanup, and refuses overwrite',()=>{
    const dir=fs.mkdtempSync(join(tmpdir(),'poly2-publication-')),f=fixture(dir),out=join(dir,'archive.json');
    try {
      fault.output=out;
      const manifest=f.seal(out);
      expect(fault.checks).toEqual([true,false]);expect(fs.existsSync(out+'.pending')).toBe(false);
      fault.output='';const original=fs.readFileSync(out);expect(f.validate(out).manifest).toEqual(manifest);
      expect(()=>f.seal(out)).toThrow(/EEXIST/);expect(fs.readFileSync(out)).toEqual(original);
      // A failed exclusive link leaves its serialized pending evidence intact.
      expect(fs.readFileSync(out+'.pending')).toEqual(original);
    } finally {fault.output='';f.close();fs.rmSync(dir,{recursive:true,force:true});}
  });
  for(const failAt of [1,2])it('fails conservatively on directory sync '+failAt+'; refuses same-path retry and permits a fresh exclusive path',()=>{
    const dir=fs.mkdtempSync(join(tmpdir(),'poly2-publication-fault-')),f=fixture(dir),out=join(dir,'archive.json');
    try {
      fault.output=out;fault.failAt=failAt;
      let thrown:unknown;
      try {f.seal(out);} catch(error) {thrown=error;}
      expect(thrown).toBe(fault.error);
      expect(fault.checks).toEqual(failAt===1?[true]:[true,false]);
      expect(fs.existsSync(out+'.pending')).toBe(failAt===1);
      const original=fs.readFileSync(out),pending=failAt===1?fs.readFileSync(out+'.pending'):null;
      fault.output='';
      expect(()=>f.seal(out)).toThrow(/EEXIST/);expect(fs.readFileSync(out)).toEqual(original);
      if(pending)expect(fs.readFileSync(out+'.pending')).toEqual(pending);
      const retry=join(dir,'retry.json');fault.output=retry;fault.failAt=0;fault.checks=[];
      const manifest=f.seal(retry);expect(fault.checks).toEqual([true,false]);
      fault.output='';expect(f.validate(retry).manifest).toEqual(manifest);
      expect(fs.readFileSync(retry)).toEqual(original);expect(fs.existsSync(retry+'.pending')).toBe(false);
    } finally {fault.output='';f.close();fs.rmSync(dir,{recursive:true,force:true});}
  });
});
