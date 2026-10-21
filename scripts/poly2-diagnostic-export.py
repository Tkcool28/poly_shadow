#!/usr/bin/env python3
"""Bounded, read-only Poly2 export for UNCERTIFIED_DIAGNOSTIC.

This script is executed in the existing backend container. It performs no
writes and never reads mutable order, settlement, or current eligibility state.
Decision-log rows are application audit evidence, not a DB-enforced immutable
ledger; reports must retain that limitation.
"""
from __future__ import annotations
import argparse
import asyncio
import datetime as dt
import itertools
import json
import math
import os
from pathlib import Path
import re
import stat
import sys
from typing import Any

WALLETS = (
    '0x82cf2b31d18fca19830e216b98cffa5dbc6c0998',
    '0x924379a79c64b77ad5816ad362122a5f6228658e',
    '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029',
    '0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b',
    '0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227',
)
MAX_TRADE_ROWS = 50_000
MAX_AUDIT_ROWS = 50_000
MAX_EXPORT_BYTES = 64 * 1024 * 1024
PAGE_SIZE = 1_000
MAX_AUDIT_CONTEXT_ROW_BYTES = 4_096
MAX_AUDIT_CONTEXT_TOTAL_BYTES = 4 * 1024 * 1024
MAX_AUDIT_CONTEXT_PAGE_BYTES = 512 * 1024
REDACT_KEY = re.compile(r'(?:secret|password|private.?key|api.?key|credential|authority|signature|connection.?string)', re.I)


def parse_utc(value: str) -> dt.datetime:
    if not isinstance(value, str) or not value or len(value) > 64:
        raise ValueError('timestamp must be bounded ISO-8601 text')
    try:
        parsed = dt.datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    except ValueError as exc:
        raise ValueError('invalid ISO-8601 timestamp') from exc
    if parsed.tzinfo is None or parsed.utcoffset() is None:
        raise ValueError('timestamp must include an explicit timezone')
    return parsed.astimezone(dt.timezone.utc)


