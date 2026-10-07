import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
spec=importlib.util.spec_from_file_location('collector',Path(__file__).resolve().parents[1]/'scripts/status/collector.py')
assert spec and spec.loader
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
class MemoryTests(unittest.TestCase):
 def test_missing_is_unknown(self):
  with tempfile.TemporaryDirectory() as d:
   m=c.memory_status(Path(d),{},1000)
   self.assertIsNone(m['rssBytes']);self.assertIsNone(m['pressureRatio']);self.assertEqual(m['status'],'unknown')
 def test_verified_fields_and_limit_warnings(self):
  with tempfile.TemporaryDirectory() as d:
   token={'pid':123,'startTicks':'7','pgid':123,'session':123}
   (Path(d)/'shadow-data').mkdir()
   (Path(d)/'shadow-data/runtime-memory.json').write_text(json.dumps(dict(token=token,atUtc=c.utc(1000),rssBytes=5,heapUsedBytes=4,cgroupUsageBytes=90,cgroupLimitBytes=100,replayActive=True,replayRows=42,lastProgressUtc=c.utc(800),inflight=2,retryQueue=3,secret='DO NOT EXPORT')))
   with patch.object(c,'process_status',return_value={'alive':True,'identityVerified':True}),patch.object(c,'proc',return_value=dict(token,ppid=1,state='S')):
    m=c.memory_status(Path(d),token,1000)
   self.assertEqual(m['pressureRatio'],.9);self.assertIn('cgroup memory usage >= 85% of actual limit',m['warnings']);self.assertIn('replay progress stalled > 90s',m['warnings']);self.assertNotIn('secret',str(m));self.assertEqual(m['replayRows'],42)
   with patch.object(c,'process_status',return_value={'alive':False,'identityVerified':False}):
    m=c.memory_status(Path(d),token,1000)
   self.assertIsNone(m['rssBytes']);self.assertIsNone(m['pressureRatio'])
 def test_index_progress_fields_and_stall(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'shadow-data').mkdir()
   token={'pid':123,'startTicks':'7','pgid':123,'session':123}
   row=dict(token=token,atUtc=c.utc(1000),indexRows=256,indexInvalid=True,racingIndexInvalid=False,indexRebuildActive=True,indexFile='raw_logs.ndjson',indexLastProgressUtc=c.utc(800),racingIndexRows=512,racingIndexRebuildActive=True,racingIndexFile='reconciliation.ndjson',racingIndexLastProgressUtc=c.utc(990))
   (root/'shadow-data/runtime-memory.json').write_text(json.dumps(row))
   with patch.object(c,'process_status',return_value={'alive':True}),patch.object(c,'proc',return_value=dict(token,ppid=1,state='S')):
    m=c.memory_status(root,token,1000)
   self.assertEqual(m['indexRows'],256);self.assertEqual(m['racingIndexRows'],512)
   self.assertTrue(m['indexInvalid']);self.assertFalse(m['racingIndexInvalid'])
   self.assertIn('index invalid; fail-stopped until authorized reopen/rebuild',m['warnings'])
   self.assertEqual(m['indexFile'],'raw_logs.ndjson');self.assertEqual(m['indexProgressAgeSeconds'],200)
   self.assertIn('index rebuild progress stalled > 90s',m['warnings'])
   self.assertNotIn('racing index rebuild progress stalled > 90s',m['warnings'])
 def test_public_collect_field(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);run=root/'phase4-synthetic';run.mkdir();(run/'shadow-data').mkdir()
   start=100000
   (run/'run-manifest.json').write_text(json.dumps(dict(state='SEALED_NOT_STARTED',experimentDirectory=str(run),shadowSha='a'*40,durationSeconds=86400,window=dict(startUtc=c.utc(start),endUtc=c.utc(start+86400)))))
   result=c.collect(run,now=start-1,runs_root=root,cache_path=root/'cache.json',health_provider=lambda:{})
   self.assertIn('memory',result);self.assertEqual(result['memory']['status'],'unknown');self.assertIsNone(result['memory']['cgroupLimitBytes'])
 def test_ui_card(self):
  html=(Path(__file__).resolve().parents[1]/'scripts/status/index.html').read_text()
  self.assertIn('Runtime memory',html);self.assertIn('cgroupUsageBytes',html);self.assertIn('replayRows',html)
 def test_stale_unlimited_malformed_and_symlink(self):
  with tempfile.TemporaryDirectory() as d:
   root=Path(d);(root/'shadow-data').mkdir();p=root/'shadow-data/runtime-memory.json'
   token={'pid':123,'startTicks':'7','pgid':123,'session':123}
   row=dict(token=token,atUtc=c.utc(1000),rssBytes=True,heapUsedBytes=-1,cgroupUsageBytes=100,cgroupLimitBytes=None,replayRows='secret')
   p.write_text(json.dumps(row))
   with patch.object(c,'process_status',return_value={'alive':True,'identityVerified':True}),patch.object(c,'proc',return_value=dict(token,ppid=1,state='S')):
    m=c.memory_status(root,token,1000)
    self.assertIsNone(m['pressureRatio']);self.assertIsNone(m['rssBytes']);self.assertIsNone(m['heapUsedBytes']);self.assertIsNone(m['replayRows'])
    m=c.memory_status(root,token,1040)
    self.assertEqual(m['status'],'unknown');self.assertIsNone(m['rssBytes']);self.assertTrue(m['warnings'])
   secret=root/'unrelated';secret.write_text(json.dumps(row));p.unlink();p.symlink_to(secret)
   self.assertEqual(c.obj(p),{})
 def test_real_pid_start_tick_reuse_is_rejected(self):
  import os
  token=c.proc(os.getpid());self.assertIsNotNone(token)
  self.assertTrue(c.process_status(token)['identityVerified'])
  token['startTicks']=str(int(token['startTicks'])+1)
  self.assertFalse(c.process_status(token)['identityVerified'])
 def test_no_secrets_or_process_enumeration_in_collector(self):
  source=(Path(__file__).resolve().parents[1]/'scripts/status/collector.py').read_text()
  self.assertNotIn("/environ",source);self.assertNotIn("/cmdline",source)
  self.assertNotIn('production_snapshot()',source);self.assertNotIn("Path('/proc').iterdir()",source)
if __name__=='__main__':unittest.main()
