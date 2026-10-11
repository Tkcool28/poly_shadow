"""Isolated read-only insertion-fact reconciler. No Poly2 imports or writer hooks.

Explicit invocation only. No default DSN, scheduling, trading dependencies or
closure inference. PostgreSQL uses a read-only repeatable-read transaction;
SQLite copy/synthetic tests use native read-only transactions. Each scan revisits
all frozen-cohort ingestions, including old IDs that commit late, and all linked
initial orders. It does not SELECT mutable policy/outcome/status fields.
"""
import argparse
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

import sqlite3
import uuid


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)


def digest(value):
    # Match the journal's JS canonical numbers for integral DB numeric operands.
    def normalized(v):
        if isinstance(v, float) and v.is_integer():
            return int(v)
        if isinstance(v, list):
            return [normalized(x) for x in v]
        if isinstance(v, dict):
            return {k: normalized(x) for k, x in v.items()}
        return v
    return hashlib.sha256(canonical(normalized(value)).encode()).hexdigest()


def clock(value):
    if value is None:
        return None
    if isinstance(value, str):
        result = value
    else:
        if value.tzinfo is None:
            raise ValueError('original timestamp lacks timezone')
        result = value.isoformat().replace('+00:00', 'Z')
    epoch_micros(result)
    return result


def epoch(value):
    return epoch_micros(value)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')


