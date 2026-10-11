"""Real SQLAlchemy Session lifecycle tests, optional scratch-installed dependency."""
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT=Path(__file__).resolve().parents[1]
AVAILABLE=importlib.util.find_spec('sqlalchemy') is not None
SPEC=importlib.util.spec_from_file_location('session_observer',ROOT/'scripts/poly2-comparison-session-observer.py')
assert SPEC and SPEC.loader
O=importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(O)

if AVAILABLE:
    from sqlalchemy import Column,Integer,String,Numeric,create_engine,event,text,select
    from sqlalchemy.orm import declarative_base,Session
    Base=declarative_base()
    class Wallet(Base):
        __tablename__='wallets'; id=Column(Integer,primary_key=True); address=Column(String)
    class Market(Base):
        __tablename__='markets'; id=Column(Integer,primary_key=True); condition_id=Column(String)
    class Trade(Base):
        __tablename__='trades'
        id=Column(Integer,primary_key=True); polymarket_trade_id=Column(String,unique=True)
        wallet_id=Column(Integer); market_id=Column(Integer); asset_id=Column(String); side=Column(String)
        size=Column(Numeric); traded_at=Column(String); ingested_at=Column(String,default=lambda:'2026-01-01T12:00:00.000001Z')


@unittest.skipUnless(AVAILABLE,'SQLAlchemy optional adapter dependency not installed')
class SessionTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']); self.addCleanup(self.temp.cleanup)
        self.engine=create_engine('sqlite:///'+self.temp.name+'/source.sqlite')
        self.addCleanup(self.engine.dispose)
        Base.metadata.create_all(self.engine)
        with self.engine.begin() as c:
            c.execute(text(O.F.WITNESS_SCHEMA)); c.execute(text("INSERT INTO wallets VALUES(1,'0x"+'a'*40+"');")); c.execute(text("INSERT INTO markets VALUES(1,'condition')"))
        self.now='2026-01-01T00:00:00Z'
        binding=dict(runId='orm',shadowRunId='shadow',poly2CodeSha='a'*40,componentSha256='b'*64,evidenceKind='synthetic',sourcePublicKey=None,cohort=['0x'+x*40 for x in 'abcde'],window=dict(startUtc=self.now,endUtc='2026-01-02T00:00:00Z'),expectedWorkers=['bot:one','backend:one'])
        self.f=O.F.Fence(Path(self.temp.name)/'authority',binding,read_clock=lambda:self.now); self.f.enroll('bot:one'); self.f.enroll('backend:one'); self.addCleanup(self.f.close)
        self.s=Session(self.engine,expire_on_commit=False); self.addCleanup(self.s.close)
        self.o=O.SessionObserver(self.s,self.f,'bot:one',Trade,Wallet,Market); self.addCleanup(self.o.detach)
    def trade(self,ident):
        t=Trade(id=ident,polymarket_trade_id='event:'+str(ident),wallet_id=1,market_id=1,asset_id='7',side='BUY',size=100,traded_at='2026-01-01T11:59:00Z')
        self.s.add(t); return t
    def witness(self):
        with self.engine.connect() as c:
            return [json.loads(x) for x in c.execute(text('SELECT payload FROM comparison_transaction_witness')).scalars()]
    def test_actual_before_flush_admission_and_defaults_not_caller_callbacks(self):
        observed=[]
        def check(conn,cursor,statement,parameters,context,many):
            if statement.startswith('INSERT INTO trades'):
                self.assertEqual(len(self.f.state()['attempts']),1)
                self.assertEqual(next(iter(self.f.state()['attempts'].values()))['state'],'OUTSTANDING'); observed.append(statement)
        event.listen(self.engine,'before_cursor_execute',check)
        self.trade(1); self.s.commit()
        self.assertEqual(len(observed),1); self.assertIsNone(self.f.state()['error'])
        self.assertEqual(self.witness()[0]['trades'][0]['ingestedUtc'],'2026-01-01T12:00:00.000001Z')
        self.assertEqual(self.f.status()['outstanding'],1) # actual witness recovery, no after_commit assertion
    def test_begin_nested_autoflush_is_admitted_before_implicit_insert(self):
        self.trade(1)
        with self.s.begin_nested(): self.trade(2); self.s.flush()
        self.s.commit()
        self.assertEqual(len(self.f.state()['attempts']),1)
        self.assertEqual([t['sourceRecordId'] for t in self.witness()[0]['trades']],[1,2])
    def test_row_savepoint_rollback_does_not_resolve_outer_and_no_phantom_fact(self):
        self.trade(1); self.s.flush()
        try:
            with self.s.begin_nested():
                self.trade(2); self.s.flush(); raise ValueError('row quarantine')
        except ValueError: pass
        self.assertEqual(self.f.status()['outstanding'],1)
        self.s.commit(); self.assertEqual([t['sourceRecordId'] for t in self.witness()[0]['trades']],[1])
    def test_confirmed_outer_rollback_is_durable_and_retry_new_attempt(self):
        self.trade(1); self.s.flush(); self.s.rollback()
        self.assertEqual(self.f.status()['rolledBack'],1)
        self.trade(2); self.s.commit(); self.assertEqual(len(self.f.state()['attempts']),2)
        self.assertEqual(len(self.witness()),1)
    def test_witness_savepoint_failure_commit_source_unchanged_and_capture_failed(self):
        with self.engine.begin() as c: c.execute(text('DROP TABLE comparison_transaction_witness'))
        self.trade(1); self.s.commit()
        self.assertEqual(self.s.scalar(select(Trade.id)),1)
        self.assertEqual(self.f.status()['state'],'FAILED')
    def test_admission_journal_failure_source_insert_commit_still_succeeds(self):
        self.f._admit=lambda *a,**kw: (_ for _ in ()).throw(OSError('full admission disk'))
        self.trade(1); self.s.commit(); self.assertEqual(self.s.scalar(select(Trade.id)),1)
        self.assertEqual(self.f.status()['state'],'FAILED')
    def test_close_race_after_flush_stays_original_epoch_late_commit(self):
        self.trade(1); self.s.flush(); self.now='2026-01-02T00:00:00.000001Z'; self.f.close_epoch(); self.o.acknowledge_epoch(); self.f._ack('backend:one')
        self.assertIsNone(self.f.complete()); self.s.commit()
        self.assertEqual(self.witness()[0]['epoch'],0)
    def test_subsequent_source_transaction_uses_postepoch_while_old_pending(self):
        self.trade(1); self.s.commit(); self.now='2026-01-02T00:00:00.000001Z'; self.f.close_epoch(); self.o.acknowledge_epoch(); self.f._ack('backend:one')
        self.trade(2).ingested_at='2026-01-02T00:00:01Z'; self.s.commit()
        self.assertEqual([w['epoch'] for w in self.witness()],[0,1])
        self.assertEqual(self.f.status()['outstanding'],1)

if __name__=='__main__': unittest.main()
