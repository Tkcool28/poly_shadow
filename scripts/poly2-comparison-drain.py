"""Persistent frozen-ID decision drain; explicit adapter only, never a trading hook.

No observed status/approval/time is a no-decision authority. The actual writer
has no admission fence: decision completeness is NOT population completeness.
This implementation records the missing property rather than minting closure.
"""
import base64
import fcntl
import hashlib
import importlib.util
import json
import os
import sqlite3
import tempfile
from pathlib import Path

SPEC = importlib.util.spec_from_file_location('drain_checkpoint', Path(__file__).with_name('poly2-comparison-checkpoint.py'))
assert SPEC is not None and SPEC.loader is not None
CHECKPOINT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CHECKPOINT)
canonical, digest, epoch = CHECKPOINT.canonical, CHECKPOINT.digest, CHECKPOINT.epoch
_BSPEC = importlib.util.spec_from_file_location('bounded_journal', Path(__file__).with_name('bounded_journal.py'))
assert _BSPEC and _BSPEC.loader
B = importlib.util.module_from_spec(_BSPEC)
_BSPEC.loader.exec_module(B)
COUNTS = ('DECISION_RECORDED', 'NO_INITIAL_DECISION_EXPECTED', 'PENDING', 'CAPTURE_ERROR')
MISSING = 'AT_END_SOURCE_ADMISSION_BARRIER_UNPROVEN'


