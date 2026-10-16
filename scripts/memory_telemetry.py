"""Bounded, read-only Linux memory-test telemetry. No provider or control calls."""
import json
import os
from pathlib import Path
import stat
import time

LABEL = 'MEMORY_VALIDATION_ONLY_NOT_SCIENTIFIC_COMPARISON'
GIB = 1024 ** 3
MAX_PIDS = 256
MAX_HOST_PIDS = 16384
EVIDENCE_FILES = ('raw_log_tombstones.ndjson','dispositions.ndjson','quarantine.ndjson','rpc_recoveries.ndjson','rpc_publications.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson','raw_logs.ndjson', 'observations.ndjson', 'source_observations.ndjson',
                  'rest_raw.ndjson', 'reconciliation.ndjson', 'poll_telemetry.ndjson',
                  'rest_poll_receipts.ndjson', 'rpc_lineage.ndjson', 'quarantine_v2.ndjson',
                  'quarantine_resolutions.ndjson', 'runtime_telemetry.ndjson',
                  'operational-index.sqlite', 'racing-index.sqlite', 'recovery-index.sqlite')


def bounded(path, limit=65536):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        if not stat.S_ISREG(os.fstat(fd).st_mode):
            raise ValueError('nonregular telemetry input')
        value = os.read(fd, limit + 1)
        if len(value) > limit:
            raise ValueError('telemetry input overflow')
        return value.decode()
    finally:
        os.close(fd)


def pairs(text, multiplier=1):
    return {p[0].rstrip(':'): int(p[1]) * multiplier for line in text.splitlines()
            if len(p := line.split()) >= 2 and p[1].isdigit()}


def psi(text):
    result = {}
    for line in text.splitlines():
        fields = line.split()
        result[fields[0]] = {k: float(v) for s in fields[1:] for k, v in [s.split('=')]}
    for kind in ('some', 'full'):
        for key in ('avg10', 'avg60', 'avg300', 'total'):
            value = result[kind][key]
            if not 0 <= value < float('inf'):
                raise ValueError('invalid PSI')
    return result


def host_snapshot(root=Path('/proc')):
    mem = pairs(bounded(root / 'meminfo'), 1024)
    events = pairs(bounded(root / 'vmstat'))
    return {'memAvailableBytes': mem['MemAvailable'], 'memTotalBytes': mem['MemTotal'],
            'swapTotalBytes': mem['SwapTotal'], 'swapFreeBytes': mem['SwapFree'],
            'oomKills': events['oom_kill'], 'psi': psi(bounded(root / 'pressure/memory'))}


def process_token(pid, root=Path('/proc')):
    fields = bounded(root / str(pid) / 'stat', 8192).rsplit(')', 1)[1].split()
    return {'pid': pid, 'state': fields[0], 'pgid': int(fields[2]),
            'session': int(fields[3]), 'startTicks': fields[19]}


def process_memory(pid, root=Path('/proc')):
    try:
        before = process_token(pid, root)
        try:
            values = pairs(bounded(root / str(pid) / 'smaps_rollup', 16384), 1024)
            rss, pss = values['Rss'], values['Pss']
        except (OSError, ValueError, KeyError):
            values = pairs(bounded(root / str(pid) / 'status', 16384), 1024)
            rss, pss = values.get('VmRSS'), None
        after = process_token(pid, root)
        if any(before[k] != after[k] for k in ('pid','pgid','session','startTicks')):
            raise ValueError('process changed during memory sample')
        return {**before, 'rssBytes': rss, 'pssBytes': pss}
    except (OSError, ValueError, KeyError, IndexError):
        return {'pid': pid, 'rssBytes': None, 'pssBytes': None, 'unavailable': True}


def cgroup_pids(leaf):
    pids = set()
    pending = [Path(leaf)]
    seen = 0
    while pending:
        directory = pending.pop()
        if directory.is_symlink():
            raise ValueError('cgroup symlink')
        seen += 1
        if seen > 32:
            raise ValueError('cgroup directory budget')
        pids.update(int(p) for p in bounded(directory / 'cgroup.procs', 16384).split())
        if len(pids) > MAX_PIDS:
            raise ValueError('observer process budget')
        for p in directory.iterdir():
            if p.is_symlink():
                raise ValueError('cgroup symlink')
            if p.is_dir():
                pending.append(p)
    return sorted(pids)


