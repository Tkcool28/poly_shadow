"""Synthetic-only binding regressions; never reads an operational pointer."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('binding_collector', Path(__file__).resolve().parents[1] / 'scripts/status/collector.py')
assert spec and spec.loader
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
SHA = 'a' * 40
START = '2030-01-01T00:00:00Z'
END = '2030-01-02T00:00:00Z'

class BindingTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.targets = self.root / 'runs'; self.targets.mkdir()
        self.target = self.targets / 'phase4-synthetic'; self.target.mkdir()
        (self.target / 'shadow-data').mkdir()
        self.pointer = self.root / 'current-run.json'
        self.manifest = dict(state='SEALED_NOT_STARTED', experimentDirectory=str(self.target), shadowSha=SHA,
                             durationSeconds=86400, window=dict(startUtc=START, endUtc=END))
        self.binding = dict(schemaVersion=1, runDirectory=str(self.target), runId=self.target.name,
                            approvedShadowSha=SHA, startUtc=START, endUtc=END, lifecycleState='AUTHORIZED')
        self.save()
    def save(self):
        (self.target / 'run-manifest.json').write_text(json.dumps(self.manifest))
        self.pointer.write_text(json.dumps(self.binding))
    def collect(self, **kw):
        return c.collect(now=c.epoch(START)-1, cache_path=self.root/'cache.json', health_provider=lambda:{},
                         pointer_path=self.pointer, runs_root=self.targets, **kw)
    def unknown(self, result, state='INVALID_BINDING'):
        self.assertEqual(result['state'], state)
        self.assertFalse(result['currentActive'])
        self.assertIsNone(result['window']['startUtc'])
        self.assertIsNone(result['shadowSha'])
        self.assertEqual(result['memory']['status'], 'unknown')
        for key in ('rssBytes', 'replayRows', 'indexRows', 'blockCache', 'matchedCache', 'aggregateCache', 'exclusiveDepth', 'filteredLogs'):
            self.assertIsNone(result['memory'][key])
    def test_missing_pointer_no_fallback(self):
        self.pointer.unlink(); self.unknown(self.collect(), 'NO_ACTIVE_RUN')
    def test_valid_authorized_binding(self):
        result=self.collect()
        self.assertEqual(result['shadowSha'], SHA); self.assertEqual(result['state'], 'SEALED')
        self.assertEqual(result['window']['startUtc'], START); self.assertFalse(result['currentActive'])
        self.assertEqual(result['binding']['status'], 'VALID')
    def test_pointer_mismatches(self):
        for field, value in [('approvedShadowSha','b'*40),('approvedShadowSha','g'*40),('runId','wrong'),('endUtc','2030-01-03T00:00:00Z'),('startUtc','2030-01-01T01:00:00+01:00'),('schemaVersion',True),('lifecycleState','INACTIVE')]:
            with self.subTest(field=field):
                old=self.binding[field]; self.binding[field]=value; self.save()
                self.unknown(self.collect()); self.binding[field]=old
    def test_manifest_mismatches(self):
        for field,value in [('experimentDirectory',str(self.targets)),('shadowSha','b'*40),('state','RUNNING'),('durationSeconds',1)]:
            with self.subTest(field=field):
                old=self.manifest[field];self.manifest[field]=value;self.save()
                self.unknown(self.collect());self.manifest[field]=old
    def test_missing_invalid_and_symlink_manifest(self):
        p=self.target/'run-manifest.json';p.unlink();self.unknown(self.collect())
        self.save();(self.target/'INVALID').touch();self.unknown(self.collect());(self.target/'INVALID').unlink()
        p.rename(self.root/'manifest');p.symlink_to(self.root/'manifest');self.unknown(self.collect())
    def test_malformed_duplicate_nonfinite_oversize_pointer(self):
        for raw in ('{', '{"schemaVersion":1,"schemaVersion":1}', '{"x":NaN}', ' '* (c.LIMIT+1)):
            self.pointer.write_text(raw);self.unknown(self.collect())
    def test_pointer_and_directory_symlinks(self):
        self.pointer.rename(self.root/'other');self.pointer.symlink_to(self.root/'other');self.unknown(self.collect())
        self.pointer.unlink();self.save();self.target.rename(self.targets/'real');self.target.symlink_to(self.targets/'real',target_is_directory=True);self.unknown(self.collect())
    def test_unsafe_paths_and_missing_directory(self):
        for value in (str(self.root/'outside'), str(self.targets/'missing'), str(self.targets/'x'/'..'/self.target.name), 'relative'):
            self.binding['runDirectory']=value;self.save();self.unknown(self.collect())
    def test_historical_explicit_uses_manifest_without_pointer(self):
        self.pointer.write_text('{')
        result=self.collect(run=self.target)
        self.assertEqual(result['shadowSha'],SHA);self.assertEqual(result['window']['endUtc'],END)
        self.assertTrue(result['historical']);self.assertFalse(result['currentActive'])
        self.assertEqual(result['memory']['status'],'unknown')
    def test_ended_and_terminal_never_expose_live_memory(self):
        for terminal in (False,True):
            self.save()
            if terminal:(self.target/'REPORT_FAILED.json').write_text('{}')
            with patch.object(c,'memory_status',side_effect=AssertionError('must not sample inactive memory')):
                result=c.collect(now=c.epoch(END)+1,cache_path=self.root/'cache.json',health_provider=lambda:{},pointer_path=self.pointer,runs_root=self.targets)
            self.assertTrue(result['historical']);self.assertFalse(result['currentActive']);self.assertEqual(result['memory']['status'],'unknown')
    def test_active_binding_and_terminal_before_end(self):
        token=dict(pid=123,startTicks='7',pgid=123,session=123)
        (self.target/'launch-receipt.json').write_text(json.dumps(dict(childToken=token)))
        now=c.epoch(START)+10
        (self.target/'shadow-data/runtime-memory.json').write_text(json.dumps(dict(token=token,atUtc=c.utc(now),rssBytes=12,blockCache=4,matchedCache=3,aggregateCache=2,exclusiveDepth=1,filteredLogs=5)))
        with patch.object(c,'process_status',return_value=dict(alive=True,identityVerified=True,pid=123)),patch.object(c,'proc',return_value=dict(token,ppid=1,state='S')):
            result=c.collect(now=now,cache_path=self.root/'cache.json',health_provider=lambda:{},pointer_path=self.pointer,runs_root=self.targets)
            self.assertTrue(result['currentActive']);self.assertEqual(result['memory']['rssBytes'],12)
            self.assertEqual(result['memory']['blockCache'],4)
            (self.target/'REPORT_FAILED.json').write_text('{}')
            result=c.collect(now=now,cache_path=self.root/'cache.json',health_provider=lambda:{},pointer_path=self.pointer,runs_root=self.targets)
            self.assertTrue(result['historical']);self.assertFalse(result['currentActive']);self.assertIsNone(result['memory']['rssBytes'])
    def test_manifest_window_and_shadow_data_symlink(self):
        self.manifest['window']['endUtc']='2030-01-02T00:00:01Z';self.save();self.unknown(self.collect())
        self.manifest['window']['endUtc']=END;self.save()
        (self.target/'shadow-data').rmdir();(self.root/'outside-data').mkdir()
        (self.target/'shadow-data').symlink_to(self.root/'outside-data',target_is_directory=True)
        self.unknown(self.collect())
    def test_pointer_exact_seven_fields(self):
        original = dict(self.binding)
        for field in original:
            with self.subTest(missing=field):
                self.binding = dict(original)
                del self.binding[field]
                self.save()
                self.unknown(self.collect())
        self.binding = dict(original, extra='unexpected')
        self.save()
        self.unknown(self.collect())
        raw = json.dumps(original)
        self.pointer.write_text(raw[:-1] + ', "runId": ' + json.dumps(original['runId']) + '}')
        self.unknown(self.collect())
        # Publisher accepts lowercase full SHAs only; reader must agree even
        # when both pointer and manifest contain the same uppercase digest.
        self.binding = dict(original, approvedShadowSha=SHA.upper())
        self.manifest['shadowSha'] = SHA.upper()
        self.save()
        self.unknown(self.collect())

    def test_public_whitelist(self):
        self.binding['secret']='DO NOT EXPORT'; self.manifest['secret']='DO NOT EXPORT';self.save()
        result = self.collect()
        self.unknown(result)
        self.assertNotIn('DO NOT EXPORT',json.dumps(result))
    def test_dashboard_contract(self):
        html=(Path(__file__).resolve().parents[1]/'scripts/status/index.html').read_text()
        for value in ('blockCache','matchedCache','aggregateCache','exclusiveDepth','filteredLogs','indexed incomplete identities examined','NO_ACTIVE_RUN','INVALID_BINDING','invalidateLiveMemory'):
            self.assertIn(value,html)

if __name__ == '__main__': unittest.main()
