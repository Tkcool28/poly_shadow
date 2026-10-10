"""Native isolated PostgreSQL proof using installed postgres image, no network.

PsqlConnection is test-only DB-API transport, not a mock SQL engine. Each actual
capture SELECT executes on one persistent restricted-role PostgreSQL session.
Environment names an already-created isolated fixture, never a production DSN.
"""
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('frozen_drain', ROOT/'scripts/poly2-comparison-drain.py')
assert SPEC is not None and SPEC.loader is not None
M = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(M)
START, END = '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
COHORT = ['0x'+x*40 for x in 'abcde']
CONTAINER = os.environ.get('POLY2_DISPOSABLE_PG_CONTAINER')


class PsqlConnection:
    autocommit = True
    info = type('Info', (), {'transaction_status': 0})()

    def __init__(self, user='capture_reader'):
        if CONTAINER not in ('poly-shadow-phase4-drain-fixture', 'poly-shadow-phase4-drain-authority-fixture'):
            raise ValueError('exact disposable fixture container required')
        port = '55439' if CONTAINER == 'poly-shadow-phase4-drain-authority-fixture' else '5432'
        self.process = subprocess.Popen(['docker','exec','-i',CONTAINER,'sh','-c',f'exec psql -X -qAt -p {port} -U {user} -d drain_fixture 2>&1'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        assert self.process.stdin is not None and self.process.stdout is not None
        self.rows = []
        self.calls = []

    def cursor(self):
        return self

    def execute(self, sql, params=None):
        self.calls.append((sql, params))
        if params:
            for value in params:
                literal = str(value) if isinstance(value, int) else "'"+str(value).replace("'", "''")+"'"
                sql = sql.replace('%s', literal, 1)
        if sql.startswith('SELECT '):
            sql = 'SELECT COALESCE(json_agg(row_to_json(q)),\'[]\'::json) FROM ('+sql+') q'
        marker = 'fixture_query_done'
        self.process.stdin.write(sql+';\n\\echo '+marker+'\n')
        self.process.stdin.flush()
        lines = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError('native PostgreSQL session ended')
            if line.strip() == marker:
                break
            if line.strip():
                lines.append(line.strip())
        if any('ERROR:' in line for line in lines):
            raise RuntimeError('\n'.join(lines))
        self.rows = []
        if sql.startswith('SELECT '):
            for row in json.loads(lines[-1]):
                values = []
                for key, value in row.items():
                    if key in ('traded_at','ingested_at','t2_decided_at') and value is not None:
                        value = dt.datetime.fromisoformat(value)
                    values.append(value)
                self.rows.append(tuple(values))

    def fetchall(self):
        return self.rows

    def rollback(self):
        self.execute('ROLLBACK')

    def close(self):
        pass  # DB-API cursor.close must not close the dedicated session

    def disconnect(self):
        self.process.stdin.write('\\q\n')
        self.process.stdin.flush()
        self.process.communicate(timeout=10)


@unittest.skipUnless(CONTAINER, 'set explicit disposable PostgreSQL fixture container')
class NativeDrainTests(unittest.TestCase):
    def setUp(self):
        self.admin = PsqlConnection('postgres')
        self.addCleanup(self.admin.disconnect)
        self.admin.execute('TRUNCATE paper_orders, signals, trades, wallets, markets')
        self.admin.execute("INSERT INTO markets VALUES(1,'condition'); INSERT INTO wallets VALUES(1,'"+COHORT[0]+"')")
        self.reader = PsqlConnection()
        self.addCleanup(self.reader.disconnect)
        self.adapter = M.CHECKPOINT.SQLAdapter(self.reader, 'postgres')
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.binding = dict(runId='drain', shadowRunId='shadow', poly2CodeSha='a'*40, componentSha256='b'*64, cohort=COHORT, window=dict(startUtc=START,endUtc=END), evidenceKind='synthetic', sourcePublicKey=None)
        self.producers = []
        self.addCleanup(lambda: [p.close() for p in self.producers if not p.owner.closed])

    def producer(self):
        p = M.FrozenDrain(self.temp.name,self.binding,self.adapter,read_clock=lambda: '2026-01-02T00:00:05Z')
        self.producers.append(p)
        return p

    def trade(self, ident, ingest='2026-01-01T10:00:00Z'):
        self.admin.execute(f"INSERT INTO trades VALUES({ident},'event:{ident}',1,1,'7','BUY',100,'2026-01-01T09:59:00Z','{ingest}')")

    def decision(self, ident, clock='2026-01-02T00:01:00Z'):
        self.admin.execute(f"INSERT INTO signals VALUES({ident},'event:{ident}'); INSERT INTO paper_orders VALUES({ident},{ident},'{clock}',NULL)")

    def test_A_all_before_end_native_read_only_and_equation(self):
        self.trade(1)
        self.decision(1,'2026-01-01T10:01:00Z')
        p = self.producer()
        f = p.step()
        self.assertEqual(f['state'],'COMPLETE')
        self.assertEqual(f['counts']['DECISION_RECORDED'],1)
        self.assertEqual(sum(f['counts'].values()),len(f['frozenIds']))
        self.assertFalse(f['comparisonEligible'])
        self.assertEqual(self.reader.calls[0][0], 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        with self.assertRaisesRegex(RuntimeError,'permission denied'):
            self.reader.execute('INSERT INTO markets VALUES(2,\'forbidden\')')
        self.reader.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        with self.assertRaisesRegex(RuntimeError,'read-only transaction'):
            self.reader.execute('CREATE TABLE forbidden(id int)')
        self.reader.rollback()

    def test_B_late_initial_decision_preserves_clock(self):
        self.trade(1)
        p = self.producer()
        self.assertEqual(p.step()['counts']['PENDING'],1)
        self.decision(1)
        f = p.step()
        self.assertEqual(f['state'],'COMPLETE')
        self.assertEqual(f['perId']['event:1']['decision']['decisionUtc'],'2026-01-02T00:01:00Z')

    def test_C_multi_late_no_grace_and_oldest(self):
        for ident in (1,2,3):
            self.trade(ident)
        p = self.producer()
        self.assertEqual(p.step()['counts']['PENDING'],3)
        self.assertEqual(p.status()['pendingOldestUtc'],'2026-01-01T10:00:00Z')
        for ident in (3,1,2):
            self.decision(ident)
            f = p.step()
            self.assertEqual(len(f['frozenIds']),3)
        self.assertEqual(f['state'],'COMPLETE')

    def test_D_no_decision_not_applicable_no_terminal_source_path(self):
        self.trade(1)
        p = self.producer()
        self.assertEqual(p.step()['counts']['NO_INITIAL_DECISION_EXPECTED'],0)
        self.assertEqual(p.status()['counts']['PENDING'],1)

    def test_E_permanent_pending_timeout_is_failed_incomplete(self):
        self.trade(1)
        p = self.producer()
        for _ in range(4):
            self.assertEqual(p.step()['state'],'DRAINING')
        self.assertEqual(p.timeout()['state'],'FAILED')
        self.assertEqual(p.status()['counts']['PENDING'],1)
        self.assertFalse(p.status()['comparisonEligible'])

    def test_F_restart_late_decision_cursor_idempotence(self):
        self.trade(1)
        p = self.producer()
        p.step()
        p.close()
        self.decision(1)
        p = self.producer()
        f = p.step()
        cursor = f['cursor']
        p.close()
        p = self.producer()
        self.assertEqual(p.step(),f)
        self.assertEqual(p.status()['cursor'],cursor)

    def test_G_post_end_and_new_inwindow_ids_excluded(self):
        self.trade(1)
        p = self.producer()
        first = p.step()
        self.trade(2,'2026-01-02T00:00:01Z')
        self.trade(3)  # late transaction/admission cannot silently expand frozen IDs
        self.decision(2)
        self.decision(3)
        f = p.step()
        self.assertEqual(f['frozenIds'],[1])
        self.assertEqual(f['frozenIdsSha256'],first['frozenIdsSha256'])
        self.assertEqual(f['counts']['PENDING'],1)
        self.assertEqual(f['incompleteProperty'],M.MISSING)

    def test_H_duplicate_query_retains_ids_and_decisions_once(self):
        self.trade(1)
        self.trade(2)
        self.decision(1)
        p = self.producer()
        f = p.step()
        again = p.step()
        self.assertEqual(f['perIdSha256'],again['perIdSha256'])
        self.assertEqual(again['counts']['DECISION_RECORDED'],1)
        self.assertEqual(again['frozenIds'],[1,2])

    def test_I_decision_conflict_retains_all_ids_failed_incomplete(self):
        self.trade(1)
        self.trade(2)
        self.decision(1)
        p = self.producer()
        first = p.step()
        self.admin.execute("UPDATE paper_orders SET t2_decided_at='2026-01-02T00:02:00Z' WHERE id=1")
        f = p.step()
        self.assertEqual(f['state'],'FAILED')
        self.assertEqual(f['frozenIds'],[1,2])
        self.assertEqual(f['perId']['event:1'],first['perId']['event:1'])
        self.assertEqual(f['counts']['CAPTURE_ERROR'],1)
        p.close()
        self.assertEqual(self.producer().status()['state'],'FAILED')

    def test_native_delayed_commit_population_barrier_counterexample(self):
        writer = PsqlConnection('postgres')
        self.addCleanup(writer.disconnect)
        writer.execute('BEGIN')
        writer.execute("INSERT INTO trades VALUES(99,'event:99',1,1,'7','BUY',100,'2026-01-01T09:59:00Z','2026-01-01T10:00:00Z')")
        p = self.producer()
        frozen = p.step()
        self.assertEqual(frozen['frozenIds'],[])
        writer.execute('COMMIT')
        trades, _ = self.adapter.scan(self.binding)
        self.assertEqual([t['sourceRecordId'] for t in trades],[99])
        self.assertEqual(p.step()['frozenIds'],[])
        self.assertFalse(p.status()['comparisonEligible'])

    def test_source_failure_no_phantom_cursor_and_retention_loss_failed(self):
        self.trade(1)
        p = self.producer()
        p.step()
        scan = self.adapter.scan
        self.adapter.scan = lambda *a, **kw: (_ for _ in ()).throw(OSError('DB unavailable'))
        with self.assertRaises(OSError):
            p.step()
        self.assertEqual(p.status()['cursor'],1)
        self.adapter.scan = scan
        self.admin.execute('DELETE FROM trades WHERE id=1')
        self.assertEqual(p.step()['state'],'FAILED')
        self.assertEqual(p.status()['frozenCount'],1)

    def test_native_repeatable_read_snapshot_and_later_transaction_visibility(self):
        self.trade(1)
        self.reader.execute('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.reader.execute('SELECT count(*) AS count FROM paper_orders')
        self.assertEqual(self.reader.fetchall(), [(0,)])
        self.decision(1)
        self.reader.execute('SELECT count(*) AS count FROM paper_orders')
        self.assertEqual(self.reader.fetchall(), [(0,)])
        self.reader.rollback()
        trades, decisions = self.adapter.scan(self.binding, frozen_ids=[1])
        self.assertEqual([t['sourceRecordId'] for t in trades], [1])
        self.assertEqual([d['paperRecordId'] for d in decisions], [1])

    def test_duplicate_original_orders_reject_without_advancing_cursor(self):
        self.trade(1)
        p = self.producer()
        p.step()
        self.decision(1)
        self.admin.execute("INSERT INTO paper_orders VALUES(2,1,'2026-01-02T00:02:00Z',NULL)")
        with self.assertRaisesRegex(ValueError, 'ambiguous original decision linkage'):
            p.step()
        self.assertEqual(p.status()['cursor'], 1)
        self.assertEqual(p.status()['counts']['PENDING'], 1)

    def test_writer_before_append_fault_no_phantom_population(self):
        self.trade(1)
        p = self.producer()
        original = M.os.write
        def fail(*args):
            raise OSError('injected append failure')
        M.os.write = fail
        try:
            with self.assertRaisesRegex(OSError, 'injected append failure'):
                p.step()
        finally:
            M.os.write = original
        self.assertEqual(p.status()['frozenCount'], 0)
        self.assertTrue(p.latched)
        p.close()
        self.assertEqual(self.producer().step()['frozenIds'], [1])

    def test_actual_partial_append_fault_preserves_bytes_restart_rejects(self):
        self.trade(1)
        p = self.producer()
        original = M.os.write
        def fail(fd, data):
            original(fd, data[:13])
            raise OSError('injected torn write')
        M.os.write = fail
        try:
            with self.assertRaisesRegex(OSError, 'injected torn write'):
                p.step()
        finally:
            M.os.write = original
        self.assertTrue(p.latched)
        path = Path(self.temp.name)/'poly2_drain_receipts.ndjson'
        before = path.read_bytes()
        self.assertEqual(len(before), 13)
        p.close()
        with self.assertRaisesRegex(ValueError, 'torn'):
            self.producer()
        self.assertEqual(path.read_bytes(), before)

    def test_durable_receipt_before_health_cursor_fault_restart_recovers_fixed_set(self):
        self.trade(1)
        p = self.producer()
        original = p._publish
        p._publish = lambda: (_ for _ in ()).throw(OSError('injected health cursor failure'))
        with self.assertRaisesRegex(OSError, 'injected health cursor failure'):
            p.step()
        self.assertTrue(p.latched)
        self.assertEqual(p.status()['cursor'], 1)
        p._publish = original
        p.close()
        self.trade(2)
        p = self.producer()
        self.assertEqual(p.status()['frozenCount'], 1)
        self.assertEqual(p.step()['frozenIds'], [1])

    def test_torn_authority_preserved_restart_refuses(self):
        self.trade(1)
        p = self.producer()
        p.step()
        p.close()
        path = Path(self.temp.name)/'poly2_drain_receipts.ndjson'
        with path.open('ab') as stream:
            stream.write(b'{"torn":')
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError,'torn'):
            self.producer()
        self.assertEqual(path.read_bytes(),before)


if __name__ == '__main__':
    unittest.main()
