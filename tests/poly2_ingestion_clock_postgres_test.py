"""Actual inserted PostgreSQL rows / production Python SQLAdapter / TS comparator.

Only a new exact isolated fixture is accepted; no production DSN/source import.
"""
import datetime as dt
import importlib.machinery
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('clock_checkpoint', ROOT/'scripts/poly2-comparison-checkpoint.py')
assert SPEC is not None and SPEC.loader is not None
CHECKPOINT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKPOINT)
NAME = 'poly-shadow-timestamp-amendment-v1-f0296c9-run3'
CONTAINER = os.environ.get('POLY2_TIMESTAMP_AMENDMENT_FIXTURE')
START, END = '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'
WINDOW = dict(startUtc=START, endUtc=END)
COHORT = ['0x'+x*40 for x in 'abcde']
MATRIX = [
    ('start-minus-us', '2025-12-31T23:59:59.999999Z', False),
    ('start', '2026-01-01T00:00:00Z', True),
    ('start-plus-us', '2026-01-01T00:00:00.000001Z', True),
    ('end-minus-us', '2026-01-01T23:59:59.999999Z', True),
    ('end', '2026-01-02T00:00:00Z', True),
    ('end-plus-us', '2026-01-02T00:00:00.000001Z', False),
    ('end-millis', '2026-01-02T00:00:00.000Z', True),
    ('end-micros', '2026-01-02T00:00:00.000000Z', True),
    ('end-positive-offset', '2026-01-02T01:00:00+01:00', True),
    ('end-negative-offset', '2026-01-01T19:00:00-05:00', True),
    ('start-offset-plus-us', '2026-01-01T05:30:00.000001+05:30', True),
    ('end-offset-plus-us', '2026-01-01T19:00:00.000001-05:00', False),
    ('fraction-one-digit', '2026-01-01T12:00:00.1Z', True),
    ('max-positive-offset', '2026-01-02T15:59:00+15:59', True),
    ('max-negative-offset', '2026-01-01T08:01:00-15:59', True),
]


def sql(statement, user='postgres'):
    if CONTAINER != NAME:
        raise ValueError('exact owned timestamp amendment fixture required')
    return subprocess.run(['docker', 'exec', '-i', NAME, 'psql', '-X', '-qAt',
                           '-v', 'ON_ERROR_STOP=1', '-p', '55443', '-U', user],
                          input=statement, text=True, capture_output=True, check=True).stdout