class FrozenDrain:
    def __init__(self, directory, binding, adapter, *, read_clock=CHECKPOINT.now, signer=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.path = self.directory / 'poly2_drain_receipts.ndjson'
        self.health_path = self.directory / 'poly2_drain_health.json'
        self.owner = open(self.directory / 'drain-owner.lock', 'a+b')
        fd, self.index_path = tempfile.mkstemp(prefix='drain-derived-', suffix='.sqlite', dir=self.directory)
        os.close(fd)
        self.index = sqlite3.connect(self.index_path, isolation_level=None)
        self.index.execute('PRAGMA cache_size=-2048')
        self.index.execute('PRAGMA synchronous=OFF')
        self.index.execute('PRAGMA journal_mode=MEMORY')
        self.frames = B.JournalSequence(self.index, self.path, canonical)
        self._validation_cursor = None
        self.binding, self.adapter, self.read_clock, self.signer = binding, adapter, read_clock, signer
        self.latched = False
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if binding['evidenceKind'] == 'observational' and signer is None:
                raise ValueError('observational custody signer required')
            if self.path.exists():
                with self.path.open('rb') as stream:
                    for line in stream:
                        if not line.endswith(b'\n'):
                            raise ValueError('torn drain authority preserved')
                        frame = json.loads(line)
                        self._validate(frame)
                        self.frames.append(frame, raw=line)
            self._publish()
        except BaseException:
            self.close()
            raise

    def _validate(self, frame):
        if frame['bindingSha256'] != digest(self.binding) or frame['cursor'] != (self._validation_cursor if self._validation_cursor is not None else len(self.frames))+1 or frame['previousSha256'] != (digest(self.frames[-1]) if self.frames else None):
            raise ValueError('drain binding/chain conflict')
        unsigned = {k: v for k, v in frame.items() if k not in ('signature', 'signedPayload')}
        if self.signer:
            if frame['signedPayload'] != canonical(unsigned):
                raise ValueError('drain signed payload conflict')
            self.signer.public_key().verify(base64.b64decode(frame['signature']), frame['signedPayload'].encode())
        elif frame['signature'] is not None:
            raise ValueError('synthetic drain signature forbidden')
        if frame['frozenIdsSha256'] != digest(frame['frozenIds']) or frame['sourceFactsSha256'] != digest(frame['sourceFacts']):
            raise ValueError('drain source-fact digest conflict')
        ids = [f['sourceRecordId'] for f in frame['sourceFacts']]
        events = [f['sourceEventId'] for f in frame['sourceFacts']]
        if ids != frame['frozenIds'] or len(set(ids)) != len(ids) or len(set(events)) != len(events):
            raise ValueError('drain population identity conflict')
        if set(frame['perId']) != set(events) or any(v['state'] not in COUNTS for v in frame['perId'].values()):
            raise ValueError('drain exact per-ID map required')
        counts = {s: sum(v['state'] == s for v in frame['perId'].values()) for s in COUNTS}
        if counts != frame['counts'] or sum(counts.values()) != len(ids) or frame['perIdSha256'] != digest(frame['perId']):
            raise ValueError('drain completeness equation/digest conflict')
        for event, terminal in frame['perId'].items():
            if terminal['state'] == 'NO_INITIAL_DECISION_EXPECTED':
                raise ValueError('actual source has no proven terminal no-decision path')
            d = terminal['decision']
            if terminal['state'] == 'DECISION_RECORDED' and (not d or d['sourceEventId'] != event or d['decisionUtc'] is None):
                raise ValueError('decision fact required')
        complete = counts['PENDING'] == counts['CAPTURE_ERROR'] == 0
        if frame['state'] != ('FAILED' if frame['error'] else 'COMPLETE' if complete else 'DRAINING'):
            raise ValueError('drain state/equation conflict')
        eligible, missing = self._population_proof(frame['sourceFacts'])
        if frame['comparisonEligible'] != (eligible and complete and not frame['error']) or frame['incompleteProperty'] != missing:
            raise ValueError('unproven population cannot become comparison eligible')
        if self.frames:
            previous = self.frames[-1]
            if previous['state'] in ('FAILED', 'COMPLETE'):
                raise ValueError('drain terminal transition')
            if frame['frozenIds'] != previous['frozenIds'] or frame['sourceFacts'] != previous['sourceFacts']:
                raise ValueError('frozen population cannot change')
            for event, old in previous['perId'].items():
                if old['state'] == 'DECISION_RECORDED' and frame['perId'][event] != old:
                    raise ValueError('original decision cannot change/disappear')

    def _population_proof(self, source_facts):
        return False, MISSING  # standalone read-only drain cannot prove admission

    def _append(self, source_facts, per_id, query, error=None):
        if error and error != 'SAFETY_TIMEOUT_INCOMPLETE':
            per_id = {k: (dict(state='CAPTURE_ERROR', decision=None) if v['state'] == 'PENDING' else v) for k, v in per_id.items()}
        counts = {s: sum(v['state'] == s for v in per_id.values()) for s in COUNTS}
        frame = dict(version=1, bindingSha256=digest(self.binding), cursor=len(self.frames)+1,
                     previousSha256=digest(self.frames[-1]) if self.frames else None,
                     observedUtc=self.read_clock(), frozenIds=[f['sourceRecordId'] for f in source_facts],
                     sourceFacts=source_facts, sourceFactsSha256=digest(source_facts),
                     perId=per_id, perIdSha256=digest(per_id), counts=counts, error=error,
                     state='FAILED' if error else 'COMPLETE' if counts['PENDING'] == counts['CAPTURE_ERROR'] == 0 else 'DRAINING',
                     query=query, toolSha256=hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
                     comparisonEligible=self._population_proof(source_facts)[0] and counts['PENDING'] == counts['CAPTURE_ERROR'] == 0 and not error,
                     incompleteProperty=self._population_proof(source_facts)[1])
        frame['frozenIdsSha256'] = digest(frame['frozenIds'])
        if self.signer:
            frame['signedPayload'] = canonical(frame)
            frame['signature'] = base64.b64encode(self.signer.sign(frame['signedPayload'].encode())).decode()
        else:
            frame['signature'] = None
        self._validate(frame)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_APPEND | os.O_WRONLY, 0o600)
            try:
                data = memoryview((canonical(frame)+'\n').encode())
                while data:
                    n = os.write(fd, data)
                    if n <= 0:
                        raise OSError('short drain append')
                    data = data[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
            self._sync_directory()
            self.frames.append(frame)
            self._publish()
        except BaseException:
            self.latched = True
            raise
        return frame

    def _sync_directory(self):
        fd = os.open(self.directory, os.O_RDONLY)
        try:
            os.fsync(fd)
        finally:
            os.close(fd)

    def status(self):
        if not self.frames:
            return dict(state='NOT_STARTED', frozenCount=0, counts={s: 0 for s in COUNTS}, pendingOldestUtc=None, latestQueryUtc=None, comparisonEligible=False, incompleteProperty=MISSING)
        f = self.frames[-1]
        pending = [t['ingestedUtc'] for t in f['sourceFacts'] if f['perId'][t['sourceEventId']]['state'] == 'PENDING']
        return dict(state=f['state'], frozenCount=len(f['frozenIds']), counts=f['counts'], pendingOldestUtc=min(pending, key=epoch) if pending else None, latestQueryUtc=f['query']['observedUtc'], comparisonEligible=f['comparisonEligible'], incompleteProperty=f['incompleteProperty'], receiptSha256=digest(f), cursor=f['cursor'], error=f['error'], blockingIds=self.pending_ids(limit=100), blockingCount=f['counts']['PENDING']+f['counts']['CAPTURE_ERROR'], blockingIdsTruncated=f['counts']['PENDING']+f['counts']['CAPTURE_ERROR'] > 100)

    def _publish(self):
        pending = self.health_path.with_suffix('.pending')
        with pending.open('wb') as stream:
            stream.write(canonical(dict(version=1, binding=self.binding, bindingSha256=digest(self.binding), **self.status())).encode())
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pending, self.health_path)
        self._sync_directory()

    def step(self):
        if self.latched:
            raise ValueError('drain sink latched; restart required')
        if self.frames and self.frames[-1]['state'] in ('FAILED', 'COMPLETE'):
            return self.frames[-1]  # exact restart/idempotent terminal readback
        if epoch(self.read_clock()) < epoch(self.binding['window']['endUtc']):
            raise ValueError('at-end freeze cannot precede original inclusive end')
        previous = self.frames[-1] if self.frames else None
        frozen_ids = previous['frozenIds'] if previous else None
        # Query errors are retryable: do not advance a phantom authority cursor.
        trades, decisions = self.adapter.scan(self.binding, frozen_ids=frozen_ids)
        query = dict(observedUtc=self.read_clock(), bindingSha256=digest(self.binding),
                     frozenIds=frozen_ids, tradesSha256=digest(trades), decisionsSha256=digest(decisions),
                     tradeCount=len(trades), decisionCount=len(decisions),
                     isolation='REPEATABLE_READ_READ_ONLY' if self.adapter.dialect == 'postgres' else 'SQLITE_READ_ONLY')
        if getattr(self.adapter, 'last_checkpoint', None):
            query['sourceSQLCheckpoint'] = self.adapter.last_checkpoint
        facts = previous['sourceFacts'] if previous else trades
        per_id = json.loads(canonical(previous['perId'])) if previous else {t['sourceEventId']: dict(state='PENDING', decision=None) for t in facts}
        if previous and trades != facts:
            return self._append(facts, per_id, query, 'SOURCE_INSERTION_RETENTION_OR_IMMUTABILITY_VIOLATED')
        current_decisions = {d['sourceEventId']: d for d in decisions}
        if any(v['decision'] is not None and current_decisions.get(k) != v['decision'] for k, v in per_id.items()):
            return self._append(facts, per_id, query, 'INITIAL_DECISION_RETENTION_OR_CONFLICT')
        for decision in decisions:
            event = decision['sourceEventId']
            if event not in per_id:
                return self._append(facts, per_id, query, 'DECISION_OUTSIDE_FROZEN_SET')
            old = per_id[event]
            if old['decision'] is not None and old['decision'] != decision:
                return self._append(facts, per_id, query, 'INITIAL_DECISION_CONFLICT')
            if decision['decisionUtc'] is not None:
                per_id[event] = dict(state='DECISION_RECORDED', decision=decision)
        return self._append(facts, per_id, query)

    def timeout(self):
        if not self.frames or self.frames[-1]['state'] != 'DRAINING':
            raise ValueError('only an active pending drain can time out')
        f = self.frames[-1]
        return self._append(f['sourceFacts'], f['perId'], f['query'], 'SAFETY_TIMEOUT_INCOMPLETE')

    def pending_ids(self, *, after=None, limit=100):
        if not 1 <= limit <= 1000:
            raise ValueError('page limit must be 1..1000')
        if not self.frames:
            return []
        per_id = self.frames[-1]['perId']
        import heapq
        return heapq.nsmallest(limit, (k for k in per_id if (after is None or k > after) and per_id[k]['state'] in ('PENDING', 'CAPTURE_ERROR')))

    def close(self):
        self.owner.close()
        self.index.close()
        Path(self.index_path).unlink(missing_ok=True)
