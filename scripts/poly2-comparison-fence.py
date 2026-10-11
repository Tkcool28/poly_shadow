"""Locally authored, opt-in DB-API source boundary; never installed in Poly2.

The driver, not caller callbacks, performs commit/rollback. A receipt inserted in
its source transaction is the commit witness. Receipt failure uses a SAVEPOINT
and is fail-contained: trading continues, experimental closure fails. Missing
witnesses remain UNKNOWN (absence never means rollback). All durable state is a
hash-chained SQLite event journal serialized across processes by BEGIN IMMEDIATE.
No service, DSN, production path, timer, enrollment or signing-key defaults.
"""
import importlib.util
import json
import os
import re
from pathlib import Path
import sqlite3
import uuid
from typing import Any

_SPEC = importlib.util.spec_from_file_location('fence_checkpoint', Path(__file__).with_name('poly2-comparison-checkpoint.py'))
assert _SPEC is not None and _SPEC.loader is not None
C = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(C)
canonical, digest, epoch = C.canonical, C.digest, C.epoch
_BSPEC = importlib.util.spec_from_file_location('bounded_journal', Path(__file__).with_name('bounded_journal.py'))
assert _BSPEC and _BSPEC.loader
B = importlib.util.module_from_spec(_BSPEC)
_BSPEC.loader.exec_module(B)

WITNESS_SCHEMA = '''CREATE TABLE comparison_transaction_witness (
    transaction_id text PRIMARY KEY, binding_sha256 text NOT NULL,
    payload text NOT NULL, payload_sha256 text NOT NULL
)'''
# Source inspection found comparator-relevant writers only in these two runtime
# services: bot (Trade ingestion + initial PaperOrder decisions) and backend
# (candidate-history Trade bootstrap). Optional labels in a caller-supplied roster
# must not make either source service disappear.
REQUIRED_WRITER_SERVICES = ('backend', 'bot')


def validate_writer_roster(binding):
    workers = binding.get('expectedWorkers') or []
    if (not isinstance(workers, list) or not workers
            or any(not isinstance(worker, str) or not re.fullmatch(r'(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}', worker) for worker in workers)
            or len(set(workers)) != len(workers)):
        raise ValueError('complete bot/backend writer-service inventory required')
    services = {worker.split(':', 1)[0] for worker in workers}
    if services != set(REQUIRED_WRITER_SERVICES):
        raise ValueError('complete bot/backend writer-service inventory required')


