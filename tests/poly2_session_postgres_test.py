"""Real AsyncSession + asyncpg on the explicitly owned network-none PG fixture.

Run inside that fixture after copying installed-image Python runtime. No DSN,
network, Poly2 import or installation claim. Host invokes offline TS replay only
on the emitted synthetic seal input. Dependency absence is reported as a skip.
"""
import asyncio
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_session_observer', ROOT/'scripts/poly2-comparison-session-observer.py')
assert SPEC and SPEC.loader
O = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(O)
NAME = 'poly-shadow-phase4-epoch-resume-f0296c9-20261009'
AVAILABLE = importlib.util.find_spec('sqlalchemy') is not None and importlib.util.find_spec('asyncpg') is not None
ENABLED = os.environ.get('POLY2_SESSION_PG_CONTAINER') == NAME and AVAILABLE
START, END = '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
COHORT = ['0x'+x*40 for x in 'abcde']

if AVAILABLE:
    import asyncpg
    from sqlalchemy import Column, Integer, String, Numeric, DateTime, text
    from sqlalchemy.orm import declarative_base
    from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
    Base = declarative_base()
    INGEST_CLOCK = dt.datetime(2026,1,1,12,tzinfo=dt.timezone.utc)
    class Wallet(Base):
        __tablename__='wallets'; id=Column(Integer,primary_key=True); address=Column(String)
    class Market(Base):
        __tablename__='markets'; id=Column(Integer,primary_key=True); condition_id=Column(String)
    class Trade(Base):
        __tablename__='trades'; id=Column(Integer,primary_key=True)
        polymarket_trade_id=Column(String,unique=True); wallet_id=Column(Integer); market_id=Column(Integer)
        asset_id=Column(String); side=Column(String); size=Column(Numeric)
        traded_at=Column(DateTime(timezone=True)); ingested_at=Column(DateTime(timezone=True),default=lambda:INGEST_CLOCK)

class Reader:
    """Sync capture adapter over a real asyncpg connection on a private loop."""
    autocommit=True
    info=type('Info',(),{'transaction_status':0})()
    def __init__(self):
        self.loop=asyncio.new_event_loop()
        self.thread=threading.Thread(target=self.loop.run_forever); self.thread.start()
        self.conn=self.call(asyncpg.connect(user='capture_reader',database='epoch_fixture',host='/var/run/postgresql',port=55443))
        self.rows=[]
    def call(self,coro): return asyncio.run_coroutine_threadsafe(coro,self.loop).result(10)
    def cursor(self): return self
    def execute(self,sql,params=None):
        values=[]
        for i,p in enumerate(params or [],1):
            sql=sql.replace('%s','$'+str(i),1)
            if isinstance(p,str):
                try: p=dt.datetime.fromisoformat(O.F.C.clock(p))
                except (ValueError,TypeError): pass
            values.append(p)
        if sql.startswith('SELECT '): self.rows=[tuple(r) for r in self.call(self.conn.fetch(sql,*values))]
        else: self.call(self.conn.execute(sql,*values))
    def fetchall(self): return self.rows
    def rollback(self): self.execute('ROLLBACK')
    def close(self): pass
    def disconnect(self):
        self.call(self.conn.close()); self.loop.call_soon_threadsafe(self.loop.stop); self.thread.join(); self.loop.close()