class SQLAdapter:
    """DB-API adapter: caller owns a dedicated connection, never a trading session."""
    def __init__(self, connection, dialect, *, checkpoint=False):
        if dialect not in ('sqlite', 'postgres'):
            raise ValueError('unsupported dialect')
        if dialect == 'postgres' and (getattr(connection, 'autocommit', False) is not True
                                      or getattr(getattr(connection, 'info', None), 'transaction_status', None) != 0):
            raise ValueError('dedicated PostgreSQL connection must be idle/autocommit before explicit read-only transaction')
        self.connection, self.dialect = connection, dialect
        self.checkpoint, self.last_checkpoint = checkpoint, None

    @classmethod
    def sqlite_copy(cls, path):
        connection = sqlite3.connect(Path(path).resolve().as_uri() + '?mode=ro', uri=True)
        connection.execute('PRAGMA query_only=ON')
        return cls(connection, 'sqlite')

    def scan(self, binding, frozen_ids=None):
        c = self.connection.cursor()
        placeholder = '?' if self.dialect == 'sqlite' else '%s'
        cohort = binding['cohort']
        if len(cohort) != 5 or len(set(cohort)) != 5:
            raise ValueError('exact five-wallet cohort required')
        epoch_micros(binding['window']['startUtc']); epoch_micros(binding['window']['endUtc'])
        params = [*cohort, binding['window']['startUtc'], binding['window']['endUtc']]
        if self.dialect == 'sqlite':
            self.connection.create_function('comparison_epoch_micros', 1, epoch_micros, deterministic=True)
        predicate = 'w.address IN (' + ','.join([placeholder] * len(cohort)) + ') AND t.ingested_at >= ' + placeholder + ' AND t.ingested_at <= ' + placeholder
        if self.dialect == 'sqlite':
            predicate = 'w.address IN (' + ','.join([placeholder] * len(cohort)) + ') AND comparison_epoch_micros(t.ingested_at) >= comparison_epoch_micros(?) AND comparison_epoch_micros(t.ingested_at) <= comparison_epoch_micros(?)'
        if frozen_ids is not None:
            if len(set(frozen_ids)) != len(frozen_ids):
                raise ValueError('duplicate frozen source IDs')
            predicate += (' AND t.id IN (' + ','.join([placeholder] * len(frozen_ids)) + ')') if frozen_ids else ' AND 1=0'
            params += list(frozen_ids)
        try:
            c.execute('BEGIN' if self.dialect == 'sqlite' else 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
            metadata = None
            if self.checkpoint:
                if self.dialect != 'postgres':
                    raise ValueError('authoritative SQL checkpoint requires native PostgreSQL')
                c.execute("SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only, txid_current_snapshot()::text AS snapshot")
                rows = c.fetchall()
                if len(rows) != 1 or rows[0][0:2] != ('repeatable read', 'on'):
                    raise ValueError('native read-only repeatable-read checkpoint not verified')
                metadata = dict(isolation=rows[0][0], readOnly=rows[0][1], snapshot=rows[0][2])
            c.execute('SELECT t.id, t.polymarket_trade_id, w.address, t.asset_id, m.condition_id, t.side, t.size, t.traded_at, t.ingested_at FROM trades t JOIN wallets w ON w.id=t.wallet_id JOIN markets m ON m.id=t.market_id WHERE ' + predicate + ' ORDER BY t.id', params)
            trades = []
            for ident, event, wallet, asset, condition, side, size, source, ingest in c.fetchall():
                source, ingest = clock(source), clock(ingest)
                if not in_window(ingest, binding['window']):
                    raise ValueError('SQL/exact timestamp membership disagreement')
                trades.append(dict(sourceRecordId=ident, sourceEventId=event, wallet=wallet, asset=asset, conditionId=condition, side=side, size=float(size) if size is not None else None, originalSize=str(size) if size is not None else None, sourceTs=epoch(source) / 1000000 if source else None, tradedAtUtc=source, ingestedUtc=ingest))
            if self.dialect == 'postgres':
                c.execute('''SELECT t.polymarket_trade_id, p.id AS paper_id, p.t2_decided_at, p.miss_reason,
                                    t.ingested_at, s.id AS signal_id, l.id AS audit_id, l.action, l.context, l.created_at
                             FROM trades t JOIN wallets w ON w.id=t.wallet_id
                             JOIN markets m ON m.id=t.market_id
                             JOIN signals s ON s.source_trade_id=t.polymarket_trade_id
                             JOIN paper_orders p ON p.signal_id=s.id
                             LEFT JOIN decision_log l
                               ON l.context->>'signal_id'=s.id::text
                              AND l.context->>'source_trade_id'=s.source_trade_id
                              AND l.action IN ('signal_skipped','paper_order_executed')
                             WHERE ''' + predicate + ' ORDER BY t.id, p.id, l.id', params)
                grouped = {}
                for event, paper_id, decided, reason, ingest, signal_id, audit_id, action, context, created in c.fetchall():
                    key = (event, paper_id)
                    grouped.setdefault(key, []).append((decided, reason, ingest, signal_id, audit_id, action, context, created))
                decisions = []
                for (event, ident), matches in grouped.items():
                    decided, reason, ingest, signal_id = matches[0][:4]
                    expected_action = 'signal_skipped' if reason is not None else 'paper_order_executed'
                    # Query has one row per PaperOrder when no audit exists. Each original
                    # decision must have exactly one matching immutable audit linkage.
                    audit_rows = [r for r in matches if r[4] is not None]
                    if len(audit_rows) != 1 or len(matches) != 1:
                        raise ValueError('missing/conflicting original decision audit linkage')
                    _, _, _, _, audit_id, action, context, created = audit_rows[0]
                    if isinstance(context, str):
                        context = json.loads(context)
                    if (action != expected_action or not isinstance(context, dict)
                            or str(context.get('signal_id')) != str(signal_id)
                            or context.get('source_trade_id') != event):
                        raise ValueError('original decision audit linkage/action mismatch')
                    decisions.append(dict(sourceEventId=event, paperRecordId=ident,
                        signalRecordId=signal_id, decisionUtc=clock(decided), rejectionReason=reason,
                        sourceIngestedUtc=clock(ingest), sourceAudit=dict(recordId=audit_id,
                            action=action, createdUtc=clock(created), context=context)))
            else:
                c.execute('SELECT t.polymarket_trade_id, p.id, p.t2_decided_at, p.miss_reason, t.ingested_at FROM trades t JOIN wallets w ON w.id=t.wallet_id JOIN signals s ON s.source_trade_id=t.polymarket_trade_id JOIN paper_orders p ON p.signal_id=s.id WHERE ' + predicate + ' ORDER BY t.id, p.id', params)
                decisions = [dict(sourceEventId=event, paperRecordId=ident, decisionUtc=clock(decided), rejectionReason=reason, sourceIngestedUtc=clock(ingest)) for event, ident, decided, reason, ingest in c.fetchall()]
            # Multiple original orders cannot be resolved by status/earliest-ID hindsight.
            if len({d['sourceEventId'] for d in decisions}) != len(decisions):
                raise ValueError('ambiguous original decision linkage')
            for fact in trades:
                fact['clockEvidence'] = clock_evidence(fact, ['ingestedUtc', 'tradedAtUtc'])
            for fact in decisions:
                fact['clockEvidence'] = clock_evidence(fact, ['sourceIngestedUtc', 'decisionUtc'])
            if metadata:
                ordered = sorted(trades, key=lambda t: canonical(t['sourceRecordId']))
                order = {t['sourceEventId']: i for i,t in enumerate(ordered)}
                self.last_checkpoint = dict(**metadata, sourceFactsSha256=digest(ordered),
                    decisionsSha256=digest(sorted(decisions, key=lambda d: order[d['sourceEventId']])),
                    querySha256=digest(dict(predicate=predicate, params=params)),
                    sourceRecordIds=[t['sourceRecordId'] for t in ordered])
            return trades, decisions
        finally:
            self.connection.rollback()
            c.close()


class CheckpointProducer:
    def __init__(self, directory, binding, adapter, *, read_clock=now, signer=None):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.owner = open(self.directory / 'source-owner.lock', 'a+b')
        try:
            fcntl.flock(self.owner, fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.binding, self.adapter, self.read_clock, self.signer = binding, adapter, read_clock, signer
            self.frames, self.trades, self.decisions = [], {}, {}
            self.failed = False
            self.path = self.directory / 'poly2_source_receipts.ndjson'
            if binding['evidenceKind'] == 'observational' and signer is None:
                raise ValueError('observational custody signer required')
            if self.path.exists():
                data = self.path.read_bytes()
                if data and not data.endswith(b'\n'):
                    raise ValueError('torn checkpoint spool preserved')
                for line in data.splitlines():
                    f = json.loads(line)
                    if f['bindingSha256'] != digest(binding) or f['cursor'] != len(self.frames) + 1 or f['previousCursor'] != len(self.frames):
                        raise ValueError('checkpoint binding/sequence conflict')
                    if signer:
                        payload = {k: v for k, v in f.items() if k not in ('signature', 'signedPayload')}
                        if f['signedPayload'] != canonical(payload):
                            raise ValueError('signed payload conflict')
                        signer.public_key().verify(base64.b64decode(f['signature']), f['signedPayload'].encode())
                    elif f['signature'] is not None:
                        raise ValueError('synthetic signature forbidden')
                    self._apply(f)
            else:
                if epoch(read_clock()) > epoch(binding['window']['startUtc']):
                    raise ValueError('pre-start activation required')
                self._frame('ACTIVATION')
        except BaseException:
            self.owner.close()
            raise

    def _apply(self, frame):
        if self.frames and self.frames[-1]['kind'] == 'END_FENCE':
            raise ValueError('source frame after terminal receipt')
        for name, store, key in [('trades', self.trades, 'sourceEventId'), ('decisions', self.decisions, 'sourceEventId')]:
            for fact in frame[name]:
                old = store.get(fact[key])
                if old is not None and old != fact:
                    raise ValueError('original insertion fact conflict')
                store[fact[key]] = fact
        self.frames.append(frame)

    def _frame(self, kind, trades=None, decisions=None, fence=None):
        if self.failed:
            raise ValueError('sink latched; restart/replay required')
        f = dict(version=1, bindingSha256=digest(self.binding), cursor=len(self.frames)+1, previousCursor=len(self.frames), transactionId='checkpoint:'+str(uuid.uuid4()), observedUtc=self.read_clock(), kind=kind, trades=trades or [], decisions=decisions or [], commitBeforeUtc=None, commitAfterUtc=None, fence=fence)
        if kind == 'CHECKPOINT':
            f['checkpointPayload'] = canonical(f)
        if self.signer:
            f['signedPayload'] = canonical(f)
            f['signature'] = base64.b64encode(self.signer.sign(f['signedPayload'].encode())).decode()
        else:
            f['signature'] = None
        try:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
            try:
                data = memoryview((canonical(f)+'\n').encode())
                while data:
                    n = os.write(fd, data)
                    if n <= 0:
                        raise OSError('short checkpoint append')
                    data = data[n:]
                os.fsync(fd)
            finally:
                os.close(fd)
            fd = os.open(self.directory, os.O_RDONLY)
            try:
                os.fsync(fd)
            finally:
                os.close(fd)
            self._apply(f)
        except Exception:
            self.failed = True
            raise
        return f

    def reconcile(self, *, force=False):
        if self.failed or self.frames[-1]['kind'] == 'END_FENCE':
            raise ValueError('checkpoint reader terminal/latched')
        trades, decisions = self.adapter.scan(self.binding)
        # Full scans also detect loss/change of previously retained insertion facts.
        for current, store, key in [(trades, self.trades, 'sourceEventId'), (decisions, self.decisions, 'sourceEventId')]:
            mapping = {f[key]: f for f in current}
            if len(mapping) != len(current) or any(mapping.get(k) != old for k, old in store.items()):
                raise ValueError('source insertion retention/immutability violated')
        new_t = [t for t in trades if t['sourceEventId'] not in self.trades]
        new_d = [d for d in decisions if d['sourceEventId'] not in self.decisions]
        if new_t or new_d or force:
            return self._frame('CHECKPOINT', new_t, new_d)
        return None

    def terminal(self, certificate=None):
        """Certificate is external authority, NEVER inferred from this scan/MAX.

        Current source has no such authority; absent certificate returns INCOMPLETE
        and leaves the reader resumable. A synthetic authority can model it.
        """
        if self.binding['evidenceKind'] == 'observational':
            return {'state': 'INCOMPLETE', 'property': 'AT_END_SOURCE_ADMISSION_BARRIER_UNPROVEN',
                    'detail': 'Caller certificate booleans cannot prove pending ingestion transaction closure; source-fact frozen drain required.'}
        authority = self.binding.get('terminalAuthority')
        if not authority or not certificate:
            return {'state': 'INCOMPLETE', 'property': 'NO_FUTURE_IN_WINDOW_INGESTIONS_AND_RELEVANT_INITIAL_DECISIONS_AFTER_FINAL_READ'}
        if (any(certificate.get(k) != authority[k] for k in ('inventorySha256', 'contractSha256'))
                or any(certificate.get(k) is not True for k in ('noFutureInWindowInsertions', 'noFutureRelevantDecisions', 'insertionFactsRetained'))
                or certificate.get('outstandingTransactions') != 0
                or certificate.get('unresolvedFailures') != 0
                or sorted(certificate.get('registeredWriters', [])) != ['execution', 'ingestion']
                or epoch(certificate['closedUtc']) < epoch(self.binding['window']['endUtc'])
                or epoch(self.read_clock()) < epoch(certificate['closedUtc'])):
            raise ValueError('invalid independently pinned drain certificate')
        final = self.reconcile(force=True)
        assert final is not None
        cert = {**certificate, 'finalCheckpointCursor': final['cursor'], 'finalCheckpointSha256': hashlib.sha256(final['checkpointPayload'].encode()).hexdigest()}
        fence = dict(protocol='all-writers-transaction-drain-v1', registeredWriters=['execution', 'ingestion'], outstandingTransactions=0, unresolvedFailures=0, throughCursor=final['cursor'], certificate=cert)
        return self._frame('END_FENCE', fence=fence)

    def close(self):
        self.owner.close()


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('binding')
    p.add_argument('sqlite_copy', help='explicit isolated copy/synthetic database; no default/live DSN')
    p.add_argument('source_dir')
    args = p.parse_args()
    binding = json.loads(Path(args.binding).read_text())
    if binding['evidenceKind'] != 'synthetic':
        p.error('CLI accepts synthetic/copy fixtures only; observational use requires separately authorized dedicated adapter/signing custody')
    adapter = SQLAdapter.sqlite_copy(args.sqlite_copy)
    producer = CheckpointProducer(args.source_dir, binding, adapter)
    try:
        producer.reconcile()
        print(canonical(producer.terminal()))
    finally:
        producer.close()
        adapter.connection.close()


if __name__ == '__main__':
    main()