def replay(events, binding, state=None, start=1, previous=None):
    """Rebuild authority, including every transition, never trust a status cache."""
    validate_writer_roster(binding)
    if state is None:
        state = dict(epoch=0, closed=None, workers=set(), acks=set(), attempts={},
                     error=None, receipt=None, population=None)
    for index, e in enumerate(events, start):
        if e['seq'] != index or e['previousSha256'] != previous or e['bindingSha256'] != digest(binding):
            raise ValueError('fence journal chain/binding conflict')
        previous = digest(e)
        p, kind = e['payload'], e['kind']
        if index == 1:
            if kind != 'ARM' or p != binding or epoch(e['observedUtc']) > epoch(binding['window']['startUtc']):
                raise ValueError('pre-start ARM with exact binding required')
            continue
        if kind == 'ENROLL':
            if state['closed'] or p['worker'] not in binding['expectedWorkers'] or p['worker'] in state['workers']:
                raise ValueError('unknown/duplicate/late worker incarnation')
            state['workers'].add(p['worker'])
        elif kind == 'ATTEMPT':
            if p['worker'] not in state['workers'] or p['transactionId'] in state['attempts'] or p['epoch'] != state['epoch']:
                raise ValueError('unregistered/duplicate/generation race attempt')
            if p['retryOf'] is not None and state['attempts'].get(p['retryOf'], {}).get('state') != 'ROLLED_BACK':
                raise ValueError('retry requires confirmed rollback; unknown commit is not retryable')
            state['attempts'][p['transactionId']] = dict(p, state='OUTSTANDING', admittedUtc=e['observedUtc'])
        elif kind == 'CLOSE':
            if state['closed'] or p != {'closingEpoch': state['epoch'], 'nextEpoch': state['epoch']+1} or epoch(e['observedUtc']) <= epoch(binding['window']['endUtc']):
                raise ValueError('inclusive endpoint not passed or conflicting close')
            state['closed'] = e
            state['epoch'] += 1
        elif kind == 'ACK':
            if (not state['closed'] or p.get('worker') not in state['workers']
                    or p.get('epoch') != state['epoch']
                    or p != {'worker': p.get('worker'), 'epoch': state['epoch']}):
                raise ValueError('unknown/conflicting ACK')
            # Replaying the same identity/generation acknowledgement is idempotent.
            state['acks'].add(p['worker'])
        elif kind in ('COMMITTED', 'ROLLED_BACK'):
            token = p['transactionId']
            a = state['attempts'].get(token)
            if not a or a['state'] != 'OUTSTANDING':
                raise ValueError('unknown/duplicate/conflicting transaction resolution')
            if kind == 'COMMITTED':
                w = p['witness']
                if w['transactionId'] != token or w['bindingSha256'] != digest(binding) or w['worker'] != a['worker'] or w['epoch'] != a['epoch']:
                    raise ValueError('commit witness identity conflict')
                facts = w['trades']
                if len({t['sourceRecordId'] for t in facts}) != len(facts) or len({t['sourceEventId'] for t in facts}) != len(facts):
                    raise ValueError('duplicate witness facts')
                for t in facts:
                    C.clock(t['ingestedUtc'])
                    if a['epoch'] > 0 and epoch(t['ingestedUtc']) <= epoch(binding['window']['endUtc']):
                        raise ValueError('postepoch original ingestion clock violates admission boundary')
                a['witness'] = w
            a['state'] = kind
            state['attempts'][token] = a
        elif kind == 'ERROR':
            state['error'] = p['error']
        elif kind == 'FENCE':
            if state['receipt'] or state['error'] or state['closed'] is None:
                raise ValueError('invalid fence transition')
            expected = receipt(state, binding)
            if p != expected or expected['outstanding'] or state['acks'] != set(binding['expectedWorkers']):
                raise ValueError('all exact worker ACKs and resolved preepoch work required')
            state['receipt'] = e
        elif kind == 'FREEZE':
            if not state['receipt'] or state['population'] or state['error']:
                raise ValueError('freeze requires completed healthy fence')
            facts = committed_population(state, binding)
            if p['sourceFacts'] != facts or p['sourceFactsSha256'] != digest(facts) or p['frozenIds'] != [t['sourceRecordId'] for t in facts] or p['frozenIdsSha256'] != digest(p['frozenIds']) or p['fenceReceiptSha256'] != digest(state['receipt']):
                raise ValueError('population/witness/count/digest mismatch')
            checkpoint = p['query']['sourceSQLCheckpoint']
            if p['count'] != len(facts) or p['query']['sourceFactsSha256'] != digest(facts) or p['query']['isolation'] != 'REPEATABLE_READ_READ_ONLY' or checkpoint['isolation'] != 'repeatable read' or checkpoint['readOnly'] != 'on' or not checkpoint['snapshot'] or checkpoint['sourceFactsSha256'] != digest(facts) or checkpoint['sourceRecordIds'] != p['frozenIds']:
                raise ValueError('consistent full-window SQL checkpoint required')
            state['population'] = e
        else:
            raise ValueError('unknown fence event')
    if not events:
        raise ValueError('missing ARM')
    return state


