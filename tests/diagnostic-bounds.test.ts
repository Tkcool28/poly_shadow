import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readNdjson } from '../src/compare/ndjson.js';

const roots:string[]=[];
function fixture(){const dir=mkdtempSync(join(tmpdir(),'diagnostic-ndjson-'));roots.push(dir);return dir}
afterEach(()=>{for(const dir of roots.splice(0))rmSync(dir,{recursive:true,force:true})});

it('enforces byte, record, and line bounds while streaming',async()=>{
 const dir=fixture(),path=join(dir,'rows.ndjson');writeFileSync(path,'{"a":1}\n{"b":2}\n');
 async function collect(limits:Parameters<typeof readNdjson>[2]){const rows=[];for await(const row of readNdjson(path,8,limits))rows.push(row);return rows}
 await expect(collect({maxBytes:8})).rejects.toThrow('byte limit');
 await expect(collect({maxRows:1})).rejects.toThrow('row limit');
 await expect(collect({maxLineBytes:4})).rejects.toThrow('line limit');
 expect(await collect({maxBytes:64,maxRows:2,maxLineBytes:16})).toHaveLength(2);
});

it('refuses symlinked evidence inputs',async()=>{
 const dir=fixture(),real=join(dir,'real.ndjson'),link=join(dir,'link.ndjson');writeFileSync(real,'{"a":1}\n');symlinkSync(real,link);
 const rows:unknown[]=[];await expect((async()=>{for await(const row of readNdjson(link))rows.push(row)})()).rejects.toThrow();
 expect(rows).toHaveLength(0);
});
it('live snapshots omit an uncommitted tail while default final evidence remains strict',async()=>{
 const dir=fixture(),path=join(dir,'live.ndjson');writeFileSync(path,'{"committed":true}\n{"partial":');
 const live:unknown[]=[];for await(const row of readNdjson(path,8,{freezeAtOpen:true,allowIncompleteTail:true}))live.push(row);
 expect(live).toEqual([{committed:true}]);
 await expect((async()=>{for await(const _ of readNdjson(path)){} })()).rejects.toThrow('malformed NDJSON');
});
