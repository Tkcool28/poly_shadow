"""Deterministic synthetic authority history; no source DB/provider/deployment."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import tempfile
import tracemalloc
import unittest

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('bounded_fence_test', ROOT/'scripts/poly2-comparison-fence.py')
assert SPEC and SPEC.loader
F = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(F)
START, END = '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'
BINDING = dict(runId='bounded', shadowRunId='shadow', poly2CodeSha='a'*40, componentSha256='b'*64,
    cohort=['0x'+c*40 for c in 'abcde'], window=dict(startUtc=START,endUtc=END),
    evidenceKind='synthetic', sourcePublicKey=None, expectedWorkers=['bot:runtime-A','backend:runtime-B'])


def journal_hash(events):
    h = hashlib.sha256(b'[')
    for i, event in enumerate(events):
        h.update((',' if i else '').encode())
        h.update(F.canonical(event).encode())
    return h.update(b']') or h.hexdigest()


class BoundedHistoryTests(unittest.TestCase):
    def test_large_retry_postend_history_restart_early_pending_counts_and_conflicts(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            now = START
            f = F.Fence(directory, BINDING, read_clock=lambda:now)
            f.enroll('bot:runtime-A'); f.enroll('backend:runtime-B')
            tracemalloc.start()
            with f.transaction():
                for i in range(151):
                    f._append('ATTEMPT', dict(transactionId=f'early:{i:04}',worker='bot:runtime-A',epoch=0,retryOf=None))
                previous = None
                for i in range(1000):
                    token=f'retry:{i:06}'
                    f._append('ATTEMPT',dict(transactionId=token,worker='bot:runtime-A',epoch=0,retryOf=previous))
                    f._append('ROLLED_BACK',dict(transactionId=token))
                    previous=token
                small = tracemalloc.get_traced_memory()[0]
                for i in range(1000,20000):
                    token=f'retry:{i:06}'
                    f._append('ATTEMPT',dict(transactionId=token,worker='bot:runtime-A',epoch=0,retryOf=previous))
                    f._append('ROLLED_BACK',dict(transactionId=token))
                    previous=token
            now='2026-01-02T00:00:00.000001Z'
            f.close_epoch(); f._ack('bot:runtime-A'); f._ack('backend:runtime-B')
            with f.transaction():
                for i in range(10000):
                    token=f'postend:{i:06}'
                    f._append('ATTEMPT',dict(transactionId=token,worker='bot:runtime-A',epoch=1,retryOf=None))
                    witness=dict(transactionId=token,bindingSha256=F.digest(BINDING),worker='bot:runtime-A',epoch=1,trades=[])
                    f._append('COMMITTED',dict(transactionId=token,witness=witness))
            current, peak = tracemalloc.get_traced_memory()
            tracemalloc.stop()
            self.assertLess(current-small, 2*1024*1024)
            self.assertLess(peak, 8*1024*1024)
            h = journal_hash(f.events())
            self.assertEqual(len(f.events()),60157)
            self.assertEqual(len(f.state()['attempts']),30151)
            status=f.status()
            self.assertEqual((status['admitted'],status['rolledBack'],status['outstanding']),(20151,20000,151))
            self.assertEqual(len(status['blockingTransactions']),100)
            self.assertTrue(status['blockingTransactionsTruncated'])
            self.assertEqual(status['pendingOldestUtc'], START)
            seen=[]; after=None
            while page:=f.pending_transactions(after=after,limit=37):
                seen.extend(x['transactionId'] for x in page); after=page[-1]['transactionId']
            self.assertEqual(seen,[f'early:{i:04}' for i in range(151)])
            self.assertIsNone(f.complete())
            f.close()
            tracemalloc.start()
            f=F.Fence(directory,BINDING,read_clock=lambda:now)
            restart_peak=tracemalloc.get_traced_memory()[1];tracemalloc.stop()
            self.assertLess(restart_peak,8*1024*1024)
            self.assertEqual(journal_hash(f.events()),h)
            self.assertEqual(f.status(),status)
            with self.assertRaisesRegex(ValueError,'retry requires confirmed rollback'):
                f._admit('bot:runtime-A',retry_of='early:0000')
            self.assertEqual(journal_hash(f.events()),h)
            self.assertEqual(f.status(),status)
            # Cross-connection incremental replay must retain early outstanding IDs.
            second=F.Fence(directory,BINDING,read_clock=lambda:now)
            with second.transaction(): second._append('ROLLED_BACK',dict(transactionId='early:0000'))
            self.assertEqual(f.status()['outstanding'],150)
            second.close();f.close()
            print(json.dumps(dict(case='large_fence',events=60157,attempts=30151,
                currentBytes=current,peakBytes=peak,restartPeakBytes=restart_peak,journalSha256=h)))

    def test_large_drain_history_early_decision_pending_exact_restart_and_page_counts(self):
        facts=[]
        for i in range(151):
            facts.append(dict(sourceRecordId=i,sourceEventId=f'event:{i:04}',wallet=BINDING['cohort'][0],
                asset='7',conditionId='condition',side='BUY',size=1,sourceTs=None,
                tradedAtUtc=None,ingestedUtc=START))
        class Adapter:
            dialect='sqlite'
            decisions=[]
            def scan(self,binding,frozen_ids=None): return facts,self.decisions
        adapter=Adapter()
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            d=F.D.FrozenDrain(directory,BINDING,adapter,read_clock=lambda:END)
            tracemalloc.start()
            for _ in range(400): d.step()
            peak=tracemalloc.get_traced_memory()[1];tracemalloc.stop()
            self.assertLess(peak,8*1024*1024)
            status=d.status();h=journal_hash(d.frames)
            self.assertEqual(status['blockingCount'],151)
            self.assertEqual(len(status['blockingIds']),100)
            self.assertTrue(status['blockingIdsTruncated'])
            self.assertEqual(d.pending_ids(after='event:0099',limit=100),[f'event:{i:04}' for i in range(100,151)])
            d.close()
            tracemalloc.start();d=F.D.FrozenDrain(directory,BINDING,adapter,read_clock=lambda:END)
            restart_peak=tracemalloc.get_traced_memory()[1];tracemalloc.stop()
            self.assertLess(restart_peak,8*1024*1024)
            self.assertEqual(d.status(),status);self.assertEqual(journal_hash(d.frames),h)
            adapter.decisions=[dict(sourceEventId=t['sourceEventId'],paperRecordId=t['sourceRecordId'],
                sourceIngestedUtc=t['ingestedUtc'],decisionUtc='2026-01-03T00:00:00.000001Z',rejectionReason=None) for t in facts]
            terminal=d.step()
            self.assertEqual(terminal['sourceFacts'],facts)
            self.assertEqual(terminal['counts']['DECISION_RECORDED'],151)
            self.assertEqual(terminal['counts']['PENDING'],0)
            self.assertEqual(d.step(),terminal)
            d.close()
            print(json.dumps(dict(case='large_drain',frames=401,peakBytes=peak,restartPeakBytes=restart_peak,journalSha256=h)))

    def test_corrupt_authority_and_torn_tail_refused_not_repaired(self):
        with tempfile.TemporaryDirectory(dir=os.environ['TMPDIR']) as directory:
            f=F.Fence(directory,BINDING,read_clock=lambda:START);f.enroll('bot:runtime-A')
            f.db.execute("UPDATE events SET body=json_set(body,'$.previousSha256','corrupt') WHERE seq=2")
            f.close()
            with self.assertRaisesRegex(ValueError,'chain/binding'):
                F.Fence(directory,BINDING,read_clock=lambda:START)
            path=Path(directory)/'poly2_drain_receipts.ndjson';path.write_bytes(b'{')
            class Adapter: dialect='sqlite'
            with self.assertRaisesRegex(ValueError,'torn'):
                F.D.FrozenDrain(directory,BINDING,Adapter(),read_clock=lambda:END)
            self.assertEqual(path.read_bytes(),b'{')


if __name__ == '__main__': unittest.main()