def receipt(state, binding):
    counts = dict(OUTSTANDING=0, COMMITTED=0, ROLLED_BACK=0)
    attempts = state['attempts']
    if isinstance(attempts, B.DiskMap):
        for kind, count in attempts.db.execute("SELECT kind,count FROM attempt_counts"):
            counts[kind] = count
    else:
        for a in attempts.values():
            if a['epoch'] == 0:
                counts[a['state']] += 1
    return dict(protocol='source-epoch-inflight-v1', runId=binding['runId'],
                endpointUtc=binding['window']['endUtc'], closingEpoch=0,
                requiredWriterServices=list(REQUIRED_WRITER_SERVICES),
                expectedWorkers=sorted(binding['expectedWorkers']), acknowledgements=sorted(state['acks']),
                admitted=sum(counts.values()), committed=counts['COMMITTED'],
                rolledBack=counts['ROLLED_BACK'], outstanding=counts['OUTSTANDING'],
                highWaterMark=state['closed']['seq'] if state['closed'] else None)


def committed_population(state, binding):
    facts = {}
    for a in state['attempts'].values():
        if a['state'] != 'COMMITTED':
            continue
        for t in a['witness']['trades']:
            if t['wallet'] not in binding['cohort'] or not C.in_window(t['ingestedUtc'], binding['window']):
                continue
            key = t['sourceRecordId']
            if key in facts:
                raise ValueError('source stable ID belongs to multiple committed attempts')
            facts[key] = t
    # Bytewise canonical identity ordering is shared with the offline validator.
    return sorted(facts.values(), key=lambda t: canonical(t['sourceRecordId']))


