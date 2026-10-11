"""Synthetic-only producer/worker tests; never imports or queries Poly2."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('prospective_hook', ROOT / 'scripts/poly2-comparison-source-hook.py')
assert spec is not None and spec.loader is not None
hook = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hook)
START = '2026-01-01T00:00:00.000Z'
END = '2026-01-02T00:00:00.000Z'
COHORT = ['0x' + c * 40 for c in 'abcde']
TX = '0x' + '1' * 64


def binding():
    return {'runId': 'synthetic-capture', 'shadowRunId': 'synthetic-shadow',
            'poly2CodeSha': 'a' * 40, 'componentSha256': 'b' * 64,
            'cohort': COHORT, 'window': {'startUtc': START, 'endUtc': END},
            'evidenceKind': 'synthetic', 'sourcePublicKey': None}


def facts():
    event = f'data-api:{TX}:{COHORT[0]}:7:100:0.5:1767261600'
    trade = SimpleNamespace(id=1, polymarket_trade_id=event, asset_id='7',
                            side='BUY', size=100, traded_at='2026-01-01T10:00:00.000Z',
                            ingested_at='2026-01-01T10:00:10.000Z')
    t = hook.trade_fact(trade, SimpleNamespace(address=COHORT[0]), SimpleNamespace(condition_id='market'))
    d = hook.decision_fact(SimpleNamespace(id=2, t2_decided_at='2026-01-01T10:00:20.000Z', miss_reason='stale_signal'),
                           SimpleNamespace(source_trade_id=event, t1_detected_at=t['ingestedUtc']))
    return t, d


def build_fixture(directory):
    directory = Path(directory)
    source = directory / 'source'
    b = binding()
    (directory / 'binding.json').write_text(json.dumps(b))
    clock = [START]
    producer = hook.ObservationHook(source, b, enabled=True, synthetic_clock=lambda: clock[0])
    assert producer.register_writer('ingestion') and producer.register_writer('execution')
    assert producer.activate()
    token = producer.begin('ingestion')
    clock[0] = '2026-01-01T10:00:19.000Z'
    assert producer.before_commit(token)
    clock[0] = '2026-01-01T10:00:21.000Z'
    t, d = facts()
    assert producer.committed(token, trades=[t], decisions=[d])
    clock[0] = END
    assert producer.end_fence()
    producer.close()
    return b


class SourceHookTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ.get('TMPDIR', '/root/.hermes/cache/scratch'), prefix='poly2-prospective-python-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.clock = [START]

    def source(self, **kw):
        obj = hook.ObservationHook(self.root / 'source', binding(), enabled=True,
                                   synthetic_clock=lambda: self.clock[0], **kw)
        self.addCleanup(obj.close)
        return obj

    def activate(self, **kw):
        obj = self.source(**kw)
        self.assertTrue(obj.register_writer('ingestion'))
        self.assertTrue(obj.register_writer('execution'))
        self.assertTrue(obj.activate())
        return obj

    def test_disabled_has_zero_files_and_never_requires_keys(self):
        obj = hook.ObservationHook(self.root / 'absent', binding())
        self.assertIsNone(obj.begin('ingestion'))
        self.assertFalse(obj.committed('missing'))
        self.assertFalse((self.root / 'absent').exists())

    def test_producer_to_worker_sealed_manifest_readback_and_restart_exact(self):
        build_fixture(self.root)
        archive = self.root / 'archive.json'
        command = [sys.executable, str(ROOT / 'scripts/poly2-comparison-capture-worker.py'),
                   str(self.root / 'binding.json'), str(self.root / 'source'),
                   str(self.root / 'capture'), '--archive', str(archive)]
        result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(archive.read_text())
        self.assertEqual(data['manifest']['rowCount'], 1)
        self.assertEqual(data['manifest']['sourceCursor'], 3)
        self.assertEqual(data['rows'][0]['sourceEventId'], facts()[0]['sourceEventId'])
        self.assertIsNone(data['rows'][0]['normalizedUtc'])
        self.assertEqual(data['rows'][0]['decisionUtc'], facts()[1]['decisionUtc'])
        self.assertEqual(json.loads((self.root / 'capture/poly2_capture_health.json').read_text())['state'], 'SEALED')
        # Rebuild reads the same immutable spool, no duplicate rows; existing archive refuses overwrite.
        again = subprocess.run(command, cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(again.returncode, 2)
        self.assertEqual(json.loads(archive.read_text()), data)
        replay = subprocess.run(command[:-2], cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(replay.returncode, 0, replay.stderr)

    def test_begin_without_enrollment_visible_no_trading_exception(self):
        obj = self.source()
        self.assertIsNone(obj.begin('ingestion'))
        self.assertFalse(obj.healthy)
        self.assertFalse(obj.end_fence())

    def test_source_writer_failure_does_not_propagate_or_advance_cursor(self):
        armed = [False]
        def append(path, value):
            if armed[0] and path.name == 'poly2_source_receipts.ndjson':
                raise OSError('synthetic ENOSPC')
            with open(path, 'ab') as stream:
                stream.write(value)
        obj = self.activate(append=append)
        token = obj.begin('ingestion')
        self.assertTrue(obj.before_commit(token))
        armed[0] = True
        self.assertFalse(obj.committed(token, trades=[facts()[0]]))
        self.assertEqual(obj.cursor, 1)
        self.assertFalse(obj.end_fence())
        self.assertEqual(json.loads((self.root / 'source/source_capture_health.json').read_text())['quality'], 'AT_RISK')

    def test_crash_precommit_pending_durable_and_restart_no_fence(self):
        obj = self.activate()
        obj.begin('ingestion')
        obj.close()
        recovered = self.source()
        self.assertFalse(recovered.healthy)
        self.assertIn('authoritative transaction recovery', recovered.error)
        self.assertFalse(recovered.end_fence())
        rows = [json.loads(line) for line in (self.root / 'source/source_transactions.ndjson').read_text().splitlines()]
        self.assertTrue(any(row['kind'] == 'BEGIN' for row in rows))
        self.assertFalse(any(row['kind'] == 'OWNER_STOP' for row in rows))

    def test_missing_aftercommit_ack_cannot_prove_boundary(self):
        obj = self.activate()
        token = obj.begin('execution')
        self.assertTrue(obj.before_commit(token))
        self.clock[0] = END
        self.assertFalse(obj.end_fence())
        self.assertTrue(obj.pending)

    def test_rollback_receipt_not_phantom_ingestion(self):
        obj = self.activate()
        token = obj.begin('ingestion')
        self.assertTrue(obj.rolled_back(token))
        self.clock[0] = END
        self.assertTrue(obj.end_fence())
        frames = [json.loads(line) for line in (self.root / 'source/poly2_source_receipts.ndjson').read_text().splitlines()]
        self.assertEqual([f['kind'] for f in frames], ['ACTIVATION', 'END_FENCE'])
        self.assertEqual(frames[-1]['fence']['throughCursor'], 1)

    def test_late_activation_and_unknown_commit_are_risk_not_exceptions(self):
        obj = self.source()
        obj.register_writer('ingestion')
        obj.register_writer('execution')
        self.clock[0] = '2026-01-01T00:00:00.001Z'
        self.assertFalse(obj.activate())
        self.assertFalse(obj.committed('unknown'))

    def test_orphan_frames_never_start_new_ownership_or_reset_position(self):
        source = self.root / 'source'
        source.mkdir()
        path = source / 'poly2_source_receipts.ndjson'
        path.write_bytes(b'{"orphan":true}\n')
        recovered = self.source()
        self.assertFalse(recovered.healthy)
        self.assertIn('orphan source frames', recovered.error)
        self.assertFalse((source / 'source_transactions.ndjson').exists())
        self.assertEqual(path.read_bytes(), b'{"orphan":true}\n')

    def test_durable_fence_crash_before_owner_stop_restarts_terminal(self):
        armed = [False]
        def append(path, value):
            if armed[0] and path.name == 'source_transactions.ndjson' and b'OWNER_STOP' in value:
                raise SystemExit('synthetic crash after durable fence')
            with open(path, 'ab') as stream:
                stream.write(value)
        obj = self.activate(append=append)
        armed[0] = True
        self.clock[0] = END
        with self.assertRaises(SystemExit):
            obj.end_fence()
        obj.close()
        path = self.root / 'source/poly2_source_receipts.ndjson'
        before = path.read_bytes()
        recovered = self.source()
        self.assertTrue(recovered.healthy, recovered.error)
        self.assertTrue(recovered.ended)
        self.assertEqual(recovered.cursor, 2)
        self.assertEqual(path.read_bytes(), before)

    def test_actual_frame_append_crash_matrix_preserves_authority(self):
        for failure in ('before', 'complete', 'partial'):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory(dir=self.root) as root:
                armed = [False]
                def append(path, value):
                    if armed[0] and path.name == 'poly2_source_receipts.ndjson':
                        if failure != 'before':
                            with open(path, 'ab') as stream:
                                stream.write(value if failure == 'complete' else value[:23])
                                stream.flush()
                                os.fsync(stream.fileno())
                        raise SystemExit('synthetic abrupt death at append boundary')
                    with open(path, 'ab') as stream:
                        stream.write(value)
                obj = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START, append=append)
                obj.register_writer('ingestion')
                obj.register_writer('execution')
                obj.activate()
                token = obj.begin('ingestion')
                obj.before_commit(token)
                armed[0] = True
                with self.assertRaises(SystemExit):
                    obj.committed(token, trades=[facts()[0]])
                obj.close()
                path = Path(root) / 'poly2_source_receipts.ndjson'
                before = path.read_bytes()
                recovered = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START)
                self.assertEqual(recovered.healthy, failure == 'complete', recovered.error)
                self.assertEqual(recovered.cursor, 2 if failure == 'complete' else (0 if failure == 'partial' else 1))
                self.assertEqual(path.read_bytes(), before)
                if failure != 'complete':
                    self.assertFalse(recovered.end_fence())
                recovered.close()

    def test_commit_ack_without_frame_and_rollback_conflict_rejected(self):
        for conflict in ('ack-without-frame', 'rollback-after-commit'):
            with self.subTest(conflict=conflict), tempfile.TemporaryDirectory(dir=self.root) as root:
                obj = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START)
                obj.register_writer('ingestion')
                obj.register_writer('execution')
                obj.activate()
                token = obj.begin('ingestion')
                obj.before_commit(token)
                if conflict == 'ack-without-frame':
                    obj._control('COMMIT_ACK', {'transactionId': token, 'cursor': 2})
                else:
                    obj.committed(token, trades=[facts()[0]])
                    obj._control('ROLLBACK_ACK', {'transactionId': token})
                obj.close()
                recovered = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START)
                self.assertFalse(recovered.healthy)
                self.assertFalse(recovered.end_fence())
                recovered.close()

    def test_clean_restart_restores_position_and_exact_duplicate_is_noop(self):
        obj = self.activate()
        token = obj.begin('ingestion')
        obj.before_commit(token)
        self.assertTrue(obj.committed(token, trades=[facts()[0]]))
        obj.close()
        recovered = self.source()
        self.assertTrue(recovered.healthy, recovered.error)
        self.assertEqual(recovered.cursor, 2)
        path = self.root / 'source/poly2_source_receipts.ndjson'
        before = path.read_bytes()
        self.assertTrue(recovered.committed(token, trades=[facts()[0]]))
        self.assertEqual(path.read_bytes(), before)
        self.assertFalse(recovered.committed(token, trades=[]))
        self.assertIn('conflicting source transaction replay', recovered.error)

    def test_crash_after_commit_frame_before_ack_recovers_only_durable_frame(self):
        armed = [False]
        def append(path, value):
            if armed[0] and path.name == 'source_transactions.ndjson' and b'COMMIT_ACK' in value:
                raise SystemExit('synthetic process death before ACK')
            with open(path, 'ab') as stream:
                stream.write(value)
                stream.flush()
                os.fsync(stream.fileno())
        obj = self.activate(append=append)
        token = obj.begin('ingestion')
        obj.before_commit(token)
        armed[0] = True
        with self.assertRaises(SystemExit):
            obj.committed(token, trades=[facts()[0]])
        obj.close()
        recovered = self.source()
        self.assertTrue(recovered.healthy, recovered.error)
        self.assertEqual(recovered.cursor, 2)
        self.assertFalse(recovered.pending)
        self.clock[0] = END
        self.assertTrue(recovered.end_fence())

    def test_crash_after_commit_response_before_frame_never_fabricates_commit(self):
        armed = [False]
        def append(path, value):
            if armed[0] and path.name == 'poly2_source_receipts.ndjson':
                raise SystemExit('synthetic death after DB success before source receipt')
            with open(path, 'ab') as stream:
                stream.write(value)
        obj = self.activate(append=append)
        token = obj.begin('execution')
        obj.before_commit(token)
        armed[0] = True
        with self.assertRaises(SystemExit):
            obj.committed(token, decisions=[facts()[1]])
        obj.close()
        path = self.root / 'source/poly2_source_receipts.ndjson'
        before = path.read_bytes()
        recovered = self.source()
        self.assertFalse(recovered.healthy)
        self.assertIn('authoritative transaction recovery', recovered.error)
        self.assertFalse(recovered.end_fence())
        self.assertEqual(path.read_bytes(), before)

    def test_rollback_restart_has_no_phantom_commit(self):
        obj = self.activate()
        token = obj.begin('execution')
        obj.before_commit(token)
        obj.rolled_back(token)
        obj.close()
        recovered = self.source()
        self.assertTrue(recovered.healthy, recovered.error)
        self.assertFalse(recovered.pending)
        self.assertEqual(recovered.cursor, 1)

    def test_torn_source_and_control_bytes_preserved_restart_refused(self):
        for filename in ('poly2_source_receipts.ndjson', 'source_transactions.ndjson'):
            with self.subTest(filename=filename):
                with tempfile.TemporaryDirectory(dir=self.root) as root:
                    obj = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START)
                    obj.register_writer('ingestion')
                    obj.register_writer('execution')
                    obj.activate()
                    obj.close()
                    path = Path(root) / filename
                    with open(path, 'ab') as stream:
                        stream.write(b'{"torn":')
                    before = path.read_bytes()
                    recovered = hook.ObservationHook(root, binding(), enabled=True, synthetic_clock=lambda: START)
                    self.assertFalse(recovered.healthy)
                    self.assertIn('torn source journal', recovered.error)
                    self.assertEqual(path.read_bytes(), before)
                    self.assertFalse(recovered.end_fence())
                    recovered.close()

    def test_binding_mismatch_and_cursor_conflict_refuse_recovery(self):
        obj = self.activate()
        obj.close()
        path = self.root / 'source/poly2_source_receipts.ndjson'
        row = json.loads(path.read_text())
        row['cursor'] = 8
        path.write_text(hook.canonical(row) + '\n')
        recovered = self.source()
        self.assertFalse(recovered.healthy)
        self.assertIn('position conflict', recovered.error)

    def test_run_binding_mismatch_never_adopts_old_position(self):
        obj = self.activate()
        obj.close()
        b = binding()
        b['runId'] = 'other-run'
        recovered = hook.ObservationHook(self.root / 'source', b, enabled=True, synthetic_clock=lambda: START)
        self.addCleanup(recovered.close)
        self.assertFalse(recovered.healthy)
        self.assertIn('binding mismatch', recovered.error)

    def test_owner_lock_denies_concurrent_producer(self):
        obj = self.activate()
        other = self.source()
        self.assertFalse(other.healthy)
        self.assertEqual(obj.cursor, 1)
        self.assertFalse(other.end_fence())

    def test_sealed_restart_never_duplicates_fence(self):
        obj = self.activate()
        self.clock[0] = END
        obj.end_fence()
        obj.close()
        path = self.root / 'source/poly2_source_receipts.ndjson'
        before = path.read_bytes()
        recovered = self.source()
        self.assertTrue(recovered.healthy, recovered.error)
        self.assertTrue(recovered.ended)
        self.assertFalse(recovered.end_fence())
        self.assertEqual(path.read_bytes(), before)

    def test_failed_append_restart_retains_latch_and_never_fences(self):
        armed = [False]
        def append(path, value):
            if armed[0]:
                raise OSError('synthetic ENOSPC')
            with open(path, 'ab') as stream:
                stream.write(value)
        obj = self.activate(append=append)
        armed[0] = True
        self.assertIsNone(obj.begin('ingestion'))
        obj.close()
        recovered = self.source()
        self.assertFalse(recovered.healthy)
        self.assertIn('failure latch retained', recovered.error)
        self.assertFalse(recovered.end_fence())

    def test_real_mode_cannot_activate_from_two_labels_and_a_key(self):
        class TestKey:
            def sign(self, value):
                raise AssertionError('must not sign an unproven activation')
        b = binding()
        b['evidenceKind'] = 'observational'
        b['sourcePublicKey'] = 'synthetic-not-a-real-key'
        obj = hook.ObservationHook(self.root / 'real', b, enabled=True, private_key=TestKey())
        self.addCleanup(obj.close)
        self.assertTrue(obj.register_writer('ingestion'))
        self.assertTrue(obj.register_writer('execution'))
        self.assertFalse(obj.activate())
        self.assertIn('all-writer commit recovery and boundary authority', obj.error)
        self.assertFalse((self.root / 'real/poly2_source_receipts.ndjson').exists())

    def test_facts_exclude_mutable_statuses_and_preserve_clock_id(self):
        t, d = facts()
        self.assertEqual(t['tradedAtUtc'], '2026-01-01T10:00:00.000Z')
        self.assertEqual(t['sourceRecordId'], 1)
        self.assertEqual(d['sourceIngestedUtc'], t['ingestedUtc'])
        self.assertNotIn('status', d)
        self.assertNotIn('paperOutcome', d)
        self.assertNotIn('normalizedUtc', t)


if __name__ == '__main__':
    if len(sys.argv) == 3 and sys.argv[1] == '--fixture':
        build_fixture(sys.argv[2])
    else:
        unittest.main()
