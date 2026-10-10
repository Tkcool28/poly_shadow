"""Synthetic readiness regressions. No Docker, Poly2, live run, or systemd calls."""
import importlib.util
import json
import os
from pathlib import Path
import py_compile
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

sys.dont_write_bytecode = True
ROOT = Path(__file__).resolve().parents[1]
SHA = 'a' * 40

def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

runner = load('readiness_runner', ROOT / 'scripts/phase4-runner.py')

class Readiness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='readiness-')
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        (self.repo / 'scripts').mkdir()
        (self.repo / 'scripts/phase4-runner.py').write_text('x = 1\n')
        subprocess.run(['git', 'init', '-q', str(self.repo)], check=True)
        subprocess.run(['git', '-C', str(self.repo), 'add', 'scripts/phase4-runner.py'], check=True)
        self.target = self.repo / 'runs/phase4-synthetic'
        self.production = mock.Mock(return_value={'synthetic': True})
        self.real_call = runner.call

    def tearDown(self):
        self.tmp.cleanup()

    def lookup(self, cmd, cwd=None):
        tail = cmd[1:]
        if tail == ['branch', '--show-current']:
            return 'main'
        if tail in (['rev-parse', 'HEAD'], ['rev-parse', 'origin/main']):
            return SHA
        if tail == ['rev-list', '--left-right', '--count', 'HEAD...origin/main']:
            return '0\t0'
        if '--untracked-files=no' in cmd:
            return ''
        if '--porcelain=v1' in cmd and '-z' in cmd:
            # Fixture source is staged, not committed. Production's tracked
            # gate is mocked above; retain real Git NUL untracked path output.
            return '\0'.join(row for row in self.real_call(cmd, cwd).split('\0') if row.startswith('?? ')) + '\0'
        return self.real_call(cmd, cwd)

    def preflight(self, lookup=None, sha=SHA):
        with mock.patch.object(runner, 'call', side_effect=lookup or self.lookup), mock.patch.object(runner, 'production_snapshot', self.production), mock.patch.object(runner, 'orphans'), mock.patch.dict(os.environ, {}, clear=True):
            return runner.preflight(self.repo, sha, self.target)

    def test_revision_main_exact_and_divergence(self):
        self.assertEqual(self.preflight()['branch'], 'main')
        for tail, value in ((['branch', '--show-current'], 'feature'), (['rev-parse', 'HEAD'], 'b'*40), (['rev-parse', 'origin/main'], 'b'*40), (['rev-list', '--left-right', '--count', 'HEAD...origin/main'], '1\t0'), (['rev-list', '--left-right', '--count', 'HEAD...origin/main'], '0\t1')):
            with self.subTest(tail=tail, value=value):
                self.production.reset_mock()
                def lookup(cmd, cwd=None):
                    return value if cmd[1:] == tail else self.lookup(cmd, cwd)
                with self.assertRaises(runner.Blocked):
                    self.preflight(lookup)
                self.production.assert_not_called()
        for sha in ('a'*39, 'A'*40, ''):
            with self.assertRaises(runner.Blocked):
                self.preflight(sha=sha)
        self.assertFalse(self.target.exists())

    def test_actual_interpreter_cache_and_quoted_evidence_allowed(self):
        cache = self.repo / 'scripts/__pycache__'
        cache.mkdir()
        py_compile.compile(str(self.repo / 'scripts/phase4-runner.py'), doraise=True)
        (self.repo / 'runs').mkdir()
        (self.repo / 'runs/evidence "tab\t and unicode-λ.ndjson').write_text('evidence')
        before = {p: p.read_bytes() for p in cache.iterdir()}
        result = self.preflight()
        self.assertEqual(result['untrackedClassification']['evidence'][0][:5], 'runs/')
        self.assertEqual(len(result['untrackedClassification']['interpreterCache']), 1)
        self.assertEqual(before, {p: p.read_bytes() for p in cache.iterdir()})

    def test_preserved_312_and_314_caches_across_interpreters(self):
        source = self.repo / 'scripts/phase4-runner.py'
        candidates = {sys.executable, '/usr/bin/python3'}
        # Explicit CI interpreter paths or PATH; never probe another user's
        # private home. Both actual versions are installed by the workflow.
        for version, key in (('3.12', 'POLY_SHADOW_TEST_PYTHON_312'),
                             ('3.14', 'POLY_SHADOW_TEST_PYTHON_314')):
            executable = os.environ.get(key) or shutil.which('python' + version)
            if executable:
                candidates.add(executable)
        interpreters = {}
        for executable in sorted(candidates):
            if Path(executable).is_file():
                tag = subprocess.check_output([executable, '-B', '-c',
                       'import sys; print(sys.implementation.cache_tag)'], text=True).strip()
                interpreters[tag] = executable
        if not {'cpython-312', 'cpython-314'} <= interpreters.keys():
            self.skipTest('actual CPython 3.12 and 3.14 interpreters required for cross-version proof')
        for tag in ('cpython-312', 'cpython-314'):
            executable = interpreters[tag]
            subprocess.run([executable, '-B', '-c',
                            'import py_compile,sys; py_compile.compile(sys.argv[1], doraise=True)',
                            str(source)], check=True)
        cache = self.repo / 'scripts/__pycache__'
        before = {p: p.read_bytes() for p in cache.iterdir()}
        self.assertEqual(len(before), 2)
        source.write_text('x = 99\n')  # Preserved caches need not be fresh.
        result = self.preflight()['untrackedClassification']['interpreterCache']
        self.assertEqual(set(result), {str(p.relative_to(self.repo)) for p in before})
        self.assertEqual(before, {p: p.read_bytes() for p in cache.iterdir()})

    def test_recognized_cache_header_and_tag_pair_required(self):
        cache = self.repo / 'scripts/__pycache__'
        cache.mkdir()
        for tag, magic in (('cpython-312', bytes.fromhex('cb0d0d0a')),
                           ('cpython-314', bytes.fromhex('2b0e0d0a'))):
            p = cache / ('phase4-runner.' + tag + '.pyc')
            for header in (b'BAD!', magic):
                for flags in (2, 4, 0xffffffff):
                    p.write_bytes(header + flags.to_bytes(4, 'little') + b'0' * 20)
                    with self.assertRaises(runner.Blocked):
                        self.preflight()
            other_magic = bytes.fromhex('2b0e0d0a' if tag == 'cpython-312' else 'cb0d0d0a')
            p.write_bytes(other_magic + b'\0' * 20)
            with self.assertRaises(runner.Blocked):
                self.preflight()
            p.unlink()

    def test_cache_forged_source_and_trailing_payload_rejected(self):
        cache = self.repo/'scripts/__pycache__'
        cache.mkdir()
        generated = Path(py_compile.compile(str(self.repo/'scripts/phase4-runner.py'),doraise=True))
        original = generated.read_bytes()
        generated.write_bytes(original+b'not-bytecode')
        with self.assertRaises(runner.Blocked):
            self.preflight()
        wrong = self.root/'untracked-source.py'
        wrong.write_text('x = 2\n')
        py_compile.compile(str(wrong),cfile=str(generated),doraise=True)
        with self.assertRaises(runner.Blocked):
            self.preflight()
        generated.write_bytes(original)
        # A generated but stale cache is not deleted/re-executed/freshened.
        (self.repo/'scripts/phase4-runner.py').write_text('x = 3\n')
        self.preflight()
        self.assertEqual(generated.read_bytes(),original)

    def test_bad_cache_and_outside_evidence_rejected_without_mutation(self):
        cache = self.repo / 'scripts/__pycache__'
        cache.mkdir()
        cases = ('random.pyc', 'phase4-runner.cpython-314.pyc', 'source.py', 'config.json', 'raw.ndjson', 'nested/file.pyc')
        for name in cases:
            with self.subTest(name=name):
                p = cache / name
                p.parent.mkdir(exist_ok=True)
                p.write_bytes(b'not generated bytecode')
                self.production.reset_mock()
                with self.assertRaises(runner.Blocked):
                    self.preflight()
                self.production.assert_not_called()
                self.assertEqual(p.read_bytes(), b'not generated bytecode')
                p.unlink()
                if p.parent != cache:
                    p.parent.rmdir()
        for name in ('raw.ndjson', 'scripts/source.py', 'config.json'):
            p = self.repo / name
            p.write_bytes(b'keep')
            with self.assertRaises(runner.Blocked):
                self.preflight()
            self.assertEqual(p.read_bytes(), b'keep')
            p.unlink()
        generated = Path(py_compile.compile(str(self.repo / 'scripts/phase4-runner.py'), doraise=True))
        (cache / 'mixed.json').write_text('{}')
        with self.assertRaises(runner.Blocked):
            self.preflight()
        (cache / 'mixed.json').unlink()
        saved = generated.read_bytes()
        generated.unlink()
        other = self.root / 'external.pyc'
        other.write_bytes(saved)
        generated.symlink_to(other)
        with self.assertRaises(runner.Blocked):
            self.preflight()
        generated.unlink()
        cache.rmdir()
        cache.symlink_to(self.root)
        with self.assertRaises(runner.Blocked):
            self.preflight()

    def manifest(self):
        start = time.time()+100
        return {'shadowSha': SHA, 'window': {'startUtc': runner.utc(start), 'endUtc': runner.utc(start+86400)}}

    def test_cli_publication_order_and_all_gate_failures_no_pointer(self):
        # Execute actual main on a synthetic copied helper + actual seal. No
        # lifecycle fork or production adapter is reachable from this harness.
        helper = self.repo/'scripts/phase4-runner.py'
        helper.write_bytes((ROOT/'scripts/phase4-runner.py').read_bytes())
        helper.with_name('exact_clock.py').write_bytes((ROOT / 'scripts/exact_clock.py').read_bytes())
        (self.repo/'runs').mkdir()
        pointer = self.root/'current-run.json'
        args = ['runner', 'run', '--experiment', str(self.target), '--expected-shadow-sha', SHA,
                '--current-run-pointer', str(pointer)]
        actual_validate = runner.validate
        actual_publish = runner.publish_current_run
        for case in ('missing-pointer', 'seal-invalid', 'revision-failed', 'protected-failed', 'past-window', 'pointer-failed', 'success'):
            with self.subTest(case=case):
                self.target = self.repo/('runs/phase4-'+case)
                args[3] = str(self.target)
                start = time.time()+100
                events = []
                with mock.patch.object(runner, '__file__', str(helper)):
                    runner.seal_files(self.repo, self.target, start, start+86400, {'shadowSha': SHA, 'poly2': {'synthetic': True}})
                def validate(*a):
                    events.append('validate')
                    if case == 'seal-invalid':
                        raise runner.Blocked('SEAL_INVALID','synthetic invalid seal')
                    return actual_validate(*a)
                def preflight(*a):
                    events.extend(['revision', 'protected'])
                    if case in ('revision-failed', 'protected-failed'):
                        raise runner.Blocked('PREFLIGHT_FAILED','synthetic gate failure')
                def publish(*a):
                    events.append('pointer')
                    if case == 'pointer-failed':
                        raise OSError('synthetic pointer failure')
                    return actual_publish(*a)
                def lifecycle(repo, target, m, command, env):
                    events.append('lifecycle')
                    self.assertEqual(json.loads(pointer.read_text())['runDirectory'], str(target))
                    self.assertEqual(command, runner.observer_command(repo, target))
                    self.assertEqual(command[0], 'systemd-run')
                    return 0
                selected_args = args[:-2] if case == 'missing-pointer' else args
                clock = mock.patch.object(time, 'time', return_value=start+1) if case == 'past-window' else mock.patch.object(runner, 'WINDOW_SECONDS', 86400)
                with mock.patch.object(sys, 'argv', selected_args), mock.patch.object(runner, '__file__', str(helper)), mock.patch.object(runner, 'validate', side_effect=validate), mock.patch.object(runner, 'preflight', side_effect=preflight), mock.patch.object(runner, 'publish_current_run', side_effect=publish), mock.patch.object(runner, 'lifecycle', side_effect=lifecycle) as life, mock.patch.object(runner, 'production_snapshot', side_effect=AssertionError('No Poly2')), mock.patch.dict(os.environ, {}, clear=True), clock:
                    result = runner.main()
                if case == 'success':
                    self.assertEqual(result, 0)
                    self.assertEqual(events, ['validate','revision','protected','pointer','lifecycle'])
                else:
                    self.assertEqual(result, 1)
                    life.assert_not_called()
                    self.assertFalse(pointer.exists())
                    if case in ('missing-pointer','seal-invalid'):
                        self.assertFalse((self.target/'runner-start.json').exists())
                    self.assertEqual(list((self.target/'shadow-data').iterdir()), [])

    def test_duplicate_pointer_rejected_preserved_no_lifecycle(self):
        helper = self.repo / 'scripts/phase4-runner.py'
        helper.write_bytes((ROOT / 'scripts/phase4-runner.py').read_bytes())
        helper.with_name('exact_clock.py').write_bytes((ROOT / 'scripts/exact_clock.py').read_bytes())
        (self.repo / 'runs').mkdir()
        start = time.time() + 100
        with mock.patch.object(runner, '__file__', str(helper)):
            runner.seal_files(self.repo, self.target, start, start + 86400,
                              {'shadowSha': SHA, 'poly2': {'synthetic': True}})
        pointer = self.root / 'current-run.json'
        future = {'schemaVersion': 1, 'runDirectory': str(self.target),
                  'runId': self.target.name, 'approvedShadowSha': SHA,
                  'startUtc': runner.utc(start), 'endUtc': runner.utc(start + 86400),
                  'lifecycleState': 'AUTHORIZED'}
        expired = time.time() - 100000
        raw = (json.dumps(future)[:-1] + ',"startUtc":' + json.dumps(runner.utc(expired))
               + ',"endUtc":' + json.dumps(runner.utc(expired + 86400)) + '}').encode()
        pointer.write_bytes(raw)
        argv = ['runner', 'run', '--experiment', str(self.target),
                '--expected-shadow-sha', SHA, '--current-run-pointer', str(pointer)]
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(runner, '__file__', str(helper)), \
                mock.patch.object(runner, 'preflight'), mock.patch.object(runner, 'lifecycle', return_value=0) as life, \
                mock.patch.object(runner, 'production_snapshot', side_effect=AssertionError('No Poly2')), \
                mock.patch.dict(os.environ, {}, clear=True):
            self.assertEqual(runner.main(), 1)
        life.assert_not_called()
        self.assertEqual(pointer.read_bytes(), raw)
        self.assertFalse((self.target / 'runner-start.json').exists())
        self.assertEqual(list((self.target / 'shadow-data').iterdir()), [])

    def test_current_pointer_decoder_rejects_malformed_and_oversized(self):
        for raw in (b'{', b'{"schemaVersion":1,"schemaVersion":1}',
                    b'{"schemaVersion":NaN}', b' ' * (128 * 1024 + 1)):
            with self.subTest(raw_prefix=raw[:50]):
                with self.assertRaises(runner.Blocked):
                    runner.decode_current_pointer(raw)

    def test_pointer_write_fsync_failure_preserves_stale_bytes(self):
        pointer = self.root/'current-run.json'
        old = self.manifest()
        start = time.time()-100000
        old['window'] = {'startUtc':runner.utc(start),'endUtc':runner.utc(start+86400)}
        data = {'schemaVersion':1,'runDirectory':str(self.target),'runId':self.target.name,
                'approvedShadowSha':SHA, **old['window'],'lifecycleState':'AUTHORIZED'}
        pointer.write_text(json.dumps(data))
        before = pointer.read_bytes()
        real_sync = runner.fsync_dir
        count = [0]
        def fsync(path):
            if path == pointer.parent:
                count[0] += 1
                if count[0] == 2:  # First stages; second follows atomic replace.
                    raise OSError('synthetic durability failure')
            return real_sync(path)
        with mock.patch.object(runner,'fsync_dir',side_effect=fsync):
            with self.assertRaises(OSError):
                runner.publish_current_run(self.repo,self.target,self.manifest(),pointer)
        self.assertEqual(pointer.read_bytes(),before)
        self.assertEqual(list(self.root.glob('.current-run.json.*')),[])

    def test_scope_command_fixed_no_override(self):
        cmd = runner.observer_command(self.repo, self.target)
        self.assertEqual(cmd, ['systemd-run', '--user', '--scope', '--quiet', '--unit=poly-shadow-observer-phase4-synthetic', '--property=MemoryMax=4294967296', '--property=MemoryHigh=3221225472', '--property=MemorySwapMax=536870912', 'python3', '-B', str(self.repo/'scripts/phase4-observer-entry.py'), '--run-id', self.target.name])
        self.assertNotIn('MemoryOOMGroup', ' '.join(cmd))
        with self.assertRaises(runner.Blocked):
            runner.observer_command(self.repo, self.repo/'runs/phase4-bad.name')

    def test_pointer_publish_schema_active_stale_and_failure(self):
        pointer = self.root / 'current-run.json'
        m = self.manifest()
        runner.publish_current_run(self.repo, self.target, m, pointer)
        data = json.loads(pointer.read_text())
        self.assertEqual(data, {'schemaVersion': 1, 'runDirectory': str(self.target), 'runId': self.target.name, 'approvedShadowSha': SHA, 'startUtc': m['window']['startUtc'], 'endUtc': m['window']['endUtc'], 'lifecycleState': 'AUTHORIZED'})
        old = pointer.read_bytes()
        with self.assertRaises(runner.Blocked):
            runner.publish_current_run(self.repo, self.target, m, pointer)
        self.assertEqual(pointer.read_bytes(), old)
        start = time.time()-100000
        data['startUtc'], data['endUtc'] = runner.utc(start), runner.utc(start+86400)
        pointer.write_text(json.dumps(data))
        old = pointer.read_bytes()
        with mock.patch.object(os, 'replace', side_effect=OSError('synthetic replace failure')):
            with self.assertRaises(OSError):
                runner.publish_current_run(self.repo, self.target, m, pointer)
        self.assertEqual(pointer.read_bytes(), old)
        runner.publish_current_run(self.repo, self.target, m, pointer)
        self.assertEqual(json.loads(pointer.read_text())['startUtc'], m['window']['startUtc'])

    def test_pointer_bad_paths_schema_and_expired_gate(self):
        m = self.manifest()
        for p in (self.repo/'pointer.json', self.repo/'runs/current-run.json'):
            with self.assertRaises(runner.Blocked):
                runner.publish_current_run(self.repo, self.target, m, p)
            self.assertFalse(p.exists())
        pointer = self.root/'current.json'
        pointer.write_text('{}')
        with self.assertRaises(runner.Blocked):
            runner.publish_current_run(self.repo, self.target, m, pointer)
        self.assertEqual(pointer.read_text(), '{}')
        pointer.unlink()
        m['window']['startUtc'] = runner.utc(time.time()-1)
        with self.assertRaises(runner.Blocked):
            runner.publish_current_run(self.repo, self.target, m, pointer)
        self.assertFalse(pointer.exists())

