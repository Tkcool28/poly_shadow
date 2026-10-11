"""Actual disposable PostgreSQL committed-witness observational custody lifecycle."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from poly2_authority_test import A, F, fixture
import poly2_fence_postgres_test as N

@unittest.skipUnless(N.ENABLED,'explicit owned network-none fixture required')
class NativeAuthorityTests(unittest.TestCase):
    def test_observational_native_witness_restart_freeze_drain_official_cli(self):
        connections=[];fences=[];drains=[]
        self.addCleanup(lambda:[c.disconnect() for c in connections])
        self.addCleanup(lambda:[f.close() for f in fences])
        self.addCleanup(lambda:[d.close() for d in drains if not d.owner.closed])
        def connection(user='postgres'):
            c=N.NativeConnection(user);connections.append(c);return c
        admin=connection();reader=connection('capture_reader')
        admin.execute('TRUNCATE decision_log,paper_orders,signals,trades,wallets,markets,comparison_transaction_witness')
        b,a,key=fixture();now=['2025-12-31T23:30:00Z']
        admin.execute('INSERT INTO wallets VALUES(1,%s); INSERT INTO markets VALUES(1,%s)',[b['cohort'][0],'condition'])
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            def open_fence():
                f=F.Fence(Path(directory)/'fence',b,authority=a,authority_pin=A.digest(a),private_key=key,read_clock=lambda:now[0]);fences.append(f);return f
            f=open_fence()
            for worker in b['expectedWorkers']: f.enroll(worker)
            now[0]='2026-01-01T12:00:00Z'
            driver=F.TransactionDriver(f,'bot:test',connection())
            driver.connection.execute("INSERT INTO trades VALUES(1,'event:1',1,1,'7','BUY',100.000001,'2026-01-01T11:59:59.000001Z','2026-01-01T12:00:00.000001Z')")
            driver.commit([1]);self.assertEqual(f.status()['outstanding'],1)
            f=open_fence();f.recover(reader);self.assertEqual(f.status()['committed'],1)
            now[0]='2026-01-02T00:00:00.000001Z';f.close_epoch()
            for worker in b['expectedWorkers']: f._ack(worker)
            self.assertIsNotNone(f.complete())
            adapter=F.C.SQLAdapter(reader,'postgres',checkpoint=True);f.freeze(adapter)
            d=F.FencedDrain(Path(directory)/'drain',f,adapter,read_clock=lambda:now[0]);drains.append(d)
            self.assertEqual(d.step()['counts']['PENDING'],1)
            admin.execute("BEGIN; INSERT INTO signals VALUES(1,'event:1'); INSERT INTO paper_orders VALUES(1,1,'2026-01-03T00:01:00.000001Z',NULL); INSERT INTO decision_log(actor,action,context) VALUES('bot','paper_order_executed','{\"signal_id\":1,\"source_trade_id\":\"event:1\"}'::jsonb); COMMIT")
            now[0]='2026-01-03T00:02:00Z';self.assertTrue(d.step()['comparisonEligible']);d.close()
            d=F.FencedDrain(Path(directory)/'drain',f,adapter,read_clock=lambda:now[0]);drains.append(d)
            handoff=Path(directory)/'handoff';d.write_seal_journals(handoff)
            (handoff/'authority.json').write_text(A.canonical(a));(handoff/'pin').write_text(A.digest(a))
            result=subprocess.run(['node','--import','tsx',str(N.ROOT/'tests/poly2_authority_native_e2e.ts'),str(handoff)],cwd=N.ROOT,capture_output=True,text=True)
            self.assertEqual(result.returncode,0,result.stdout+result.stderr)
            print('NATIVE_OBSERVATIONAL '+result.stdout.strip())

if __name__=='__main__': unittest.main()
