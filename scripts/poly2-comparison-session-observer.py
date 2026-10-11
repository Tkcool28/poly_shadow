"""Optional locally-authored SQLAlchemy session integration, NOT installed in Poly2.

Uses real Session events (AsyncSession.sync_session included), before_flush for
all source entry paths including begin_nested's implicit autoflush. Whole outer
transactions share one admission token. Initial insertion facts are detached at
successful flush. A SAVEPOINT isolates witness insertion failures. Commit outcome
is recovered from committed witnesses, never an after_commit caller assertion.
Pass the real Trade/Wallet/Market mapped classes explicitly; no Poly2 imports.
"""
import importlib.util
from pathlib import Path

_SPEC = importlib.util.spec_from_file_location('orm_source_fence', Path(__file__).with_name('poly2-comparison-fence.py'))
assert _SPEC and _SPEC.loader
F = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(F)


class SessionObserver:
    def __init__(self, session, fence, worker, Trade, Wallet, Market):
        # Import optional dependency only on explicit adapter construction.
        from sqlalchemy import event, select, text
        self.session = getattr(session, 'sync_session', session)
        self.fence, self.worker, self.Trade = fence, worker, Trade
        self.token = None
        self.trades = {}
        self.candidates = []
        self.intent = False
        self.ended_token = None
        self.fact_transactions = {}
        self.listeners = []

        def contained(fn):
            def wrapped(*args):
                try:
                    fn(*args)
                except Exception as exc:
                    fence.error(exc)  # observer cannot veto source decisions/availability
            return wrapped

        def before_flush(s, context, instances):
            candidates = [obj for obj in s.new if isinstance(obj, Trade)]
            if not candidates:
                return
            if self.token is None:
                self.token = fence._admit(worker)  # BEFORE defaults/INSERT, including autoflush
            self.candidates.extend(candidates)

        def after_flush(s, context):
            for trade in self.candidates:
                wallet = s.execute(select(Wallet).where(Wallet.id == trade.wallet_id)).scalar_one()
                market = s.execute(select(Market).where(Market.id == trade.market_id)).scalar_one()
                self.trades[trade.id] = dict(sourceRecordId=trade.id,sourceEventId=trade.polymarket_trade_id,
                    wallet=wallet.address,asset=trade.asset_id,conditionId=market.condition_id,side=trade.side,
                    size=float(trade.size),originalSize=str(trade.size),
                    sourceTs=F.epoch(F.C.clock(trade.traded_at))/1000000 if trade.traded_at else None,
                    tradedAtUtc=F.C.clock(trade.traded_at),ingestedUtc=F.C.clock(trade.ingested_at))
                self.trades[trade.id]['clockEvidence'] = F.C.clock_evidence(self.trades[trade.id],['ingestedUtc','tradedAtUtc'])
                self.fact_transactions[trade.id] = s.get_nested_transaction()
            self.candidates.clear()

        def before_commit(s):
            # SQLAlchemy also emits before_commit for SAVEPOINT release. Only the
            # outer transaction gets a witness, after its final automatic flush.
            if s.in_nested_transaction():
                return
            s.flush()
            if self.token is None or fence.local_error or fence.state()['error']:
                return
            a = fence.state()['attempts'][self.token]
            witness = dict(transactionId=self.token,bindingSha256=F.digest(fence.binding),worker=worker,
                           epoch=a['epoch'],trades=sorted(self.trades.values(),key=lambda t:t['sourceRecordId']))
            connection = s.connection()
            savepoint = connection.begin_nested()
            try:
                connection.execute(text('INSERT INTO comparison_transaction_witness(transaction_id,binding_sha256,payload,payload_sha256) VALUES(:token,:binding,:payload,:sha)'),
                    dict(token=self.token,binding=F.digest(fence.binding),payload=F.canonical(witness),sha=F.digest(witness)))
                savepoint.commit()
                self.intent = True
            except Exception:
                savepoint.rollback()
                raise

        def after_commit(s):
            # Released child SAVEPOINT facts belong to its enclosing SAVEPOINT.
            # A later parent rollback must remove them as well. This callback is
            # bookkeeping only; it is NEVER source outer-commit authority.
            nested = s.get_nested_transaction()
            if nested is not None:
                for ident, owner in list(self.fact_transactions.items()):
                    if owner is nested:
                        self.fact_transactions[ident] = nested.parent

        def after_soft_rollback(s, previous):
            if previous.parent is not None:
                # A row SAVEPOINT rollback is not an outer transaction terminal.
                # Remove detached facts for objects expunged by that SAVEPOINT.
                self.trades = {k:v for k,v in self.trades.items() if self.fact_transactions.get(k) is not previous}
                self.fact_transactions = {k:v for k,v in self.fact_transactions.items() if v is not previous}
                self.candidates.clear()
                return
            token = self.token or self.ended_token
            if token is not None:
                with fence.transaction():
                    fence._append('ROLLED_BACK',{'transactionId':token})
            self.ended_token = None
            self._clear()

        def after_transaction_end(s, transaction):
            if transaction.parent is None:
                # This event alone cannot distinguish commit, rollback or unknown.
                # Witness survives real commit; missing witness stays outstanding.
                self.ended_token = self.token
                self._clear()

        for name, fn in [('before_flush',before_flush),('after_flush',after_flush),('before_commit',before_commit),('after_commit',after_commit),('after_soft_rollback',after_soft_rollback),('after_transaction_end',after_transaction_end)]:
            wrapped = contained(fn)
            event.listen(self.session,name,wrapped)
            self.listeners.append((name,wrapped))

    def _clear(self):
        self.token, self.intent, self.trades, self.candidates = None, False, {}, []
        self.fact_transactions = {}

    def acknowledge_epoch(self):
        try:
            self.fence._ack(self.worker)
        except Exception as exc:
            self.fence.error(exc)

    def detach(self):
        from sqlalchemy import event
        for name,fn in self.listeners:
            event.remove(self.session,name,fn)
        self.listeners.clear()


class ObservedSessionFactory:
    """Prospective wrapper for the real async_sessionmaker at get_sessionmaker.

    Install before ANY bot/API/scoring session is created. One pinned worker
    incarnation per process, shared durable Fence across processes. This covers
    future sessions, not already-open sessions or independent/manual SQL writers.
    Enrollment is not evidence of deployment; production evidence remains refused
    by Fence until separately established installation/retention/custody authority.
    No global registry retains Session instances, and observation failure never
    prevents the caller receiving its ordinary source session.
    """
    def __init__(self, maker, fence, worker, Trade, Wallet, Market):
        if worker not in fence.binding['expectedWorkers']:
            raise ValueError('worker incarnation absent from pinned expected inventory')
        self.maker, self.fence, self.worker = maker, fence, worker
        self.models = Trade, Wallet, Market
        try:
            fence.enroll(worker)
        except Exception as exc:
            fence.error(exc)

    def __call__(self, **kwargs):
        session = self.maker(**kwargs)
        try:
            sync = getattr(session, 'sync_session', session)
            if 'poly2_comparison_observer' in sync.info:
                raise ValueError('session already instrumented')
            sync.info['poly2_comparison_observer'] = SessionObserver(
                session, self.fence, self.worker, *self.models)
        except Exception as exc:
            self.fence.error(exc)
        return session

    def acknowledge_epoch(self):
        # All later before_flush admissions read the same serialized epoch. This
        # ACK cannot resolve old work and is not an installation authentication.
        try:
            self.fence._ack(self.worker)
        except Exception as exc:
            self.fence.error(exc)
