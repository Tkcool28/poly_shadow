"""Owned, network-none PostgreSQL epoch/inflight acceptance tests (no live DSN)."""
import copy
import datetime as dt
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('native_fence', ROOT/'scripts/poly2-comparison-fence.py')
assert SPEC and SPEC.loader
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
NAME = 'poly-shadow-phase4-epoch-resume-f0296c9-20261009'
ENABLED = os.environ.get('POLY2_EPOCH_PG_CONTAINER') == NAME
START, END = '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
COHORT = ['0x'+x*40 for x in 'abcde']


class NativeConnection:
    autocommit = True
    info = type('Info', (), {'transaction_status': 0})()
    def __init__(self, user='postgres'):
        if not ENABLED:
            raise ValueError('exact owned fixture required')
        self.process = subprocess.Popen(['docker','exec','-i',NAME,'sh','-c',f'exec psql -X -qAt -p 55443 -U {user} -d epoch_fixture 2>&1'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,bufsize=1)
        self.rows, self.calls = [], []
    def cursor(self): return self
    def execute(self, sql, params=None):
        self.calls.append((sql,params))
        if params:
            for v in params:
                literal = str(v) if isinstance(v,int) else "'"+str(v).replace("'","''")+"'"
                sql = sql.replace('%s',literal,1)
        if sql.startswith('SELECT '):
            sql = "SELECT COALESCE(json_agg(row_to_json(q)),'[]'::json) FROM ("+sql+") q"
        marker = 'done_'+os.urandom(8).hex()
        self.process.stdin.write(sql+';\n\\echo '+marker+'\n')
        self.process.stdin.flush()
        lines=[]
        while True:
            line=self.process.stdout.readline()
            if not line: raise RuntimeError('native session ended')
            if line.strip()==marker: break
            if line.strip(): lines.append(line.strip())
        if any('ERROR:' in x for x in lines): raise RuntimeError('\n'.join(lines))
        self.rows=[]
        if sql.startswith('SELECT '):
            for row in json.loads(lines[-1]):
                self.rows.append(tuple(dt.datetime.fromisoformat(v) if k in ('ingested_at','traded_at','t2_decided_at','created_at') and v is not None else v for k,v in row.items()))
    def fetchall(self): return self.rows
    def commit(self): self.execute('COMMIT')
    def rollback(self): self.execute('ROLLBACK')
    def close(self): pass
    def disconnect(self):
        self.process.stdin.write('\\q\n'); self.process.stdin.flush(); self.process.communicate(timeout=10)


class WriterRosterTests(unittest.TestCase):
    def test_only_full_backend_bot_roster_can_arm_and_every_instance_is_explicit(self):
        for workers in (['bot:one'],['backend:one'],['bot:one','backend:one','watchdog:one'],
                        ['bot:','backend:one'],['bot:space id','backend:one'],
                        ['bot:one','bot:one','backend:one']):
            with self.subTest(workers=workers), self.assertRaisesRegex(ValueError,'complete bot/backend writer-service inventory'):
                F.validate_writer_roster(dict(expectedWorkers=workers))
            with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
                with self.assertRaisesRegex(ValueError,'complete bot/backend writer-service inventory'):
                    F.Fence(directory,dict(cohort=COHORT,expectedWorkers=workers,evidenceKind='synthetic'))
        self.assertIsNone(F.validate_writer_roster(dict(expectedWorkers=['backend:one','bot:one','bot:two'])))

    def test_identical_generation_ack_is_idempotent_conflict_is_visible_and_closure_requires_both(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            binding=dict(runId='ack',shadowRunId='shadow',poly2CodeSha='a'*40,componentSha256='b'*64,
                cohort=COHORT,window=dict(startUtc=START,endUtc=END),evidenceKind='synthetic',sourcePublicKey=None,
                expectedWorkers=['bot:one','backend:one'])
            now=[START]
            f=F.Fence(directory,binding,read_clock=lambda:now[0])
            f.enroll('bot:one'); f.enroll('backend:one'); now[0]='2026-01-02T00:00:00.000001Z'; f.close_epoch()
            f._ack('bot:one'); before=f.events(); f._ack('bot:one')
            self.assertEqual(f.events(),before)
            with self.assertRaisesRegex(ValueError,'ACK'):
                f._append('ACK',dict(worker='bot:one',epoch=0))
            self.assertEqual(f.state()['acks'],{'bot:one'})
            self.assertIsNone(f.complete())
            f._ack('backend:one')
            self.assertIsNotNone(f.complete())
            f.close()


@unittest.skipUnless(ENABLED,'explicit owned network-none native fixture required')
class EpochTests(unittest.TestCase):
    def setUp(self):
        self.connections=[]
        self.admin=self.connection()
        self.admin.execute('TRUNCATE decision_log,paper_orders,signals,trades,wallets,markets,comparison_transaction_witness')
        self.admin.execute("INSERT INTO markets VALUES(1,'condition'); INSERT INTO wallets VALUES(1,'"+COHORT[0]+"')")
        self.temp=tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']); self.addCleanup(self.temp.cleanup)
        self.addCleanup(lambda:[c.disconnect() for c in self.connections])
        self.now=START
        self.binding=dict(runId='epoch',shadowRunId='shadow',poly2CodeSha='a'*40,componentSha256='b'*64,cohort=COHORT,window=dict(startUtc=START,endUtc=END),evidenceKind='synthetic',sourcePublicKey=None,expectedWorkers=['bot:runtime-A','backend:runtime-B'])
        self.fences=[]; self.drains=[]
        self.addCleanup(lambda:[d.close() for d in self.drains if not d.owner.closed])
        self.addCleanup(lambda:[f.close() for f in self.fences])
        self.fence=self.open_fence()
        for w in self.binding['expectedWorkers']: self.fence.enroll(w)
        self.now='2026-01-01T12:00:00Z'
        self.reader=self.connection('capture_reader')
        self.adapter=F.C.SQLAdapter(self.reader,'postgres',checkpoint=True)
    def connection(self,user='postgres'):
        c=NativeConnection(user); self.connections.append(c); return c
    def open_fence(self):
        f=F.Fence(self.temp.name,self.binding,read_clock=lambda:self.now); self.fences.append(f); return f
    def driver(self,worker=0,retry_of=None):
        return F.TransactionDriver(self.fence,self.binding['expectedWorkers'][worker],self.connection(),retry_of=retry_of)
    def insert(self,d,ident,clock='2026-01-01T12:00:00.000001Z'):
        d.connection.execute("INSERT INTO trades VALUES(%s,%s,1,1,'7','BUY',100,'2026-01-01T11:59:00Z',%s)",[ident,'event:'+str(ident),clock])
    def decision(self,ident,reason=None):
        self.admin.execute('INSERT INTO signals VALUES(%s,%s)',[ident,'event:'+str(ident)])
        self.admin.execute("INSERT INTO paper_orders VALUES(%s,%s,'2026-01-03T00:01:00.000001Z',"+("NULL" if reason is None else "'"+reason+"'")+")",[ident,ident])
        action='signal_skipped' if reason is not None else 'paper_order_executed'
        context=json.dumps(dict(signal_id=ident,source_trade_id='event:'+str(ident),reason=reason))
        self.admin.execute('INSERT INTO decision_log(actor,action,context) VALUES(%s,%s,%s::jsonb)', ['bot',action,context])
    def close_ack(self,*drivers):
        self.now='2026-01-02T00:00:00.000001Z'; self.fence.close_epoch()
        for d in drivers: d.acknowledge_epoch()
    def ack_missing(self):
        # Workers themselves attach a new source transaction and acknowledge the
        # generation; labels/certificate booleans cannot resolve old transactions.
        for i,w in enumerate(self.binding['expectedWorkers']):
            if w not in self.fence.state()['acks']:
                d=self.driver(i); d.rollback(); d.acknowledge_epoch()
    def finish(self):
        self.fence.recover(self.reader); self.ack_missing()
        self.assertIsNotNone(self.fence.complete())
        return self.fence.freeze(self.adapter)
    def drain(self):
        d=F.FencedDrain(Path(self.temp.name)/'drain',self.fence,self.adapter,read_clock=lambda:self.now)
        self.drains.append(d); return d
    def test_held_A_fast_B_postepoch_C_late_decision_seal_compare(self):
        a,b=self.driver(0),self.driver(1)
        self.insert(a,1); self.insert(b,2,END); b.commit([2])
        self.close_ack(a,b)
        c=self.driver(0); self.insert(c,3,'2026-01-02T00:00:00.000002Z')
        self.fence.recover(self.reader)
        self.assertIsNone(self.fence.complete())
        self.assertEqual(self.fence.status()['outstanding'],1)
        with self.assertRaisesRegex(ValueError,'completed authoritative'): self.fence.freeze(self.adapter)
        a.commit([1]); self.fence.recover(self.reader)
        self.assertIsNotNone(self.fence.complete())  # C still uncommitted and running
        p=self.fence.freeze(self.adapter)
        self.assertEqual(p['payload']['frozenIds'],[1,2])
        c.commit([3]); self.fence.recover(self.reader)
        d=self.drain(); self.assertEqual(d.step()['counts']['PENDING'],2)
        with self.assertRaisesRegex(ValueError,'pending/error'): d.seal_input()
        self.decision(1,'stale_signal'); self.decision(2)
        self.now='2026-01-03T00:02:00Z'; frame=d.step()
        self.assertTrue(frame['comparisonEligible']); self.assertEqual(frame['counts']['DECISION_RECORDED'],2)
        self.assertEqual(frame['perId']['event:1']['decision']['decisionUtc'],'2026-01-03T00:01:00.000001Z')
        path=Path(self.temp.name)/'seal-input.json'; path.write_text(F.canonical(d.seal_input()))
        r=subprocess.run(['node','--import','tsx',str(ROOT/'tests/poly2_fence_e2e.ts'),str(path)],cwd=ROOT,text=True,capture_output=True)
        self.assertEqual(r.returncode,0,r.stdout+r.stderr)
        result=json.loads(r.stdout)
        self.assertEqual(result['ids'],[1,2]); self.assertEqual(result['decisionClocks'][0],'2026-01-03T00:01:00.000001Z')
        self.assertEqual(result['normalized'],[None,None]); self.assertEqual(result['comparisonPrimary'],2)
        print('NATIVE_FENCE_E2E '+r.stdout.strip())
        # Restart from authoritative disk journals before the production file handoff.
        d.close()
        resumed = self.drain()
        handoff = Path(self.temp.name)/'file-handoff'
        resumed.write_seal_journals(handoff)
        file_result = subprocess.run(['node','--import','tsx',str(ROOT/'tests/poly2_fence_file_e2e.ts'),str(handoff)],cwd=ROOT,text=True,capture_output=True)
        self.assertEqual(file_result.returncode,0,file_result.stdout+file_result.stderr)
        file_proof = json.loads(file_result.stdout)
        self.assertEqual(file_proof['handoff'],'FILE_JOURNALS')
        self.assertEqual(file_proof['ids'],[1,2])
        self.assertEqual(file_proof['decisionClocks'],result['decisionClocks'])
        self.assertEqual(file_proof['normalized'],[None,None])
        self.assertEqual(file_proof['comparisonPrimary'],2)
        self.assertEqual(file_proof['negativeReplayChecks'],10)
        print('NATIVE_FENCE_FILE_E2E '+file_result.stdout.strip())
    def test_restart_preserves_partial_writer_enrollment_and_ack_state(self):
        bot,backend=self.driver(0),self.driver(1); bot.rollback(); backend.rollback()
        self.now='2026-01-02T00:00:00.000001Z'; self.fence.close_epoch(); bot.acknowledge_epoch()
        self.assertEqual(self.fence.status()['missingAcknowledgements'],['backend:runtime-B'])
        self.fence=self.open_fence()
        self.assertEqual(self.fence.state()['workers'],{'bot:runtime-A','backend:runtime-B'})
        self.assertEqual(self.fence.state()['acks'],{'bot:runtime-A'})
        backend.fence=self.fence; backend.acknowledge_epoch()
        self.assertIsNotNone(self.fence.complete())

    def test_worker_death_and_unknown_outcome_never_resolve_from_absence(self):
        a=self.driver(); self.insert(a,1); self.close_ack(a); self.ack_missing()
        self.fence.recover(self.reader); self.assertIsNone(self.fence.complete())
        a.connection.disconnect(); self.connections.remove(a.connection)
        f=self.open_fence(); f.recover(self.reader)
        self.assertEqual(f.status()['outstanding'],1); self.assertIsNone(f.complete())
    def test_dead_worker_no_ack_blocks_even_zero_outstanding(self):
        a=self.driver(); a.rollback(); self.close_ack(a)
        self.assertIsNone(self.fence.complete()); self.assertEqual(self.fence.status()['missingAcknowledgements'],['backend:runtime-B'])
    def test_confirmed_rollback_retry_new_identity_no_phantom_fact(self):
        a=self.driver(); self.insert(a,1); a.rollback()
        b=self.driver(retry_of=a.token); self.assertNotEqual(a.token,b.token); self.insert(b,2); b.commit([2])
        self.close_ack(b); p=self.finish(); self.assertEqual(p['payload']['frozenIds'],[2])
        self.assertEqual(self.fence.status()['rolledBack'],1)
    def test_unknown_outcome_retry_rejected_but_source_continues(self):
        a=self.driver(); self.insert(a,1)
        b=self.driver(retry_of=a.token); self.assertIsNone(b.token)
        self.insert(b,2); b.commit([2]); a.rollback()
        self.close_ack(b); self.assertRaises(ValueError,self.fence.complete)
        self.admin.execute('SELECT count(*) FROM trades'); self.assertEqual(self.admin.fetchall(),[(1,)])
    def test_commit_crash_before_capture_recovered_from_actual_witness(self):
        a=self.driver(); self.insert(a,1); a.commit([1])
        self.assertEqual(self.fence.status()['outstanding'],1)
        self.fence=self.open_fence(); self.close_ack(a); self.finish()
        self.assertEqual(self.fence.status()['committed'],1)
    def test_restart_duplicate_ack_and_recover_are_idempotent(self):
        a=self.driver(); self.insert(a,1); a.commit([1]); self.close_ack(a); self.finish()
        before=self.fence.events(); self.fence=self.open_fence()
        self.fence.recover(self.reader); a.fence=self.fence; a.acknowledge_epoch(); self.fence.complete(); self.fence.freeze(self.adapter)
        self.assertEqual(self.fence.events(),before)
    def test_witness_sink_failure_preserves_source_commit_and_blocks_fence(self):
        a=self.driver(); self.insert(a,1)
        a.connection.execute('DROP TABLE comparison_transaction_witness')
        a.commit([1]); self.assertTrue(a.finished)
        self.admin.execute('SELECT count(*) FROM trades'); self.assertEqual(self.admin.fetchall(),[(1,)])
        self.assertEqual(self.fence.status()['state'],'FAILED')
        self.admin.execute(F.WITNESS_SCHEMA)
        self.admin.execute('GRANT SELECT ON comparison_transaction_witness TO capture_reader')
        self.close_ack(a); self.assertRaises(ValueError,self.fence.complete)
    def test_registration_sink_failure_does_not_change_source_availability(self):
        old=self.fence._admit; self.fence._admit=lambda *a,**kw: (_ for _ in ()).throw(OSError('admission sink full'))
        a=self.driver(); self.insert(a,1); a.commit([1]); self.fence._admit=old
        self.admin.execute('SELECT count(*) FROM trades'); self.assertEqual(self.admin.fetchall(),[(1,)])
        self.assertEqual(self.fence.status()['state'],'FAILED')
    def test_perpetual_postepoch_work_does_not_starve_fence(self):
        a=self.driver(); self.insert(a,1); a.commit([1]); self.close_ack(a); self.finish()
        for i in range(3,10):
            c=self.driver(0); self.insert(c,i,'2026-01-02T00:00:01Z'); c.commit([i])
        self.fence.recover(self.reader); self.assertEqual(self.fence.freeze(self.adapter)['payload']['frozenIds'],[1])
    def test_decision_restart_duplicates_conflict_and_blocking_health(self):
        a=self.driver(); self.insert(a,1); self.insert(a,2); a.commit([1,2]); self.close_ack(a); self.finish()
        d=self.drain(); self.decision(1); d.step(); self.assertEqual(d.status()['blockingIds'],['event:2']); d.close()
        d=self.drain(); d.step(); self.assertEqual(d.status()['counts']['DECISION_RECORDED'],1)
        self.admin.execute("UPDATE paper_orders SET miss_reason='changed' WHERE id=1")
        self.admin.execute("UPDATE decision_log SET action='signal_skipped' WHERE context->>'signal_id'='1'")
        self.assertEqual(d.step()['state'],'FAILED'); self.assertRaises(ValueError,d.seal_input)
    def test_decision_requires_exact_source_audit_linkage_and_captures_it(self):
        a=self.driver(); self.insert(a,1); self.insert(a,2); a.commit([1,2]); self.close_ack(a); self.finish()
        self.admin.execute("INSERT INTO signals VALUES(1,'event:1'); INSERT INTO paper_orders VALUES(1,1,'2026-01-03T00:01:00Z',NULL)")
        d=self.drain()
        with self.assertRaisesRegex(ValueError,'missing/conflicting original decision audit'):
            d.step()
        self.assertEqual(len(d.frames),0)
        context=json.dumps(dict(signal_id=1,source_trade_id='event:1'))
        self.admin.execute("INSERT INTO decision_log(actor,action,context) VALUES('bot','signal_skipped',%s::jsonb)",[context])
        with self.assertRaisesRegex(ValueError,'audit linkage/action mismatch'):
            d.step()
        self.admin.execute('TRUNCATE decision_log')
        self.admin.execute("INSERT INTO decision_log(actor,action,context) VALUES('bot','paper_order_executed',%s::jsonb)",[context])
        self.admin.execute("INSERT INTO decision_log(actor,action,context) VALUES('bot','paper_order_executed',%s::jsonb)",[context])
        with self.assertRaisesRegex(ValueError,'missing/conflicting original decision audit'):
            d.step()
        self.admin.execute('TRUNCATE decision_log')
        self.admin.execute("INSERT INTO decision_log(actor,action,context) VALUES('bot','paper_order_executed',%s::jsonb)",[context])
        result=d.step()
        self.assertEqual(result['perId']['event:1']['state'],'DECISION_RECORDED')
        audit=result['perId']['event:1']['decision']['sourceAudit']
        self.assertEqual(audit['action'],'paper_order_executed')
        self.assertEqual(audit['context'],dict(signal_id=1,source_trade_id='event:1'))
        self.assertTrue(audit['recordId'] > 0)
        self.assertIsNotNone(audit['createdUtc'])
        self.admin.execute("UPDATE decision_log SET context='{}'::jsonb WHERE id=%s",[audit['recordId']])
        with self.assertRaisesRegex(ValueError,'missing/conflicting original decision audit'):
            d.step()
        self.assertEqual(d.status()['state'],'DRAINING')
        with self.assertRaises(ValueError):
            d.seal_input()

    def test_pending_no_no_decision_terminal_and_timeout_incomplete(self):
        a=self.driver(); self.insert(a,1); a.commit([1]); self.close_ack(a); self.finish()
        d=self.drain(); frame=d.step(); self.assertEqual(frame['perId']['event:1']['state'],'PENDING')
        for _ in range(3): self.assertEqual(d.step()['state'],'DRAINING')
        self.assertFalse(d.timeout()['comparisonEligible']); self.assertRaises(ValueError,d.seal_input)
    def test_duplicate_initial_order_rejected_no_earliest_hindsight(self):
        a=self.driver(); self.insert(a,1); a.commit([1]); self.close_ack(a); self.finish(); self.decision(1)
        self.admin.execute("INSERT INTO paper_orders VALUES(2,1,'2026-01-03T00:02:00Z',NULL)")
        d=self.drain(); self.assertRaisesRegex(ValueError,'ambiguous',d.step); self.assertEqual(len(d.frames),0)
    def test_postepoch_old_clock_fails_without_redefining_window(self):
        a=self.driver(); a.rollback(); self.close_ack(a); self.ack_missing()
        c=self.driver(0); self.insert(c,3,END); c.commit([3])
        self.assertRaisesRegex(ValueError,'postepoch original',self.fence.recover,self.reader)
        self.assertEqual(self.fence.status()['outstanding'],0) # postepoch not preepoch
    def test_unregistered_source_row_checkpoint_mismatch_blocks_population(self):
        a=self.driver(); a.rollback(); self.close_ack(a); self.ack_missing(); self.fence.complete()
        self.admin.execute("INSERT INTO trades VALUES(1,'unregistered',1,1,'7','BUY',100,NULL,'2026-01-01T12:00:00Z')")
        self.assertRaisesRegex(ValueError,'unregistered',self.fence.freeze,self.adapter)
        self.assertEqual(self.fence.status()['state'],'FAILED')
    def test_unenrolled_held_old_clock_exposes_install_authority_blocker(self):
        # Counterexample, NOT closure acceptance: labels cannot exclude a source
        # connection that never installed the prospective observer. Final SQL
        # reconciliation cannot see this still-uncommitted transaction either.
        rogue = self.connection()
        rogue.execute('BEGIN')
        rogue.execute("INSERT INTO trades VALUES(99,'unenrolled:held',1,1,'7','BUY',100,NULL,'2026-01-01T12:00:00Z')")
        a = self.driver(); a.rollback(); self.close_ack(a); self.ack_missing()
        self.assertIsNotNone(self.fence.complete())
        self.assertEqual(self.fence.freeze(self.adapter)['payload']['frozenIds'], [])
        rogue.commit()
        self.reader.execute('SELECT id FROM trades ORDER BY id')
        self.assertEqual(self.reader.fetchall(), [(99,)])
        self.assertEqual(self.fence.state()['population']['payload']['frozenIds'], [])
        production_binding = dict(self.binding, evidenceKind='observational')
        with self.assertRaisesRegex(ValueError, 'UNINSTALLED'):
            F.Fence(Path(self.temp.name)/'forbidden-observational', production_binding, read_clock=lambda:self.now)

    def test_concurrent_admission_close_race_is_serialized_and_restart_stable(self):
        # Two independent coordinator connections contend on native file authority.
        self.now='2026-01-02T00:00:00.000001Z'
        barrier=threading.Barrier(2); result=[]
        def admit():
            f=F.Fence(self.temp.name,self.binding,read_clock=lambda:self.now)
            barrier.wait(); token=f._admit(self.binding['expectedWorkers'][0]); result.append(token); f.close()
        t=threading.Thread(target=admit); t.start(); barrier.wait(); self.fence.close_epoch(); t.join()
        events=self.fence.events(); token=result[0]
        a=self.fence.state()['attempts'][token]
        attempt=next(e for e in events if e['kind']=='ATTEMPT' and e['payload']['transactionId']==token)
        close=self.fence.state()['closed']
        self.assertEqual(a['epoch'],0 if attempt['seq']<close['seq'] else 1)
        self.assertEqual(self.open_fence().state()['attempts'][token]['epoch'],a['epoch'])
    def test_exact_end_close_refused_inclusive_original_membership(self):
        self.now=END; self.assertRaisesRegex(ValueError,'inclusive endpoint',self.fence.close_epoch)
        self.assertEqual(self.fence.state()['epoch'],0)
    def test_fixture_readonly_and_no_source_policy_outcome_queries(self):
        self.assertRaisesRegex(RuntimeError,'permission denied',self.reader.execute,"INSERT INTO markets VALUES(2,'forbidden')")
        a=self.driver(); self.insert(a,1); a.commit([1]); self.close_ack(a); self.finish()
        sql=' '.join(q for q,p in self.reader.calls)
        for forbidden in ('approval_state','paper_outcome','settlement','policy_eligible'):
            self.assertNotIn(forbidden,sql)

if __name__=='__main__': unittest.main()
