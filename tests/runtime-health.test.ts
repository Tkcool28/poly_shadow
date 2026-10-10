import { mkdtempSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { RacingStore, Reconciler } from '../src/shadow/racing.js';
import { RestPoller } from '../src/shadow/rest-poller.js';
import { OperationalEvidence } from '../src/shadow/operational-evidence.js';
import { runtimeHealthSnapshot } from '../src/shadow/runtime-health.js';
import { startMemoryPublisher } from '../src/shadow/runtime-memory.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const directory = () => { const d = mkdtempSync(join(tmpdir(), 'runtime-health-')); dirs.push(d); return d; };
const quarantine = (e: OperationalEvidence, id: string) => e.quarantine({ quarantineId:id, component:'CHAIN', source:'CHAIN', sourceIdentity:null, rawEvidenceRef:null, rpcRequestId:null, errorClass:'TIMEOUT', reason:'fixture', eventIdentityKnown:false, wallet:null, txHash:null, logIdentity:null, affectedRange:null, scientificImpactPossible:true });
const publish = (d: string, e: OperationalEvidence) => {
  const p = startMemoryPublisher(d, () => runtimeHealthSnapshot(
    { memoryTelemetry: () => ({ lastProgressUtc: new Date().toISOString(), retryQueue:0 }) },
    { indexTelemetry: () => ({ racingIndexInvalid:false }) }, e, () => ({ pid:123 }),
  ));
  p.stop();
  return JSON.parse(readFileSync(join(d, 'runtime-memory.json'), 'utf8'));
};

it('shared runtime publisher uses persisted unresolved quarantine and resolution counts after rebuild', () => {
  const d = directory(); let e = new OperationalEvidence(d);
  for (let i=0; i<10; i++) quarantine(e, `q-${i}`);
  e.close(); unlinkSync(join(d, 'operational-index.sqlite')); e = new OperationalEvidence(d);
  let snapshot = publish(d,e);
  expect(snapshot.unresolvedQuarantine).toBe(10);
  expect(snapshot.failureClass).toBe('SOURCE_FAILURE');
  expect(snapshot.dataQuality).toEqual({state:'AT_RISK',rules:['unresolved quarantine count >= 10']});
  for (let i=0; i<10; i++) e.resolveQuarantine(`q-${i}`, 'RECOVERED', 'obs', 'OBSERVED', false);
  snapshot = publish(d,e);
  expect(snapshot.unresolvedQuarantine).toBe(0);
  expect(snapshot.failureClass).toBeNull();
  expect(snapshot.dataQuality.state).not.toBe('AT_RISK');
  e.close();
});

it('shared runtime publisher retains indexed REST page-limit and unproven completeness across later polls and restart', () => {
  const d = directory(); let e = new OperationalEvidence(d);
  e.restReceipt({source:'REST_TRADES', wallet:'wallet', atApiLimit:true, pagination:'UNSUPPORTED_UNPROVEN'});
  for (let i=0; i<300; i++) e.restReceipt({source:'REST_ACTIVITY', wallet:'wallet', atApiLimit:false, pagination:'UNSUPPORTED_UNPROVEN'});
  e.close(); unlinkSync(join(d, 'operational-index.sqlite')); e = new OperationalEvidence(d);
  const snapshot = publish(d,e);
  expect(snapshot.restAtPageLimit).toBe(true);
  expect(snapshot.restCompletenessUnproven).toBe(true);
  expect(snapshot.dataQuality).toEqual({state:'DEGRADED', rules:[
    'REST page at configured limit; completeness unproven; matched overlap alone is insufficient', 'REST pagination completeness unproven',
  ]});
  e.close();
});

it('actual REST poll receipts feed shared runtime health for both sources without completeness inference', async () => {
  const d=directory(), e=new OperationalEvidence(d), store=new RacingStore(d), rec=new Reconciler(store);
  for (const source of ['REST_TRADES','REST_ACTIVITY'] as const) {
    const p=new RestPoller({source,endpoint:source==='REST_TRADES'?'trades':'activity',baseUrl:'https://data-api.test',wallets:new Set(['0x'+'ab'.repeat(20)]),intervalMs:1000},store,rec,undefined,
      async () => ({status:200,body:[],headers:{age:null,cacheControl:null,etag:null,date:null}}),e);
    await p.pollAll(); p.stop();
  }
  const snapshot=publish(d,e);
  expect(snapshot.restAtPageLimit).toBe(false);
  expect(snapshot.dataQuality).toEqual({state:'DEGRADED',rules:['REST pagination completeness unproven']});
  store.close();e.close();
});

it('REST health cache remains constant size and digest checkpoints grow geometrically', () => {
  const d=directory(), e=new OperationalEvidence(d);
  const digest=vi.spyOn(e as unknown as {indexDigest():string},'indexDigest');
  for(let i=0;i<2048;i++)e.restReceipt({source:'REST_TRADES',atApiLimit:i===0,pagination:'UNSUPPORTED_UNPROVEN'});
  expect(digest.mock.calls.length).toBeLessThanOrEqual(5);
  const db=new DatabaseSync(join(d,'operational-index.sqlite'));
  expect(db.prepare('SELECT count(*) n FROM rest_quality').get()?.n).toBe(1);
  db.close();e.close();
});

it.each(['before-authoritative-append','after-authoritative-append'] as const)('REST health rebuild reflects only committed receipt after %s fault', point => {
  const d=directory(), failure=Error('REST index fixture');
  const e=new OperationalEvidence(d,undefined,{fault:(at,name)=>{if(at===point && name==='rest_poll_receipts.ndjson')throw failure;}});
  expect(()=>e.restReceipt({source:'REST_TRADES',atApiLimit:true,pagination:'UNSUPPORTED_UNPROVEN'})).toThrow(failure);
  const rebuilt=new OperationalEvidence(d);
  expect(publish(d,rebuilt).restAtPageLimit).toBe(point==='after-authoritative-append');
  rebuilt.close();
});

it('REST health semantic cache corruption is discarded without changing authoritative receipts', () => {
  const d=directory();let e=new OperationalEvidence(d);
  e.restReceipt({source:'REST_TRADES',atApiLimit:true,pagination:'UNSUPPORTED_UNPROVEN'});e.close();
  const before=readFileSync(join(d,'rest_poll_receipts.ndjson'),'utf8'),db=new DatabaseSync(join(d,'operational-index.sqlite'));
  db.prepare('UPDATE rest_quality SET row=?').run(JSON.stringify({restAtPageLimit:false,restCompletenessUnproven:false}));db.close();
  e=new OperationalEvidence(d);
  expect(e.indexStatus().rebuildReason).toBe('SEMANTIC_MISMATCH');
  expect(publish(d,e).restAtPageLimit).toBe(true);
  expect(readFileSync(join(d,'rest_poll_receipts.ndjson'),'utf8')).toBe(before);e.close();
});

it('shared runtime publisher exposes broken sink without querying its closed index', () => {
  const d = directory(); const failure = Error('ENOSPC health fixture');
  const e = new OperationalEvidence(d, undefined, {fault: () => {throw failure;}});
  expect(() => quarantine(e,'broken')).toThrow(failure);
  const snapshot = publish(d,e);
  expect(snapshot.unresolvedQuarantine).toBeNull();
  expect(snapshot.failureClass).toBe('EVIDENCE_SINK_FAILURE');
  expect(snapshot.dataQuality).toEqual({state:'AT_RISK',rules:['EVIDENCE_SINK_FAILURE']});
});
