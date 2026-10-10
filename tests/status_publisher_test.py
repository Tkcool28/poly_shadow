"""Disposable publisher lifecycle / failure proofs; no scheduler or observer calls."""
import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('publisher_fixture', ROOT/'scripts/status/publisher.py')
p = importlib.util.module_from_spec(spec); spec.loader.exec_module(p)

class PublisherTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.now = 1900000000
    def publisher(self, **kw):
        return p.Publisher(self.root/'public.json', self.root/'cache.json', self.root/'pointer.json', self.root/'runs', now=lambda:self.now, **kw)
    def test_horizon_unlimited_24h_plus_drain(self):
        for cadence in (1, 60, 120):
            h = p.horizon_proof(cadence)
            self.assertIsNone(h['maximumAttempts']); self.assertFalse(h['canExhaust'])
            self.assertGreaterEqual(h['requiredAttempts']*cadence, 93600)
        self.assertGreater(p.horizon_proof()['requiredAttempts'], 1500)
    def test_more_than_1500_real_atomic_cycles_restart_failure_recovery(self):
        calls = []
        def collect(**kw):
            calls.append(kw); return dict(schemaVersion=1, generatedUtc=p.collector.utc(kw['now']))
        pub = self.publisher(collect=collect)
        for _ in range(1562):
            self.assertTrue(pub.cycle()); self.now += 60
        before = (self.root/'public.json').read_bytes()
        error = OSError('synthetic ENOSPC')
        pub.write = lambda *a, **k: (_ for _ in ()).throw(error)
        self.assertFalse(pub.cycle()); self.assertEqual((self.root/'public.json').read_bytes(), before)
        self.assertEqual(pub.state['consecutiveFailures'], 1)
        pub.write = p.collector.atomic_json
        pub.collect = lambda **k: (_ for _ in ()).throw(error)
        self.now += 60; self.assertFalse(pub.cycle())
        self.assertEqual(p.collector.obj(pub.state_path)['failures'], 2)
        restart = self.publisher(collect=collect)
        self.assertEqual(restart.state['attempts'], 1564)
        self.now += 60; self.assertTrue(restart.cycle())
        value = p.collector.obj(self.root/'public.json')['publisher']
        self.assertEqual(value['attempts'], 1565); self.assertEqual(value['failures'], 2)
        self.assertEqual(value['consecutiveFailures'], 0)
        self.assertEqual(value['lastSuccessfulUtc'], p.collector.utc(self.now))
        self.assertEqual(value['nextExpectedUtc'], p.collector.utc(self.now+60))
        self.assertEqual(len(calls), 1564)
    def test_real_collector_independent_missing_observer_pointer(self):
        pub = self.publisher()
        self.assertTrue(pub.cycle())
        self.assertEqual(p.collector.obj(self.root/'public.json')['state'], 'NO_ACTIVE_RUN')
    def test_fixed_loop_skips_missed_slots_and_stops_only_by_signal(self):
        class Stop:
            count = 0
            waits = []
            def is_set(self): return self.count >= 1601
            def wait(self, delay): self.waits.append(delay); self.count += 1
        stop = Stop(); pub = self.publisher(collect=lambda **kw:{}, write=lambda *a, **kw:None)
        times = iter([v for i in range(1601) for v in (i*100, i*100+80)])
        pub.run(stop, monotonic=lambda:next(times))
        self.assertEqual(pub.state['attempts'], 1601); self.assertEqual(set(stop.waits), {0})
    def test_invalid_cadence(self):
        for value in (0, -1, float('nan'), float('inf')):
            with self.assertRaises(ValueError): p.horizon_proof(value)