class Entry(unittest.TestCase):
    def setUp(self):
        self.entry = load('observer_entry', ROOT/'scripts/phase4-observer-entry.py')
        self.tmp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'], prefix='cgroup-synthetic-')
        self.root = Path(self.tmp.name)
        self.leaf = self.root/'user.slice/poly-shadow-observer-phase4-synthetic.scope'
        self.leaf.mkdir(parents=True)
        for p in (self.root, self.leaf.parent, self.leaf):
            (p/'memory.max').write_text('max')
        (self.leaf/'memory.max').write_text('4294967296')
        (self.leaf/'memory.high').write_text('3221225472')
        (self.leaf/'memory.swap.max').write_text('536870912')
        (self.leaf/'memory.oom.group').write_text('0')
        self.cg = '0::/user.slice/'+self.leaf.name+'\n'

    def tearDown(self):
        self.tmp.cleanup()

    def verify(self):
        return self.entry.verify_scope('phase4-synthetic', self.cg, self.root)

    def test_exact_scope_verifies_and_writes_only_own_oom(self):
        (self.leaf.parent/'memory.oom.group').write_text('0')
        self.assertEqual(self.verify()['effectiveMemoryMax'], 4294967296)
        self.assertEqual((self.leaf/'memory.oom.group').read_text().strip(), '1')
        self.assertEqual((self.leaf.parent/'memory.oom.group').read_text(), '0')

    def test_mismatch_limits_and_scope_block_before_exec(self):
        for file, value in (('memory.max','max'), ('memory.max','4294967297'), ('memory.high','max'), ('memory.swap.max','0')):
            with self.subTest(file=file, value=value):
                p = self.leaf/file
                old = p.read_text()
                p.write_text(value)
                with self.assertRaises(self.entry.ScopeBlocked):
                    self.verify()
                self.assertEqual((self.leaf/'memory.oom.group').read_text(), '0')
                p.write_text(old)
        (self.leaf.parent/'memory.max').write_text('2147483648')
        with self.assertRaises(self.entry.ScopeBlocked):
            self.verify()
        with mock.patch.object(self.entry, 'verify_scope', side_effect=self.entry.ScopeBlocked('wrong scope')), mock.patch.object(os, 'execve') as execute:
            self.assertEqual(self.entry.main(['--run-id','phase4-synthetic']), 1)
            execute.assert_not_called()

    def test_ancestor_change_during_oom_write_blocks_exec(self):
        real_write = Path.write_text
        def change(path, text, *args, **kwargs):
            result = real_write(path, text, *args, **kwargs)
            if path == self.leaf/'memory.oom.group':
                real_write(self.leaf.parent/'memory.max','2147483648')
            return result
        with mock.patch.object(Path,'write_text',change):
            with self.assertRaises(self.entry.ScopeBlocked):
                self.verify()

    def test_verified_entry_fixed_exec_minimal_environment(self):
        self.verify_source_entry()

    def test_unchecked_hash_stale_cache_cannot_supply_runtime_env(self):
        self.verify_source_entry(stale_cache=True)

    def verify_source_entry(self, stale_cache=False):
        # Copy only runner helper to a synthetic repository. exec is mocked.
        repo = self.root/'fixture-repo'
        (repo/'scripts').mkdir(parents=True)
        source = repo/'scripts/phase4-runner.py'
        approved = (ROOT/'scripts/phase4-runner.py').read_bytes()
        if stale_cache:
            source.write_text('def runtime_env(target):\n    return {"MARKER": "stale-unchecked-hash"}\n')
            generated = Path(py_compile.compile(str(source), doraise=True,
                             invalidation_mode=py_compile.PycInvalidationMode.UNCHECKED_HASH))
            preserved = generated.read_bytes()
            self.assertEqual(int.from_bytes(preserved[4:8], 'little'), 1)
        source.write_bytes(approved)
        if stale_cache:
            subprocess.run(['git', 'init', '-q', str(repo)], check=True)
            subprocess.run(['git', '-C', str(repo), 'add', 'scripts/phase4-runner.py'], check=True)
            real_call = runner.call
            def untracked_only(cmd, cwd=None):
                value = real_call(cmd, cwd)
                if '--porcelain=v1' in cmd:
                    return '\0'.join(row for row in value.split('\0') if row.startswith('?? ')) + '\0'
                return value
            with mock.patch.object(runner, 'call', side_effect=untracked_only):
                accepted = runner.classify_untracked(repo)['interpreterCache']
            self.assertEqual(accepted, [str(generated.relative_to(repo))])
        target = repo/'runs/phase4-synthetic'
        (target/'shadow-data').mkdir(parents=True)
        (target/'runtime-home').mkdir()
        original_verify = self.entry.verify_scope
        original_read = Path.read_text
        with mock.patch.object(self.entry,'__file__',str(repo/'scripts/phase4-observer-entry.py')), mock.patch.object(self.entry,'verify_scope',side_effect=lambda run_id, text: original_verify(run_id, self.cg, self.root)), mock.patch.object(Path,'read_text',autospec=True,side_effect=lambda p,*a,**kw: self.cg if p == Path('/proc/self/cgroup') else original_read(p,*a,**kw)), mock.patch.object(os,'chdir') as chdir, mock.patch.object(os,'execve') as execute, mock.patch.dict(os.environ,{'PRIVATE_KEY':'ignored-value','PATH':'/evil','NODE_OPTIONS':'--bad','SHADOW_DATA_DIR':'/evil'},clear=True):
            self.entry.main(['--run-id','phase4-synthetic'])
        chdir.assert_called_once_with(repo)
        command, argv, env = execute.call_args.args
        self.assertEqual((command,argv),('/usr/bin/npm',['npm','start']))
        self.assertNotIn('MARKER', env)
        if stale_cache:
            self.assertEqual(generated.read_bytes(), preserved)
            self.assertEqual(source.read_bytes(), approved)
        self.assertEqual(env['PATH'],'/usr/bin:/bin')
        self.assertEqual(env['SHADOW_DATA_DIR'],str(target/'shadow-data'))
        self.assertNotIn('PRIVATE_KEY',env)
        self.assertNotIn('NODE_OPTIONS',env)
        self.assertNotIn('XDG_RUNTIME_DIR',env)
        self.assertEqual((self.leaf/'memory.oom.group').read_text().strip(),'1')

    def test_cgroup_root_without_memory_controller_file(self):
        # cgroup v2 root is not resource-controlled and has no memory.max.
        (self.root/'memory.max').unlink()
        self.assertEqual(self.verify()['effectiveMemoryMax'], 4294967296)

    def test_cgroup_limit_file_symlink_rejected(self):
        source = self.root/'outside-memory.high'
        source.write_text('3221225472')
        (self.leaf/'memory.high').unlink()
        (self.leaf/'memory.high').symlink_to(source)
        with self.assertRaises(self.entry.ScopeBlocked):
            self.verify()
        self.assertEqual((self.leaf/'memory.oom.group').read_text(), '0')

    def test_oom_write_readback_failure_and_direct_entry_block(self):
        with mock.patch.object(Path, 'write_text', side_effect=PermissionError('blocked')):
            with self.assertRaises(self.entry.ScopeBlocked):
                self.verify()
        with mock.patch.object(Path, 'write_text', return_value=1):
            with self.assertRaises(self.entry.ScopeBlocked):
                self.verify()
        with self.assertRaises(self.entry.ScopeBlocked):
            self.entry.verify_scope('phase4-synthetic','0::/user.slice\n',self.root)
        with self.assertRaises(self.entry.ScopeBlocked):
            self.entry.verify_scope('phase4-../bad',self.cg,self.root)

if __name__ == '__main__':
    unittest.main(verbosity=2)
