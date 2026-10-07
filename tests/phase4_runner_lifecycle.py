"""Real isolated Linux subprocess proofs; no production CLI/npm/Docker/DB.
Fixture dispatch is ONLY in this test module, never a production safety bypass.
"""
import ctypes
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('runner', ROOT / 'scripts/phase4-runner.py')
assert spec is not None and spec.loader is not None
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
SELF = str(Path(__file__).resolve())
SHA = 'a' * 40
SCRATCH = Path(os.environ.get('TMPDIR', str(Path.home() / '.hermes/cache/scratch')))


def fixture_run(repo, target, duration, mode):
    repo, target = Path(repo), Path(target)
    fd = runner.owner_lock(repo)
    try:
        m = runner.validate(repo, target, SHA, float(duration))
        command = [sys.executable, SELF, '--dummy', mode]
        if mode == 'launchfail':
            command = [str(repo / 'missing-harmless-fixture')]
        if mode == 'term-tree':
            real_killpg = os.killpg
            def traced_killpg(pgid, sig):
                with (target / 'signal-trace.ndjson').open('a') as trace:
                    trace.write(json.dumps({'signal': signal.Signals(sig).name, 'utc': time.time(),
                                            'monotonic': time.monotonic(), 'pgid': pgid}) + '\n')
                return real_killpg(pgid, sig)
            setattr(os, 'killpg', traced_killpg)
        if mode == 'blocked-stat':
            real_stats = runner.evidence_stats
            first = [True]
            def blocking_stat(path):
                if first[0]:
                    first[0] = False
                    time.sleep(5)
                return real_stats(path)
            setattr(runner, 'evidence_stats', blocking_stat)
        if mode == 'capturefail':
            real_proc = runner.proc
            def missing_child(pid):
                value = real_proc(pid)
                if value and value['pgid'] == pid and pid != os.getpid():
                    limit = time.monotonic() + .5
                    while not (target / 'shadow-data/descendant.pid').exists() and time.monotonic() < limit:
                        time.sleep(.01)
                    return None
                return value
            setattr(runner, 'proc', missing_child)
            command = [sys.executable, SELF, '--dummy', 'tree']
        if mode in ('digestfail', 'hashwritefail', 'commitfail', 'reportfsyncfail', 'commitfsyncfail', 'hashrenamefail', 'markerfail'):
            real_digest, real_write, real_sync, real_rename = runner.digest, runner.write_new, runner.fsync_dir, runner.rename_new
            def failed_digest(path):
                if Path(path).name == 'execution-receipt.json':
                    raise OSError('injected final digest failure')
                return real_digest(path)
            def failed_write(path, value):
                name = Path(path).name
                if ((mode == 'hashwritefail' and name == 'execution-receipt.sha256.json')
                        or (mode == 'commitfail' and name == 'REPORT_COMMITTED.json')
                        or (mode == 'markerfail' and name == 'REPORT_FAILED.json')):
                    raise OSError('injected final publication failure')
                return real_write(path, value)
            def failed_sync(path):
                if Path(path) == target and ((mode == 'reportfsyncfail' and (target / 'execution-receipt.json').exists())
                                            or (mode == 'commitfsyncfail' and (target / 'REPORT_COMMITTED.json').exists())):
                    raise OSError('injected final durability failure')
                return real_sync(path)
            def failed_rename(source, destination):
                if Path(destination) == target / 'execution-receipt.sha256.json':
                    raise OSError('injected hash publication failure')
                return real_rename(source, destination)
            if mode in ('digestfail', 'markerfail'):
                setattr(runner, 'digest', failed_digest)
                if mode == 'markerfail':
                    setattr(runner, 'write_new', failed_write)
            elif mode in ('reportfsyncfail', 'commitfsyncfail'):
                setattr(runner, 'fsync_dir', failed_sync)
            elif mode == 'hashrenamefail':
                setattr(runner, 'rename_new', failed_rename)
            else:
                setattr(runner, 'write_new', failed_write)
        return runner.lifecycle(repo, target, m, command,
                                runner.runtime_env(target), heartbeat_seconds=.1)
    finally:
        os.close(fd)


def dummy(mode):
    if mode == 'empty':
        time.sleep(30)
        return
    data = Path(os.environ['SHADOW_DATA_DIR'])
    if mode in ('grandchild', 'term-grandchild'):
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        if mode == 'term-grandchild':
            (data / 'descendant-ready').write_text('TERM ignored')
        time.sleep(30)
        return
    if mode == 'term-tree':
        signal.signal(signal.SIGTERM, signal.SIG_IGN)
        child = subprocess.Popen([sys.executable, SELF, '--dummy', 'term-grandchild'])
        (data / 'descendant.pid').write_text(str(child.pid))
    if mode == 'tree':
        child = subprocess.Popen([sys.executable, SELF, '--dummy', 'grandchild'])
        (data / 'descendant.pid').write_text(str(child.pid))
    (data / 'dummy.pid').write_text(str(os.getpid()))
    row = {'source': 'REST_TRADES', 'requestStartUtc': runner.utc()}
    with (data / 'poll_telemetry.ndjson').open('x') as f:
        f.write(json.dumps(row) + '\n'); f.flush(); os.fsync(f.fileno())
    print('REAL_DUMMY_STARTED', flush=True)
    if mode == 'early':
        return
    time.sleep(30)