def observer_snapshot(leaf, root=Path('/proc')):
    pids = cgroup_pids(leaf)
    rows = [process_memory(pid, root) for pid in pids]
    rss = [r['rssBytes'] for r in rows if r['rssBytes'] is not None]
    pss = [r['pssBytes'] for r in rows if r['pssBytes'] is not None]
    return {'processes': rows, 'processCount': len(rows),
            'treeRssBytes': sum(rss) if len(rss) == len(rows) else None,
            'treePssBytes': sum(pss) if len(pss) == len(rows) else None,
            'availableRssSubtotalBytes': sum(rss), 'availablePssSubtotalBytes': sum(pss),
            'rssComplete': len(rss) == len(rows), 'pssComplete': len(pss) == len(rows),
            'memoryCurrentBytes': int(bounded(leaf / 'memory.current', 128)),
            'memoryPeakBytes': int(bounded(leaf / 'memory.peak', 128)),
            'swapCurrentBytes': int(bounded(leaf / 'memory.swap.current', 128)),
            'events': pairs(bounded(leaf / 'memory.events', 4096))}


def workloads(excluded=(), root=Path('/proc')):
    top = []
    count = 0
    excluded = set(excluded)
    for p in root.iterdir():
        if not p.name.isdigit():
            continue
        count += 1
        if count > MAX_HOST_PIDS:
            raise ValueError('host process budget')
        if int(p.name) in excluded:
            continue
        try:
            rss = pairs(bounded(p / 'status', 16384), 1024).get('VmRSS', 0)
            if rss >= 64 * 1024 ** 2:
                top.append({'pid': int(p.name), 'name': bounded(p / 'comm', 256).strip(),
                            'rssBytes': rss})
                top = sorted(top, key=lambda r: r['rssBytes'], reverse=True)[:12]
        except OSError:
            continue  # disappearing/inaccessible unrelated workload, never invent zero
    return {'topRssProcesses': top, 'selection': 'top 12 readable processes >=64MiB RSS; no argv/env',
            'enumeratedProcesses': count}


def disk_snapshot(path):
    s = os.statvfs(path)
    return {'freeBytes': s.f_bavail * s.f_frsize, 'capacityBytes': s.f_blocks * s.f_frsize}


def evidence_snapshot(directory):
    sizes = {}
    names = list(EVIDENCE_FILES) + [n + suffix for n in EVIDENCE_FILES if n.endswith('.sqlite') for suffix in ('-wal','-shm')]
    for name in names:
        path = directory / name
        try:
            s = path.lstat()
            if not stat.S_ISREG(s.st_mode):
                raise ValueError('nonregular evidence')
            sizes[name] = s.st_size
        except FileNotFoundError:
            sizes[name] = 0
    runtime = None
    path = directory / 'runtime-memory.json'
    try:
        value = json.loads(bounded(path, 262144))
        op = value.get('operationalEvidence') or {}
        runtime = {'token': value.get('token'), 'publisher': value.get('publisher'),
                   'operationalSinkBroken': value.get('operationalSinkBroken'),
                   'failureClass': value.get('failureClass'), 'dataQuality': value.get('dataQuality'),
                   'streams': op.get('streams'), 'chain': op.get('chain'), 'rest': op.get('rest'),
                   'runtimeMtime': path.stat().st_mtime}
    except FileNotFoundError:
        pass
    return {'fileBytes': sizes, 'totalSelectedBytes': sum(sizes.values()), 'acquisition': runtime}


def pressure_failure(host, original, disk, observer=None, prior_events=None, psi_streak=0):
    if disk['freeBytes'] < 10 * GIB + 32 * 1024 ** 2:
        return 'DISK_RESERVE', psi_streak
    if host['oomKills'] > original['oomKills']:
        return 'HOST_OOM', psi_streak
    if host['memAvailableBytes'] < GIB:
        return 'HOST_MEMAVAILABLE', psi_streak
    if host['swapTotalBytes'] and host['swapFreeBytes'] < 256 * 1024 ** 2 and host['memAvailableBytes'] < 2 * GIB:
        return 'HOST_SWAP_PRESSURE', psi_streak
    psi_streak = psi_streak + 1 if host['psi']['full']['avg10'] >= 10 or host['psi']['some']['avg10'] >= 50 else 0
    if psi_streak >= 2:
        return 'HOST_PSI', psi_streak
    if observer is not None and prior_events is not None:
        for key in ('max', 'oom', 'oom_kill'):
            if observer['events'][key] > prior_events[key]:
                return 'OBSERVER_' + key.upper(), psi_streak
    return None, psi_streak
