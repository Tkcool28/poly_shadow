"""Offline v2 approval and existing-publisher adapter tests; no production calls."""
import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest import mock
ROOT=Path(__file__).resolve().parents[1]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
R=load('stage1_runner_test',ROOT/'scripts/stage1-runner-v2.py')
L=load('stage1_status_test',ROOT/'scripts/status/live_match.py')

class Stage1ApprovalStatus(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup);self.root=Path(self.tmp.name)
        self.window=dict(startUtc='2030-01-01T00:00:00Z',endUtc='2030-01-02T00:00:00Z')
        self.a=dict(version='stage1-v2',approved=True,approvedBy='OFFLINE_FIXTURE',approvedUtc='2029-12-31T00:00:00Z',contractSha256=hashlib.sha256((ROOT/'docs/shadow/PHASE4_COMPARISON_CONTRACT.md').read_bytes()).hexdigest(),runId='phase4-test',shadowSha='a'*40,window=self.window,cohort=R.R.WALLETS)
        self.path=self.root/'approval.json'
    def save(self):
        self.path.write_text(json.dumps(self.a));return hashlib.sha256(self.path.read_bytes()).hexdigest()
    def test_approval_is_explicit_frozen_and_bound(self):
        pin=self.save();self.assertEqual(R.approval(self.path,pin,'phase4-test','a'*40,self.window,R.R.WALLETS),self.a)
        for key,value in [('version','v1'),('approved',False),('approvedBy',''),('shadowSha','b'*40),('contractSha256','0'*64),('approvedUtc',self.window['startUtc']),('runId','other')]:
            original=self.a[key];self.a[key]=value;pin=self.save()
            with self.subTest(key=key),self.assertRaises(ValueError):R.approval(self.path,pin,'phase4-test','a'*40,self.window,R.R.WALLETS)
            self.a[key]=original
        pin=self.save()
        with self.assertRaises(ValueError):R.approval(self.path,'0'*64,'phase4-test','a'*40,self.window,R.R.WALLETS)
    def test_wrapper_refuses_without_approval_before_delegation(self):
        with mock.patch.object(R.os,'execv') as execute:
            with self.assertRaises(SystemExit):R.main(['preflight'])
            execute.assert_not_called()
    def test_status_without_configuration_stays_not_authorized(self):
        with mock.patch.object(L.subprocess,'Popen') as launch:
            result=L.refresh(self.root/'run',self.root/'status-cache.json','2030-01-01T00:40:00Z',self.root/'absent')
            self.assertEqual(result['state'],'COMPARISON_NOT_AUTHORIZED');self.assertIsNone(result['counts']);launch.assert_not_called()
    def test_symlink_projection_cannot_touch_evidence(self):
        run=self.root/'runs/phase4-test';run.mkdir(parents=True);evidence=run/'must-not-change';evidence.write_text('original')
        config=self.root/'config.json';config.write_text(json.dumps(dict(runDirectory=str(run))))
        cache=self.root/'cache.json';cache.with_name(cache.name+'.stage1').symlink_to(run,target_is_directory=True)
        with mock.patch.object(L.subprocess,'Popen') as launch:
            result=L.refresh(run,cache,'2030-01-01T00:40:00Z',config)
            self.assertEqual(result['state'],'MONITOR_UNAVAILABLE');launch.assert_not_called()
        self.assertEqual(evidence.read_text(),'original');self.assertFalse((run/'refresh.lock').exists())
    def test_symlink_lock_refused_without_truncating_target(self):
        run=self.root/'runs/phase4-test';run.mkdir(parents=True);target=run/'evidence';target.write_text('original')
        config=self.root/'config.json';config.write_text(json.dumps(dict(runDirectory=str(run))))
        cache=self.root/'cache.json';directory=cache.with_name(cache.name+'.stage1');directory.mkdir(mode=0o700);(directory/'refresh.lock').symlink_to(target)
        with mock.patch.object(L.subprocess,'Popen') as launch:
            self.assertEqual(L.refresh(run,cache,'2030-01-01T00:40:00Z',config)['state'],'MONITOR_UNAVAILABLE');launch.assert_not_called()
        self.assertEqual(target.read_text(),'original')
    def test_immutable_v1_engine_contract_and_lifecycle_are_unchanged(self):
        for path,digest in [
            ('src/compare/phase4.ts','57126890204c04ec96adbf1fb5f632b3696cb27be86d42019124aaf0eac34f4b'),
            ('scripts/phase4-runner.py','15b0628fad53ca3d9ffa459409c3c4302febb3d725485f426a1c58bb29eaf065'),
            ('docs/shadow/PHASE4_COMPARISON_CONTRACT_V1_FROZEN.md','8dfefea8621189892905f0bf29e64310549e51c16d9b7fa325e67f9c19b0955e'),
        ]:
            self.assertEqual(hashlib.sha256((ROOT/path).read_bytes()).hexdigest(),digest)

    def test_dashboard_labels_provisional_and_traces_safe_text(self):
        html=(ROOT/'scripts/status/index.html').read_text()
        for phrase in ['PROVISIONAL','Confirmed high-confidence pairs','Probable pairs (not confirmed)','Retrospective / recovery','STale'.upper(),'poly2Ref','shadowRefs']:
            self.assertIn(phrase,html)
        self.assertNotIn('innerHTML',html)

if __name__=='__main__':unittest.main()
