"""Native synthetic SQL storage -> read-only producer -> journal -> offline seal."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('checkpoint', ROOT / 'scripts/poly2-comparison-checkpoint.py')
assert spec is not None and spec.loader is not None
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
START, END = '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
COHORT = ['0x'+x*40 for x in 'abcde']


class CheckpointTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(dir=os.environ['TMPDIR'])
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.path = self.root / 'native.sqlite'
        self.db = sqlite3.connect(self.path)
        self.addCleanup(self.db.close)
        self.db.executescript('''CREATE TABLE wallets(id INTEGER PRIMARY KEY,address TEXT);
          CREATE TABLE markets(id INTEGER PRIMARY KEY,condition_id TEXT);
          CREATE TABLE trades(id INTEGER PRIMARY KEY,polymarket_trade_id TEXT,wallet_id INTEGER,market_id INTEGER,asset_id TEXT,side TEXT,size NUMERIC,traded_at TEXT,ingested_at TEXT);
          CREATE TABLE signals(id INTEGER PRIMARY KEY,source_trade_id TEXT,status TEXT);
          CREATE TABLE paper_orders(id INTEGER PRIMARY KEY,signal_id INTEGER,t2_decided_at TEXT,miss_reason TEXT,status TEXT);
          INSERT INTO markets VALUES(1,'market');''')
        self.db.execute('INSERT INTO wallets VALUES(1,?)', (COHORT[0],))
        self.db.commit()
        self.b = dict(runId='checkpoint', shadowRunId='shadow', poly2CodeSha='a'*40, componentSha256='b'*64, cohort=COHORT, window=dict(startUtc=START,endUtc=END), evidenceKind='synthetic',sourcePublicKey=None,terminalAuthority=dict(inventorySha256='c'*64,contractSha256='d'*64))
        self.time = [START]
        self.adapter = module.SQLAdapter.sqlite_copy(self.path)
        self.addCleanup(self.adapter.connection.close)
        self.source = self.root / 'source'
        self.producers = []
        self.addCleanup(lambda: [p.close() for p in self.producers if not p.owner.closed])

    def producer(self):
        p = module.CheckpointProducer(self.source, self.b, self.adapter, read_clock=lambda: self.time[0])
        self.producers.append(p)
        return p

    def trade(self, ident=1):
        event = 'data-api:0x'+'1'*64+':'+COHORT[0]+':7:100:0.5:1767261600' if ident == 1 else 'other:'+str(ident)
        self.db.execute('INSERT INTO trades VALUES(?,?,1,1,\'7\',\'BUY\',100,?,?)', (ident,event,'2026-01-01T10:00:00.000Z','2026-01-01T10:00:10.000Z'))
        return event

    def certificate(self):
        return dict(**self.b['terminalAuthority'],closedUtc=END,noFutureInWindowInsertions=True,noFutureRelevantDecisions=True,insertionFactsRetained=True,outstandingTransactions=0,unresolvedFailures=0,registeredWriters=['execution','ingestion'])

    def worker(self, archive=False):
        binding = self.root / 'binding.json'
        binding.write_text(json.dumps(self.b))
        cmd = [sys.executable,'scripts/poly2-comparison-capture-worker.py',str(binding),str(self.source),str(self.root/'capture')]
        if archive:
            cmd += ['--archive',str(self.root/'archive.json')]
        return subprocess.run(cmd,cwd=ROOT,capture_output=True,text=True)

    def test_missing_callback_and_source_downtime_recovered_restart_dedup_postend_decision(self):
        p = self.producer()
        event = self.trade()
        self.db.commit()  # no callback whatsoever
        self.time[0] = END
        p.reconcile()
        self.assertEqual(self.worker().returncode,0)
        p.close()  # downtime: native commit occurs with observer absent
        self.db.execute('INSERT INTO signals VALUES(1,?,\'executed\')',(event,))
        self.db.execute('INSERT INTO paper_orders VALUES(2,1,?,\'stale_signal\',\'filled\')',('2026-01-01T10:00:20.000Z',))
        self.db.commit()
        self.time[0] = '2026-01-02T00:00:03.000Z'
        p = self.producer()
        p.reconcile()
        self.assertIsNone(p.reconcile())
        # Mutable status change is not a fact conflict and never sampled.
        self.db.execute("UPDATE paper_orders SET status='settled'")
        self.db.execute("UPDATE signals SET status='skipped'")
        self.db.commit()
        self.assertIsNone(p.reconcile())
        self.assertEqual(p.terminal()['state'],'INCOMPLETE')
        p.terminal(self.certificate())
        result = self.worker(archive=True)
        self.assertEqual(result.returncode,0,result.stderr)
        a = json.loads((self.root/'archive.json').read_text())
        self.assertEqual(a['manifest']['rowCount'],1)
        self.assertEqual(a['rows'][0]['decisionUtc'],'2026-01-01T10:00:20.000Z')
        self.assertEqual(a['rows'][0]['rejectionReason'],'stale_signal')
        self.assertIsNone(a['rows'][0]['paperOutcome'])
        self.assertEqual(self.worker().returncode,0)
        p.close()
        p = self.producer()
        self.assertEqual(len(p.decisions),1)
        with self.assertRaisesRegex(ValueError,'terminal'):
            p.reconcile()

    def test_late_commit_after_final_read_no_max_or_repeated_scan_closure(self):
        p = self.producer()
        event = self.trade()
        # Transaction has original in-window clock but is not visible to reader.
        self.time[0] = '2026-01-02T00:00:03.000Z'
        p.reconcile(force=True)
        p.reconcile(force=True)
        self.assertEqual(len(p.trades),0)
        self.assertEqual(p.terminal()['state'],'INCOMPLETE')
        self.assertNotEqual(self.worker(archive=True).returncode,0)
        self.assertFalse((self.root/'archive.json').exists())
        self.db.commit()  # late visibility, lower ID, old timestamp
        p.reconcile()
        self.assertIn(event,p.trades)
        self.assertEqual(p.terminal()['state'],'INCOMPLETE')
        p.terminal(self.certificate())
        result = self.worker(archive=True)
        self.assertEqual(result.returncode,0,result.stderr)

    def test_only_valid_pinned_certificate_after_drain_permits_seal(self):
        p = self.producer()
        self.time[0] = END
        for change in [dict(outstandingTransactions=1),dict(unresolvedFailures=1),dict(registeredWriters=['ingestion']),dict(noFutureInWindowInsertions=False),dict(noFutureRelevantDecisions=False),dict(insertionFactsRetained=False),dict(inventorySha256='e'*64),dict(closedUtc=START)]:
            with self.assertRaisesRegex(ValueError,'certificate'):
                p.terminal({**self.certificate(),**change})
        self.trade()
        self.db.execute('UPDATE trades SET size=0.000001')
        self.db.commit()
        p.terminal(self.certificate())
        result = self.worker(archive=True)
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(len(json.loads((self.root/'archive.json').read_text())['rows']),1)

    def test_native_adapter_read_only_and_insertion_mutation_rejected(self):
        p = self.producer()
        self.trade()
        self.db.commit()
        p.reconcile()
        with self.assertRaises(sqlite3.OperationalError):
            self.adapter.connection.execute('DELETE FROM trades')
        self.adapter.connection.rollback()
        self.db.execute("UPDATE trades SET size=101")
        self.db.commit()
        with self.assertRaisesRegex(ValueError,'immutability'):
            p.reconcile()

    def test_postgres_adapter_explicit_read_only_transaction_shape_without_connection(self):
        class Cursor:
            def __init__(self):
                self.calls = []
            def execute(self, sql, params=None):
                self.calls.append((sql,params))
            def fetchall(self):
                return []
            def close(self):
                pass
        class Connection:
            autocommit = True
            info = type('IdleInfo', (), {'transaction_status': 0})()
            def __init__(self):
                self.c = Cursor()
                self.rollbacks = 0
            def cursor(self):
                return self.c
            def rollback(self):
                self.rollbacks += 1
        connection = Connection()
        adapter = module.SQLAdapter(connection,'postgres')
        self.assertEqual(adapter.scan(self.b),([],[]))
        self.assertEqual(connection.c.calls[0][0],'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
        self.assertEqual(connection.rollbacks,1)
        for sql, params in connection.c.calls[1:]:
            self.assertTrue(sql.startswith('SELECT '))
            self.assertNotIn('status',sql)
            self.assertNotIn('MAX(',sql)
            self.assertNotIn('t2_decided_at <=',sql)
            self.assertEqual(params,[*COHORT,START,END])
        connection.autocommit = False
        with self.assertRaisesRegex(ValueError,'dedicated'):
            module.SQLAdapter(connection,'postgres')

    def test_append_before_position_crash_and_torn_spool_preservation(self):
        p = self.producer()
        self.trade()
        self.db.commit()
        def crash_after_append(frame):
            raise OSError('crash after fsync before position')
        p._apply = crash_after_append
        with self.assertRaises(OSError):
            p.reconcile()
        self.assertEqual(len(p.frames),1)
        p.close()
        p = self.producer()
        self.assertEqual(len(p.trades),1)
        self.assertIsNone(p.reconcile())
        self.assertEqual(self.worker().returncode,0)
        p.close()
        path = self.source/'poly2_source_receipts.ndjson'
        with path.open('ab') as stream:
            stream.write(b'{"torn":')
        before = path.read_bytes()
        with self.assertRaisesRegex(ValueError,'torn'):
            self.producer()
        self.assertEqual(path.read_bytes(),before)

    def test_source_query_failure_resumable_without_phantom_cursor(self):
        p = self.producer()
        before = len(p.frames)
        scan = self.adapter.scan
        self.adapter.scan = lambda b: (_ for _ in ()).throw(OSError('source unavailable'))
        with self.assertRaises(OSError):
            p.reconcile()
        self.assertEqual(len(p.frames),before)
        self.adapter.scan = scan
        self.trade()
        self.db.commit()
        p.reconcile()
        self.assertEqual(len(p.trades),1)


if __name__ == '__main__':
    unittest.main()
