"""Prospective capture health reaches the existing status composition, synthetic only."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('prospective_status', Path(__file__).resolve().parents[1] / 'scripts/status/collector.py')
assert spec and spec.loader
collector = importlib.util.module_from_spec(spec)
spec.loader.exec_module(collector)
START = '2030-01-01T00:00:00Z'
END = '2030-01-02T00:00:00Z'


class CaptureStatusTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', '/root/.hermes/cache/scratch'))
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / 'phase4-synthetic-shadow'
        self.target.mkdir()
        (self.target / 'shadow-data').mkdir()
        self.capture = self.target / 'poly2-comparison-capture'
        self.capture.mkdir()
        (self.target / 'run-manifest.json').write_text(json.dumps({'state': 'SEALED_NOT_STARTED',
            'experimentDirectory': str(self.target), 'shadowSha': 'a' * 40, 'durationSeconds': 86400,
            'window': {'startUtc': START, 'endUtc': END}}))
        self.binding = {'runId': 'synthetic-capture', 'shadowRunId': self.target.name,
                        'cohort': ['0x' + c * 40 for c in 'abcde'],
                        'window': {'startUtc': START, 'endUtc': END}}
        self.health = {'version': 1, 'binding': self.binding,
                       'bindingSha256': hashlib.sha256(json.dumps(self.binding, sort_keys=True, separators=(',', ':')).encode()).hexdigest(),
                       'state': 'ACTIVE', 'quality': 'HEALTHY', 'lastSuccessUtc': START,
                       'cursor': 2, 'endCoverage': False, 'failures': 0, 'gaps': [], 'count': 1, 'error': None}

    def publish(self):
        (self.capture / 'poly2_capture_health.json').write_text(json.dumps(self.health))

    def status(self, now=None):
        return collector.collect(run=self.target, now=collector.epoch(START) + 10 if now is None else now,
                                 cache_path=self.root / 'cache.json', health_provider=lambda: {},
                                 pointer_path=self.root / 'no-pointer', runs_root=self.root)['poly2ComparisonCapture']

    def test_actual_status_composition_exposes_bound_health_without_source_query(self):
        self.publish()
        value = self.status()
        self.assertEqual(value['state'], 'ACTIVE')
        self.assertEqual(value['cursor'], 2)
        self.assertEqual(value['count'], 1)
        self.assertFalse(value['endCoverage'])
        self.assertIn('not producer/cursor proof', value['scope'])

    def test_missing_capture_is_unknown_not_success(self):
        self.assertEqual(self.status()['state'], 'NOT_ARMED')
        self.assertEqual(self.status()['quality'], 'UNKNOWN_UNPROVEN')

    def test_gaps_failure_stale_and_misbound_never_end_coverage(self):
        self.health.update(state='FAILED', quality='AT_RISK', endCoverage=True, failures=2, gaps=['missed-commit'], error='synthetic source loss')
        self.publish()
        value = self.status()
        self.assertFalse(value['endCoverage'])
        self.assertEqual(value['failures'], 2)
        self.assertEqual(value['gaps'], ['missed-commit'])
        self.health.update(state='ACTIVE', quality='HEALTHY', gaps=[], failures=0)
        self.publish()
        self.assertEqual(self.status(collector.epoch(START) + 100)['quality'], 'AT_RISK')
        self.health['binding']['shadowRunId'] = 'wrong'
        self.publish()
        self.assertEqual(self.status()['state'], 'UNVERIFIED')

    def test_malformed_oversize_and_symlink_capture_fail_closed(self):
        path = self.capture / 'poly2_capture_health.json'
        for text in ('{', ' ' * (collector.LIMIT + 1), '{"cursor":-1}'):
            path.write_text(text)
            self.assertEqual(self.status()['state'], 'UNVERIFIED')
        path.unlink()
        (self.root / 'untrusted').write_text(json.dumps(self.health))
        path.symlink_to(self.root / 'untrusted')
        self.assertEqual(self.status()['state'], 'UNVERIFIED')


if __name__ == '__main__':
    unittest.main()
