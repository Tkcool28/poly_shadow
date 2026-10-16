import {describe,it,expect,vi} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildShadowGroups} from '../src/compare/phase4.js';
import type {SourceObservationRow} from '../src/shadow/racing.js';

const verify=vi.fn();
vi.mock('../research/v2-cursor-v1/replay.js',()=>({analyze:(dir:string,strict:boolean)=>verify(dir,strict)}));
import {readVerifiedV2Groups} from '../src/compare/v2-research-bridge.js';

const wallet='0x'+'aa'.repeat(20);
const other='0x'+'bb'.repeat(20);
const window={startUtc:'2026-01-01T00:00:00.000Z',endUtc:'2026-01-02T00:00:00.000Z'};
const cohort=(w:string)=>w===wallet?'CONTROLLED_OVERLAP' as const:w===other?'SHADOW_EXPLORATORY' as const:null;
const observation=(over:Partial<SourceObservationRow>={}):SourceObservationRow=>({
 source:'REST_TRADES',identity:'rest-trades:example',wallet,side:'BUY',asset:'123',
 size:'1.000000',price:'0.5000',sourceTs:1767261600,blockTimestamp:null,
 sourceFirstSeenUtc:'2026-01-01T10:00:00.000Z',
 completedUtc:'2026-01-01T10:00:00.003Z',role:'UNKNOWN',
 groupKey:'econ:0xabc:123:1.000000',hydration:'FULL',...over
});
async function withRows(rows:unknown[],test:(dir:string)=>Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'v2-bridge-'));
 try{writeFileSync(join(dir,'observations.ndjson'),rows.map(r=>JSON.stringify(r)).join('\n')+'\n');await test(dir)}
 finally{rmSync(dir,{recursive:true,force:true})}
}
const wrap=(normalized:SourceObservationRow)=>({
 source:normalized.source==='REST_TRADES'?'trades':'activity',
 identity:normalized.identity,traversal:'trades:'+wallet,page:0,
 row:{payload:{},normalizationUtc:normalized.completedUtc,normalized}
});

describe('v2 research evidence bridge',()=>{
 it('requires the strict existing replay verifier before reading publications',async()=>{
  verify.mockImplementationOnce(()=>{throw Error('RESPONSE_HASH_MISMATCH')});
  await withRows([wrap(observation())],async dir=>{
   await expect(readVerifiedV2Groups(dir,cohort,window)).rejects.toThrow('RESPONSE_HASH_MISMATCH');
  });
  expect(verify).toHaveBeenCalledWith(expect.any(String),true);
 });
 it('reduces measured clocks and identities using the existing frozen group reducer',async()=>{
  verify.mockReturnValue({completeness:'UNKNOWN_UNPROVEN'});
  const rows=[observation(),observation({wallet:other,identity:'excluded',groupKey:'excluded'}),observation({identity:'late',groupKey:'late',sourceFirstSeenUtc:'2026-01-03T00:00:00.000Z',completedUtc:'2026-01-03T00:00:00.003Z'})];
  await withRows(rows.map(wrap),async dir=>{
   const actual=await readVerifiedV2Groups(dir,cohort,window);
   const expected=buildShadowGroups(rows,cohort,window);
   expect([...actual.entries()]).toEqual([...expected.entries()]);
   expect(actual.get(rows[0]!.groupKey)?.rawUtc).toBe(rows[0]!.sourceFirstSeenUtc);
   expect(actual.get(rows[0]!.groupKey)?.usableUtc).toBe(rows[0]!.completedUtc);
  });
 });
 it('rejects altered publication identity and measured normalization clock',async()=>{
  verify.mockReturnValue({completeness:'UNKNOWN_UNPROVEN'});
  await withRows([{...wrap(observation()),identity:'tampered'}],async dir=>{
   await expect(readVerifiedV2Groups(dir,cohort,window)).rejects.toThrow('V2_BRIDGE_IDENTITY_OR_CLOCK_MISMATCH');
  });
  const tampered=wrap(observation());tampered.row.normalizationUtc='2026-01-01T10:00:00.009Z';
  await withRows([tampered],async dir=>{
   await expect(readVerifiedV2Groups(dir,cohort,window)).rejects.toThrow('V2_BRIDGE_IDENTITY_OR_CLOCK_MISMATCH');
  });
 });
 it('rejects backward clocks and attempts to claim verified completeness',async()=>{
  verify.mockReturnValue({completeness:'UNKNOWN_UNPROVEN'});
  await withRows([wrap(observation({completedUtc:'2026-01-01T09:59:59.000Z'}))],async dir=>{
   await expect(readVerifiedV2Groups(dir,cohort,window)).rejects.toThrow('V2_BRIDGE_IDENTITY_OR_CLOCK_MISMATCH');
  });
  verify.mockReturnValue({completeness:'COMPLETE'});
  await withRows([wrap(observation())],async dir=>{
   await expect(readVerifiedV2Groups(dir,cohort,window)).rejects.toThrow('V2_BRIDGE_UNEXPECTED_COMPLETENESS');
  });
 });
});
