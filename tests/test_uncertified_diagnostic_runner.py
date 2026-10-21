import importlib.util
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'uncertified-diagnostic-runner.py'
spec = importlib.util.spec_from_file_location('diagnostic_runner', PATH)
assert spec and spec.loader
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class Clock:
    def __init__(self): self.value = 0.0
    def monotonic(self): return self.value
    def sleep(self, seconds): self.value += seconds


class FakeChild:
    pid = 765432
    def __init__(self, *, exit_code=None): self.returncode = exit_code; self.waits = []
    def poll(self): return self.returncode
    def wait(self, timeout=None):
        self.waits.append(timeout)
        if self.returncode is None: raise subprocess.TimeoutExpired('collector', timeout)
        return self.returncode


class RunnerTests(unittest.TestCase):
    def test_dashboard_publication_default_matches_static_panel_url(self):
        html = (runner.ROOT / 'scripts/status/index.html').read_text()
        self.assertEqual(str(runner.DEFAULT_DASHBOARD_SUMMARY), '/var/www/poly-shadow-status/diagnostic-comparison/summary.json')
        self.assertIn("fetch('diagnostic-comparison/summary.json'", html)

    def test_timestamp_helpers_require_timezone_and_preserve_exact_interval(self):
        start = '2026-10-19T00:00:00.123456Z'
        self.assertEqual(runner.add_seconds(start, 60), '2026-10-19T00:01:00.123456Z')
        with self.assertRaises(ValueError): runner.parse_utc('2026-10-19T00:00:00')

    def test_window_periodically_checks_storage_and_aborts_on_budget_state(self):
        class WaitChild:
            def __init__(self,clock): self.clock=clock
            def wait(self,timeout): self.clock.value+=timeout; raise subprocess.TimeoutExpired('collector',timeout)
        clock=Clock(); calls=[]
        result=runner.wait_for_window(WaitChild(clock),1.1,monotonic=clock.monotonic,wall=lambda:'END',check_storage=lambda:calls.append(clock.value),check_interval=0.4)
        self.assertFalse(result['early']); self.assertGreaterEqual(len(calls),2)
        clock=Clock()
        def blocked(): raise RuntimeError('STORAGE_BUDGET_EXHAUSTED')
        with self.assertRaisesRegex(RuntimeError,'STORAGE_BUDGET_EXHAUSTED'):
            runner.wait_for_window(WaitChild(clock),2,monotonic=clock.monotonic,check_storage=blocked,check_interval=0.1)

    def test_real_process_group_termination_includes_descendant(self):
        import sys
        import time
        child_code="import subprocess,sys,time; subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)']); time.sleep(30)"
        child=subprocess.Popen([sys.executable,'-c',child_code],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        time.sleep(0.1)
        self.assertTrue(runner.process_group_alive(child.pid))
        runner.stop_process_group(child,grace_seconds=2)
        self.assertFalse(runner.process_group_alive(child.pid))
        self.assertIsNotNone(child.returncode)

    def test_forbidden_certified_targets_are_rejected(self):
        for target in runner.FORBIDDEN_OUTPUTS:
            with self.subTest(target=target), self.assertRaises(ValueError):
                runner.assert_isolated_path(target)

    def test_storage_preflight_accepts_only_green_gate(self):
        good = types.SimpleNamespace(returncode=0, stdout='{"state":"GREEN","gate":"PASS"}\n')
        with patch.object(runner.subprocess, 'run', return_value=good), patch.object(runner,'resource_envelope',return_value={'enforcement':'FIXTURE'}):
            state = runner.storage_preflight(Path('/fixture/repo'), Path('/fixture/run/data'))
        self.assertEqual(state['state'], 'GREEN')
        denied = types.SimpleNamespace(returncode=7, stdout='{"state":"DEGRADED","gate":"FAIL"}\n')
        with patch.object(runner.subprocess, 'run', return_value=denied), self.assertRaisesRegex(RuntimeError, 'STORAGE_PREFLIGHT_BLOCKED'):
            runner.storage_preflight(Path('/fixture/repo'), Path('/fixture/run/data'))
        unavailable = types.SimpleNamespace(returncode=0, stdout='not-json')
        with patch.object(runner.subprocess, 'run', return_value=unavailable), self.assertRaisesRegex(RuntimeError, 'STORAGE_PREFLIGHT_UNAVAILABLE'):
            runner.storage_preflight(Path('/fixture/repo'), Path('/fixture/run/data'))

    def test_window_uses_monotonic_deadline_and_reports_early_collector_exit(self):
        class WaitChild:
            def __init__(self, clock, exit_after=None): self.clock=clock; self.exit_after=exit_after; self.calls=0
            def wait(self, timeout):
                self.calls += 1
                if self.exit_after is not None and self.calls >= self.exit_after: return 1
                self.clock.value += timeout
                raise subprocess.TimeoutExpired('collector', timeout)
        clock = Clock()
        child = WaitChild(clock)
        normal = runner.wait_for_window(child, 0.6, monotonic=clock.monotonic, wall=lambda:'END')
        self.assertEqual(normal, {'endedUtc':'END','early':False,'interrupted':False})
        clock = Clock()
        early = runner.wait_for_window(WaitChild(clock, exit_after=1), 60, monotonic=clock.monotonic, wall=lambda:'EXIT')
        self.assertEqual(early, {'endedUtc':'EXIT','early':True,'interrupted':False})

    def test_stop_signals_descendants_and_escalates_if_group_stays_alive(self):
        clock=Clock(); child=FakeChild(exit_code=0); signals=[]; checks={'count':0}
        def live(pgid): checks['count']+=1; return checks['count']==1
        runner.stop_process_group(child, grace_seconds=1, killpg=lambda pgid,sig:signals.append(sig), group_alive=live, monotonic=clock.monotonic, sleep=clock.sleep)
        self.assertEqual(signals,[runner.signal.SIGTERM])
        clock=Clock(); child=FakeChild(); signals=[]; state={'killed':False}
        def killpg(pgid,sig):
            signals.append(sig)
            if sig==runner.signal.SIGKILL: state['killed']=True; child.returncode=-9
        def alive(pgid): return not state['killed']
        runner.stop_process_group(child, grace_seconds=0.1, killpg=killpg, group_alive=alive, monotonic=clock.monotonic, sleep=clock.sleep)
        self.assertEqual(signals,[runner.signal.SIGTERM,runner.signal.SIGKILL])

    def execute_run(self, tmp, *, interrupted=False, early=False, launch_error=False, export_error=False, late_exit=False):
        repo=runner.ROOT; poly_repo=Path(tmp)/'poly2'; poly_repo.mkdir()
        run_root=Path(tmp)/'runs'; start='2026-10-19T00:00:00.000000Z'
        before={'imageId':'sha256:'+'a'*64,'revisionLabel':runner.EXPECTED_POLY2_SHA,'flags':runner.REQUIRED_FLAGS.copy()}
        highs=[{'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'mode':'preflight','cohort':list(runner.WALLETS),'approvedWallets':list(runner.WALLETS),'tradeIdHighWater':5,'decisionLogIdHighWater':3},
               {'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'mode':'preflight','cohort':list(runner.WALLETS),'approvedWallets':list(runner.WALLETS),'tradeIdHighWater':8,'decisionLogIdHighWater':7}]
        args=types.SimpleNamespace(repo=repo,poly2_repo=poly_repo,run_root=run_root,poly2_container='fake-backend',duration_seconds=60,publish_dashboard=False,dashboard_summary=Path(tmp)/'diagnostic-comparison'/'latest.json')
        child=FakeChild()
        cli=types.SimpleNamespace(returncode=0,stdout='{}',stderr='')
        now_values=iter((start,'2026-10-19T00:01:02.000000Z'))
        def fake_report(cmd, **kwargs):
            run_dir=Path(cmd[cmd.index('--run-directory')+1])
            (run_dir/'diagnostic-report.json').write_text('{"fixture":true}\n')
            return cli
        wait_effect=KeyboardInterrupt if interrupted else lambda *a,**k:({'endedUtc':'2026-10-19T00:01:20.000000Z' if late_exit else '2026-10-19T00:00:20.000000Z','early':True} if early else {'endedUtc':'2026-10-19T00:01:00.000000Z','early':False})
        export_effect=(lambda *a,**k:(_ for _ in ()).throw(RuntimeError('export failed'))) if export_error else lambda container,script,manifest,out:runner.atomic_json(out,{'runId':manifest['runId'],'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False})
        def fake_launch(*args, **kwargs):
            data_dir = Path(kwargs['env']['SHADOW_DATA_DIR'])
            (data_dir / 'partial.ndjson').write_bytes(b'collected-before-interrupt\n')
            return child
        with patch.object(runner,'git_value',side_effect=lambda r,*a: runner.EXPECTED_BRANCH if a==('rev-parse','--abbrev-ref','HEAD') else ''), \
             patch.object(runner,'revision',side_effect=lambda r: '1'*40 if r==repo else runner.EXPECTED_POLY2_SHA), \
             patch.object(runner,'inspect_poly2',return_value=before), \
             patch.object(runner,'preflight',side_effect=highs), \
             patch.object(runner,'storage_preflight',return_value={'state':'GREEN','gate':'PASS'}), \
             patch.object(runner,'now_utc',side_effect=lambda:next(now_values,'2026-10-19T00:01:02.000000Z')), \
             patch.object(runner.subprocess,'Popen',side_effect=fake_launch), \
             patch.object(runner,'wait_for_window',side_effect=wait_effect), \
             patch.object(runner,'stop_process_group',side_effect=lambda *a,**k:setattr(child,'returncode',0)) as stopped, \
             patch.object(runner.os,'killpg',return_value=None), \
             patch.object(runner.threading,'Timer'), \
             patch.object(runner,'export_poly2',side_effect=export_effect) as exported, \
             patch.object(runner.subprocess,'run',side_effect=fake_report) as reported:
            if launch_error:
                with patch.object(runner.subprocess,'Popen',side_effect=OSError('launch denied')):
                    rc=runner.run(args)
            else:
                rc=runner.run(args)
        manifests=list(run_root.glob('*/diagnostic-manifest.json'))
        self.assertEqual(len(manifests),1)
        import json
        manifest=json.loads(manifests[0].read_text())
        if interrupted:
            stopped.assert_called_once()
            exported.assert_not_called()
            reported.assert_not_called()
            self.assertEqual(manifest['terminationSignal'], 'SIGINT')
            self.assertEqual(manifest['failureType'], 'SIGINT')
            self.assertTrue(manifest['collectorShutdownCompletedUtc'])
            self.assertFalse(manifest['collectorEndedAtRequestedDuration'])
            self.assertEqual((manifests[0].parent / 'shadow-data' / 'partial.ndjson').read_bytes(),
                             b'collected-before-interrupt\n')
            self.assertFalse((manifests[0].parent / 'diagnostic-report.json').exists())
        return rc,manifest,manifests[0].parent

    def test_complete_run_binds_exact_window_and_both_database_highwaters(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc,m,run_dir=self.execute_run(tmp)
            self.assertEqual(rc,0)
            self.assertEqual(m['state'],'COMPLETE')
            self.assertEqual(m['window'],{'startUtc':'2026-10-19T00:00:00.000000Z','endUtc':'2026-10-19T00:01:00.000000Z'})
            self.assertEqual(m['poly2Preflight']['tradeIdHighWater'],5)
            self.assertEqual(m['poly2EndPreflight']['tradeIdHighWater'],8)
            self.assertTrue((run_dir/'poly2-export.json').is_file())

    def test_late_poll_of_early_exit_never_proves_complete_window(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(runner.threading,'Timer'):
            rc,m,_=self.execute_run(tmp,early=True,late_exit=True)
            self.assertEqual(rc,2)
            self.assertEqual(m['state'],'INCOMPLETE')
            self.assertFalse(m['collectorDeadlineObservation']['aliveAtDeadline'])

    def test_interruption_and_early_exit_preserve_incomplete_manifest(self):
        for kwargs,expected_rc in (({'interrupted':True},130),({'early':True},2)):
            with self.subTest(kwargs=kwargs), tempfile.TemporaryDirectory() as tmp:
                rc,m,run_dir=self.execute_run(tmp,**kwargs)
                self.assertEqual(rc,expected_rc)
                self.assertEqual(m['state'],'INCOMPLETE')
                self.assertTrue(m.get('interrupted',False) if kwargs.get('interrupted') else not m['collectorEndedAtRequestedDuration'])
                self.assertTrue((run_dir/'poly2-export.json').is_file() if not kwargs.get('interrupted') else not (run_dir/'poly2-export.json').exists())

    def run_real_signal_case(self, tmp, *, first_signal=runner.signal.SIGTERM,
                             repeat_signal=None, unresponsive=False):
        import json, os, signal, sys, time
        temp = Path(tmp)
        (temp / 'poly2').mkdir()
        ready, term = temp / 'ready', temp / 'term'
        descendant_ready = temp / 'descendant-ready'
        descendant_code = (
            'import os,signal,time\nfrom pathlib import Path\n'
            + ('signal.signal(signal.SIGTERM,signal.SIG_IGN)\n' if unresponsive else '')
            + f'Path({str(descendant_ready)!r}).write_text(str(os.getpid()))\n'
            + 'time.sleep(120)\n'
        )
        collector_code = (
            'import os,signal,subprocess,sys,time\nfrom pathlib import Path\n'
            f'term=Path({str(term)!r})\n'
            'def handle(sig,frame):\n'
            " term.write_text('seen')\n"
            + (' return\n' if unresponsive else ' child.wait(timeout=3)\n sys.exit(0)\n')
            + 'signal.signal(signal.SIGTERM,handle)\n'
            + f'child=subprocess.Popen([sys.executable,"-c",{descendant_code!r}])\n'
            + f'while not Path({str(descendant_ready)!r}).exists(): time.sleep(.01)\n'
            + "data=Path(os.environ['SHADOW_DATA_DIR'])\n"
            + "(data/'partial.ndjson').write_bytes(b'partial\\n')\n"
            + f'Path({str(ready)!r}).write_text(str(os.getpid()))\n'
            + 'time.sleep(120)\n'
        )
        collector_path = temp / 'collector.py'
        collector_path.write_text(collector_code)
        harness = temp / 'harness.py'
        code = f'''import importlib.util,sys,types,subprocess,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('r',{str(PATH)!r});r=importlib.util.module_from_spec(spec);spec.loader.exec_module(r)
repo=r.ROOT;temp=Path({str(temp)!r});poly=temp/'poly2'
r.git_value=lambda repo,*args:r.EXPECTED_BRANCH if args==('rev-parse','--abbrev-ref','HEAD') else ''
r.revision=lambda repo:'1'*40 if Path(repo)==Path(r.ROOT) else r.EXPECTED_POLY2_SHA
before={{'imageId':'sha256:'+'a'*64,'revisionLabel':r.EXPECTED_POLY2_SHA,'flags':r.REQUIRED_FLAGS.copy()}}
high={{'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'mode':'preflight','cohort':list(r.WALLETS),'approvedWallets':list(r.WALLETS),'tradeIdHighWater':5,'decisionLogIdHighWater':3}}
r.inspect_poly2=lambda *a:before
r.preflight=lambda *a:high
r.storage_preflight=lambda *a:{{'state':'GREEN','gate':'PASS'}}
r.storage_telemetry=lambda *a:{{'disk':{{'state':'GREEN'}}}}
def forbidden(*a,**k): raise AssertionError('export/report invoked after interruption')
r.export_poly2=forbidden
r.subprocess.run=forbidden
orig=r.subprocess.Popen
def launch(*args,**kwargs):
 return orig([sys.executable,{str(collector_path)!r}],**kwargs)
r.subprocess.Popen=launch
args=types.SimpleNamespace(repo=repo,poly2_repo=poly,run_root=temp/'runs',poly2_container='offline',duration_seconds=60,publish_dashboard=False,dashboard_summary=temp/'diagnostic-comparison'/'summary.json')
rc=r.run(args);print('RESULT='+str(rc));sys.exit(rc)
'''
        # Compile every generated layer before launching any process.
        for source, name in ((descendant_code, 'descendant'),
                             (collector_code, str(collector_path)), (code, str(harness))):
            compile(source, name, 'exec')
        harness.write_text(code)
        env = {'PATH': os.environ.get('PATH', ''), 'PYTHONDONTWRITEBYTECODE': '1',
               'TMPDIR': str(temp)}
        proc = subprocess.Popen([sys.executable, str(harness)], stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env,
                                start_new_session=True)
        collector_pid = None
        try:
            deadline = time.monotonic() + 10
            while time.monotonic() < deadline and not ready.exists() and proc.poll() is None:
                time.sleep(.02)
            if not ready.exists():
                self.fail('runner did not launch collector: ' +
                          (proc.communicate(timeout=1)[1] if proc.poll() is not None else 'timeout'))
            collector_pid = int(ready.read_text())
            descendant_pid = int(descendant_ready.read_text())
            started = time.monotonic()
            proc.send_signal(first_signal)
            if repeat_signal is not None:
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline and not term.exists() and proc.poll() is None:
                    time.sleep(.02)
                self.assertTrue(term.exists(), 'collector did not observe shutdown SIGTERM')
                proc.send_signal(repeat_signal)
            out, err = proc.communicate(timeout=17)
            elapsed = time.monotonic() - started
            self.assertLess(elapsed, 16)
            if repeat_signal is not None:
                self.assertLess(elapsed, 5, 'repeat signal did not accelerate escalation')
            self.assertEqual(proc.returncode, 128 + first_signal, (out, err))
            self.assertIn('RESULT=' + str(128 + first_signal), out)
            result = json.loads(err.strip().splitlines()[-1])
            run_dir = Path(result['runDirectory'])
            manifest = json.loads((run_dir / 'diagnostic-manifest.json').read_text())
            self.assertEqual(result['result'], 'INTERRUPTED')
            self.assertEqual(manifest['state'], 'INCOMPLETE')
            self.assertTrue(manifest['interrupted'])
            self.assertEqual(manifest['terminationSignal'], signal.Signals(first_signal).name)
            self.assertEqual(manifest['failureType'], signal.Signals(first_signal).name)
            self.assertFalse(manifest['collectorEndedAtRequestedDuration'])
            self.assertTrue(manifest['collectorShutdownCompletedUtc'])
            self.assertLess(runner.parse_utc(manifest['window']['endUtc']),
                            runner.parse_utc(manifest['plannedEndUtc']))
            self.assertEqual((run_dir / 'shadow-data' / 'partial.ndjson').read_bytes(), b'partial\n')
            for name in ('poly2-export.json', 'diagnostic-report.json'):
                self.assertFalse((run_dir / name).exists())
            self.assertFalse((temp / 'diagnostic-comparison' / 'summary.json').exists())
            self.assertFalse(runner.process_group_alive(collector_pid))
            for pid in (collector_pid, descendant_pid):
                self.assertFalse(Path(f'/proc/{pid}').exists(), f'collector descendant not reaped: {pid}')
            if unresponsive:
                self.assertEqual(manifest['collectorExitCode'], -signal.SIGKILL)
        finally:
            # Exact owned process groups only, even when an assertion fails.
            if collector_pid is None and ready.exists():
                collector_pid = int(ready.read_text())
            if collector_pid is not None:
                try: os.killpg(collector_pid, signal.SIGKILL)
                except ProcessLookupError: pass
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
            proc.communicate(timeout=5)

    def test_real_sigterm_during_collection_preserves_evidence_and_records_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_real_signal_case(tmp)

    def test_real_sigint_during_collection_preserves_evidence_and_records_incomplete(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_real_signal_case(tmp, first_signal=runner.signal.SIGINT)

    def test_repeated_sigterm_then_sigint_during_shutdown_escalates_and_reaps_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_real_signal_case(tmp, repeat_signal=runner.signal.SIGINT, unresponsive=True)

    def test_repeated_sigterm_during_shutdown_escalates_and_reaps_group(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_real_signal_case(tmp, repeat_signal=runner.signal.SIGTERM, unresponsive=True)

    def test_unresponsive_collector_and_descendant_are_killed_after_bounded_grace(self):
        with tempfile.TemporaryDirectory() as tmp:
            self.run_real_signal_case(tmp, unresponsive=True)

    def test_launch_and_export_failures_are_not_reported_complete(self):
        with tempfile.TemporaryDirectory() as tmp:
            rc,m,_=self.execute_run(tmp,launch_error=True)
            self.assertEqual(rc,2); self.assertEqual(m['state'],'FAILED')
        with tempfile.TemporaryDirectory() as tmp:
            rc,m,run_dir=self.execute_run(tmp,export_error=True)
            self.assertEqual(rc,2); self.assertEqual(m['state'],'INCOMPLETE')
            self.assertFalse((run_dir/'poly2-export.json').exists())


if __name__ == '__main__': unittest.main()