class Fence:
    def __init__(self, directory, binding, *, read_clock=C.now):
        if len(binding['cohort']) != 5 or len(set(binding['cohort'])) != 5:
            raise ValueError('exact five-wallet cohort required')
        validate_writer_roster(binding)
        if binding['evidenceKind'] != 'synthetic':
            raise ValueError('UNINSTALLED: independent production enrollment/custody review required')
        self.directory, self.binding, self.clock = Path(directory), binding, read_clock
        self.directory.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.directory/'source_fence.sqlite', timeout=10, isolation_level=None)
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.execute('CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY, body TEXT NOT NULL)')
        self.local_error = None
        self.db.execute('PRAGMA temp_store=FILE')
        self.db.execute('PRAGMA temp.cache_size=-2048')
        try:
            with self.transaction():
                if not self.events():
                    event = dict(seq=1, previousSha256=None, bindingSha256=digest(binding), observedUtc=self.clock(), kind='ARM', payload=binding)
                    replay([event], binding)
                    self.db.execute('INSERT INTO events VALUES(?,?)', (1, canonical(event)))
                self.db.execute('CREATE TEMP TABLE attempt_index(id TEXT PRIMARY KEY, body TEXT NOT NULL)')
                self.db.execute("CREATE INDEX temp.attempt_state ON attempt_index(json_extract(body,'$.epoch'),json_extract(body,'$.state'),id)")
                self.db.execute('CREATE TEMP TABLE attempt_counts(kind TEXT PRIMARY KEY, count INTEGER NOT NULL)')
                self.db.executemany('INSERT INTO attempt_counts VALUES(?,0)', [(k,) for k in ('OUTSTANDING','COMMITTED','ROLLED_BACK')])
                self.db.execute("CREATE TEMP TRIGGER attempt_insert AFTER INSERT ON attempt_index WHEN json_extract(new.body,'$.epoch')=0 BEGIN UPDATE attempt_counts SET count=count+1 WHERE kind=json_extract(new.body,'$.state'); END")
                self.db.execute("CREATE TEMP TRIGGER attempt_update AFTER UPDATE ON attempt_index WHEN json_extract(new.body,'$.epoch')=0 BEGIN UPDATE attempt_counts SET count=count-1 WHERE kind=json_extract(old.body,'$.state'); UPDATE attempt_counts SET count=count+1 WHERE kind=json_extract(new.body,'$.state'); END")
                self.db.execute("CREATE TEMP TRIGGER attempt_delete AFTER DELETE ON attempt_index WHEN json_extract(old.body,'$.epoch')=0 BEGIN UPDATE attempt_counts SET count=count-1 WHERE kind=json_extract(old.body,'$.state'); END")
                self._state = dict(epoch=0, closed=None, workers=set(), acks=set(),
                    attempts=B.DiskMap(self.db), error=None, receipt=None, population=None)
                replay(self.events(), binding, self._state)
                self._indexed_seq = len(self.events())
        except BaseException:
            self.db.close()
            raise

    def transaction(self):
        owner = self
        class Transaction:
            def __enter__(self):
                owner.db.execute('BEGIN IMMEDIATE')
            def __exit__(self, typ, value, trace):
                owner.db.execute('ROLLBACK' if typ else 'COMMIT')
                if typ and hasattr(owner, '_indexed_seq'):
                    owner._rebuild()
                if not typ:
                    try:
                        owner.publish()
                    except Exception:
                        pass  # bounded diagnostic cache is never sealing authority
        return Transaction()

    def events(self):
        return B.DiskSequence(self.db)

    def _rebuild(self):
        self.db.execute('DELETE FROM attempt_index')
        self._state = dict(epoch=0, closed=None, workers=set(), acks=set(),
            attempts=B.DiskMap(self.db), error=None, receipt=None, population=None)
        replay(self.events(), self.binding, self._state)
        self._indexed_seq = len(self.events())

    def state(self):
        # Cross-process writers: consume every new authoritative event, never a tail.
        for row in self.db.execute('SELECT body FROM events WHERE seq>? ORDER BY seq', (self._indexed_seq,)):
            event = json.loads(row[0])
            previous = digest(self.events()[event['seq']-2]) if event['seq'] > 1 else None
            replay([event], self.binding, self._state, event['seq'], previous)
            self._indexed_seq = event['seq']
        return self._state

    def _append(self, kind, payload):
        events = self.events()
        event = dict(seq=len(events)+1, previousSha256=digest(events[-1]) if events else None,
                     bindingSha256=digest(self.binding), observedUtc=self.clock(), kind=kind, payload=payload)
        state = self.state()
        replay([event], self.binding, state, event['seq'], event['previousSha256'])
        self.db.execute('INSERT INTO events VALUES(?,?)', (event['seq'], canonical(event)))
        self._indexed_seq = event['seq']
        return event

    def publish(self):
        # Diagnostics only. Readback always rebuilds the SQLite journal.
        value = dict(version=1, binding=self.binding, bindingSha256=digest(self.binding), window=self.binding['window'], **self.status())
        path = self.directory/'poly2_fence_health.json'
        temp = path.with_suffix('.pending')
        with temp.open('wb') as stream:
            stream.write(canonical(value).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)

    def error(self, exc):
        self.local_error = str(exc)
        try:
            with self.transaction():
                self._append('ERROR', {'error': str(exc)})
        except Exception:
            pass  # no receipt/terminal outcome can be fabricated after sink loss

    def enroll(self, worker):
        with self.transaction():
            if worker in self.state()['workers']:
                return  # exact reattachment; never erases death/outstanding state
            self._append('ENROLL', {'worker': worker})

    def _admit(self, worker, retry_of=None):
        with self.transaction():
            token = str(uuid.uuid4())
            s = self.state()
            self._append('ATTEMPT', dict(transactionId=token, worker=worker, epoch=s['epoch'], retryOf=retry_of))
            return token

    def close_epoch(self):
        with self.transaction():
            s = self.state()
            if s['closed']:
                return s['closed']
            return self._append('CLOSE', dict(closingEpoch=s['epoch'], nextEpoch=s['epoch']+1))

    def _ack(self, worker):
        with self.transaction():
            s = self.state()
            if worker in s['acks']:
                return
            self._append('ACK', dict(worker=worker, epoch=s['epoch']))

    def recover(self, reader):
        """Only an actually visible transactional DB witness resolves a commit."""
        self.state()
        # Stable keyset pages avoid an open SELECT while resolutions update index.
        after = ''
        while True:
            row = self.db.execute("SELECT id,body FROM attempt_index WHERE id>? AND json_extract(body,'$.state')='OUTSTANDING' ORDER BY id LIMIT 1", (after,)).fetchone()
            if row is None:
                break
            token, attempt = row[0], json.loads(row[1])
            after = token
            c = reader.cursor()
            try:
                c.execute('SELECT payload, payload_sha256 FROM comparison_transaction_witness WHERE transaction_id=%s AND binding_sha256=%s', (token, digest(self.binding)))
                rows = c.fetchall()
            finally:
                c.close()
            if not rows:
                continue  # rollback/crash/death/unknown are NOT inferred from absence
            if len(rows) != 1 or digest(json.loads(rows[0][0])) != rows[0][1]:
                self.error('corrupt commit witness')
                raise ValueError('corrupt commit witness')
            witness = json.loads(rows[0][0])
            try:
                with self.transaction():
                    current = self.state()['attempts'][token]
                    if current['state'] == 'OUTSTANDING':
                        self._append('COMMITTED', dict(transactionId=token, witness=witness))
                    elif current.get('witness') != witness:
                        raise ValueError('conflicting witness recovery')
            except Exception as exc:
                self.error(exc)
                raise

    def complete(self):
        with self.transaction():
            s = self.state()
            if self.local_error or s['error']:
                raise ValueError('experimental sink/source failed; no fence')
            if s['receipt']:
                return s['receipt']
            r = receipt(s, self.binding)
            if not s['closed'] or r['outstanding'] or s['acks'] != set(self.binding['expectedWorkers']):
                return None
            return self._append('FENCE', r)

    def freeze(self, adapter):
        s = self.state()
        if not s['receipt'] or s['error'] or self.local_error:
            raise ValueError('completed authoritative fence required before population query')
        if s['population']:
            return s['population']
        trades, _ = adapter.scan(self.binding)
        facts = sorted(trades, key=lambda t: canonical(t['sourceRecordId']))
        if not adapter.last_checkpoint:
            raise ValueError('native consistency SQL checkpoint required')
        if facts != committed_population(s, self.binding):
            self.error('committed full-window checkpoint differs from admitted source witnesses')
            raise ValueError('unregistered/invisible/changed source population')
        ids = [t['sourceRecordId'] for t in facts]
        with self.transaction():
            return self._append('FREEZE', dict(sourceFacts=facts, sourceFactsSha256=digest(facts), frozenIds=ids,
                frozenIdsSha256=digest(ids), count=len(ids), fenceReceiptSha256=digest(s['receipt']),
                query=dict(observedUtc=self.clock(), isolation='REPEATABLE_READ_READ_ONLY', sourceFactsSha256=digest(facts), sourceSQLCheckpoint=adapter.last_checkpoint)))

    def status(self):
        s = self.state()
        outstanding = self.pending_transactions(limit=100)
        oldest = None
        for row in self.db.execute("SELECT body FROM attempt_index WHERE json_extract(body,'$.epoch')=0 AND json_extract(body,'$.state')='OUTSTANDING'"):
            a = json.loads(row[0])
            if oldest is None or epoch(a['admittedUtc']) < epoch(oldest):
                oldest = a['admittedUtc']
        return dict(state='FAILED' if self.local_error or s['error'] else 'FROZEN' if s['population'] else 'COMPLETE' if s['receipt'] else 'DRAINING' if s['closed'] else 'ACTIVE',
                    **receipt(s, self.binding), blockingTransactions=outstanding,
                    missingAcknowledgements=sorted(set(self.binding['expectedWorkers'])-s['acks']),
                    blockingTransactionsTruncated=receipt(s, self.binding)['outstanding'] > len(outstanding),
                    pendingOldestUtc=oldest,
                    lastError=self.local_error or s['error'],
                    lastQueryUtc=s['population']['payload']['query']['observedUtc'] if s['population'] else None)

    def pending_transactions(self, *, after=None, limit=100):
        if not 1 <= limit <= 1000:
            raise ValueError('page limit must be 1..1000')
        self.state()
        result = []
        for key, body in self.db.execute("SELECT id,body FROM attempt_index WHERE id>? AND json_extract(body,'$.epoch')=0 AND json_extract(body,'$.state')='OUTSTANDING' ORDER BY id LIMIT ?", (after or '', limit)):
            a = json.loads(body)
            result.append(dict(transactionId=key, worker=a['worker'], admittedUtc=a['admittedUtc']))
        return result

    def close(self):
        self.db.close()


