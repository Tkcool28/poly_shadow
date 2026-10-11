"""Bounded collector projection and adversarial Poly2 diagnostic-only tests."""
from contextlib import closing
import copy
import hashlib
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('instrumented_collector',ROOT/'scripts/status/collector.py')
assert spec and spec.loader
c = importlib.util.module_from_spec(spec); spec.loader.exec_module(c)
START='2030-01-01T00:00:00Z'; END='2030-01-02T00:00:00Z'
def digest(value): return hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest()
class InstrumentationTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root=Path(self.tmp.name); self.target=self.root/'phase4-fixture'; self.target.mkdir()
        self.data=self.target/'shadow-data'; self.data.mkdir()
        self.capture=self.target/'poly2-comparison-capture'; self.capture.mkdir()
        self.window=dict(startUtc=START,endUtc=END)
        self.manifest=dict(state='SEALED_NOT_STARTED',experimentDirectory=str(self.target),shadowSha='a'*40,durationSeconds=86400,window=self.window)
        self.save(self.target/'run-manifest.json',self.manifest)
        self.binding=dict(runId='source-fixture',shadowRunId=self.target.name,window=self.window,expectedWorkers=['backend:one','bot:one'])
        self.fence=dict(version=1,binding=self.binding,bindingSha256=digest(self.binding),state='FROZEN',expectedWorkers=['backend:one','bot:one'],acknowledgements=['backend:one','bot:one'],highWaterMark=4,outstanding=0,lastQueryUtc=END)
        self.drain=dict(version=1,binding=self.binding,bindingSha256=digest(self.binding),state='COMPLETE',counts={'PENDING':0,'CAPTURE_ERROR':0,'DONE':2},frozenCount=2,comparisonEligible=True,latestQueryUtc=END)
        self.save_health()
        with closing(sqlite3.connect(self.capture/'source_fence.sqlite')) as db, db:
            db.execute('CREATE TABLE events(seq INTEGER PRIMARY KEY, body TEXT)')
            for i,w in enumerate(self.fence['expectedWorkers']):
                db.execute('INSERT INTO events VALUES(?,?)',(i,json.dumps(dict(kind='ENROLL',bindingSha256=digest(self.binding),payload=dict(worker=w)))))
    def save(self,path,value): path.write_text(json.dumps(value))
    def save_health(self):
        self.save(self.capture/'poly2_fence_health.json',self.fence); self.save(self.capture/'poly2_drain_health.json',self.drain)
    def status(self): return c.poly2_operational_status(self.target,c.epoch(END)+10)
    def test_bound_enrollment_ack_population_drain_and_archive_diagnostic(self):
        s=self.status(); self.assertEqual(s['closureReadiness'],'DIAGNOSTIC_READY_REQUIRES_ARCHIVE_VALIDATION')
        self.assertEqual(s['enrolledInstances'],['backend:one','bot:one']); self.assertEqual(s['generation'],1)
        self.assertEqual(s['frozenPopulation'],2); self.assertEqual(s['pendingDecisions'],0)
        self.assertEqual(s['lastReconciliationUtcAgeSeconds'],10)
    def test_each_missing_ack_and_enrollment_restart(self):
        for worker in self.fence['expectedWorkers']:
            with self.subTest(worker=worker):
                original=copy.deepcopy(self.fence); self.fence['acknowledgements'].remove(worker); self.save_health()
                self.assertEqual(self.status()['missingAcknowledgements'],[worker]); self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
                self.fence=original
        self.save_health()
        with closing(sqlite3.connect(self.capture/'source_fence.sqlite')) as db, db: db.execute('DELETE FROM events WHERE seq=0')
        self.assertEqual(self.status()['enrolledInstances'],['bot:one']); self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
    def test_adversarial_roster_and_ack_shapes_do_not_crash_or_ready(self):
        mutations=[('expectedWorkers',[{}]),('expectedWorkers',['bot:one']),('expectedWorkers',['backend:one']),('expectedWorkers',['bot:one','bot:one','backend:one']),('expectedWorkers',['bot:../one','backend:one']),('acknowledgements',[{}]),('acknowledgements',['bot:one','bot:one']),('acknowledgements',['rogue:one']),('highWaterMark',True),('highWaterMark',-1),('outstanding',True),('outstanding',-1),('binding',[]),('binding',{'window':[]}),('version',2)]
        original=copy.deepcopy(self.fence)
        for key,value in mutations:
            with self.subTest(key=key,value=value):
                self.fence=copy.deepcopy(original); self.fence[key]=value; self.save_health()
                self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
    def test_drain_wrong_fields_never_ready(self):
        original=copy.deepcopy(self.drain)
        for key,value in [('frozenCount',-1),('frozenCount',True),('counts',[]),('counts',{'PENDING':0}),('counts',{'PENDING':1,'CAPTURE_ERROR':0,'DONE':1}),('counts',{'PENDING':0,'CAPTURE_ERROR':1,'DONE':1}),('counts',{'PENDING':False,'CAPTURE_ERROR':0,'DONE':2}),('bindingSha256','bad'),('comparisonEligible',False)]:
            with self.subTest(key=key,value=value):
                self.drain=copy.deepcopy(original); self.drain[key]=value; self.save_health()
                self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
    def test_duplicate_nonfinite_oversize_symlink_and_misbound_paths_fail_closed(self):
        path=self.capture/'poly2_fence_health.json'
        for raw in ('{"version":1,"version":1}', '{"version":NaN}', ' '* (c.LIMIT+1), '{'):
            path.write_text(raw); self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
        path.unlink(); other=self.root/'outside.json'; self.save(other,self.fence); path.symlink_to(other)
        self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN'); path.unlink(); self.save_health()
        self.fence['binding']['shadowRunId']='other'; self.fence['bindingSha256']=digest(self.fence['binding']); self.save_health()
        self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
    def test_enrollment_symlink_and_wrong_binding_do_not_grant_ready(self):
        path=self.capture/'source_fence.sqlite'; outside=self.root/'outside.sqlite'; path.rename(outside); path.symlink_to(outside)
        self.assertIsNone(self.status()['enrolledInstances']); self.assertEqual(self.status()['closureReadiness'],'UNKNOWN_UNPROVEN')
        path.unlink(); outside.rename(path)
        with closing(sqlite3.connect(path)) as db, db: db.execute("UPDATE events SET body=json_set(body,'$.bindingSha256','wrong')")
        self.assertEqual(self.status()['enrolledInstances'],[])
    def test_whole_run_projection_stale_and_sink_separate_from_dead_process(self):
        row=dict(atUtc=START,operationalSinkBroken=False,dataQuality=dict(state='DEGRADED',rules=['uncertainty']),operationalEvidence=dict(quarantine=dict(total=1605,unresolved=1,oldestUnresolvedAgeSeconds=90000,classBreakdown={'timeout':1}),rest=[dict(source='REST_TRADES',polls=100,consecutiveFailures=11,completeness='UNKNOWN_UNPROVEN')]))
        self.save(self.data/'runtime-memory.json',row)
        fresh=c.operational_status(self.target,c.epoch(START)+10); self.assertEqual(fresh['quality']['state'],'DEGRADED')
        stale=c.operational_status(self.target,c.epoch(START)+100); self.assertEqual(stale['quality']['state'],'UNKNOWN'); self.assertEqual(stale['quarantine']['total'],1605)
        self.save(self.data/'operational-failure.json',dict(code='EVIDENCE_SINK_FAILURE',operationalSinkBroken=True))
        self.assertEqual(c.operational_status(self.target,c.epoch(START)+100)['quality']['state'],'AT_RISK')
    def test_real_collect_disk_state_and_no_raw_chain_reads(self):
        self.save(self.data/'runtime-memory.json',dict(atUtc=START,dataQuality=dict(state='GREEN'),operationalSinkBroken=False))
        result=c.collect(run=self.target,now=c.epoch(START)+10,cache_path=self.root/'cache.json',runs_root=self.root)
        self.assertIn(result['disk']['state'],('GREEN','DEGRADED','AT_RISK')); self.assertGreater(result['disk']['requiredFreeBytes'],c._BUDGET.plan()['alertReserveBytes'])
        self.assertEqual(result['boundedReads']['chainRawBytes'],0)
