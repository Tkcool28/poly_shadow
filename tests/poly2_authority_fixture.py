"""Disposable public-authority observational lifecycle; never real evidence.
The adapter is a deterministic SQL-checkpoint seam, native coverage is separate.
"""
import json
import sys
from pathlib import Path
from poly2_authority_test import A, F, fixture


def produce(directory):
    directory=Path(directory); directory.mkdir(parents=True,exist_ok=True)
    b,a,key=fixture(); now=['2025-12-31T23:30:00Z']
    f=F.Fence(directory/'fence',b,authority=a,authority_pin=A.digest(a),private_key=key,read_clock=lambda:now[0])
    for w in b['expectedWorkers']: f.enroll(w)
    now[0]='2026-01-01T12:00:00Z'
    token=f._admit('bot:test')
    t=dict(sourceRecordId=1,sourceEventId='data-api:0xabc:7:BUY',wallet=b['cohort'][0],asset='7',conditionId='condition',side='BUY',size=100.000001,sourceTs=1767268799.000001,tradedAtUtc='2026-01-01T11:59:59.000001Z',ingestedUtc='2026-01-01T12:00:00.000001Z',originalSize='100.000001')
    t['clockEvidence']=F.C.clock_evidence(t,['ingestedUtc','tradedAtUtc'])
    # Actual DB witness recovery is exercised by the separate native fixture.
    w=dict(transactionId=token,bindingSha256=A.digest(b),worker='bot:test',epoch=0,trades=[t])
    with f.transaction(): f._append('COMMITTED',dict(transactionId=token,witness=w))
    now[0]='2026-01-02T00:00:00.000001Z';f.close_epoch()
    for worker in b['expectedWorkers']: f._ack(worker)
    f.complete()
    dec=dict(sourceEventId=t['sourceEventId'],paperRecordId=1,signalRecordId=1,decisionUtc='2026-01-03T00:00:00.000001Z',rejectionReason=None,sourceIngestedUtc=t['ingestedUtc'],sourceAudit=dict(recordId=1,action='paper_order_executed',createdUtc='2026-01-03T00:00:00.000002Z',context=dict(signal_id=1,source_trade_id=t['sourceEventId'])))
    dec['clockEvidence']=F.C.clock_evidence(dec,['sourceIngestedUtc','decisionUtc'])
    class Adapter:
        dialect='postgres'
        def scan(self,binding,frozen_ids=None):
            predicate='w.address IN ('+','.join(['%s']*5)+') AND t.ingested_at >= %s AND t.ingested_at <= %s'
            params=[*b['cohort'],b['window']['startUtc'],b['window']['endUtc']]
            if frozen_ids is not None:
                predicate+=' AND t.id IN ('+','.join(['%s']*len(frozen_ids))+')';params+=frozen_ids
            decisions=[dec] if frozen_ids is not None else []
            self.last_checkpoint=dict(isolation='repeatable read',readOnly='on',snapshot='1:2:',sourceFactsSha256=A.digest([t]),sourceRecordIds=[1],querySha256=A.digest(dict(predicate=predicate,params=params)),decisionsSha256=A.digest(decisions))
            return [t],decisions
    adapter=Adapter();f.freeze(adapter); now[0]='2026-01-03T00:01:00Z'
    d=F.FencedDrain(directory/'drain',f,adapter,read_clock=lambda:now[0]);d.step();d.close()
    d=F.FencedDrain(directory/'drain',f,adapter,read_clock=lambda:now[0]);d.write_seal_journals(directory/'handoff')
    (directory/'authority.json').write_text(A.canonical(a));(directory/'pin').write_text(A.digest(a))
    vector=dict(value={'😀':1e-7,'é':100.000001,'Z':-0.0,'control':'\n\t','nested':[True,None,'𝄞']},binding=b,record=f.events()[0])
    vector['canonical']=A.canonical(vector['value']);vector['bindingDigest']=A.digest(b)
    vector['signedBytes']=A.signed_bytes(vector['record'],b,a,'fence').decode()
    vector['journalHash']=A.digest(list(f.events()))
    vector['clockMicros']=str(F.epoch(t['ingestedUtc']))
    (directory/'vectors.json').write_text(A.canonical(vector))
    d.close();f.close()

if __name__=='__main__': produce(sys.argv[1])