class Lifecycle(unittest.TestCase):
    def setUp(self):
        # Adopt the independent guardian when its fixture runner is SIGKILLed,
        # so tests also reap the guardian instead of relying on container PID 1.
        self.assertEqual(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0), 0)
        SCRATCH.mkdir(parents=True, exist_ok=True)
        self.tmp = tempfile.TemporaryDirectory(prefix='phase4-isolated-', dir=SCRATCH)
        self.repo = Path(self.tmp.name)
        (self.repo / 'runs').mkdir()
        self.target = self.repo / 'runs/phase4-synthetic'
        self.children = []

    def tearDown(self):
        for p in self.children:
            if p.poll() is None:
                p.terminate()
                try:
                    p.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    p.kill(); p.wait(timeout=5)
        limit = time.monotonic() + 1
        while time.monotonic() < limit:
            try:
                pid, _ = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            if not pid:
                time.sleep(.02)
        self.tmp.cleanup()

    def seal(self, duration=1, lead=.3):
        start = time.time() + lead
        checks = {'shadowSha': SHA, 'poly2': {'synthetic': True}}
        return runner.seal_files(self.repo, self.target, start, start + duration, checks, duration)

    def launch(self, mode='normal', duration=1):
        p = subprocess.Popen([sys.executable, SELF, '--fixture-run', str(self.repo), str(self.target), str(duration), mode],
                             cwd=self.repo, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                             env={k: v for k, v in os.environ.items() if k not in runner.BANNED and not k.startswith(('ARB_', 'SCALP_'))})
        self.children.append(p)
        return p

    def wait_file(self, name, timeout=5):
        limit = time.monotonic() + timeout
        while time.monotonic() < limit:
            f = self.target / name
            if f.exists() and f.stat().st_size:
                try:
                    return json.loads(f.read_text()) if f.suffix == '.json' else f.read_text()
                except json.JSONDecodeError:
                    pass
            time.sleep(.02)
        self.fail('Missing complete fixture artifact ' + name)

    def receipt(self, p):
        out, err = p.communicate(timeout=6)
        r = self.wait_file('execution-receipt.json')
        self.assertEqual(err, b'', err.decode())
        self.assertEqual(r['observerGroupGone'], True)
        self.assertFalse(runner.proc(r['childPid']))
        self.assertEqual(runner.digest(self.target / 'execution-receipt.json'),
                         json.loads((self.target / 'execution-receipt.sha256.json').read_text())['sha256'])
        return r

    def test_tracked_runs_dirty_rejected_before_production_adapter(self):
        def lookup(cmd, cwd=None):
            if cmd[1:] == ['branch', '--show-current']:
                return runner.BRANCH
            if cmd[1:] in (['rev-parse', 'HEAD'], ['rev-parse', 'origin/main']):
                return SHA
            if cmd[1:] == ['rev-list', '--left-right', '--count', 'HEAD...origin/main']:
                return '0\t0'
            return ' M runs/tracked.json'
        with mock.patch.object(runner, 'call', side_effect=lookup), mock.patch.object(runner, 'production_snapshot') as production, mock.patch.object(runner, 'orphans'), mock.patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(runner.Blocked):
                runner.preflight(self.repo, SHA, self.target)
            production.assert_not_called()
        self.assertFalse(self.target.exists())

    def test_real_git_status_only_untracked_evidence_allowed(self):
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        evidence = self.repo / 'runs/tracked.json'
        evidence.write_text('isolated evidence')
        real_call = runner.call
        def lookup(cmd, cwd=None):
            if cmd[1:] == ['branch', '--show-current']:
                return runner.BRANCH
            if cmd[1:] in (['rev-parse', 'HEAD'], ['rev-parse', 'origin/main']):
                return SHA
            if cmd[1:] == ['rev-list', '--left-right', '--count', 'HEAD...origin/main']:
                return '0\t0'
            return real_call(cmd, cwd)
        with mock.patch.object(runner, 'call', side_effect=lookup), mock.patch.object(runner, 'production_snapshot', return_value={'synthetic': True}) as production, mock.patch.object(runner, 'orphans'), mock.patch.dict(os.environ, {}, clear=True):
            runner.preflight(self.repo, SHA, self.target)  # real ?? runs evidence
            production.reset_mock()
            # Only a disposable scratch index changes; no commit is made.
            subprocess.run(['git', '-C', str(self.repo), 'add', 'runs/tracked.json'], check=True)
            with self.assertRaises(runner.Blocked):
                runner.preflight(self.repo, SHA, self.target)
            production.assert_not_called()
            evidence.write_text('dirty tracked evidence')
            with self.assertRaises(runner.Blocked):
                runner.preflight(self.repo, SHA, self.target)
            production.assert_not_called()

    def test_report_failure_never_leaves_success_receipt(self):
        for mode in ('digestfail', 'hashwritefail', 'commitfail', 'reportfsyncfail', 'commitfsyncfail', 'hashrenamefail', 'markerfail'):
            with self.subTest(mode=mode):
                self.target = self.repo / ('runs/phase4-' + mode)
                self.seal()
                p = self.launch(mode)
                p.communicate(timeout=6)
                self.assertNotEqual(p.returncode, 0)
                self.assertEqual((self.target / 'REPORT_FAILED.json').exists(), mode != 'markerfail')
                self.assertFalse(runner.report_valid(self.target))
                if (self.target / 'execution-receipt.json').exists():
                    r = json.loads((self.target / 'execution-receipt.json').read_text())
                    self.assertNotIn(r['classification'], ('COMPLETE', 'END_WINDOW_COMPLETE'))
                self.assertFalse((self.target / 'REPORT_COMMITTED.json').exists())
                stages = list(self.target.glob('.report-stage-*'))
                self.assertEqual(len(stages), 1)
                staged = json.loads((stages[0] / 'execution-receipt.json').read_text())
                for relative, item in staged['artifactInventory'].items():
                    self.assertEqual(runner.digest(self.target / relative), item['sha256'])
        print('PROOF report transaction: digest/hash/commit/durability failures leave no success receipt')

    def test_deadline_tree_immediate_kill_and_unrelated_survives(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], start_new_session=True)
        self.children.append(unrelated)
        m = self.seal()
        p = self.launch('tree')
        descendant = int(self.wait_file('shadow-data/descendant.pid'))
        r = self.receipt(p)
        self.assertEqual(r['stopSignalPolicy'], 'FROZEN_END_IMMEDIATE_SIGKILL')
        self.assertEqual(r['firstStopSignal'], 'SIGKILL')
        stop_lag = runner.epoch(r['actualStopUtc']) - runner.epoch(m['window']['endUtc'])
        self.assertLess(stop_lag, .18)
        self.assertIsNone(runner.proc(descendant))
        self.assertIsNone(unrelated.poll())
        print(f'PROOF fixed end: TERM-ignoring descendant killed without grace; unrelated child alive; observed cleanup lag={stop_lag:.6f}s, scheduling tolerance=0.18s')

    def test_early_signal_term_grace_capped_at_frozen_end(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], start_new_session=True)
        self.children.append(unrelated)
        for sig in (signal.SIGINT, signal.SIGTERM):
            with self.subTest(signal=sig.name):
                self.target = self.repo / ('runs/phase4-near-end-' + sig.name)
                m = self.seal()
                end = runner.epoch(m['window']['endUtc'])
                p = self.launch('term-tree')
                descendant = int(self.wait_file('shadow-data/descendant.pid'))
                self.wait_file('shadow-data/descendant-ready')
                time.sleep(max(0, end - time.time() - .05))
                p.send_signal(sig)
                r = self.receipt(p)
                self.assertEqual(p.returncode, 1)
                self.assertEqual(r['classification'], 'SIGNAL_TERMINATION')
                self.assertEqual(r['firstStopSignal'], 'SIGTERM')
                self.assertEqual(r['stopSignalPolicy'], 'EARLY_STOP_BOUNDED_TERM_THEN_KILL')
                trace = [json.loads(line) for line in (self.target / 'signal-trace.ndjson').read_text().splitlines()]
                self.assertEqual([v['signal'] for v in trace], ['SIGTERM', 'SIGKILL'])
                self.assertTrue(all(v['pgid'] == r['observerProcessGroup'] for v in trace))
                term, kill = trace
                self.assertLess(term['utc'], end)
                self.assertGreaterEqual(kill['utc'], end)
                self.assertLess(kill['utc'] - end, .18)
                self.assertLess(kill['monotonic'] - term['monotonic'], .18)
                self.assertLess(runner.epoch(r['actualStopUtc']) - end, .18)
                self.assertIsNone(runner.proc(descendant))
                self.assertIsNone(unrelated.poll())
                print(f"PROOF near-end {sig.name}: TERM={term['utc'] - end:.6f}s KILL={kill['utc'] - end:.6f}s; grace={kill['monotonic'] - term['monotonic']:.6f}s; unrelated alive; external scheduling tolerance=0.18s, not scientific delay")

    def test_cleanup_rechecks_dynamic_utc_with_alarm_cancelled(self):
        clock = {'mono': 0.0, 'utc': 99.95}
        sent = []
        child = mock.Mock()
        token = {'pgid': 123}
        def sleep(seconds):
            clock['mono'] += seconds
            clock['utc'] = 100.1  # Forward step during TERM grace.
        def send(pgid, sig):
            sent.append((sig, clock['mono']))
        def members(pgid):
            return [] if any(sig == signal.SIGKILL for sig, _ in sent) else [{'state': 'S'}]
        with mock.patch.object(runner, 'owned_identity', return_value=True), mock.patch.object(runner, 'group', side_effect=members), mock.patch.object(os, 'killpg', side_effect=send), mock.patch.object(os, 'waitpid', side_effect=ChildProcessError), mock.patch.object(time, 'monotonic', side_effect=lambda: clock['mono']), mock.patch.object(time, 'time', side_effect=lambda: clock['utc']), mock.patch.object(time, 'sleep', side_effect=sleep):
            self.assertTrue(runner.stop_owned(child, token, frozen_end=100.0))
        self.assertEqual([sig for sig, _ in sent], [signal.SIGTERM, signal.SIGKILL])
        self.assertEqual(sent[1][1], .02)

    def test_cleanup_end_passed_before_first_signal_skips_term(self):
        child = mock.Mock()
        with mock.patch.object(runner, 'owned_identity', return_value=True), mock.patch.object(runner, 'group', return_value=[]), mock.patch.object(os, 'killpg') as send, mock.patch.object(os, 'waitpid', side_effect=ChildProcessError), mock.patch.object(time, 'time', return_value=100.0):
            self.assertTrue(runner.stop_owned(child, {'pgid': 123}, frozen_end=100.0))
        send.assert_called_once_with(123, signal.SIGKILL)

    def test_capture_failure_owned_tree_cleanup(self):
        unrelated = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], start_new_session=True)
        self.children.append(unrelated)
        self.seal()
        p = self.launch('capturefail')
        leader = int(self.wait_file('shadow-data/dummy.pid'))
        descendant = int(self.wait_file('shadow-data/descendant.pid'))
        try:
            r = self.receipt(p)
            self.assertNotEqual(p.returncode, 0)
            self.assertEqual(r['lifecycleCode'], 'LAUNCH_FAILED')
            self.assertEqual(r['childToken']['ownershipProof'], 'UNREAPED_DIRECT_CHILD_SESSION')
            self.assertIsNone(runner.proc(leader))
            self.assertIsNone(runner.proc(descendant))
            self.assertIsNone(unrelated.poll())
        finally:
            if runner.proc(leader):
                os.killpg(leader, signal.SIGKILL)
        print('PROOF identity capture failure: real owned tree reaped; unrelated child alive')

    def test_required_metadata_and_canonical_classifications(self):
        self.seal()
        p = self.launch()
        r = self.receipt(p)
        self.assertEqual(r['classification'], 'END_WINDOW_COMPLETE')
        self.assertEqual(r['lifecycleCode'], 'COMPLETE')
        self.assertIsNone(r['canonicalFailureReason'])
        self.assertEqual(r['experimentId'], self.target.name)
        self.assertEqual(r['restartCount'], 0)
        self.assertEqual(r['observationPhase'], 'COMPLETE')
        self.assertEqual(r['restartEvents'], [])
        self.assertEqual(r['outageGaps'], [])
        self.assertEqual(r['outageGapAssessment'], 'UNKNOWN')
        self.assertEqual(r['postrun']['export'], 'NOT_RUN')
        for name in ('runner-start.json', 'launch-receipt.json'):
            start_receipt = json.loads((self.target / name).read_text())
            self.assertEqual(start_receipt['experimentId'], self.target.name)
            self.assertEqual(start_receipt['restartCount'], 0)
        required = {'PRESTART_GATE_FAILED', 'WINDOW_SEAL_FAILED', 'MISSED_START', 'OBSERVER_START_FAILED',
                    'OBSERVER_EXITED_EARLY', 'SIGNAL_TERMINATION', 'END_WINDOW_COMPLETE',
                    'POSTRUN_EXPORT_FAILED', 'COMPARATOR_FAILED', 'DASHBOARD_FAILED'}
        self.assertTrue(required <= runner.CANONICAL_CLASSIFICATIONS)
        for code in runner.CODES:
            terminal = {'classification': code}
            runner.terminal_metadata(terminal, self.target)
            self.assertEqual(terminal['lifecycleCode'], code)
            self.assertEqual(terminal['classification'], runner.CANONICAL[code])
            self.assertEqual(terminal['canonicalFailureReason'], None if code == 'COMPLETE' else runner.CANONICAL[code])
            self.assertEqual(terminal['observationPhase'], 'COMPLETE' if code == 'COMPLETE' else 'FAILED')
            self.assertEqual(set(terminal['postrun'].values()), {'NOT_RUN'})
        beats = [json.loads(x) for x in (self.target / 'heartbeat.ndjson').read_text().splitlines()]
        self.assertTrue(all(b['runnerAlive'] and b['evidenceDirectoryExists'] for b in beats))
        self.assertTrue(runner.report_valid(self.target))
        (self.target / 'execution-receipt.sha256.json').write_text('{}')
        self.assertFalse(runner.report_valid(self.target))

    def test_contract_fixed_and_no_test_cli_flags(self):
        self.assertEqual(runner.WINDOW_SECONDS, 86400)
        p = subprocess.run([sys.executable, str(ROOT / 'scripts/phase4-runner.py'), '--help'], capture_output=True, text=True, check=True)
        self.assertNotIn('synthetic', p.stdout)
        self.assertNotIn('duration', p.stdout)
        self.assertNotIn('command', p.stdout)

    def test_real_future_wait_deadline_and_provenance(self):
        m = self.seal()
        p = self.launch()
        r = self.receipt(p)
        self.assertEqual(p.returncode, 0)
        self.assertEqual(r['classification'], 'END_WINDOW_COMPLETE')
        self.assertGreaterEqual(runner.epoch(r['actualProcessLaunchUtc']), runner.epoch(m['window']['startUtc']))
        self.assertLess(r['launchDeviationSeconds'], 1)
        self.assertLess(abs(r['stopDeviationSeconds']), .3)
        self.assertLess(runner.epoch(r['actualStopUtc']) - runner.epoch(m['window']['endUtc']), 1)
        self.assertEqual(r['actualObservationStartUtc'], json.loads((self.target / 'shadow-data/poll_telemetry.ndjson').read_text())['requestStartUtc'])
        self.assertIsNone(r['perSourceObservationStartUtc']['CHAIN'])
        self.assertIsNone(r['perSourceObservationStartUtc']['REST_ACTIVITY'])
        beats = [json.loads(x) for x in (self.target / 'heartbeat.ndjson').read_text().splitlines()]
        self.assertGreater(len(beats), 1)
        self.assertTrue(all(b['remainingSeconds'] >= 0 and b['childAlive'] for b in beats))
        self.assertNotIn('PATH', r['runtimeExperimentEnvironment'])
        self.assertEqual(r['command'][:2], [sys.executable, SELF])
        print('PROOF real future wait/deadline: ' + r['classification'] + ', owned group gone, source timestamp retained')

    def test_absolute_alarm_interrupts_blocked_heartbeat_real_child(self):
        self.seal()
        p = self.launch('blocked-stat')
        r = self.receipt(p)
        self.assertEqual(r['classification'], 'END_WINDOW_COMPLETE')
        self.assertLess(abs(r['stopDeviationSeconds']), .3)
        self.assertTrue(r['observerGroupGone'])

    def test_real_launch_failure_receipt(self):
        self.seal()
        p = self.launch('launchfail')
        p.communicate(timeout=4)
        r = self.wait_file('execution-receipt.json')
        self.assertEqual(r['classification'], 'OBSERVER_START_FAILED')
        self.assertIsNone(r['actualProcessLaunchUtc'])
        self.assertNotEqual(p.returncode, 0)

    def test_early_exit_immediate_no_restart(self):
        self.seal(duration=8)
        p = self.launch('early', duration=8)
        started = time.monotonic()
        r = self.receipt(p)
        self.assertEqual(r['classification'], 'OBSERVER_EXITED_EARLY')
        self.assertLess(time.monotonic() - started, 3)
        self.assertNotEqual(p.returncode, 0)
        with self.assertRaises(runner.Blocked) as e:
            runner.validate(self.repo, self.target, SHA, 8)
        self.assertEqual(e.exception.code, 'DUPLICATE_RUN')

    def test_sigterm_tree_no_orphans(self):
        self.seal(duration=8)
        p = self.launch('tree', duration=8)
        descendant = int(self.wait_file('shadow-data/descendant.pid'))
        p.send_signal(signal.SIGTERM)
        r = self.receipt(p)
        self.assertEqual(r['classification'], 'SIGNAL_TERMINATION')
        self.assertIsNone(runner.proc(descendant))
        print('PROOF SIGTERM: npm-shaped process tree stopped and descendants reaped')

    def test_sigint_no_orphans(self):
        self.seal(duration=8)
        p = self.launch(duration=8)
        self.wait_file('shadow-data/dummy.pid')
        p.send_signal(signal.SIGINT)
        self.assertEqual(self.receipt(p)['classification'], 'SIGNAL_TERMINATION')

    def test_sigkill_runner_independent_guardian(self):
        self.seal(duration=8)
        p = self.launch('tree', duration=8)
        descendant = int(self.wait_file('shadow-data/descendant.pid'))
        p.kill(); p.communicate(timeout=6)
        r = self.wait_file('execution-receipt.json')
        self.assertEqual(r['classification'], 'SIGNAL_TERMINATION')
        self.assertTrue(r['observerGroupGone'])
        self.assertIsNone(runner.proc(r['childPid']))
        self.assertIsNone(runner.proc(descendant))
        print('PROOF SIGKILL runner: independent guardian survived and stopped owned tree')

    def test_missed_start_no_child(self):
        self.seal(lead=.1)
        time.sleep(1.2)
        p = self.launch()
        p.communicate(timeout=4)
        r = self.wait_file('execution-receipt.json')
        self.assertEqual(r['classification'], 'MISSED_START')
        self.assertIsNone(r['actualProcessLaunchUtc'])
        self.assertFalse((self.target / 'observer.log').exists())

    def test_credential_presence_including_empty_no_secret_echo(self):
        for secret in ('', 'TOP_SECRET_DO_NOT_PRINT'):
            with self.assertRaises(runner.Blocked) as e:
                runner.credentials({'PRIVATE_KEY': secret})
            self.assertEqual(e.exception.code, 'PREFLIGHT_FAILED')
            self.assertNotIn('TOP_SECRET_DO_NOT_PRINT', str(e.exception))
        env = dict(os.environ, PRIVATE_KEY='TOP_SECRET_DO_NOT_PRINT')
        p = subprocess.run([sys.executable, SELF, '--credential-fixture'], capture_output=True, text=True, env=env)
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn('TOP_SECRET_DO_NOT_PRINT', p.stderr + p.stdout)
        self.assertIn('PREFLIGHT_FAILED', p.stderr)
        self.assertFalse(self.target.exists())

    def test_atomic_seal_no_overwrite_and_hash_tamper(self):
        self.seal()
        self.assertEqual(runner.validate(self.repo, self.target, SHA, 1)['controlled'], runner.WALLETS)
        before = (self.target / 'run-manifest.json').read_bytes()
        with self.assertRaises(runner.Blocked):
            self.seal()
        self.assertEqual(before, (self.target / 'run-manifest.json').read_bytes())
        (self.target / 'cohorts.json').chmod(0o644)
        (self.target / 'cohorts.json').write_text('{}')
        with self.assertRaises(runner.Blocked) as e:
            runner.validate(self.repo, self.target, SHA, 1)
        self.assertEqual(e.exception.code, 'SEAL_INVALID')

    def test_existing_evidence_refused_without_writes(self):
        self.seal()
        evidence = self.target / 'shadow-data/old.ndjson'
        evidence.write_bytes(b'preserve historical bytes\n')
        with self.assertRaises(runner.Blocked) as e:
            runner.validate(self.repo, self.target, SHA, 1)
        self.assertEqual(e.exception.code, 'SEAL_INVALID')
        self.assertEqual(evidence.read_bytes(), b'preserve historical bytes\n')
        self.assertFalse((self.target / 'runner-start.json').exists())

    def test_partial_seal_invalid_unpublished(self):
        real = runner.write_new
        def fail_manifest(path, value):
            if Path(path).name == 'run-manifest.json':
                raise OSError('synthetic fsync failure')
            return real(path, value)
        with mock.patch.object(runner, 'write_new', side_effect=fail_manifest):
            with self.assertRaises(OSError):
                self.seal()
        self.assertFalse(self.target.exists())
        stages = list((self.repo / 'runs').glob('.phase4-stage-*'))
        self.assertEqual(len(stages), 1)
        self.assertTrue((stages[0] / 'INVALID').exists())
        with self.assertRaises(runner.Blocked):
            runner.validate(self.repo, self.target, SHA, 1)

    def test_post_publication_fsync_failure_invalid(self):
        real = runner.fsync_dir
        def fail_parent(path):
            if Path(path) == self.repo / 'runs':
                raise OSError('synthetic directory fsync failure')
            real(path)
        with mock.patch.object(runner, 'fsync_dir', side_effect=fail_parent):
            with self.assertRaises(OSError):
                self.seal()
        self.assertFalse(self.target.exists())
        stages = list((self.repo / 'runs').glob('.phase4-stage-*'))
        self.assertEqual(len(stages), 1)
        self.assertTrue((stages[0] / 'INVALID').exists())
        with self.assertRaises(runner.Blocked):
            runner.validate(self.repo, self.target, SHA, 1)

    def test_publication_retracted_even_if_invalid_marker_write_fails(self):
        real_sync, real_write = runner.fsync_dir, runner.write_new
        def fail_parent(path):
            if Path(path) == self.repo / 'runs':
                raise OSError('synthetic fsync failure')
            real_sync(path)
        def fail_marker(path, value):
            if Path(path).name == 'INVALID':
                raise OSError('synthetic marker write failure')
            real_write(path, value)
        with mock.patch.object(runner, 'fsync_dir', side_effect=fail_parent), mock.patch.object(runner, 'write_new', side_effect=fail_marker):
            with self.assertRaises(OSError):
                self.seal()
        self.assertFalse(self.target.exists())
        self.assertEqual(len(list((self.repo / 'runs').glob('.phase4-stage-*'))), 1)
        with self.assertRaises(runner.Blocked):
            runner.validate(self.repo, self.target, SHA, 1)

    def test_staging_rename_noreplace(self):
        stage = self.repo / 'runs/stage'
        stage.mkdir()
        self.target.mkdir()
        (self.target / 'untouched').write_bytes(b'original')
        with self.assertRaises(OSError):
            runner.rename_new(stage, self.target)
        self.assertEqual((self.target / 'untouched').read_bytes(), b'original')

    def test_symlink_and_wrong_path_refused(self):
        alias = self.repo / 'alias'
        alias.symlink_to(self.repo / 'runs')
        for path in (alias / 'phase4-x', self.repo / 'phase4-x'):
            with self.assertRaises(runner.Blocked):
                runner.experiment_path(self.repo, path)

    def test_single_owner_real_process_lock(self):
        fd = runner.owner_lock(self.repo)
        try:
            code = "import fcntl,os,sys;f=os.open(sys.argv[1],os.O_RDWR);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)"
            p = subprocess.run([sys.executable, '-c', code, str(self.repo / 'runs/.phase4-owner.lock')], capture_output=True)
            self.assertNotEqual(p.returncode, 0)
        finally:
            os.close(fd)

    def test_duplicate_owner_during_live_dummy(self):
        self.seal(duration=8)
        p = self.launch(duration=8)
        self.wait_file('shadow-data/dummy.pid')
        other = self.launch(duration=8)
        _, err = other.communicate(timeout=3)
        self.assertNotEqual(other.returncode, 0)
        self.assertIn(b'Another lifecycle owner', err)
        p.terminate()
        self.receipt(p)

    def test_orphan_other_directory_detected_poly2_unrelated_ignored(self):
        p = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)', 'node'], cwd=self.repo,
                             env=dict(os.environ, SHADOW_DATA_DIR=str(self.repo / 'elsewhere')))
        self.children.append(p)
        # Real fixture-owned /proc reads; unrelated host PIDs may be unreadable
        # to the unprivileged CI user and are not this test's process population.
        with mock.patch.object(Path, 'iterdir', return_value=iter([Path('/proc') / str(p.pid)])):
            with self.assertRaises(runner.Blocked) as e:
                runner.orphans(self.repo, self.target)
        self.assertEqual(e.exception.code, 'ORPHAN_DETECTED')
        self.assertIsNone(p.poll())  # discovery NEVER kills
        p.terminate(); p.wait(timeout=3)
        q = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)', 'poly2-node'], cwd=self.repo)
        self.children.append(q)
        with mock.patch.object(Path, 'iterdir', return_value=iter([Path('/proc') / str(q.pid)])):
            runner.orphans(self.repo, self.target)
        self.assertIsNone(q.poll())
        # Keep production's unknown-permission gate fail-closed, not skipped.
        with mock.patch.object(Path, 'iterdir', return_value=iter([Path('/proc') / str(q.pid)])):
            with mock.patch.object(Path, 'read_bytes', side_effect=PermissionError('fixture permission boundary')):
                with self.assertRaises(runner.Blocked) as e:
                    runner.orphans(self.repo, self.target)
        self.assertEqual(e.exception.code, 'PREFLIGHT_FAILED')
        self.assertIsNone(q.poll())

    def test_pid_reuse_token_no_signal(self):
        p = subprocess.Popen([sys.executable, '-c', 'import time;time.sleep(30)'], start_new_session=True)
        self.children.append(p)
        token = runner.proc(p.pid)
        token['startTicks'] = str(int(token['startTicks']) + 1)
        with mock.patch.object(os, 'killpg', side_effect=AssertionError('Must not signal reused PID')):
            self.assertFalse(runner.stop_owned(p, token))
        self.assertIsNone(p.poll())

    def test_empty_evidence_not_complete_unknown_start(self):
        self.seal()
        p = self.launch('empty')
        r = self.receipt(p)
        self.assertEqual(r['classification'], 'EVIDENCE_MISSING')
        self.assertEqual(r['lifecycleCode'], 'EVIDENCE_MISSING')
        self.assertEqual(r['canonicalFailureReason'], 'EVIDENCE_MISSING')
        self.assertEqual(r['observationPhase'], 'FAILED')
        self.assertEqual(p.returncode, 1)
        self.assertTrue(runner.report_valid(self.target))
        self.assertEqual(set(r['postrun'].values()), {'NOT_RUN'})
        self.assertEqual(list((self.target / 'shadow-data').iterdir()), [])
        for relative, item in r['artifactInventory'].items():
            self.assertEqual(runner.digest(self.target / relative), item['sha256'])
        self.assertIsNone(r['actualObservationStartUtc'])
        print('PROOF missing evidence: FAILED phase, exit 1, committed non-success receipt, source artifacts preserved')

    def test_bounded_first_line_no_fabricated_timestamp(self):
        self.seal()
        p = self.target / 'shadow-data/poll_telemetry.ndjson'
        p.write_bytes(b'x' * 65537 + b'\n')
        self.assertIsNone(runner.first_observation(self.target, 0, time.time())['actualObservationStartUtc'])
        p.write_text(json.dumps({'source': 'REST_TRADES', 'requestStartUtc': runner.utc(time.time() + 100)}) + '\n')
        self.assertIsNone(runner.first_observation(self.target, 0, time.time())['actualObservationStartUtc'])

    def test_signal_before_future_start_no_launch(self):
        self.seal(duration=1, lead=3)
        p = self.launch()
        self.wait_file('runner-start.json')
        p.terminate()
        p.communicate(timeout=4)
        r = self.wait_file('execution-receipt.json')
        self.assertEqual(r['classification'], 'SIGNAL_TERMINATION')
        self.assertIsNone(r['actualProcessLaunchUtc'])
        self.assertFalse((self.target / 'observer.log').exists())

    def test_preflight_readonly_adapter_gates_before_creation(self):
        commands = []
        snapshot = {'sha': runner.POLY2_SHA, 'config': {}, 'envFileSha256': 'synthetic', 'container': {}}
        def lookup(cmd, cwd=None):
            commands.append(cmd)
            if cmd[1:] == ['branch', '--show-current']:
                return runner.BRANCH
            if cmd[1:] in (['rev-parse', 'HEAD'], ['rev-parse', 'origin/main']):
                return SHA
            if cmd[1:] == ['rev-list', '--left-right', '--count', 'HEAD...origin/main']:
                return '0\t0'
            return ''
        with mock.patch.object(runner, 'call', side_effect=lookup), mock.patch.object(runner, 'orphans'), mock.patch.object(runner, 'production_snapshot', return_value=snapshot), mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runner.preflight(self.repo, SHA, self.target)['poly2'], snapshot)
            self.assertFalse(self.target.exists())
            with self.assertRaises(runner.Blocked):
                runner.preflight(self.repo, SHA, self.target, dict(snapshot, envFileSha256='changed'))
            with self.assertRaises(runner.Blocked):
                runner.preflight(self.repo, 'not-a-sha', self.target)
            with mock.patch.object(runner, 'call', return_value='wrong branch'):
                with self.assertRaises(runner.Blocked):
                    runner.preflight(self.repo, SHA, self.target)
            self.assertFalse(self.target.exists())
        self.assertTrue(all(cmd[0] == 'git' for cmd in commands))

    def test_production_snapshot_contract_only_mocked_observational_calls(self):
        config = {'paper_mode': True, 'allow_live_trading': False}
        db = {'readOnly': 'on', 'wallets': runner.WALLETS, 'heartbeats': [
            {'service': k, 'last_seen': runner.utc()} for k in ('bot_alive', 'bot_success')]}
        container = {'Status': 'running', 'Running': True, 'Restarting': False, 'StartedAt': 'synthetic'}
        for mutate in (None, 'paper', 'wallet', 'sha', 'readonly'):
            c, d, sha = dict(config), dict(db), runner.POLY2_SHA
            if mutate == 'paper':
                c['paper_mode'] = False
            if mutate == 'wallet':
                d['wallets'] = runner.WALLETS[:-1]
            if mutate == 'sha':
                sha = SHA
            if mutate == 'readonly':
                d['readOnly'] = 'off'
            with mock.patch.object(runner, 'call', side_effect=[json.dumps(c), json.dumps(d), json.dumps(container), sha]) as calls, mock.patch.object(runner, 'digest', return_value='synthetic'):
                if mutate is None:
                    self.assertEqual(runner.production_snapshot()['sha'], runner.POLY2_SHA)
                else:
                    with self.assertRaises(runner.Blocked):
                        runner.production_snapshot()
                query = calls.call_args_list[1]
                self.assertIn('READ ONLY', query.kwargs['input'])
                self.assertIn('ROLLBACK', query.kwargs['input'])
                self.assertIn('default_transaction_read_only=on', ' '.join(query.args[0]))

    def test_chain_first_raw_arrival_not_subscription_start(self):
        self.seal()
        now = runner.utc()
        (self.target / 'shadow-data/raw_logs.ndjson').write_text(json.dumps({'firstSeenUtc': now}) + '\n')
        r = runner.first_observation(self.target, 0, time.time() + 1)
        self.assertIsNone(r['actualObservationStartUtc'])
        self.assertEqual(r['perSourceObservationStartUtc']['CHAIN'], now)
        self.assertIn('NOT subscription startup', r['perSourceObservationStartProvenance']['CHAIN'])

    def test_past_or_wrong_window_creates_nothing(self):
        for start, end in ((time.time() - 2, time.time() - 1), (time.time() + 10, time.time() + 30)):
            with self.assertRaises(runner.Blocked):
                runner.seal_files(self.repo, self.target, start, end, {'shadowSha': SHA}, 1)
            self.assertFalse(self.target.exists())


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == '--credential-fixture':
        try:
            runner.credentials(os.environ)
        except runner.Blocked as e:
            print(e.code + ': ' + str(e), file=sys.stderr)
            sys.exit(1)
        sys.exit(0)
    if len(sys.argv) > 1 and sys.argv[1] == '--fixture-run':
        sys.exit(fixture_run(*sys.argv[2:]))
    if len(sys.argv) > 1 and sys.argv[1] == '--dummy':
        dummy(sys.argv[2])
        sys.exit(0)
    unittest.main(verbosity=2)