@unittest.skipUnless(ENABLED,'explicit owned fixture plus installed-image SQLAlchemy/asyncpg required')
class NativeSessionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine=create_async_engine('postgresql+asyncpg://postgres@/epoch_fixture?host=/var/run/postgresql&port=55443')
        self.addAsyncCleanup(self.engine.dispose)
        async with self.engine.begin() as c:
            await c.execute(text('TRUNCATE decision_log,paper_orders,signals,trades,wallets,markets,comparison_transaction_witness'))
            await c.execute(text("INSERT INTO wallets VALUES(1,'"+COHORT[0]+"');"))
            await c.execute(text("INSERT INTO markets VALUES(1,'condition')"))
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']); self.addCleanup(self.temp.cleanup)
        self.now=START
        binding=dict(runId='native-orm',shadowRunId='shadow',poly2CodeSha='a'*40,componentSha256='b'*64,
            evidenceKind='synthetic',sourcePublicKey=None,cohort=COHORT,window=dict(startUtc=START,endUtc=END),expectedWorkers=['bot:runtime-A','backend:runtime-B'])
        self.f=O.F.Fence(Path(self.temp.name)/'fence',binding,read_clock=lambda:self.now); self.addCleanup(self.f.close)
        maker=async_sessionmaker(self.engine,expire_on_commit=False)
        self.factories=[O.ObservedSessionFactory(maker,self.f,w,Trade,Wallet,Market) for w in binding['expectedWorkers']]
        self.reader=Reader(); self.addCleanup(self.reader.disconnect)
        self.adapter=O.F.C.SQLAdapter(self.reader,'postgres',checkpoint=True)
        self.now='2026-01-01T12:00:00Z'
    def trade(self,session,ident,clock=None):
        t=Trade(id=ident,polymarket_trade_id='event:'+str(ident),wallet_id=1,market_id=1,asset_id='7',side='BUY',size=100,
            traded_at=dt.datetime(2026,1,1,11,59,tzinfo=dt.timezone.utc))
        if clock: t.ingested_at=dt.datetime.fromisoformat(clock)
        session.add(t); return t
    def close_epoch(self):
        self.now='2026-01-02T00:00:00.000001Z'; self.f.close_epoch()
        for factory in self.factories: factory.acknowledge_epoch()
    async def test_real_asyncsession_held_A_B_C_freeze_drain_seal(self):
        async with self.factories[0]() as a, self.factories[1]() as b, self.factories[0]() as c:
            self.trade(a,1); await a.flush()
            self.trade(b,2,END); await b.commit()
            self.close_epoch(); self.f.recover(self.reader)
            self.assertIsNone(self.f.complete()); self.assertEqual(self.f.status()['outstanding'],1)
            self.reader.execute('SELECT id FROM trades ORDER BY id'); self.assertEqual(self.reader.fetchall(),[(2,)])
            self.trade(c,3,'2026-01-02T00:00:00.000002Z'); await c.flush()
            await a.commit(); self.f.recover(self.reader); self.assertIsNotNone(self.f.complete())
            population=self.f.freeze(self.adapter); self.assertEqual(population['payload']['frozenIds'],[1,2])
            await c.commit(); self.f.recover(self.reader)
        drain=O.F.FencedDrain(Path(self.temp.name)/'drain',self.f,self.adapter,read_clock=lambda:self.now)
        self.addCleanup(drain.close)
        self.assertEqual(drain.step()['counts']['PENDING'],2)
        with self.assertRaises(ValueError): drain.seal_input()
        async with self.engine.begin() as c:
            await c.execute(text("INSERT INTO signals VALUES(1,'event:1'),(2,'event:2')"))
            await c.execute(text("INSERT INTO paper_orders VALUES(1,1,'2026-01-03T00:01:00.000001Z',NULL),(2,2,'2026-01-03T00:01:00.000001Z',NULL)"))
            await c.execute(text("INSERT INTO decision_log(actor,action,context) VALUES('bot','paper_order_executed',jsonb_build_object('signal_id',1,'source_trade_id','event:1')),('bot','paper_order_executed',jsonb_build_object('signal_id',2,'source_trade_id','event:2'))"))
        self.now='2026-01-03T00:02:00Z'; self.assertTrue(drain.step()['comparisonEligible'])
        output=os.environ.get('POLY2_SESSION_SEAL_OUTPUT')
        if output: Path(output).write_text(O.F.canonical(drain.seal_input()))
        file_output=os.environ.get('POLY2_SESSION_FILE_SEAL_OUTPUT')
        if file_output:
            drain.close()
            resumed=O.F.FencedDrain(Path(self.temp.name)/'drain',self.f,self.adapter,read_clock=lambda:self.now)
            self.addCleanup(resumed.close)
            resumed.write_seal_journals(file_output)
            self.assertEqual(resumed.status()['counts']['DECISION_RECORDED'],2)
        else:
            self.assertEqual(drain.status()['counts']['DECISION_RECORDED'],2)
    async def test_nested_release_then_parent_rollback_excludes_descendant_fact(self):
        async with self.factories[0]() as s:
            self.trade(s,1); await s.flush()
            try:
                async with s.begin_nested():
                    async with s.begin_nested(): self.trade(s,2); await s.flush()
                    raise ValueError('parent row rollback')
            except ValueError: pass
            await s.commit()
        self.f.recover(self.reader)
        witness=next(a['witness'] for a in self.f.state()['attempts'].values())
        self.assertEqual([t['sourceRecordId'] for t in witness['trades']],[1])
        self.close_epoch(); self.assertIsNotNone(self.f.complete()); self.f.freeze(self.adapter)
    async def test_real_outer_rollback_new_attempt_and_factory_future_sessions(self):
        async with self.factories[0]() as s:
            self.trade(s,1); await s.flush(); await s.rollback()
        async with self.factories[0]() as s:
            self.trade(s,2); await s.commit()
        self.f.recover(self.reader); self.close_epoch(); self.assertIsNotNone(self.f.complete())
        self.assertEqual(self.f.freeze(self.adapter)['payload']['frozenIds'],[2])
        self.assertEqual(self.f.status()['rolledBack'],1)
    async def test_async_admission_sink_failure_preserves_source_commit(self):
        self.f._admit=lambda *args,**kwargs: (_ for _ in ()).throw(OSError('admission sink failure'))
        async with self.factories[0]() as s:
            self.trade(s,1); await s.commit()
        async with self.engine.connect() as c:
            self.assertEqual((await c.execute(text('SELECT id FROM trades'))).scalar_one(),1)
        self.assertEqual(self.f.status()['state'],'FAILED')
        with self.assertRaises(ValueError): self.f.complete()

    async def test_async_witness_savepoint_failure_preserves_source_commit(self):
        async with self.engine.begin() as c:
            await c.execute(text('DROP TABLE comparison_transaction_witness'))
        try:
            async with self.factories[0]() as s:
                self.trade(s,1); await s.commit()
            async with self.engine.connect() as c:
                self.assertEqual((await c.execute(text('SELECT id FROM trades'))).scalar_one(),1)
            self.assertEqual(self.f.status()['state'],'FAILED')
        finally:
            async with self.engine.begin() as c:
                await c.execute(text(O.F.WITNESS_SCHEMA))
                await c.execute(text('GRANT SELECT ON comparison_transaction_witness TO capture_reader'))

    async def test_factory_rejects_unexpected_incarnation(self):
        with self.assertRaisesRegex(ValueError,'pinned expected'):
            O.ObservedSessionFactory(async_sessionmaker(self.engine),self.f,'external:unknown',Trade,Wallet,Market)

if __name__=='__main__': unittest.main()
