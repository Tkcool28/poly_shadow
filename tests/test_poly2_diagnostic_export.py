import asyncio
import datetime as dt
import importlib.util
import json
from decimal import Decimal
from pathlib import Path
import unittest

PATH = Path(__file__).resolve().parents[1] / 'scripts' / 'poly2-diagnostic-export.py'
spec = importlib.util.spec_from_file_location('diagnostic_export', PATH)
assert spec and spec.loader
exporter = importlib.util.module_from_spec(spec)
spec.loader.exec_module(exporter)

START = dt.datetime(2026, 10, 19, 0, 0, tzinfo=dt.timezone.utc)
END = START + dt.timedelta(minutes=5)
WALLET = exporter.WALLETS[0]
TX = '0x' + 'a' * 64
SOURCE_ID = f'data-api:{TX}:{WALLET}:123:2:0.5:1792368000'
SHADOW_SHA = '1' * 40
POLY_SHA = '2' * 40


def trade(row_id, ingested):
    return {
        'source_record_id': row_id, 'source_event_id': SOURCE_ID, 'wallet': WALLET,
        'asset_id': '123', 'condition_id': 'condition-1', 'side': 'BUY',
        'size': Decimal('2.000000'), 'price': Decimal('0.500000'),
        'traded_at': START - dt.timedelta(seconds=2), 'ingested_at': ingested,
    }


class Result:
    def __init__(self, rows):
        self.rows = rows

    def fetchall(self):
        return [type('Row', (), {'_mapping': row})() for row in self.rows]


class FakeConnection:
    def __init__(self, *, audits=True, trade_rows=None, audit_rows=None, read_only='on', isolation='repeatable read', approved=None):
        self.audits = audits
        self.trade_rows = trade_rows if trade_rows is not None else [trade(1, START + dt.timedelta(seconds=1)), trade(2, START + dt.timedelta(seconds=2))]
        self.audit_rows = audit_rows if audit_rows is not None else ([{
            'id':9,'actor':'bot','action':'paper_order_executed',
            'context':{'source_trade_id':SOURCE_ID,'signal_id':7,'filled_size':'1.25'},
            'created_at':START+dt.timedelta(seconds=4)}] if audits else [])
        self.read_only, self.isolation = read_only, isolation
        self.approved = approved if approved is not None else list(exporter.WALLETS)
        self.sql = []

    async def execute(self, statement, params=None):
        params = params or {}
        sql = str(statement)
        self.sql.append((sql, params))
        if sql.startswith('SET TRANSACTION'):
            return Result([])
        if 'current_setting' in sql:
            return Result([{'read_only': self.read_only, 'isolation': self.isolation}])
        if 'FROM wallets' in sql:
            return Result([{'address': x} for x in self.approved])
        if 'MAX(id)' in sql and 'FROM trades' in sql:
            return Result([{'max_id': max((r['source_record_id'] for r in self.trade_rows), default=0)}])
        if 'MAX(id)' in sql and 'FROM decision_log' in sql:
            return Result([{'max_id': max((r['id'] for r in self.audit_rows), default=0)}])
        if 'FROM trades AS t' in sql:
            cursor, high, limit = params['cursor'], params['high_id'], params['limit']
            rows = [r for r in self.trade_rows if cursor < r['source_record_id'] <= high]
            return Result(rows[:limit])
        if 'FROM signals' in sql:
            return Result([{'id': 7, 'source_trade_id': SOURCE_ID, 't1_detected_at': START + dt.timedelta(seconds=3)}])
        if 'FROM decision_log' in sql:
            if 'audit_page' not in sql or not self.audits:
                return Result([])
            cursor,high,limit=params['cursor'],params['high_id'],params['limit']
            source_ids=params['source_ids']; budget=params['context_budget_bytes']; row_cap=params['max_context_row_bytes']
            batch=sorted((r for r in self.audit_rows if cursor<r['id']<=high and r['context'].get('source_trade_id') in source_ids),key=lambda r:r['id'])[:limit]
            used=0; result=[]
            for audit in batch:
                payload=json.dumps(audit['context'],separators=(',',':'),ensure_ascii=False)
                size=len(payload.encode('utf-8')); used+=size
                result.append({'id':audit['id'],'actor':audit['actor'],'action':audit['action'],'created_at':audit['created_at'],
                    'context_bytes':size,'linked_source_trade_id':audit['context'].get('source_trade_id'),
                    'context_payload':payload if size<=row_cap and used<=budget else None})
            return Result(result)
        raise AssertionError(f'unexpected SQL: {sql}')


