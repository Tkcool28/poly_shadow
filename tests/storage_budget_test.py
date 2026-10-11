"""Engineering storage boundaries, language parity and runner fail-closed gate."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch
ROOT = Path(__file__).resolve().parents[1]
def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
b = load('budget_fixture', ROOT/'scripts/storage_budget.py')
r = load('disk_runner_fixture', ROOT/'scripts/phase4-runner.py')
class BudgetTests(unittest.TestCase):
    def test_language_parity_24h_drain_and_remaining(self):
        for seconds in (0, 86400, 93600):
            # Run real TS implementation, not duplicated formulas.
            command = "import {storageBudget} from './src/shadow/storage-budget.ts'; console.log(JSON.stringify(storageBudget(%s)));" % seconds
            out = subprocess.check_output([str(ROOT/'node_modules/.bin/tsx'), '-e', command], cwd=ROOT, text=True)
            self.assertEqual(json.loads(out), b.budget(seconds))
        self.assertEqual(len(b.budget()['families']), 8)
    def test_exact_thresholds(self):
        total = b.budget()['requiredFreeBytes']; reserve = b.plan()['alertReserveBytes']
        for available, state in ((None,'UNKNOWN'), (reserve-1,'AT_RISK'), (reserve,'DEGRADED'),(total-1,'DEGRADED'),(total,'GREEN')):
            self.assertEqual(b.disk_state(available)['state'], state)
    def test_prelaunch_nearest_parent_and_fail_closed(self):
        with tempfile.TemporaryDirectory() as d:
            calls=[]
            def stat(path):
                calls.append(path); return types.SimpleNamespace(f_bavail=b.budget()['requiredFreeBytes'], f_frsize=1, f_blocks=2*b.budget()['requiredFreeBytes'])
            self.assertEqual(b.prelaunch_gate(Path(d)/'not/yet',stat)['state'],'GREEN')
            self.assertEqual(calls,[Path(d)])
            with self.assertRaisesRegex(ValueError,'PRELAUNCH_DISK_GATE'):
                b.prelaunch_gate(d,lambda _:types.SimpleNamespace(f_bavail=0,f_frsize=1,f_blocks=1))
    def test_runner_gate_before_production_side_effect(self):
        def lookup(cmd,cwd=None):
            if cmd[1:] == ['branch','--show-current']: return r.BRANCH
            if cmd[1:3] == ['rev-parse','HEAD'] or cmd[1:3] == ['rev-parse','origin/main']: return 'a'*40
            if cmd[1] == 'rev-list': return '0 0'
            return ''
        with tempfile.TemporaryDirectory() as d, patch.object(r,'call',side_effect=lookup), patch.object(r,'classify_untracked',return_value={}), patch.object(r,'credentials'), patch.object(r,'prelaunch_disk',side_effect=r.Blocked('PREFLIGHT_FAILED','disk')), patch.object(r,'production_snapshot') as prod, patch.object(r,'orphans') as orphan:
            with self.assertRaises(r.Blocked): r.preflight(Path(d),'a'*40,Path(d)/'runs/x')
            prod.assert_not_called(); orphan.assert_not_called()
    def test_missing_budget_source_fails_as_blocked(self):
        with tempfile.TemporaryDirectory() as d:
            with self.assertRaises(r.Blocked): r.prelaunch_disk(Path(d),Path(d)/'target')