class TransactionDriver:
    """Executable integration seam. Owns real DB transaction terminal operations.

    Construct before any Trade flush/autoflush; all canonical writer entry points
    use one driver per outer transaction, NOT per SAVEPOINT. Caller executes its
    unchanged source SQL/ORM writes, supplying inserted IDs only for source reads.
    No caller committed/rolled_back Boolean/certificate exists. PostgreSQL-only.
    """
    def __init__(self, fence, worker, connection, *, retry_of=None):
        self.fence, self.worker, self.connection = fence, worker, connection
        self.token, self.finished = None, False
        try:
            self.token = fence._admit(worker, retry_of)
        except Exception as exc:
            fence.error(exc)
        # Source availability does not depend on experimental admission success.
        self.connection.cursor().execute('BEGIN')

    def _witness(self, inserted_ids):
        if self.token is None or self.fence.local_error or self.fence.state()['error']:
            return
        c = self.connection.cursor()
        c.execute('SAVEPOINT comparison_observation')
        try:
            ids = list(inserted_ids)
            if len(set(ids)) != len(ids):
                raise ValueError('duplicate inserted stable IDs')
            a = self.fence.state()['attempts'][self.token]
            predicate = 't.id IN ('+','.join(['%s']*len(ids))+')' if ids else '1=0'
            c.execute('SELECT t.id, t.polymarket_trade_id, w.address, t.asset_id, m.condition_id, t.side, t.size, t.traded_at, t.ingested_at FROM trades t JOIN wallets w ON w.id=t.wallet_id JOIN markets m ON m.id=t.market_id WHERE '+predicate+' ORDER BY t.id', ids)
            trades = []
            for ident,event,wallet,asset,condition,side,size,source,ingest in c.fetchall():
                source, ingest = C.clock(source), C.clock(ingest)
                t = dict(sourceRecordId=ident, sourceEventId=event, wallet=wallet, asset=asset, conditionId=condition,
                         side=side, size=float(size), originalSize=str(size), sourceTs=epoch(source)/1000000 if source else None,
                         tradedAtUtc=source, ingestedUtc=ingest)
                t['clockEvidence'] = C.clock_evidence(t, ['ingestedUtc','tradedAtUtc'])
                trades.append(t)
            if len(trades) != len(ids):
                raise ValueError('missing inserted IDs')
            w = dict(transactionId=self.token, bindingSha256=digest(self.fence.binding), worker=self.worker, epoch=a['epoch'], trades=trades)
            c.execute('INSERT INTO comparison_transaction_witness VALUES(%s,%s,%s,%s)', (self.token,digest(self.fence.binding),canonical(w),digest(w)))
            c.execute('RELEASE SAVEPOINT comparison_observation')
        except Exception as exc:
            c.execute('ROLLBACK TO SAVEPOINT comparison_observation')
            c.execute('RELEASE SAVEPOINT comparison_observation')
            self.fence.error(exc)
        finally:
            c.close()

    def commit(self, inserted_ids=()):
        if self.finished:
            raise ValueError('transaction already finished')
        try:
            self._witness(inserted_ids)
        except Exception as exc:
            self.fence.error(exc)
        self.connection.commit()  # actual source operation; ambiguity stays outstanding
        self.finished = True  # witness replay is separate; crash here is recoverable

    def rollback(self):
        if self.finished:
            raise ValueError('transaction already finished')
        self.connection.rollback()  # confirmed real source rollback, not callback
        self.finished = True
        if self.token is not None:
            try:
                with self.fence.transaction():
                    self.fence._append('ROLLED_BACK', {'transactionId': self.token})
            except Exception as exc:
                self.fence.error(exc)

    def acknowledge_epoch(self):
        # The same driver's future admissions use the shared serialized generation.
        # ACK does not claim transaction completion; old work remains outstanding.
        try:
            self.fence._ack(self.worker)
        except Exception as exc:
            self.fence.error(exc)
