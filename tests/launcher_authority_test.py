"""Disposable launcher authority tests; production adapters are never executed."""
import copy
import importlib.util
import json
import io
from pathlib import Path
import shutil
import sys
import time
import tempfile
import unittest
from unittest import mock

from poly2_authority_test import A, fixture

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('launcher', ROOT / 'scripts/phase4-runner.py')
assert spec is not None and spec.loader is not None
r = importlib.util.module_from_spec(spec)
spec.loader.exec_module(r)
APPROVED = '457796' + 'a' * 34  # representative independently approved new revision
STALE = 'bd61efc90a4ff8bfc17b8a31abc4a40dd655f81f'
SHADOW = 'a' * 40

class LauncherAuthority(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.target = ROOT / 'runs/phase4-disposable'
        b, self.authority, _ = fixture()
        b.update(poly2CodeSha=APPROVED, shadowCodeSha=SHADOW,
                 shadowRunId=self.target.name, cohort=r.WALLETS)
        self.authority['cohortSha256'] = A.digest(r.WALLETS)
        self.path = self.root / 'operator-approved.json'
        self.save()

    def save(self):
        self.path.write_text(json.dumps(self.authority))
        self.pin = A.digest(self.authority)

    def load(self, path=None, pin=None):
        return r.load_launch_authority(ROOT, self.target, SHADOW,
                                       path or self.path, self.pin if pin is None else pin)

    def snapshot(self, sha):
        approved = self.load()
        config = {'paper_mode': True, 'allow_live_trading': False}
        db = {'readOnly': 'on', 'wallets': r.WALLETS, 'heartbeats': [
            {'service': name, 'last_seen': r.utc()} for name in ('bot_alive', 'bot_success')]}
        container = {'Status': 'running', 'Running': True, 'Restarting': False, 'StartedAt': 'fixture'}
        with mock.patch.object(r, 'call', side_effect=[json.dumps(config), json.dumps(db), json.dumps(container), sha]), mock.patch.object(r, 'digest', return_value='fixture'):
            return r.production_snapshot(approved)

    def test_approved_new_revision_passes(self):
        self.assertEqual(self.snapshot(APPROVED)['sha'], APPROVED)

    def test_wrong_actual_revision_fails(self):
        with self.assertRaises(r.Blocked) as caught: self.snapshot('b' * 40)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_FAILED')

    def test_stale_old_revision_fails(self):
        with self.assertRaises(r.Blocked) as caught: self.snapshot(STALE)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_FAILED')

    def test_missing_poly2_sha_fails(self):
        del self.authority['binding']['poly2CodeSha']; self.save()
        self.assert_refused()

    def test_bad_poly2_sha_fails(self):
        for value in ('', 'a' * 39, 'A' * 40, None, 12):
            with self.subTest(value=value):
                self.authority['binding']['poly2CodeSha'] = value; self.save()
                self.assert_refused()

    def assert_refused(self, **kwargs):
        with self.assertRaises(r.Blocked) as caught: self.load(**kwargs)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_FAILED')

    def test_malformed_authority_fails(self):
        for raw in ('{', 'null', '[]', '{"binding":{}}', '{"schemaVersion":1,"schemaVersion":1}'):
            with self.subTest(raw=raw):
                self.path.write_text(raw); self.assert_refused()

    def test_missing_authority_fails(self):
        self.path.unlink(); self.assert_refused()
        with self.assertRaises(r.Blocked) as caught:
            r.load_launch_authority(ROOT, self.target, SHADOW, None, self.pin)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_FAILED')

    def test_bad_independent_pin_fails(self):
        for pin in ('', '0' * 64, 'A' * 64, '0' * 63):
            with self.subTest(pin=pin): self.assert_refused(pin=pin)

    def test_binding_mismatches_fail(self):
        for field, value in (('shadowCodeSha','b'*40), ('shadowRunId','other'), ('cohort', list(reversed(r.WALLETS)))):
            with self.subTest(field=field):
                original = copy.deepcopy(self.authority)
                self.authority['binding'][field] = value; self.save(); self.assert_refused()
                self.authority = original; self.save()

    def test_replaced_authority_cannot_select_new_pin(self):
        old_pin = self.pin
        self.authority['binding']['poly2CodeSha'] = STALE; self.save()
        self.assert_refused(pin=old_pin)

    def prepare_cli(self):
        self.repo = self.root / 'checkout'
        (self.repo / 'scripts').mkdir(parents=True)
        for name in ('phase4-runner.py', 'production_authority.py', 'exact_clock.py'):
            shutil.copyfile(ROOT / 'scripts' / name, self.repo / 'scripts' / name)
        self.target = self.repo / 'runs/phase4-disposable'
        start = time.time() + 600
        self.authority['binding']['window'] = {'startUtc': r.utc(start), 'endUtc': r.utc(start + 86400)}
        self.save()
        self.actual_sha = APPROVED
        self.production_calls = []

    def adapter(self, cmd, cwd=None, input=None):
        if cmd[0] == 'git' and '-C' not in cmd:
            if cmd[1:] == ['branch', '--show-current']: return 'main'
            if cmd[1:] in (['rev-parse', 'HEAD'], ['rev-parse', 'origin/main']): return SHADOW
            if cmd[1:] == ['rev-list', '--left-right', '--count', 'HEAD...origin/main']: return '0 0'
            return ''
        self.production_calls.append(cmd)
        if cmd[0] == 'git': return self.actual_sha
        if cmd[1] == 'inspect':
            return json.dumps({'Status': 'running', 'Running': True, 'Restarting': False, 'StartedAt': 'fixture'})
        if 'poly2-bot-1' in cmd:
            return json.dumps({'paper_mode': True, 'allow_live_trading': False})
        return json.dumps({'readOnly': 'on', 'wallets': r.WALLETS, 'heartbeats': [
            {'service': name, 'last_seen': r.utc()} for name in ('bot_alive', 'bot_success')]})

    def cli(self, operation, *, inputs=True):
        argv = ['runner', operation, '--experiment', str(self.target), '--expected-shadow-sha', SHADOW]
        if inputs: argv += ['--production-authority', str(self.path), '--authority-sha256', self.pin]
        if operation == 'seal':
            argv += ['--approve-seal', '--start-utc', self.authority['binding']['window']['startUtc'],
                     '--end-utc', self.authority['binding']['window']['endUtc']]
        if operation == 'run': argv += ['--current-run-pointer', str(self.root / 'current.json')]
        original_digest = r.digest
        def digest(path):
            return 'fixture' if str(path) == '/opt/poly2/.env' else original_digest(path)
        stderr = io.StringIO()
        with mock.patch.object(sys, 'argv', argv), mock.patch.object(r, '__file__', str(self.repo / 'scripts/phase4-runner.py')), \
             mock.patch.object(r, 'call', side_effect=self.adapter), mock.patch.object(r, 'digest', side_effect=digest), \
             mock.patch.object(r, 'credentials'), mock.patch.object(r, 'orphans'), \
             mock.patch.object(r, 'prelaunch_disk', return_value={'state': 'GREEN'}), \
             mock.patch.object(r, 'publish_current_run') as pointer, mock.patch.object(r, 'lifecycle', return_value=0) as launch, \
             mock.patch.object(sys, 'stderr', stderr), mock.patch.object(sys, 'stdout', io.StringIO()):
            code = r.main()
        self.assertFalse((self.root / 'current.json').exists())
        return code, stderr.getvalue(), pointer, launch

    def test_actual_cli_preflight_seal_run_reuses_independent_pin(self):
        self.prepare_cli()
        self.assertEqual(self.cli('preflight')[0], 0)
        self.assertFalse(self.target.exists())
        self.assertEqual(self.cli('seal')[0], 0)
        manifest = json.loads((self.target / 'run-manifest.json').read_text())
        checks = json.loads((self.target / 'preflight.json').read_text())
        self.assertEqual(manifest['poly2Sha'], APPROVED)
        self.assertEqual(manifest['productionAuthority']['sha256'], self.pin)
        self.assertEqual(checks['productionAuthority'], manifest['productionAuthority'])
        code, _, pointer, launch = self.cli('run')
        self.assertEqual(code, 0); pointer.assert_called_once(); launch.assert_called_once()
        self.assertEqual(launch.call_args.args[2]['productionAuthority']['sha256'], self.pin)

    def test_cli_missing_authority_all_operations_fail_before_adapters(self):
        self.prepare_cli()
        for operation in ('preflight', 'seal', 'run'):
            with self.subTest(operation=operation):
                code, stderr, pointer, launch = self.cli(operation, inputs=False)
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(stderr)['lifecycleCode'], 'PREFLIGHT_FAILED')
                pointer.assert_not_called(); launch.assert_not_called()
                self.assertFalse(self.target.exists()); self.assertEqual(self.production_calls, [])

    def test_cli_revision_mismatch_preflight_and_seal_fail_closed(self):
        self.prepare_cli()
        for sha in ('b' * 40, STALE):
            self.actual_sha = sha
            for operation in ('preflight', 'seal'):
                with self.subTest(sha=sha, operation=operation):
                    code, stderr, pointer, launch = self.cli(operation)
                    self.assertEqual(code, 1)
                    self.assertEqual(json.loads(stderr)['lifecycleCode'], 'PREFLIGHT_FAILED')
                    pointer.assert_not_called(); launch.assert_not_called(); self.assertFalse(self.target.exists())

    def test_cli_run_revision_mismatch_does_not_publish_or_launch(self):
        self.prepare_cli(); self.assertEqual(self.cli('seal')[0], 0)
        self.actual_sha = STALE
        code, stderr, pointer, launch = self.cli('run')
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(stderr)['lifecycleCode'], 'PREFLIGHT_FAILED')
        pointer.assert_not_called(); launch.assert_not_called()
        self.assertFalse((self.target / 'runtime-home').exists())

    def test_seal_binding_pin_and_revision_tampering_fail(self):
        self.prepare_cli(); self.assertEqual(self.cli('seal')[0], 0)
        path = self.target / 'run-manifest.json'
        original = json.loads(path.read_text())
        path.chmod(0o600)
        for field in ('poly2Sha', 'productionAuthority'):
            changed = copy.deepcopy(original)
            if field == 'poly2Sha': changed[field] = STALE
            else: changed[field]['sha256'] = '0' * 64
            path.write_text(json.dumps(changed))
            with self.subTest(field=field), self.assertRaises(r.Blocked) as caught:
                r.validate(self.repo, self.target, SHADOW, authority_path=self.path, authority_pin=self.pin)
            self.assertEqual(caught.exception.code, 'SEAL_INVALID')
        path.write_text(json.dumps(original))
        old_pin = self.pin
        self.authority['binding']['poly2CodeSha'] = STALE; self.save()
        with self.assertRaises(r.Blocked) as caught:
            r.validate(self.repo, self.target, SHADOW, authority_path=self.path, authority_pin=old_pin)
        self.assertEqual(caught.exception.code, 'PREFLIGHT_FAILED')
        # Even a separately valid new approval cannot silently replace a seal's approval.
        with self.assertRaises(r.Blocked) as caught:
            r.validate(self.repo, self.target, SHADOW, authority_path=self.path, authority_pin=self.pin)
        self.assertEqual(caught.exception.code, 'SEAL_INVALID')

    def test_preflight_tampering_with_recomputed_hash_cannot_rebind_seal(self):
        self.prepare_cli(); self.assertEqual(self.cli('seal')[0], 0)
        path = self.target / 'preflight.json'
        checks = json.loads(path.read_text())
        checks['productionAuthority']['sha256'] = '0' * 64
        path.chmod(0o600)
        path.write_text(json.dumps(checks))
        manifest_path = self.target / 'run-manifest.json'
        manifest = json.loads(manifest_path.read_text())
        manifest['preflightSha256'] = r.digest(path)
        manifest_path.chmod(0o600)
        manifest_path.write_text(json.dumps(manifest))
        with self.assertRaises(r.Blocked) as caught:
            r.validate(self.repo, self.target, SHADOW, authority_path=self.path, authority_pin=self.pin)
        self.assertEqual(caught.exception.code, 'SEAL_INVALID')

    def test_cli_invalid_authority_matrix_is_preflight_failed(self):
        self.prepare_cli()
        valid = copy.deepcopy(self.authority)
        for case in ('missing-sha', 'bad-sha', 'bad-pin', 'malformed', 'missing-file'):
            with self.subTest(case=case):
                self.authority = copy.deepcopy(valid); self.save()
                if case == 'missing-sha':
                    del self.authority['binding']['poly2CodeSha']; self.save()
                elif case == 'bad-sha':
                    self.authority['binding']['poly2CodeSha'] = 'not-a-revision'; self.save()
                elif case == 'bad-pin': self.pin = '0' * 64
                elif case == 'malformed': self.path.write_text('{')
                else: self.path.unlink()
                code, stderr, pointer, launch = self.cli('seal')
                self.assertEqual(code, 1)
                self.assertEqual(json.loads(stderr)['lifecycleCode'], 'PREFLIGHT_FAILED')
                pointer.assert_not_called(); launch.assert_not_called()
                self.assertFalse(self.target.exists()); self.assertEqual(self.production_calls, [])

    def test_obsolete_constant_absent(self):
        source = (ROOT / 'scripts/phase4-runner.py').read_text()
        self.assertNotIn(STALE, source)
        self.assertNotIn('POLY2_SHA', source)

if __name__ == '__main__': unittest.main()
