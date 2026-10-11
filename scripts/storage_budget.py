"""Read-only deterministic engineering disk envelope, not scientific authority."""
import json
import math
import os
from pathlib import Path

PLAN_PATH = Path(__file__).resolve().parents[1] / 'docs/shadow/storage-budget-v2.json'

def plan():
    return json.loads(PLAN_PATH.read_text())

def budget(seconds=None):
    p = plan()
    seconds = p['windowSeconds'] + p['maximumDrainGraceSeconds'] if seconds is None else seconds
    if type(seconds) is not int or seconds < 0:
        raise ValueError('invalid storage horizon')
    families = {k: dict(expectedBytes=math.ceil(r['expectedBytesPerSecond']*seconds), upperBytes=math.ceil(r['upperBytesPerSecond']*seconds)) for k, r in p['families'].items()}
    expected = sum(r['expectedBytes'] for r in families.values())
    upper = sum(r['upperBytes'] for r in families.values())
    margin = math.ceil(upper*p['marginRatio'])
    return dict(seconds=seconds, families=families, expectedBytes=expected, upperBytes=upper, marginBytes=margin,
                reserveBytes=p['alertReserveBytes'], requiredFreeBytes=upper+margin+p['alertReserveBytes'])

def disk_state(available, capacity=None, seconds=None):
    b = budget(seconds)
    state = 'UNKNOWN' if available is None else 'AT_RISK' if available < b['reserveBytes'] else 'DEGRADED' if available < b['requiredFreeBytes'] else 'GREEN'
    return dict(b, state=state, availableBytes=available, capacityBytes=capacity,
                usePercent=100*(1-available/capacity) if available is not None and capacity else None)

def prelaunch_gate(path, statvfs=os.statvfs):
    p = Path(path)
    while not p.exists() and p != p.parent:
        p = p.parent
    s = statvfs(p)
    result = disk_state(s.f_bavail*s.f_frsize, s.f_blocks*s.f_frsize)
    if result['state'] != 'GREEN':
        raise ValueError('PRELAUNCH_DISK_GATE: available=%s required=%s' % (result['availableBytes'], result['requiredFreeBytes']))
    return result
