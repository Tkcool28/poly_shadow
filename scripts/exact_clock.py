"""Prospective timestamp amendment V1: strict integer microsecond authority.

Reject excess precision rather than datetime.fromisoformat's silent truncation.
Original serialized strings are never normalized.
"""
import datetime as dt
import re

PATTERN = re.compile(r'^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$', re.ASCII)
EPOCH = dt.datetime(1970, 1, 1)


def epoch_micros(value):
    if not isinstance(value, str):
        raise ValueError('clock: explicit timestamp required')
    m = PATTERN.fullmatch(value)
    if not m:
        raise ValueError('clock: strict explicit zone timestamp with at most microsecond precision required')
    year, month, day, hour, minute, second = map(int, m.groups()[:6])
    zone = m[8]
    zh, zm = (0, 0) if zone == 'Z' else (int(zone[1:3]), int(zone[4:6]))
    if zh > 15 or zm > 59 or zone == '-00:00':
        raise ValueError('clock: invalid/unknown zone')
    local = dt.datetime(year, month, day, hour, minute, second, int((m[7] or '').ljust(6, '0')))
    diff = local - EPOCH
    offset = (zh * 60 + zm) * (-1 if zone.startswith('-') else 1)
    return (diff.days * 86400 + diff.seconds - offset * 60) * 1000000 + diff.microseconds


def in_window(value, window):
    start, end = epoch_micros(window['startUtc']), epoch_micros(window['endUtc'])
    if end < start:
        raise ValueError('clock: reversed window')
    return start <= epoch_micros(value) <= end


def evidence(row, fields):
    return {k: {'original': row[k], 'epochMicros': str(epoch_micros(row[k]))}
            for k in fields if row.get(k) is not None}
