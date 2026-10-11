"""Prospective observational source hook. Not installed/imported by Poly2.

No SQL, provider calls, trading branches or configuration mutation. Every public
method is fail-contained; failure latches AT_RISK and cannot authorize a fence.
The embedding driver MUST call begin before a transaction starts, before_commit
immediately before commit, committed after a successful commit response (using
facts detached after flush), and rolled_back after a confirmed rollback.
No post-commit row rereads or hindsight joins are permitted.
"""
import base64
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import types
_CLOCK_PATH = Path(__file__).with_name('exact_clock.py')
_CLOCK = types.ModuleType('comparison_exact_clock')
exec(compile(_CLOCK_PATH.read_bytes(), str(_CLOCK_PATH), 'exec', dont_inherit=True), _CLOCK.__dict__)
epoch_micros, in_window, clock_evidence = _CLOCK.epoch_micros, _CLOCK.in_window, _CLOCK.evidence

import threading
import uuid


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def real_clock():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


def epoch(value):
    return epoch_micros(value)


def original_clock(value):
    """Serialize actual aware persisted clock, never replace it with capture time."""
    if value is None:
        return None
    if isinstance(value, str):
        epoch(value)
        return value
    if value.tzinfo is None:
        raise ValueError('persisted source clock lacks timezone')
    result = value.isoformat().replace('+00:00', 'Z')
    epoch_micros(result)
    return result


def trade_fact(trade, wallet, market):
    """Call after successful flush; detached ingestion joins, no current-row reread."""
    traded_at = original_clock(trade.traded_at)
    fact = {'sourceRecordId': trade.id, 'sourceEventId': trade.polymarket_trade_id,
            'wallet': wallet.address, 'asset': trade.asset_id,
            'conditionId': market.condition_id, 'side': trade.side,
            'size': float(trade.size), 'originalSize': str(trade.size),
            'sourceTs': epoch(traded_at) / 1000000 if traded_at is not None else None,
            'tradedAtUtc': traded_at, 'ingestedUtc': original_clock(trade.ingested_at)}
    fact['clockEvidence'] = clock_evidence(fact, ['ingestedUtc', 'tradedAtUtc'])
    return fact


def decision_fact(order, signal):
    """Initial order insertion only; do not sample later status/outcome mutations."""
    fact = {'sourceEventId': signal.source_trade_id, 'paperRecordId': order.id,
            'decisionUtc': original_clock(order.t2_decided_at),
            'sourceIngestedUtc': original_clock(signal.t1_detected_at),
            'rejectionReason': order.miss_reason}
    fact['clockEvidence'] = clock_evidence(fact, ['sourceIngestedUtc', 'decisionUtc'])
    return fact