"""
Production installation intentionally absent. AsyncSession integration must call
admission before begin_nested (which autoflushes), witness before outer commit,
confirmed rollback only after awaited rollback, and ACK from each actual worker.
This DB-API driver exercises that lifecycle locally without importing Poly2.
"""

_D_SPEC = importlib.util.spec_from_file_location('fenced_decision_drain', Path(__file__).with_name('poly2-comparison-drain.py'))
assert _D_SPEC is not None and _D_SPEC.loader is not None
D = importlib.util.module_from_spec(_D_SPEC)
_D_SPEC.loader.exec_module(D)


class FencedDrain(D.FrozenDrain):
    def __init__(self, directory, fence, adapter, *, read_clock=C.now):
        self.fence = fence
        s = fence.state()
        if s['error'] or not s['population'] or fence.local_error:
            raise ValueError('completed fence and population freeze required')
        population = s['population']['payload']
        fixed_ids = population['frozenIds']
        class FixedAdapter:
            dialect = adapter.dialect
            def scan(self, binding, frozen_ids=None):
                if frozen_ids is not None and frozen_ids != fixed_ids:
                    raise ValueError('drain cannot change frozen population')
                trades, decisions = adapter.scan(binding, frozen_ids=fixed_ids)
                trades.sort(key=lambda t: canonical(t['sourceRecordId']))
                order = {t['sourceEventId']: i for i,t in enumerate(trades)}
                decisions.sort(key=lambda d: order[d['sourceEventId']])
                self.last_checkpoint = adapter.last_checkpoint
                return trades, decisions
        super().__init__(directory, fence.binding, FixedAdapter(), read_clock=read_clock)

    def _population_proof(self, source_facts):
        s = self.fence.state()  # replay durable events, not cached flags/certificate
        if s['error'] or self.fence.local_error or not s['population'] or source_facts != s['population']['payload']['sourceFacts']:
            raise ValueError('fenced population proof unavailable/conflicting')
        return True, None

    def write_seal_journals(self, directory):
        """File-oriented offline handoff; legacy seal_input is explicitly in-memory.

        Refuse observational mode just as Fence does. This exports synthetic
        protocol evidence only, never an independently authenticated install seal.
        """
        s = self.fence.state()
        if s['error'] or self.fence.local_error or not self.frames or self.frames[-1]['state'] != 'COMPLETE' or not self.frames[-1]['comparisonEligible']:
            raise ValueError('pending/error decision drain cannot seal')
        self._validate_terminal()
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=False)
        def write(name, values):
            path = directory/name
            with path.open('xb') as stream:
                for value in values:
                    stream.write((canonical(value)+'\n').encode())
                stream.flush()
                os.fsync(stream.fileno())
            return str(path)
        binding_path = write('binding.json', [self.binding])
        fence_path = write('fence.ndjson', self.fence.events())
        drain_path = write('drain.ndjson', self.frames)
        fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        return dict(bindingPath=binding_path, fencePath=fence_path, drainPath=drain_path)

    def seal_input(self):
        s = self.fence.state()
        if s['error'] or self.fence.local_error or not self.frames or self.frames[-1]['state'] != 'COMPLETE' or not self.frames[-1]['comparisonEligible']:
            raise ValueError('pending/error decision drain cannot seal')
        self._validate_terminal()
        return dict(binding=self.binding, fenceJournal=list(self.fence.events()), drainJournal=list(self.frames))  # legacy in-memory artifact API

    def _validate_terminal(self):
        # Revalidate every receipt against current fence authority and original facts.
        original = self.frames
        self.frames = []
        try:
            for frame in original:
                self._validation_cursor = frame['cursor']-1
                self._validate(frame)
                self.frames = [frame]  # validation needs only previous; cursor supplied separately
        finally:
            self.frames = original
            self._validation_cursor = None