class ExportTests(unittest.TestCase):
    def test_cli_output_terminator_is_real_lf_and_json_remains_parseable(self):
        payload = b'{"classification":"UNCERTIFIED_DIAGNOSTIC"}'
        encoded = exporter.encode_export_output(payload)
        self.assertEqual(encoded, payload + bytes((10,)))
        self.assertEqual(json.loads(encoded), {'classification': 'UNCERTIFIED_DIAGNOSTIC'})

    def run_async(self, coro):
        return asyncio.run(coro)

    def test_live_transaction_must_be_read_only_repeatable_read(self):
        conn = FakeConnection()
        self.run_async(exporter.verify_read_only_repeatable_read(conn, lambda s: s))
        with self.assertRaisesRegex(RuntimeError, 'not read-only'):
            self.run_async(exporter.verify_read_only_repeatable_read(FakeConnection(read_only='off'), lambda s: s))
        with self.assertRaisesRegex(RuntimeError, 'not read-only'):
            self.run_async(exporter.verify_read_only_repeatable_read(FakeConnection(isolation='read committed'), lambda s: s))

    def test_preflight_preserves_exact_approved_wallet_order(self):
        conn = FakeConnection(approved=list(reversed(exporter.WALLETS)))
        with self.assertRaisesRegex(RuntimeError, 'population/order'):
            self.run_async(exporter.read_preflight(conn, lambda s: s, '2026-10-19T00:00:00Z'))

    def test_export_keyset_bounds_preserve_distinct_event_and_ingestion_clocks_and_deduplicate(self):
        conn = FakeConnection()
        result = self.run_async(exporter.read_export(
            conn, lambda s: s, start_utc=START.isoformat(), end_utc=END.isoformat(), run_id='diag-test',
            decision_high_water=0, decision_end_high_water=9, trade_high_water=0, trade_end_high_water=2, shadow_sha=SHADOW_SHA, poly2_checkout_sha=POLY_SHA,
            runtime_image_id='sha256:' + 'b' * 64, runtime_revision='219ad2c', exported_utc='2026-10-19T00:05:00Z'))
        self.assertTrue(result['certified'] is False)
        self.assertEqual(result['cohort'], list(exporter.WALLETS))
        self.assertTrue(result['coverage']['tradeQueryComplete'])
        self.assertEqual(result['coverage']['tradeIdRange'], {'after': 0, 'through': 2})
        self.assertEqual(result['coverage']['decisionLogIdRange'], {'after': 0, 'through': 9})
        self.assertEqual(result['coverage']['duplicateDatabaseTradeIdentities'], 1)
        self.assertEqual(len(result['rows']), 1)
        row = result['rows'][0]
        self.assertEqual(row['tradedAtUtc'], '2026-10-18T23:59:58.000000Z')
        self.assertEqual(row['ingestedUtc'], '2026-10-19T00:00:01.000000Z')
        self.assertNotEqual(row['tradedAtUtc'], row['ingestedUtc'])
        self.assertEqual(row['sourceRecordId'], 1)
        self.assertEqual(row['duplicateSourceRecordIds'], [1, 2])
        self.assertEqual(row['paperOutcome'], 'paper_order_executed')
        self.assertIsNone(row['policyEligible'])
        trade_sql = [sql for sql, _ in conn.sql if 'FROM trades AS t' in sql]
        self.assertTrue(trade_sql)
        self.assertIn('t.id > :cursor AND t.id <= :high_id', trade_sql[0])
        self.assertIn('t.ingested_at >=', trade_sql[0])
        self.assertIn('t.ingested_at <=', trade_sql[0])
        self.assertEqual([params['high_id'] for sql,params in conn.sql if 'FROM trades AS t' in sql], [2])
        audit_queries=[params for sql,params in conn.sql if 'FROM decision_log' in sql and 'MAX(id)' not in sql]
        self.assertEqual(audit_queries[0]['high_id'],9)
        self.assertEqual(audit_queries[0]['cursor'],0)
        self.assertNotIn('paper_orders', '\n'.join(sql for sql, _ in conn.sql))

    def test_extremely_large_audit_context_is_omitted_at_sql_projection_and_never_proves_action(self):
        huge={'source_trade_id':SOURCE_ID,'signal_id':7,'payload':'x'*(exporter.MAX_AUDIT_CONTEXT_ROW_BYTES*100)}
        audit={'id':9,'actor':'bot','action':'paper_order_executed','context':huge,'created_at':START+dt.timedelta(seconds=4)}
        conn=FakeConnection(audit_rows=[audit],trade_rows=[trade(1,START+dt.timedelta(seconds=1))])
        result=self.run_async(exporter.read_export(conn,lambda s:s,start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='diag-test',decision_high_water=0,decision_end_high_water=9,trade_high_water=0,trade_end_high_water=1,shadow_sha=SHADOW_SHA,poly2_checkout_sha=POLY_SHA,runtime_image_id=None,runtime_revision=None))
        row=result['rows'][0]
        self.assertIsNone(row['paperOutcome'])
        self.assertEqual(row['decisionEvidence'],'UNKNOWN_CONTEXT_INCOMPLETE')
        self.assertEqual(row['decisionAudit'][0]['contextEvidence'],'TRUNCATED_OVERSIZE')
        self.assertGreater(row['decisionAudit'][0]['contextBytes'],exporter.MAX_AUDIT_CONTEXT_ROW_BYTES)
        sql=[q for q,_ in conn.sql if 'audit_page' in q][0]
        self.assertIn('CASE WHEN context_bytes <= :max_context_row_bytes',sql)
        self.assertIn('context::text ELSE NULL END AS context_payload',sql)
        self.assertNotIn('SELECT id, actor, action, context, created_at FROM decision_log',sql)

    def test_many_audit_contexts_obey_total_and_page_budgets(self):
        contexts=[{'id':i,'actor':'bot','action':'paper_order_executed','context':{'source_trade_id':SOURCE_ID,'signal_id':7,'padding':'x'*3000},'created_at':START+dt.timedelta(seconds=4)} for i in range(1,1401)]
        conn=FakeConnection(audit_rows=contexts,trade_rows=[trade(1,START+dt.timedelta(seconds=1))])
        result=self.run_async(exporter.read_export(conn,lambda s:s,start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='diag-test',decision_high_water=0,decision_end_high_water=1400,trade_high_water=0,trade_end_high_water=1,shadow_sha=SHADOW_SHA,poly2_checkout_sha=POLY_SHA,runtime_image_id=None,runtime_revision=None))
        coverage=result['coverage']['decisionAuditContext']
        self.assertLessEqual(coverage['retainedBytes'],exporter.MAX_AUDIT_CONTEXT_TOTAL_BYTES)
        self.assertEqual(len(result['rows'][0]['decisionAudit']),1400)
        self.assertFalse(coverage['complete'])
        self.assertIsNone(result['rows'][0]['paperOutcome'])
        audit_calls=[p for sql,p in conn.sql if 'audit_page' in sql]
        self.assertGreaterEqual(len(audit_calls),2)
        self.assertTrue(all(p['limit']<=exporter.PAGE_SIZE and p['context_budget_bytes']<=exporter.MAX_AUDIT_CONTEXT_PAGE_BYTES for p in audit_calls))
        omitted=sum(v for k,v in coverage['evidenceCounts'].items() if k!='AVAILABLE')
        self.assertGreater(omitted,0)

    def test_audit_pagination_rejects_oversized_page_request_before_query(self):
        conn=FakeConnection()
        with self.assertRaisesRegex(ValueError,'pagination limits'):
            self.run_async(exporter._paged_audit_rows(conn,lambda s:s,'SELECT id FROM decision_log',{'cursor':0,'high_id':9},cap=10,page_size=exporter.PAGE_SIZE+1))
        self.assertEqual(conn.sql,[])

    def test_missing_decision_audit_keeps_eligibility_unknown(self):
        conn = FakeConnection(audits=False, trade_rows=[trade(1, START + dt.timedelta(seconds=1))])
        result = self.run_async(exporter.read_export(
            conn, lambda s: s, start_utc=START.isoformat(), end_utc=END.isoformat(), run_id='diag-test',
            decision_high_water=0, decision_end_high_water=0, trade_high_water=0, trade_end_high_water=1, shadow_sha=SHADOW_SHA, poly2_checkout_sha=POLY_SHA,
            runtime_image_id=None, runtime_revision=None))
        row = result['rows'][0]
        self.assertEqual(row['decisionEvidence'], 'UNKNOWN_NO_AUDIT')
        self.assertIsNone(row['policyEligible'])
        self.assertIsNone(row['paperOutcome'])
        self.assertEqual(result['coverage']['actualPaperOrderExecutions'], 0)

    def test_duplicate_conflict_and_row_cap_fail_without_partial_export(self):
        conflicting = [trade(1, START + dt.timedelta(seconds=1)), trade(2, START + dt.timedelta(seconds=2))]
        conflicting[1]['price'] = Decimal('0.75')
        with self.assertRaisesRegex(RuntimeError, 'conflicting duplicate'):
            exporter.deduplicate_trade_rows(conflicting)
        many = [trade(i, START + dt.timedelta(seconds=1)) for i in range(1, 3)]
        conn = FakeConnection(trade_rows=many, audits=False)
        with self.assertRaisesRegex(RuntimeError, 'row cap exceeded'):
            self.run_async(exporter.read_export(
                conn, lambda s: s, start_utc=START.isoformat(), end_utc=END.isoformat(), run_id='diag-test',
                decision_high_water=0, decision_end_high_water=0, trade_high_water=0, trade_end_high_water=2, shadow_sha=SHADOW_SHA, poly2_checkout_sha=POLY_SHA,
                runtime_image_id=None, runtime_revision=None, max_trade_rows=1))

    def test_transaction_setup_executes_sql_and_reads_back_live_flags(self):
        conn=FakeConnection()
        self.run_async(exporter.begin_read_only_repeatable_read(conn,lambda sql:sql))
        self.assertTrue(conn.sql[0][0].startswith('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
        self.assertIn('current_setting',conn.sql[1][0])

    def test_invalid_window_and_highwater_bounds_fail_before_source_queries(self):
        conn=FakeConnection()
        common=dict(start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='diag-test',decision_high_water=2,decision_end_high_water=1,trade_high_water=0,trade_end_high_water=2,shadow_sha=SHADOW_SHA,poly2_checkout_sha=POLY_SHA,runtime_image_id=None,runtime_revision=None)
        with self.assertRaisesRegex(ValueError,'invalid bounded export'):
            self.run_async(exporter.read_export(conn,lambda s:s,**common))
        self.assertEqual(conn.sql,[])
        common['decision_end_high_water']=3
        common['end_utc']=(START+dt.timedelta(days=2)).isoformat()
        with self.assertRaisesRegex(ValueError,'no longer than 24 hours'):
            self.run_async(exporter.read_export(conn,lambda s:s,**common))
        self.assertEqual(conn.sql,[])

    def test_end_highwater_must_be_visible_in_snapshot(self):
        conn=FakeConnection()
        with self.assertRaisesRegex(RuntimeError,'end primary-key high-water is not visible'):
            self.run_async(exporter.read_export(conn,lambda s:s,start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='diag-test',decision_high_water=0,decision_end_high_water=10,trade_high_water=0,trade_end_high_water=2,shadow_sha=SHADOW_SHA,poly2_checkout_sha=POLY_SHA,runtime_image_id=None,runtime_revision=None))

    def test_keyset_partial_pages_are_exhaustive_and_caps_fail_closed(self):
        class Pages:
            def __init__(self): self.params=[]
            async def execute(self,sql,params):
                self.params.append(params.copy())
                return Result([{'source_record_id':i} for i in range(1,6) if params['cursor']<i<=params['high_id']][:params['limit']])
        conn=Pages()
        rows=self.run_async(exporter._paged_rows(conn,lambda s:s,'SELECT',{'cursor':0,'high_id':5},cap=5,page_size=2))
        self.assertEqual([r['source_record_id'] for r in rows],[1,2,3,4,5])
        self.assertEqual([p['cursor'] for p in conn.params],[0,2,4])
        conn=Pages()
        with self.assertRaisesRegex(RuntimeError,'row cap exceeded'):
            self.run_async(exporter._paged_rows(conn,lambda s:s,'SELECT',{'cursor':0,'high_id':5},cap=3,page_size=2))

    def test_database_error_never_returns_partial_export(self):
        class Broken(FakeConnection):
            async def execute(self,statement,params=None): raise RuntimeError('database error with hidden details')
        with self.assertRaisesRegex(RuntimeError,'database error'):
            self.run_async(exporter.read_export(Broken(),lambda s:s,start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='diag-test',decision_high_water=0,decision_end_high_water=9,trade_high_water=0,trade_end_high_water=2,shadow_sha=SHADOW_SHA,poly2_checkout_sha=POLY_SHA,runtime_image_id=None,runtime_revision=None))

    def test_context_payload_uses_allowlist_and_omits_unrecognized_sensitive_fields(self):
        context={'source_trade_id':SOURCE_ID,'signal_id':7,'reason':'stale_signal','api_key':'highly-sensitive','opaque_blob':'x'*4096}
        safe=exporter.bounded_context(context)
        self.assertEqual(safe['source_trade_id'],SOURCE_ID)
        self.assertEqual(safe['signal_id'],7)
        self.assertEqual(safe['reason'],'stale_signal')
        self.assertNotIn('api_key',safe)
        self.assertNotIn('opaque_blob',safe)
        self.assertEqual(safe['omittedContextFields'],2)
        self.assertEqual(exporter.bounded_context({'reason':'arbitrary secret value'}),{'omittedContextFields':1})
        self.assertEqual(exporter.redact({'api_key':'secret','items':list(range(100))})['api_key'],'[REDACTED]')

    def test_unlinked_decision_is_retained_but_not_counted_as_action(self):
        conn = FakeConnection(trade_rows=[trade(1, START + dt.timedelta(seconds=1))])
        conn.audit_rows[0]['context']['signal_id']=999
        result = self.run_async(exporter.read_export(
            conn, lambda s: s, start_utc=START.isoformat(), end_utc=END.isoformat(), run_id='diag-test',
            decision_high_water=0, decision_end_high_water=9, trade_high_water=0, trade_end_high_water=1, shadow_sha=SHADOW_SHA, poly2_checkout_sha=POLY_SHA,
            runtime_image_id=None, runtime_revision=None))
        self.assertEqual(result['rows'][0]['decisionEvidence'], 'UNKNOWN_UNLINKED_AUDIT')
        self.assertIsNone(result['rows'][0]['paperOutcome'])
        self.assertEqual(result['coverage']['actualPaperOrderExecutions'], 0)


if __name__ == '__main__':
    unittest.main()