class ObservationHook:
    """One explicitly enrolled source driver; independently disabled by default.

    Local durable frames recover completed transactions/positions after a crash;
    pending DB outcomes and production downtime continuity remain unprovable.
    Observational activation is denied until independently authorized source
    transaction recovery and all-writer end-boundary authority exist.
    """
    def __init__(self, directory, binding, *, enabled=False, private_key=None,
                 synthetic_clock=None, append=None):
        self.enabled = enabled
        self.binding = binding
        self.directory = Path(directory)
        self.healthy = True
        self.error = None
        self.cursor = 0
        self.pending = {}
        self._commits = {}
        self.writers = set()
        self.active = False
        self.ended = False
        self._lock = threading.RLock()
        self._owner = None
        self._clock = real_clock
        self._append_override = append
        self._private_key = private_key
        if not enabled:
            return
        try:
            if binding['evidenceKind'] == 'synthetic':
                if synthetic_clock is None or private_key is not None:
                    raise ValueError('synthetic clock required; no impersonated signature')
                self._clock = synthetic_clock
            elif synthetic_clock is not None or private_key is None:
                raise ValueError('observational source requires real clock and signing key')
            self.directory.mkdir(parents=True, exist_ok=True)
            self._owner = open(self.directory / 'source-owner.lock', 'a+b')
            fcntl.flock(self._owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            if (self.directory / 'source_transactions.ndjson').exists():
                self._restore()
            else:
                if (self.directory / 'poly2_source_receipts.ndjson').exists():
                    raise ValueError('orphan source frames without ownership/control authority')
                self._control('OWNER_START', {'bindingSha256': digest(binding)})
        except Exception as exc:
            self._risk(exc)

    def _restore(self):
        """Replay immutable receipts only. Never infer a DB outcome from intent.

        The local source position is the durable frame sequence, not the health
        cache or COMMIT_ACK. A frame is written only after a successful commit
        response; it therefore recovers a crash before the separate control ACK.
        Missing frames cannot be recovered by this observational hook.
        """
        def rows(name):
            path = self.directory / name
            if not path.exists():
                return []
            data = path.read_bytes()
            if data and not data.endswith(b'\n'):
                raise ValueError('torn source journal; preserved, recovery refused')
            return [json.loads(line) for line in data.splitlines()]

        controls = rows('source_transactions.ndjson')
        if not controls or controls[0] != {'kind': 'OWNER_START',
                'observedUtc': controls[0].get('observedUtc'),
                'payload': {'bindingSha256': digest(self.binding)}}:
            raise ValueError('source ownership/binding mismatch')
        ack = {}
        rolled = set()
        stopped = False
        for row in controls[1:]:
            p = row['payload']
            kind = row['kind']
            token = p.get('transactionId')
            if stopped:
                raise ValueError('source control after owner stop')
            if kind == 'REGISTER':
                if p['writer'] not in ('ingestion', 'execution'):
                    raise ValueError('unknown source writer')
                self.writers.add(p['writer'])
            elif kind == 'BEGIN':
                if token in self.pending or p['writer'] not in self.writers:
                    raise ValueError('duplicate/unenrolled transaction')
                self.pending[token] = {'writer': p['writer'], 'before': None}
            elif kind == 'BEFORE_COMMIT':
                if token not in self.pending or self.pending[token]['before'] is not None:
                    raise ValueError('conflicting commit intent')
                self.pending[token]['before'] = p['before']
            elif kind == 'COMMIT_ACK':
                if token not in self.pending or token in ack or token in rolled:
                    raise ValueError('conflicting commit acknowledgement')
                ack[token] = p['cursor']
            elif kind == 'ROLLBACK_ACK':
                if token not in self.pending or token in ack or token in rolled:
                    raise ValueError('conflicting rollback acknowledgement')
                rolled.add(token)
            elif kind == 'OWNER_STOP':
                stopped = True
            else:
                raise ValueError('unknown source control')
        self._commits = {}
        for frame in rows('poly2_source_receipts.ndjson'):
            token = frame['transactionId']
            if (frame['bindingSha256'] != digest(self.binding)
                    or frame['previousCursor'] != self.cursor
                    or frame['cursor'] != self.cursor + 1
                    or frame['version'] != 1):
                raise ValueError('source frame binding/position conflict')
            if self.binding['evidenceKind'] == 'synthetic':
                if frame['signature'] is not None:
                    raise ValueError('synthetic signature forbidden')
            else:
                unsigned = {k: v for k, v in frame.items() if k not in ('signature', 'signedPayload')}
                if frame['signedPayload'] != canonical(unsigned):
                    raise ValueError('source signed payload conflict')
                if self._private_key is None:
                    raise ValueError('missing source recovery verification key')
                self._private_key.public_key().verify(base64.b64decode(frame['signature']), frame['signedPayload'].encode())
            if frame['kind'] == 'ACTIVATION':
                if self.active or self.cursor or self.writers != {'ingestion', 'execution'}:
                    raise ValueError('invalid source activation')
                self.active = True
            elif frame['kind'] == 'COMMIT':
                if (not self.active or self.ended or token not in self.pending
                        or token in rolled or token in self._commits
                        or self.pending[token]['before'] != frame['commitBeforeUtc']
                        or epoch(frame['commitBeforeUtc']) > epoch(frame['commitAfterUtc'])
                        or token in ack and ack[token] != frame['cursor']):
                    raise ValueError('commit frame/control conflict')
                self._commits[token] = frame
            elif frame['kind'] == 'END_FENCE':
                if not self.active or self.ended:
                    raise ValueError('invalid source fence ordering')
                f = frame['fence']
                if (epoch(frame['observedUtc']) < epoch(self.binding['window']['endUtc'])
                        or f != {'protocol': 'all-writers-transaction-drain-v1',
                                 'registeredWriters': sorted(self.writers),
                                 'outstandingTransactions': 0, 'unresolvedFailures': 0,
                                 'throughCursor': self.cursor}):
                    raise ValueError('invalid source fence')
                self.ended = True
            else:
                raise ValueError('unknown source frame')
            self.cursor = frame['cursor']
        if set(ack) - set(self._commits):
            raise ValueError('commit ACK without durable source frame')
        for token in rolled | set(self._commits):
            del self.pending[token]
        if self.pending:
            raise ValueError('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: authoritative transaction recovery missing for pending outcome')
        if stopped and (not self.ended or controls[-1]['payload']['cursor'] != self.cursor):
            raise ValueError('owner stop without durable fence')
        # No callback can prove that other production writers made no commits
        # while this process was absent. Only synthetic fixtures may resume an
        # active stream without independently authoritative all-writer recovery.
        if self.binding['evidenceKind'] != 'synthetic' and not self.ended:
            raise ValueError('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: production restart requires all-writer downtime continuity authority')
        health = self.directory / 'source_capture_health.json'
        if health.exists():
            # A previous latched failure is not erased by replay. Crash fixtures
            # without a health failure can recover only actually durable frames.
            raise ValueError('source failure latch retained; no recovery authorization')

    def _append(self, name, value):
        line = (canonical(value) + '\n').encode()
        path = self.directory / name
        if self._append_override:
            self._append_override(path, line)
        else:
            fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                view = memoryview(line)
                while view:
                    count = os.write(fd, view)
                    if count <= 0:
                        raise OSError('short source append')
                    view = view[count:]
                os.fsync(fd)
            finally:
                os.close(fd)
            parent = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(parent)
            finally:
                os.close(parent)

    def _control(self, kind, payload):
        self._append('source_transactions.ndjson', {'kind': kind, 'observedUtc': self._clock(), 'payload': payload})

    def _risk(self, error):
        self.healthy = False
        self.error = str(error)
        # Best effort diagnostic only; if this independent path is also broken,
        # absent fence/unfinished ownership prevents scientific admissibility.
        try:
            self.directory.mkdir(parents=True, exist_ok=True)
            path = self.directory / 'source_capture_health.json'
            temp = path.with_suffix('.pending')
            with open(temp, 'w') as stream:
                json.dump({'state': 'FAILED', 'quality': 'AT_RISK', 'error': self.error,
                           'cursor': self.cursor, 'pendingTransactions': len(self.pending)}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temp, path)
        except Exception:
            pass

    def _frame(self, kind, transaction_id, *, trades=None, decisions=None,
               before=None, after=None, fence=None):
        if not self.healthy:
            return False
        frame = {'version': 1, 'bindingSha256': digest(self.binding),
                 'cursor': self.cursor + 1, 'previousCursor': self.cursor,
                 'transactionId': transaction_id, 'observedUtc': self._clock(),
                 'kind': kind, 'trades': trades or [], 'decisions': decisions or [],
                 'commitBeforeUtc': before, 'commitAfterUtc': after, 'fence': fence}
        if self.binding['evidenceKind'] == 'synthetic':
            frame['signature'] = None
        else:
            if self._private_key is None:
                raise ValueError('missing source signing key')
            frame['signedPayload'] = canonical(frame)
            frame['signature'] = base64.b64encode(self._private_key.sign(frame['signedPayload'].encode())).decode()
        self._append('poly2_source_receipts.ndjson', frame)
        # Durable source frame BEFORE cursor advancement, never a MAX clock.
        self.cursor = frame['cursor']
        self._last_frame = json.loads(canonical(frame))
        return True

    def register_writer(self, writer):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if not self.healthy or self.active or writer not in ('ingestion', 'execution'):
                    raise ValueError('writer enrollment must precede activation')
                self._control('REGISTER', {'writer': writer})
                self.writers.add(writer)
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def activate(self):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if self.binding['evidenceKind'] != 'synthetic':
                    raise ValueError('POLY2_PROSPECTIVE_CAPTURE_INSUFFICIENT: observational hook lacks authorized all-writer commit recovery and boundary authority')
                if self.active or self.writers != {'ingestion', 'execution'} or epoch(self._clock()) > epoch(self.binding['window']['startUtc']):
                    raise ValueError('both source writers and pre-start activation required')
                if not self._frame('ACTIVATION', 'activation:' + str(uuid.uuid4())):
                    return False
                self.active = True
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def begin(self, writer):
        if not self.enabled:
            return None
        with self._lock:
            try:
                if not self.healthy or not self.active or self.ended or writer not in self.writers:
                    raise ValueError('source capture not active/enrolled')
                token = str(uuid.uuid4())
                self._control('BEGIN', {'transactionId': token, 'writer': writer})
                self.pending[token] = {'writer': writer, 'before': None}
                return token
            except Exception as exc:
                self._risk(exc)
                return None

    def before_commit(self, token):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if not self.healthy or token not in self.pending:
                    raise ValueError('unregistered commit')
                before = self._clock()
                self._control('BEFORE_COMMIT', {'transactionId': token, 'before': before})
                self.pending[token]['before'] = before
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def committed(self, token, *, trades=None, decisions=None):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if not self.healthy:
                    return False
                if token in self._commits:
                    old = self._commits[token]
                    if canonical(old['trades']) != canonical(trades or []) or canonical(old['decisions']) != canonical(decisions or []):
                        raise ValueError('conflicting source transaction replay')
                    return True
                if token not in self.pending or self.pending[token]['before'] is None:
                    raise ValueError('commit without durable begin/before receipt')
                after = self._clock()
                if not self._frame('COMMIT', token, trades=trades, decisions=decisions,
                                   before=self.pending[token]['before'], after=after):
                    return False
                self._commits[token] = self._last_frame
                self._control('COMMIT_ACK', {'transactionId': token, 'cursor': self.cursor})
                del self.pending[token]
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def rolled_back(self, token):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if not self.healthy or token not in self.pending:
                    raise ValueError('rollback without begin')
                self._control('ROLLBACK_ACK', {'transactionId': token})
                del self.pending[token]
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def end_fence(self):
        if not self.enabled:
            return False
        with self._lock:
            try:
                if not self.healthy or not self.active or self.ended or self.pending or epoch(self._clock()) < epoch(self.binding['window']['endUtc']):
                    raise ValueError('end boundary not drained; no end receipt')
                # This receipt proves the coordinator's registered transaction stream,
                # not that all production writer paths were actually enrolled.
                fence = {'protocol': 'all-writers-transaction-drain-v1',
                         'registeredWriters': sorted(self.writers), 'outstandingTransactions': 0,
                         'unresolvedFailures': 0, 'throughCursor': self.cursor}
                if not self._frame('END_FENCE', 'end:' + str(uuid.uuid4()), fence=fence):
                    return False
                self._control('OWNER_STOP', {'cursor': self.cursor})
                self.ended = True
                return True
            except Exception as exc:
                self._risk(exc)
                return False

    def close(self):
        if self._owner is not None:
            self._owner.close()
            self._owner = None