def utc_text(value: dt.datetime) -> str:
    if value.tzinfo is None or value.utcoffset() is None:
        raise ValueError('naive database timestamp')
    return value.astimezone(dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')


def epoch_micros(value: dt.datetime) -> int:
    value = value.astimezone(dt.timezone.utc)
    delta = value - dt.datetime(1970, 1, 1, tzinfo=dt.timezone.utc)
    return (delta.days * 86400 + delta.seconds) * 1_000_000 + delta.microseconds


def redact(value: Any, depth: int = 0) -> Any:
    if depth > 6:
        return '[DEPTH_LIMIT]'
    if isinstance(value, dict):
        items = list(itertools.islice(value.items(), 32))
        result = {str(k)[:128]: '[REDACTED]' if REDACT_KEY.search(str(k)) else redact(v, depth + 1) for k, v in items}
        if len(value) > len(items):
            result['__truncated_keys__'] = len(value) - len(items)
        return result
    if isinstance(value, list):
        return [redact(v, depth + 1) for v in value[:16]]
    if isinstance(value, str):
        return value[:256]
    if value is None or type(value) in (bool, int):
        return value
    if type(value) is float and math.isfinite(value):
        return value
    return str(value)[:256]


AUDIT_REASON_ALLOWLIST = {
    'stale_signal', 'wallet_not_approved', 'market_closed', 'no_token_for_outcome',
    'no_position_to_sell', 'exposure_cap', 'bankroll_stop_loss', 'bankroll_insufficient',
    'no_book_depth', 'price_zone',
}


def bounded_context(value: Any) -> Any:
    """Retain only audit fields required for linkage and known static reasons."""
    if not isinstance(value, dict):
        return {'contextOmitted': True, 'reason': 'UNSTRUCTURED_AUDIT_CONTEXT'}
    result: dict[str, Any] = {}
    source_trade_id = value.get('source_trade_id')
    if isinstance(source_trade_id, str) and len(source_trade_id) <= 512:
        result['source_trade_id'] = source_trade_id
    signal_id = value.get('signal_id')
    if type(signal_id) is int and signal_id >= 0:
        result['signal_id'] = signal_id
    elif isinstance(signal_id, str) and len(signal_id) <= 128:
        result['signal_id'] = signal_id
    reason = value.get('reason')
    if isinstance(reason, str) and reason in AUDIT_REASON_ALLOWLIST:
        result['reason'] = reason
    if len(result) < len(value):
        result['omittedContextFields'] = len(value) - len(result)
    return result


def canonical_trade_identity(source_id: str, wallet: str, asset: str | None) -> tuple[str | None, bool]:
    """Preserve the source key; validate its documented data-api composition."""
    if not isinstance(source_id, str) or not source_id:
        return None, False
    fields = source_id.split(':')
    if (len(fields) != 7 or fields[0] != 'data-api'
            or not re.fullmatch(r'0x[0-9a-fA-F]{64}', fields[1])
            or fields[2].lower() != wallet.lower()
            or (asset is not None and fields[3] != str(asset))
            or not fields[4] or not fields[5] or not fields[6].isdigit()):
        return None, False
    return fields[1].lower(), True


def cohort_matches(approved: list[str]) -> bool:
    return approved == list(WALLETS)


async def _execute(conn, text, sql: str, params: dict[str, Any] | None = None):
    result = await conn.execute(text(sql), params or {})
    return [dict(row._mapping) for row in result.fetchall()]


async def verify_read_only_repeatable_read(conn, text) -> None:
    """Assert the live PostgreSQL transaction has the required isolation/read-only flags."""
    rows = await _execute(conn, text, 'SELECT current_setting(\'transaction_read_only\') AS read_only, current_setting(\'transaction_isolation\') AS isolation')
    if len(rows) != 1 or str(rows[0]['read_only']).lower() not in ('on', 'true') or str(rows[0]['isolation']).lower() != 'repeatable read':
        raise RuntimeError('PostgreSQL transaction is not read-only repeatable-read')


async def begin_read_only_repeatable_read(conn, text) -> None:
    """Start the required PostgreSQL transaction before issuing any source query."""
    await conn.execute(text('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY'))
    await conn.execute(text("SET LOCAL statement_timeout = '15s'"))
    await conn.execute(text("SET LOCAL lock_timeout = '250ms'"))
    await conn.execute(text("SET LOCAL idle_in_transaction_session_timeout = '30s'"))
    await verify_read_only_repeatable_read(conn, text)
    roles = await _execute(conn, text, """SELECT COALESCE(bool_or(has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')),true) AS writes_permitted
        FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relname IN ('wallets','trades','signals','decision_log')""")
    if len(roles) != 1 or roles[0]['writes_permitted'] is not False:
        raise RuntimeError('dedicated SELECT-only database role required')


async def read_preflight(conn, text, observed_utc: str) -> dict[str, Any]:
    wallets = await _execute(conn, text, "SELECT lower(address) AS address FROM wallets WHERE approval_state = 'approved' ORDER BY lower(address) LIMIT 6")
    approved = [r['address'] for r in wallets]
    if not cohort_matches(approved):
        raise RuntimeError('approved wallet population/order differs from frozen cohort')
    high = await _execute(conn, text, 'SELECT COALESCE(MAX(id), 0) AS max_id FROM decision_log')
    trade_high = await _execute(conn, text, 'SELECT COALESCE(MAX(id), 0) AS max_id FROM trades')
    return {
        'schemaVersion': 1, 'classification': 'UNCERTIFIED_DIAGNOSTIC', 'mode': 'preflight',
        'certified': False, 'observedUtc': observed_utc, 'cohort': list(WALLETS),
        'approvedWallets': approved, 'decisionLogIdHighWater': int(high[0]['max_id']),
        'tradeIdHighWater': int(trade_high[0]['max_id']),
        'decisionAuditBoundary': 'PRIMARY_KEY_HIGH_WATER_BEFORE_OBSERVATION',
    }


def _validate_window(start_utc: str, end_utc: str) -> tuple[dt.datetime, dt.datetime]:
    start, end = parse_utc(start_utc), parse_utc(end_utc)
    if end <= start or (end - start).total_seconds() > 86400:
        raise ValueError('diagnostic window must be positive and no longer than 24 hours')
    return start, end


def deduplicate_trade_rows(raw: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Drop repeated source identities without letting them inflate counts."""
    kept: dict[tuple[str, str], dict[str, Any]] = {}
    duplicates = 0
    compare_fields = ('asset_id', 'condition_id', 'side', 'size', 'price', 'traded_at')
    for row in raw:
        wallet, source_id = str(row['wallet']).lower(), row.get('source_event_id')
        if not isinstance(source_id, str) or not source_id or len(source_id) > 512:
            raise ValueError('trade row lacks a bounded stable source identity')
        key = (wallet, source_id)
        prior = kept.get(key)
        if prior is None:
            kept[key] = dict(row)
            continue
        duplicates += 1
        if any(prior.get(name) != row.get(name) for name in compare_fields):
            raise RuntimeError('conflicting duplicate source identity; export refused')
        # Keep earliest recorded ingestion; source/event time remains unchanged.
        if row['ingested_at'] < prior['ingested_at']:
            row = dict(row)
            row['duplicateSourceRecordIds'] = list(prior.get('duplicateSourceRecordIds', [prior['source_record_id']]))
            kept[key] = row
        current = kept[key]
        ids = current.setdefault('duplicateSourceRecordIds', [current['source_record_id']])
        if row['source_record_id'] not in ids:
            ids.append(row['source_record_id'])
    return list(kept.values()), duplicates


def _identity_and_row(r: dict[str, Any], signals: list[dict[str, Any]], audits: list[dict[str, Any]], start: dt.datetime, end: dt.datetime) -> dict[str, Any]:
    wallet = str(r['wallet']).lower()
    source_id = str(r['source_event_id'])
    event, ingested = r['traded_at'], r['ingested_at']
    if not isinstance(event, dt.datetime) or not isinstance(ingested, dt.datetime):
        raise ValueError('database returned a non-datetime trade clock')
    event_utc, ingested_utc = utc_text(event), utc_text(ingested)
    if not (start <= ingested.astimezone(dt.timezone.utc) < end):
        raise ValueError('bounded trade query returned out-of-window ingestion')
    tx_hash, valid_identity = canonical_trade_identity(source_id, wallet, r['asset_id'])
    trade_signals = [s for s in signals if s['source_trade_id'] == source_id]
    by_signal = {str(s['id']): s for s in trade_signals}
    if len(trade_signals) > 1:
        signal_state, signal_utc = 'AMBIGUOUS', None
    elif trade_signals:
        signal_state, signal_utc = 'PRESENT', utc_text(trade_signals[0]['t1_detected_at'])
    else:
        signal_state, signal_utc = 'UNKNOWN_NO_SIGNAL_ROW', None
    audit_rows = []
    for a in audits:
        if a.get('linked_source_trade_id') != source_id:
            continue
        context = a.get('context') if isinstance(a.get('context'), dict) else None
        raw_signal_id = context.get('signal_id') if context is not None else None
        linked = raw_signal_id is not None and str(raw_signal_id) in by_signal
        context_evidence = a['contextEvidence']
        audit_rows.append({
            'recordId': int(a['id']), 'actor': str(a['actor']), 'action': str(a['action']),
            'createdUtc': utc_text(a['created_at']), 'sourceTradeId': source_id,
            'signalId': str(raw_signal_id) if raw_signal_id is not None else None,
            'linkage': 'LINKED_TO_EXPORTED_SIGNAL' if linked else 'UNKNOWN_UNLINKED',
            'context': bounded_context(context) if context is not None else {'contextOmitted': True, 'reason': context_evidence},
            'contextEvidence': context_evidence, 'contextBytes': int(a.get('contextBytes',0)),
        })
    recognized = [a for a in audit_rows if a['actor'] == 'bot' and a['linkage'] == 'LINKED_TO_EXPORTED_SIGNAL'
                  and a['action'] in ('paper_order_executed', 'signal_skipped')]
    paper_action = recognized[0]['action'] if len(recognized) == 1 else None
    reason = None
    if len(recognized) == 1:
        ctx = recognized[0]['context']
        reason = ctx.get('reason') if isinstance(ctx, dict) and isinstance(ctx.get('reason'), str) else None
    age = (epoch_micros(ingested) - epoch_micros(event)) / 1_000_000
    exact_size = float(r['size']) if r['size'] is not None else None
    exact_price = float(r['price']) if r['price'] is not None else None
    return {
        'wallet': wallet, 'txHash': tx_hash if valid_identity else None,
        'asset': str(r['asset_id']) if valid_identity and r['asset_id'] is not None else None,
        'conditionId': str(r['condition_id']) if valid_identity and r['condition_id'] is not None else None,
        'side': str(r['side']) if valid_identity else None,
        'size': exact_size if valid_identity else None, 'price': exact_price if valid_identity else None,
        'sourceTs': int(epoch_micros(event) // 1_000_000),
        'sourceEpochMicros': str(epoch_micros(event)), 'tradedAtUtc': event_utc,
        'ingestedUtc': ingested_utc, 'normalizedUtc': None,
        'decisionUtc': recognized[0]['createdUtc'] if len(recognized) == 1 else None,
        'signalUtc': signal_utc, 'source': 'POLY2_INGESTION',
        'freshnessAgeSec': age, 'freshnessRejection': reason if reason == 'stale_signal' else None,
        'policyEligible': None, 'copyabilityOutcome': None,
        'rejectionReason': reason, 'paperOutcome': paper_action,
        'sourceRecordId': int(r['source_record_id']),
        'duplicateSourceRecordIds': r.get('duplicateSourceRecordIds', []),
        'sourceEventId': source_id,
        'sourceIdentityValidity': 'VALID' if valid_identity else 'INVALID',
        'signalEvidence': signal_state,
        'decisionEvidence': 'PRESENT_LINKED' if recognized else ('UNKNOWN_CONTEXT_INCOMPLETE' if any(a['contextEvidence'] != 'AVAILABLE' for a in audit_rows) else ('UNKNOWN_UNLINKED_AUDIT' if audit_rows else 'UNKNOWN_NO_AUDIT')),
        'decisionAudit': audit_rows,
    }


async def _paged_rows(conn, text, sql: str, params: dict[str, Any], *, cap: int, page_size: int = PAGE_SIZE):
    """Keyset paginate by integer id, rejecting truncation rather than returning partial rows."""
    rows: list[dict[str, Any]] = []
    cursor = int(params['cursor'])
    high = int(params['high_id'])
    while cursor < high:
        remaining = cap - len(rows)
        limit = min(page_size, remaining + 1)
        batch = await _execute(conn, text, sql, {**params, 'cursor': cursor, 'limit': limit})
        if not batch:
            break
        ids = [int(r['source_record_id'] if 'source_record_id' in r else r['id']) for r in batch]
        if any(value <= cursor or value > high for value in ids) or ids != sorted(set(ids)):
            raise RuntimeError('keyset pagination returned invalid or repeated ids')
        if len(batch) > remaining:
            raise RuntimeError('bounded export row cap exceeded; no partial export produced')
        rows.extend(batch)
        cursor = ids[-1]
        if len(batch) < limit:
            break
    return rows


async def _paged_audit_rows(conn, text, sql: str, params: dict[str, Any], *, cap: int, page_size: int = PAGE_SIZE):
    """Page audit metadata while projecting context only inside SQL-side budgets."""
    if not 1 <= page_size <= PAGE_SIZE or not 1 <= cap <= MAX_AUDIT_ROWS:
        raise ValueError('invalid bounded audit pagination limits')
    rows: list[dict[str, Any]] = []
    cursor, high = int(params['cursor']), int(params['high_id'])
    retained_context_bytes = 0
    while cursor < high:
        remaining = cap - len(rows)
        limit = min(page_size, remaining + 1)
        context_budget = min(MAX_AUDIT_CONTEXT_PAGE_BYTES, MAX_AUDIT_CONTEXT_TOTAL_BYTES - retained_context_bytes)
        batch = await _execute(conn, text, sql, {**params, 'cursor':cursor, 'limit':limit,
            'context_budget_bytes':context_budget, 'max_context_row_bytes':MAX_AUDIT_CONTEXT_ROW_BYTES})
        if not batch:
            break
        ids = [int(r['id']) for r in batch]
        if any(value <= cursor or value > high for value in ids) or ids != sorted(set(ids)):
            raise RuntimeError('audit keyset pagination returned invalid or repeated ids')
        if len(batch) > remaining:
            raise RuntimeError('bounded export audit row cap exceeded; no partial export produced')
        for row in batch:
            payload = row.pop('context_payload', None)
            context_size = int(row.pop('context_bytes') or 0)
            if payload is not None:
                encoded_size = len(payload.encode('utf-8'))
                if encoded_size != context_size or encoded_size > MAX_AUDIT_CONTEXT_ROW_BYTES or retained_context_bytes + encoded_size > MAX_AUDIT_CONTEXT_TOTAL_BYTES:
                    raise RuntimeError('database context projection violated byte limits')
                row['context'] = json.loads(payload)
                row['contextEvidence'] = 'AVAILABLE'
                retained_context_bytes += encoded_size
            else:
                row['context'] = None
                row['contextEvidence'] = ('TRUNCATED_OVERSIZE' if context_size > MAX_AUDIT_CONTEXT_ROW_BYTES
                    else 'UNAVAILABLE_TOTAL_CONTEXT_BUDGET' if context_budget == 0 or retained_context_bytes >= MAX_AUDIT_CONTEXT_TOTAL_BYTES
                    else 'UNAVAILABLE_PAGE_CONTEXT_BUDGET')
            row['contextBytes'] = context_size
            rows.append(row)
        cursor = ids[-1]
        if len(batch) < limit:
            break
    return rows, retained_context_bytes



async def read_export(conn, text, *, start_utc: str, end_utc: str, run_id: str,
                      decision_high_water: int, decision_end_high_water: int,
                      trade_high_water: int, trade_end_high_water: int, shadow_sha: str, poly2_checkout_sha: str,
                      runtime_image_id: str | None, runtime_revision: str | None,
                      max_trade_rows: int = MAX_TRADE_ROWS, max_audit_rows: int = MAX_AUDIT_ROWS,
                      exported_utc: str | None = None) -> dict[str, Any]:
    start, end = _validate_window(start_utc, end_utc)
    if (not re.fullmatch(r'[0-9a-f]{40}', shadow_sha) or not re.fullmatch(r'[0-9a-f]{40}', poly2_checkout_sha)
            or not run_id or len(run_id) > 96
            or any(type(v) is not int or v < 0 for v in (decision_high_water, decision_end_high_water, trade_high_water, trade_end_high_water))
            or decision_end_high_water < decision_high_water or trade_end_high_water < trade_high_water
            or not 1 <= max_trade_rows <= MAX_TRADE_ROWS or not 1 <= max_audit_rows <= MAX_AUDIT_ROWS):
        raise ValueError('invalid bounded export binding or row cap')
    approved_rows = await _execute(conn, text, "SELECT lower(address) AS address FROM wallets WHERE approval_state = 'approved' ORDER BY lower(address) LIMIT 6")
    approved = [r['address'] for r in approved_rows]
    cohort_stable = cohort_matches(approved)
    if not cohort_stable:
        raise RuntimeError('approved wallet population/order changed during observation')
    trade_max_rows = await _execute(conn, text, 'SELECT COALESCE(MAX(id), 0) AS max_id FROM trades')
    decision_max_rows = await _execute(conn, text, 'SELECT COALESCE(MAX(id), 0) AS max_id FROM decision_log')
    if trade_end_high_water > int(trade_max_rows[0]['max_id']) or decision_end_high_water > int(decision_max_rows[0]['max_id']):
        raise RuntimeError('recorded end primary-key high-water is not visible')
    if trade_end_high_water < trade_high_water or decision_end_high_water < decision_high_water:
        raise RuntimeError('primary-key high-water regressed')
    names = ', '.join(f':w{i}' for i in range(len(WALLETS)))
    params: dict[str, Any] = {f'w{i}': w for i, w in enumerate(WALLETS)}
    # Sequence allocation is not commit order: a pre-start allocated ID may
    # commit during the window. Retain the start mark as metadata, never as a
    # lower selection fence. The repeatable-read snapshot supplies visibility.
    params.update(start_utc=start, end_utc=end, cursor=0, high_id=trade_end_high_water)
    trade_sql = f'''SELECT t.id AS source_record_id,
        CASE WHEN octet_length(t.polymarket_trade_id) <= 512 THEN t.polymarket_trade_id ELSE NULL END AS source_event_id,
        lower(w.address) AS wallet, t.asset_id, m.condition_id, t.side, t.size, t.price,
        t.traded_at, t.ingested_at
      FROM trades AS t JOIN wallets AS w ON w.id = t.wallet_id
      JOIN markets AS m ON m.id = t.market_id
      WHERE t.id > :cursor AND t.id <= :high_id
        AND lower(w.address) IN ({names})
        AND t.ingested_at >= CAST(:start_utc AS timestamptz)
        AND t.ingested_at < CAST(:end_utc AS timestamptz)
      ORDER BY t.id LIMIT :limit'''
    raw_trades = await _paged_rows(conn, text, trade_sql, params, cap=max_trade_rows)
    snapshot_utc = exported_utc or utc_text(dt.datetime.now(dt.timezone.utc))
    snapshot_time = parse_utc(snapshot_utc)
    late_end = min(snapshot_time, end + dt.timedelta(seconds=300))
    late_rows = []
    if late_end > end:
        late_sql = trade_sql.replace(
            'AND t.ingested_at < CAST(:end_utc AS timestamptz)',
            'AND t.ingested_at < CAST(:end_utc AS timestamptz) AND t.traded_at >= CAST(:event_start AS timestamptz) AND t.traded_at < CAST(:event_end AS timestamptz)')
        late_rows = await _paged_rows(conn, text, late_sql,
            {**params, 'start_utc': end, 'end_utc': late_end,
             'event_start': start, 'event_end': end}, cap=max_trade_rows)
        if any(not isinstance(r.get('source_event_id'), str) for r in late_rows):
            raise ValueError('late source identity exceeds SQL byte limit')
    unique_trades, duplicate_ids = deduplicate_trade_rows(raw_trades)
    source_ids = list(dict.fromkeys(str(r['source_event_id']) for r in unique_trades))
    signals: list[dict[str, Any]] = []
    if source_ids:
        signals = await _execute(conn, text, '''SELECT id, source_trade_id, t1_detected_at FROM signals
            WHERE source_trade_id = ANY(CAST(:source_ids AS text[])) ORDER BY id LIMIT :limit''',
            {'source_ids': source_ids, 'limit': max_trade_rows + 1})
        if len(signals) > max_trade_rows:
            raise RuntimeError('signal evidence row cap exceeded; no partial export produced')
        signal_ids = [int(s['id']) for s in signals]
        if len(signal_ids) != len(set(signal_ids)):
            raise RuntimeError('duplicate signal primary keys returned')
    audits: list[dict[str, Any]] = []
    if source_ids and decision_end_high_water > decision_high_water:
        audit_sql = '''WITH audit_page AS MATERIALIZED (
          SELECT id, actor, action, context, created_at,
            COALESCE(octet_length(context::text), 0) AS context_bytes
          FROM decision_log
          WHERE id > :cursor AND id <= :high_id
            AND created_at >= CAST(:start_utc AS timestamptz)
            AND created_at < CAST(:end_utc AS timestamptz)
            AND context ->> 'source_trade_id' = ANY(CAST(:source_ids AS text[]))
          ORDER BY id LIMIT :limit
        )
        SELECT id, left(actor, 128) AS actor, left(action, 128) AS action, created_at,
          context_bytes, context ->> 'source_trade_id' AS linked_source_trade_id,
          CASE WHEN context_bytes <= :max_context_row_bytes
            AND SUM(CASE WHEN context_bytes <= :max_context_row_bytes THEN context_bytes ELSE 0 END) OVER (ORDER BY id ROWS UNBOUNDED PRECEDING) <= :context_budget_bytes
            THEN context::text ELSE NULL END AS context_payload
        FROM audit_page ORDER BY id'''
        audits, retained_context_bytes = await _paged_audit_rows(conn, text, audit_sql, {
            'cursor': decision_high_water, 'high_id': decision_end_high_water,
            'start_utc': start, 'end_utc': max(end, snapshot_time), 'source_ids': source_ids,
        }, cap=max_audit_rows)
    else:
        retained_context_bytes = 0
    rows = [_identity_and_row(r, signals, audits, start, end) for r in unique_trades]
    action_counts: dict[str, int] = {}
    context_evidence_counts: dict[str,int] = {}
    for audit in audits:
        state=audit['contextEvidence']
        context_evidence_counts[state]=context_evidence_counts.get(state,0)+1
    for row in rows:
        for audit in row['decisionAudit']:
            if audit['actor'] == 'bot' and audit['linkage'] == 'LINKED_TO_EXPORTED_SIGNAL' and audit['action'] in ('paper_order_executed', 'signal_skipped'):
                action_counts[audit['action']] = action_counts.get(audit['action'], 0) + 1
    return {
        'schemaVersion': 1, 'format': 'poly2-uncertified-diagnostic-v1',
        'classification': 'UNCERTIFIED_DIAGNOSTIC', 'certified': False, 'runId': run_id,
        'window': {'startUtc': utc_text(start), 'endUtc': utc_text(end)},
        'cohort': list(WALLETS), 'approvedWalletsAtExport': approved, 'cohortStableAtExport': cohort_stable,
        'software': {'shadowGitSha': shadow_sha, 'poly2CheckoutGitSha': poly2_checkout_sha,
                     'poly2RuntimeImageId': runtime_image_id, 'poly2RuntimeRevisionLabel': runtime_revision},
        'rows': rows,
        'lateArrivals': [{'sourceRecordId': int(r['source_record_id']), 'sourceEventId': r['source_event_id'],
            'wallet': r['wallet'], 'tradedAtUtc': utc_text(r['traded_at']), 'ingestedUtc': utc_text(r['ingested_at']),
            'classification': 'POST_WINDOW_INGESTION_NOT_PRIMARY_LATENCY'} for r in late_rows],
        'lateArrivalDisclosure': {'snapshotUtc': snapshot_utc, 'observedThroughUtc': utc_text(late_end),
            'maximumGraceSeconds': 300, 'count': len(late_rows),
            'laterArrivals': 'UNKNOWN_AFTER_SNAPSHOT', 'commitVisibility': 'SNAPSHOT_ONLY_NOT_CONTINUOUS_PROOF'},
        'coverage': {
            'tradeQuery': 'KEYSET_PAGINATED_READ_ONLY_WINDOW_QUERY', 'tradeRows': len(rows),
            'tradeQueryComplete': True, 'tradeIdRange': {'after': trade_high_water, 'through': trade_end_high_water},
            'decisionLogIdRange': {'after': decision_high_water, 'through': decision_end_high_water},
            'tradeIdBoundary': 'SNAPSHOT_VISIBLE_ID_THROUGH_END_MARK; PRESTART_MARK_METADATA_ONLY',
            'queryLowerIdExclusive': 0,
            'prestartAllocatedIdsIncluded': sum(r['sourceRecordId'] <= trade_high_water for r in rows),
            'decisionAuditBoundary': 'PRIMARY_KEY_RANGE_AFTER_PRESTART_HIGH_WATER_AND_OBSERVATION_INTERVAL',
            'decisionAuditCompleteWithinConfiguredCap': True, 'decisionAuditRows': len(audits),
            'decisionAuditContext': {'retainedBytes':retained_context_bytes,'maxRowBytes':MAX_AUDIT_CONTEXT_ROW_BYTES,'maxTotalBytes':MAX_AUDIT_CONTEXT_TOTAL_BYTES,'maxPageBytes':MAX_AUDIT_CONTEXT_PAGE_BYTES,'evidenceCounts':context_evidence_counts,'complete': all(k=='AVAILABLE' for k in context_evidence_counts) or not audits},
            'decisionAuditEvidenceClass': 'APPLICATION_WRITTEN_DECISION_LOG; DATABASE_IMMUTABILITY_NOT_GUARANTEED',
            'upstreamPoly2Coverage': 'UNKNOWN_UNPROVEN', 'poly2SourceFailureEvidence': None,
            'mutablePresentDayStateUsed': False, 'databaseWrites': 0,
            'duplicateDatabaseTradeIdentities': duplicate_ids,
            'invalidSourceIdentities': sum(r['sourceIdentityValidity'] == 'INVALID' for r in rows),
            'actualPaperOrderExecutions': action_counts.get('paper_order_executed', 0),
            'recordedSkipDecisions': action_counts.get('signal_skipped', 0),
        },
        'exportedUtc': snapshot_utc,
        'limitations': [
            'Only persisted Poly2 ingestion rows inside the bounded interval and primary-key range are exported; upstream continuity is unknown.',
            'Decision-log rows are application-written audit evidence, not a database-enforced immutable ledger.',
            'Eligibility/copyability are null unless a linked contemporaneous decision audit explicitly records an outcome.',
            'Current signal/order status, settlement state, and mutable present-day fields are not read.',
            'Actual PAPER actions require a bot decision-log row linked to an exported signal; this remains diagnostic evidence, not V5 certification.',
        ],
    }


async def main_async(args) -> None:
    from sqlalchemy import text
    from sqlalchemy.ext.asyncio import create_async_engine
    from sqlalchemy.pool import NullPool
    # Credentials are read locally from a private file. No Poly2 container
    # mutation, environment change, worker restart, or DSN in process arguments.
    fd = os.open(args.dsn_file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_size > 4096:
            raise ValueError('private bounded reader credential file required')
        dsn = os.read(fd, 4097).decode().strip()
    finally:
        os.close(fd)
    if not dsn.startswith('postgresql+asyncpg://'):
        raise ValueError('native PostgreSQL async driver DSN required')
    engine = create_async_engine(dsn, poolclass=NullPool)
    try:
        async with engine.connect() as conn:
            async with conn.begin():
                await begin_read_only_repeatable_read(conn, text)
                observed = dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')
                if args.mode == 'preflight':
                    result = await read_preflight(conn, text, observed)
                else:
                    result = await read_export(conn, text, start_utc=args.start_utc, end_utc=args.end_utc,
                        run_id=args.run_id, decision_high_water=args.decision_log_high_water,
                        trade_high_water=args.trade_id_high_water, trade_end_high_water=args.trade_id_end_high_water,
                        decision_end_high_water=args.decision_log_end_high_water, shadow_sha=args.shadow_sha,
                        poly2_checkout_sha=args.poly2_checkout_sha, runtime_image_id=args.runtime_image_id,
                        runtime_revision=args.runtime_revision, max_trade_rows=args.max_trade_rows,
                        max_audit_rows=args.max_audit_rows, exported_utc=observed)
        payload = json.dumps(result, separators=(',', ':'), allow_nan=False).encode('utf-8')
        if len(payload) > MAX_EXPORT_BYTES:
            raise RuntimeError('bounded export output byte cap exceeded')
        sys.stdout.buffer.write(encode_export_output(payload))
        sys.stdout.buffer.flush()
    finally:
        await engine.dispose()


def encode_export_output(payload: bytes) -> bytes:
    """Append the required JSONL record terminator as one actual LF byte."""
    return payload + bytes((10,))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--mode', choices=('preflight', 'export'), required=True)
    parser.add_argument('--dsn-file', type=Path, required=True)
    parser.add_argument('--start-utc')
    parser.add_argument('--end-utc')
    parser.add_argument('--run-id', default='')
    parser.add_argument('--decision-log-high-water', type=int, default=0)
    parser.add_argument('--decision-log-end-high-water', type=int)
    parser.add_argument('--trade-id-high-water', type=int, default=0)
    parser.add_argument('--trade-id-end-high-water', type=int)
    parser.add_argument('--shadow-sha', default='')
    parser.add_argument('--poly2-checkout-sha', default='')
    parser.add_argument('--runtime-image-id')
    parser.add_argument('--runtime-revision')
    parser.add_argument('--max-trade-rows', type=int, default=MAX_TRADE_ROWS)
    parser.add_argument('--max-audit-rows', type=int, default=MAX_AUDIT_ROWS)
    args = parser.parse_args(argv)
    if args.mode == 'export' and not all((args.start_utc, args.end_utc, args.run_id, args.shadow_sha, args.poly2_checkout_sha, args.decision_log_end_high_water is not None, args.trade_id_end_high_water is not None)):
        parser.error('export requires start/end/run and software revisions')
    try:
        asyncio.run(main_async(args))
    except Exception as exc:
        print(json.dumps({'classification': 'UNCERTIFIED_DIAGNOSTIC', 'certified': False,
                          'error': type(exc).__name__, 'message': 'read-only export failed; details withheld'}, separators=(',', ':')), file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
