"""Required native-driver fixture, used only with the exact isolated CI service."""
import asyncio
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import unittest

SPEC = importlib.util.spec_from_file_location('native_diagnostic_export', Path(__file__).resolve().parents[1]/'scripts/poly2-diagnostic-export.py')
E = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(E)
ADMIN = 'postgresql+asyncpg://fixture_admin:fixture_password@127.0.0.1:55449/shadow_diagnostic_fixture'
READER = 'postgresql+asyncpg://fixture_reader:fixture_reader@127.0.0.1:55449/shadow_diagnostic_fixture'
START = dt.datetime(2026, 1, 1, tzinfo=dt.timezone.utc)
END = START + dt.timedelta(days=1)


@unittest.skipUnless(os.getenv('DIAGNOSTIC_NATIVE_POSTGRES') == 'isolated-ci-fixture', 'isolated PostgreSQL service required')
class NativeDiagnosticPostgres(unittest.TestCase):
    def test_native_driver_read_only_bounds_late_rows_and_hostile_context(self):
        asyncio.run(self.exercise())

    async def exercise(self):
        from sqlalchemy import text
        from sqlalchemy.ext.asyncio import create_async_engine
        from sqlalchemy.pool import NullPool
        admin = create_async_engine(ADMIN, poolclass=NullPool)
        reader = create_async_engine(READER, poolclass=NullPool)
        try:
            async with admin.begin() as c:
                # This test owns a fresh service/database; never accept a supplied DSN.
                await c.execute(text('CREATE ROLE fixture_reader LOGIN PASSWORD \'fixture_reader\''))
                for statement in (
                    'CREATE TABLE wallets(id integer PRIMARY KEY,address varchar(42),approval_state varchar(20))',
                    'CREATE TABLE markets(id integer PRIMARY KEY,condition_id varchar(80))',
                    'CREATE TABLE trades(id integer PRIMARY KEY,polymarket_trade_id text,wallet_id integer,market_id integer,asset_id varchar(80),side varchar(4),size numeric(20,6),price numeric(10,6),traded_at timestamptz,ingested_at timestamptz)',
                    'CREATE TABLE signals(id integer PRIMARY KEY,source_trade_id text,t1_detected_at timestamptz)',
                    'CREATE TABLE decision_log(id integer PRIMARY KEY,actor varchar(40),action varchar(80),context json,created_at timestamptz)',
                ):
                    await c.execute(text(statement))
                for i, wallet in enumerate(E.WALLETS, 1):
                    await c.execute(text("INSERT INTO wallets VALUES(:i,:w,'approved')"), {'i': i, 'w': wallet})
                await c.execute(text("INSERT INTO markets VALUES(1,'condition-1')"))
                ids = {}
                for ident, ingested in ((1, START+dt.timedelta(seconds=3)), (2, END), (3, END-dt.timedelta(microseconds=1))):
                    source = f'data-api:0x{ident:064x}:{E.WALLETS[0]}:7:2:0.5:{int(START.timestamp())+1}'
                    ids[ident] = source
                    await c.execute(text("INSERT INTO trades VALUES(:i,:s,1,1,'7','BUY',2,0.5,:event,:ingest)"),
                                    {'i': ident, 's': source, 'event': START+dt.timedelta(seconds=1), 'ingest': ingested})
                    await c.execute(text('INSERT INTO signals VALUES(:i,:s,:t)'), {'i': ident, 's': source, 't': ingested})
                for ident, source, context in ((9, ids[1], {'source_trade_id':ids[1], 'signal_id':1, 'payload':'x'*(1024*1024)}),
                                               (10, ids[3], {'source_trade_id':ids[3], 'signal_id':3, 'reason':'stale_signal'})):
                    await c.execute(text("INSERT INTO decision_log VALUES(:i,'bot',:action,CAST(:ctx AS json),:t)"),
                        {'i':ident, 'action':'paper_order_executed' if ident==9 else 'signal_skipped', 'ctx':json.dumps(context), 't':END-dt.timedelta(microseconds=1)})
                await c.execute(text('GRANT SELECT ON ALL TABLES IN SCHEMA public TO fixture_reader'))

            kwargs = dict(start_utc=START.isoformat(), end_utc=END.isoformat(), run_id='native-fixture',
                decision_high_water=9, decision_end_high_water=10, trade_high_water=2, trade_end_high_water=3,
                shadow_sha='1'*40, poly2_checkout_sha='2'*40, runtime_image_id=None, runtime_revision=None,
                exported_utc=(END+dt.timedelta(seconds=30)).isoformat())
            async with reader.connect() as c:
                async with c.begin():
                    await E.begin_read_only_repeatable_read(c, text)
                    pre = await E.read_preflight(c, text, END.isoformat())
                    self.assertEqual(pre['cohort'], list(E.WALLETS))
                    result = await E.read_export(c, text, **kwargs)
                    self.assertEqual([r['sourceRecordId'] for r in result['rows']], [1, 3])
                    self.assertEqual(result['coverage']['prestartAllocatedIdsIncluded'], 1)
                    self.assertEqual([r['sourceRecordId'] for r in result['lateArrivals']], [2])
                    self.assertEqual(result['rows'][0]['decisionAudit'][0]['contextEvidence'], 'TRUNCATED_OVERSIZE')
                    self.assertIsNone(result['rows'][0]['paperOutcome'])
                    self.assertEqual(result['rows'][1]['paperOutcome'], 'signal_skipped')
                    self.assertLessEqual(result['coverage']['decisionAuditContext']['retainedBytes'], 4096)
                    self.assertNotIn('x'*5000, json.dumps(result))
                    self.assertEqual((await c.execute(text("SELECT current_setting('statement_timeout')"))).scalar(), '15s')
                async with c.begin():
                    await E.begin_read_only_repeatable_read(c, text)
                    with self.assertRaisesRegex(Exception, 'row cap'):
                        await E.read_export(c, text, **kwargs, max_trade_rows=1)
                # A real PostgreSQL write refusal, not a mock driver's assertion.
                async with c.begin():
                    await E.begin_read_only_repeatable_read(c, text)
                    with self.assertRaises(Exception):
                        await c.execute(text("INSERT INTO wallets VALUES(99,'fixture','approved')"))
                    await c.rollback()
            async with admin.begin() as c:
                await c.execute(text("INSERT INTO trades VALUES(4,:hostile,1,1,'7','BUY',2,0.5,:t,:t)"), {'hostile':'y'*(2*1024*1024), 't':START+dt.timedelta(seconds=9)})
            async with reader.connect() as c:
                async with c.begin():
                    await E.begin_read_only_repeatable_read(c, text)
                    kwargs['trade_end_high_water'] = 4
                    with self.assertRaisesRegex(ValueError, 'bounded stable source identity'):
                        await E.read_export(c, text, **kwargs)
        finally:
            await reader.dispose()
            await admin.dispose()


if __name__ == '__main__':
    unittest.main()