class PsqlConnection:
    """Test-only DB-API transport; all adapter SQL executes on native PG session."""
    autocommit = True
    info = type('Info', (), {'transaction_status': 0})()
    def __init__(self):
        if CONTAINER != NAME:
            raise ValueError('exact owned timestamp amendment fixture required')
        self.process = subprocess.Popen(['docker','exec','-i',NAME,'psql','-X','-qAt','-p','55443','-U','capture_reader','-d','postgres'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        assert self.process.stdin is not None and self.process.stdout is not None
        self.rows = []
    def cursor(self):
        return self
    def execute(self, statement, params=None):
        assert self.process.stdin is not None and self.process.stdout is not None
        for value in params or []:
            statement = statement.replace('%s', "'"+str(value).replace("'", "''")+"'", 1)
        query = statement.startswith('SELECT ')
        if query:
            statement = "SELECT COALESCE(json_agg(row_to_json(q)),'[]'::json) FROM ("+statement+') q'
        self.process.stdin.write(statement+';\n\\echo amendment_query_done\n')
        self.process.stdin.flush()
        lines = []
        while True:
            line = self.process.stdout.readline()
            if not line:
                raise RuntimeError('native session ended')
            if line.strip() == 'amendment_query_done':
                break
            if line.strip():
                lines.append(line.strip())
        if any('ERROR:' in line for line in lines):
            raise RuntimeError('\n'.join(lines))
        self.rows = []
        if query:
            for row in json.loads(lines[-1]):
                self.rows.append(tuple(dt.datetime.fromisoformat(v) if k in ('traded_at','ingested_at','t2_decided_at') and v is not None else v for k,v in row.items()))
    def fetchall(self):
        return self.rows
    def rollback(self):
        self.execute('ROLLBACK')
    def close(self):
        pass
    def disconnect(self):
        assert self.process.stdin is not None
        self.process.stdin.write('\\q\n'); self.process.stdin.flush()
        self.process.communicate(timeout=10)


class ParserParityTests(unittest.TestCase):
    def test_python_strict_rejects_ambiguous_calendar_zone_and_excess_precision(self):
        for value in ['2026-01-01T00:00:00Z\n','2026-01-01T00:00:00Z\r','2026-01-01T00:00:00Z\r\n','2026-01-01T00:00:00Z\t',' 2026-01-01T00:00:00Z','2026-01-01T00:00:00Z ','2026-02-30T00:00:00Z','2025-02-29T00:00:00Z','2026-01-01','2026-01-01T00:00:00','2026-01-01 00:00:00Z','2026-01-01T24:00:00Z','2026-01-01T00:00:60Z','2026-01-01T00:00:00+24:00','2026-01-01T00:00:00+16:00','2026-01-01T00:00:00-16:00','2026-01-01T00:00:00+01:60','2026-01-01T00:00:00-00:00','2026-01-01T00:00:00.0000001Z','0000-01-01T00:00:00Z','2026-01-01T00:00:00z']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                CHECKPOINT.epoch(value)
    def test_python_ts_production_parser_and_comparator_matrix(self):
        values = [clock for _,clock,_ in MATRIX]
        ts = json.loads(subprocess.run(['node','--import','tsx','tests/poly2_timestamp_matrix.ts'],cwd=ROOT,input=json.dumps(dict(window=WINDOW,clocks=values)),text=True,capture_output=True,check=True).stdout)
        for (_,clock,expected), row in zip(MATRIX,ts,strict=True):
            self.assertEqual(row['epochMicros'],str(CHECKPOINT.epoch(clock)))
            self.assertEqual(row['included'], expected)
            self.assertEqual(row['shadowIncluded'], expected)
            self.assertEqual(row['archiveIncluded'], expected)
            self.assertEqual(row['archiveClockEvidence'], dict(original=clock, epochMicros=str(CHECKPOINT.epoch(clock))))
            self.assertEqual(CHECKPOINT.in_window(clock,WINDOW), expected)


@unittest.skipUnless(CONTAINER, 'explicit isolated timestamp amendment fixture required')
class NativeClockAmendmentTests(unittest.TestCase):
    def test_inserted_native_rows_sql_python_capture_ts_identical(self):
        sql('''CREATE TABLE wallets(id integer PRIMARY KEY,address text);
CREATE TABLE markets(id integer PRIMARY KEY,condition_id text);
CREATE TABLE trades(id integer PRIMARY KEY,polymarket_trade_id text,wallet_id integer,market_id integer,asset_id text,side text,size numeric,traded_at timestamptz,ingested_at timestamptz);
CREATE TABLE signals(id integer PRIMARY KEY,source_trade_id text);
CREATE TABLE paper_orders(id integer PRIMARY KEY,signal_id integer,t2_decided_at timestamptz,miss_reason text);
CREATE TABLE decision_log(id serial PRIMARY KEY,actor text,action text,context jsonb,created_at timestamptz NOT NULL DEFAULT now());
CREATE ROLE capture_reader LOGIN;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO capture_reader;
INSERT INTO markets VALUES(1,'original-market');
INSERT INTO wallets VALUES(1,''' + "'"+COHORT[0]+"');")
        for i,(label,clock,_) in enumerate(MATRIX,1):
            sql(f"INSERT INTO trades VALUES({i},'native:{label}',1,1,'7','BUY',100,'{clock}'::timestamptz,'{clock}'::timestamptz);")
        native = json.loads(sql(f"SELECT json_agg(q) FROM (SELECT id, ingested_at >= '{START}'::timestamptz AND ingested_at <= '{END}'::timestamptz AS included, (extract(epoch FROM ingested_at)*1000000)::bigint::text AS micros FROM trades ORDER BY id) q;"))
        connection = PsqlConnection()
        try:
            facts, decisions = CHECKPOINT.SQLAdapter(connection,'postgres').scan(dict(cohort=COHORT,window=WINDOW))
        finally:
            connection.disconnect()
        selected = {t['sourceRecordId']:t for t in facts}
        ts = json.loads(subprocess.run(['node','--import','tsx','tests/poly2_timestamp_matrix.ts'],cwd=ROOT,input=json.dumps(dict(window=WINDOW,clocks=[c for _,c,_ in MATRIX]+[t['ingestedUtc'] for t in facts])),text=True,capture_output=True,check=True).stdout)
        self.assertEqual(len(ts), len(MATRIX)+len(facts)); self.assertEqual(decisions, [])
        for i,((label,clock,expected),pg,comparator) in enumerate(zip(MATRIX,native,ts[:len(MATRIX)],strict=True),1):
            with self.subTest(label=label):
                self.assertEqual(pg['included'],expected)
                self.assertEqual(i in selected,expected)
                self.assertEqual(comparator['included'],expected)
                self.assertEqual(comparator['shadowIncluded'],expected)
                self.assertEqual(comparator['archiveIncluded'],expected)
                self.assertEqual(comparator['archiveClockEvidence'],dict(original=clock,epochMicros=pg['micros']))
                self.assertEqual(pg['micros'],comparator['epochMicros'])
                if expected:
                    self.assertEqual(selected[i]['clockEvidence']['ingestedUtc']['epochMicros'],pg['micros'])
                    self.assertTrue(CHECKPOINT.in_window(selected[i]['ingestedUtc'],WINDOW))
            print(json.dumps(dict(case=label,original=clock,sql=pg['included'],pythonCapture=i in selected,tsComparator=comparator['included'],shadow=comparator['shadowIncluded'],archive=comparator['archiveIncluded'],epochMicros=pg['micros']),sort_keys=True))
        for fact, rendered in zip(facts,ts[len(MATRIX):],strict=True):
            self.assertTrue(rendered['included']); self.assertTrue(rendered['shadowIncluded']); self.assertTrue(rendered['archiveIncluded'])
            self.assertEqual(rendered['archiveClockEvidence'],fact['clockEvidence']['ingestedUtc'])
        self.assertEqual(len(facts),sum(expected for _,_,expected in MATRIX))
        # Restricted actual capture session cannot mutate source tables.
        with self.assertRaises(subprocess.CalledProcessError):
            sql('INSERT INTO trades(id) VALUES(999);',user='capture_reader')


class ExactClockSourceLoadingTests(unittest.TestCase):
    def test_fence_capture_and_status_consumers_bypass_timestamp_pyc(self):
        clock_path=(ROOT/'scripts/exact_clock.py').resolve()
        source_loader=importlib.machinery.SourceFileLoader
        original=source_loader.get_code
        def reject_clock_bytecode(loader,fullname):
            if Path(loader.path).resolve()==clock_path:
                raise AssertionError('cache-aware loader reached exact_clock.py')
            return original(loader,fullname)
        consumers=(
            ('checkpoint_clock_source',ROOT/'scripts/poly2-comparison-checkpoint.py'),
            ('source_hook_clock_source',ROOT/'scripts/poly2-comparison-source-hook.py'),
            ('status_clock_source',ROOT/'scripts/status/collector.py'),
        )
        with patch.object(source_loader,'get_code',reject_clock_bytecode):
            for name,path in consumers:
                with self.subTest(consumer=name):
                    spec=importlib.util.spec_from_file_location(name,path)
                    assert spec is not None and spec.loader is not None
                    module=importlib.util.module_from_spec(spec)
                    spec.loader.exec_module(module)
                    self.assertEqual(module.epoch_micros('2026-01-01T00:00:00Z'),1767225600000000)


if __name__ == '__main__':
    unittest.main(verbosity=2)
