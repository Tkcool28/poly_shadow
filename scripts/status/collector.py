#!/usr/bin/env python3
"""Read-only operational snapshot; no observer/runtime CLI, science, or control actions.
Run with Python stdlib. Only public output is the atomic status.json; private
health/growth cache and lock live outside the sealed experiment in scratch.
Every evidence read and receipt is bounded to 128 KiB; raw CHAIN is stat-only.
"""
import datetime as dt
import fcntl
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

RUN = Path('/opt/poly-shadow/runs/phase4-real-20261006T091721Z-controlled')
OUTPUT = Path('/var/www/poly-shadow-status/status.json')
CACHE = Path('/root/.hermes/cache/scratch/poly-shadow-status-state.json')
LIMIT = 128 * 1024
START = dt.datetime(2026, 10, 6, 10, tzinfo=dt.timezone.utc).timestamp()
END = dt.datetime(2026, 10, 7, 10, tzinfo=dt.timezone.utc).timestamp()
SHA = '54d8ee34ad4098b843ed62b362c6bf4a47244398'
SOURCES = ('CHAIN', 'REST_TRADES', 'REST_ACTIVITY')
FILES = ('raw_logs.ndjson', 'source_observations.ndjson', 'rest_raw.ndjson', 'poll_telemetry.ndjson')
CODES = {'END_WINDOW_COMPLETE', 'MISSED_START', 'OBSERVER_EXITED_EARLY', 'SIGNAL_TERMINATION', 'PRESTART_GATE_FAILED', 'WINDOW_SEAL_FAILED', 'OBSERVER_START_FAILED', 'CLEANUP_FAILED', 'EVIDENCE_MISSING', 'REPORT_FAILED', 'INTERNAL_ERROR'}


def utc(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def epoch(value):
    try:
        parsed = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        return parsed.timestamp() if parsed.tzinfo else None
    except (ValueError, TypeError, AttributeError, OverflowError):
        return None


def safe_stat(path):
    try:
        s = path.lstat()
        return s if stat.S_ISREG(s.st_mode) else None
    except OSError:
        return None


def read_bytes(path, tail=False):
    """Single bounded read, reject symlinks/nonregular files, detect growth races."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, 'rb') as stream:
            s = os.fstat(stream.fileno())
            if not stat.S_ISREG(s.st_mode) or (not tail and s.st_size > LIMIT):
                return None, False
            offset = max(0, s.st_size - LIMIT) if tail else 0
            stream.seek(offset)
            data = stream.read(min(LIMIT, s.st_size))
            complete = offset == 0 and len(data) == s.st_size and os.fstat(stream.fileno()).st_size == s.st_size
            if offset:
                # Discard first possibly-partial row, even if offset hits a boundary.
                data = data.partition(b'\n')[2]
            return data, complete
    except OSError:
        return None, False


def obj(path):
    data, complete = read_bytes(path)
    try:
        value = json.loads(data) if complete else None
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError, UnicodeError):
        return {}


def tail_rows(path):
    data, complete = read_bytes(path, tail=True)
    if data is None:
        return [], False, 0
    rows = []
    for line in data.splitlines():
        if not line.strip():
            continue
        try:
            value = json.loads(line)
            if isinstance(value, dict):
                rows.append(value)
            else:
                complete = False
        except (ValueError, UnicodeError):
            complete = False
    return rows, complete, len(data)


def proc(pid):
    if not isinstance(pid, int) or pid <= 0:
        return None
    try:
        data, _ = read_bytes(Path('/proc') / str(pid) / 'stat')
        # procfs stat has size zero; special bounded read, never arbitrary proc data.
        if not data:
            with open(f'/proc/{pid}/stat', 'rb') as stream:
                data = stream.read(4096)
        fields = data.decode().rsplit(')', 1)[1].split()
        return {'pid': pid, 'state': fields[0], 'ppid': int(fields[1]),
                'pgid': int(fields[2]), 'session': int(fields[3]), 'startTicks': fields[19]}
    except (OSError, ValueError, IndexError, UnicodeError):
        return None


def process_status(token):
    if not isinstance(token, dict) or not isinstance(token.get('pid'), int):
        return {'pid': None, 'alive': None, 'identityVerified': False, 'state': 'not launched / unknown'}
    p = proc(token['pid'])
    verified = bool(p and token.get('startTicks') is not None and str(token['startTicks']) == p['startTicks']
                    and all(token.get(k) == p[k] for k in ('pgid', 'session') if k in token))
    return {'pid': token['pid'], 'alive': verified and p['state'] not in ('Z', 'X'),
            'identityVerified': verified, 'state': p['state'] if verified else 'not alive / identity mismatch'}


def guardian_token(runner, orchestration, launch):
    # Only recorded tokens: never enumerate unrelated PIDs or read cmdline/env.
    recorded = orchestration.get('guardian', {})
    return recorded if isinstance(recorded, dict) and recorded.get('pid') == launch.get('guardianPid') else {}


def atomic_json(path, data, mode=0o600):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix='.' + path.name + '.', dir=path.parent)
    try:
        os.fchmod(fd, mode)
        with os.fdopen(fd, 'w') as stream:
            json.dump(data, stream, separators=(',', ':'), allow_nan=False)
            stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
        os.replace(name, path)
    finally:
        if os.path.exists(name):
            os.unlink(name)


def production_health():
    # Standalone operational asset deliberately does not import the runner's
    # production helper (which can read environment/config material).
    return {'status': 'unknown', 'checkedUtc': utc(time.time())}


def reduce_health(health, now):
    result = {'status': health.get('status') if health.get('status') in ('healthy', 'warning', 'unknown') else 'unknown',
              'checkedUtc': utc(epoch(health.get('checkedUtc'))) if epoch(health.get('checkedUtc')) is not None else utc(now)}
    for key in ('baselineUnchanged', 'paperBaseline', 'paperMode', 'liveTradingDisabled', 'serviceHealthy'):
        result[key] = health.get(key) if type(health.get(key)) is bool else None
    for key in ('latestBotAliveUtc', 'latestBotSuccessUtc'):
        timestamp = epoch(health.get(key))
        result[key] = utc(timestamp) if timestamp is not None else None
    return result


def terminal(run):
    path = run / 'execution-receipt.json'
    raw, complete = read_bytes(path)
    committed = False
    receipt = {}
    if complete and raw is not None and not (run / 'REPORT_FAILED.json').exists():
        try:
            parsed = json.loads(raw)
            sha = hashlib.sha256(raw).hexdigest()
            committed = (obj(run / 'execution-receipt.sha256.json').get('sha256') == sha == obj(run / 'REPORT_COMMITTED.json').get('sha256'))
            if isinstance(parsed, dict):
                receipt = parsed
        except (ValueError, UnicodeError):
            pass
    code = receipt.get('classification')
    reason = receipt.get('canonicalFailureReason')
    restart = receipt.get('restartCount')
    return {'present': path.exists(), 'bindingValid': committed,
            'classification': code if code in CODES else None,
            'exitReason': reason if reason in CODES else None,
            'restartCount': restart if type(restart) is int and restart >= 0 else None,
            'completedLifecycleOnly': committed and code == 'END_WINDOW_COMPLETE'}


def memory_status(run, observer_token, now):
    fields = ('rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes',
              'cgroupUsageBytes', 'cgroupLimitBytes', 'inflight', 'retryQueue',
              'replayRows', 'filteredLogs', 'blockCache', 'matchedCache', 'aggregateCache',
              'indexRows', 'racingIndexRows', 'exclusiveDepth')
    result: dict = {k: None for k in fields}
    result.update(status='unknown', pressureRatio=None, sampledUtc=None, ageSeconds=None,
                  lastProgressUtc=None, progressAgeSeconds=None, replayActive=None,
                  identityVerified=False, warnings=[], scope='verified runtime snapshot; cgroup usage includes all members/cache, not heap')
    for prefix in ('index', 'racingIndex'):
        for suffix in ('Invalid', 'RebuildActive', 'File', 'LastProgressUtc', 'ProgressAgeSeconds'):
            result[prefix + suffix] = None
    row = obj(run / 'shadow-data/runtime-memory.json')
    stamp = epoch(row.get('atUtc'))
    token = row.get('token', {})
    if not isinstance(token, dict) or not isinstance(observer_token, dict):
        return result
    # Verify both launch identity and runtime start ticks, then bounded ancestry.
    if not process_status(observer_token).get('alive') or not process_status(token).get('alive'):
        return result
    p = proc(token.get('pid'))
    related = False
    for _ in range(8):
        if not p or p['pgid'] != observer_token.get('pgid') or p['session'] != observer_token.get('session'):
            break
        if p['pid'] == observer_token.get('pid'):
            related = True; break
        p = proc(p['ppid'])
    if not related or not process_status(token).get('alive'):
        return result
    result['identityVerified'] = True
    if stamp is None or not 0 <= now-stamp <= 30:
        result['warnings'].append('runtime memory telemetry stale or unavailable; progress unknown')
        return result
    result.update(status='available', sampledUtc=utc(stamp), ageSeconds=now-stamp)
    for k in fields:
        v = row.get(k)
        if type(v) is int and 0 <= v <= 2**53-1:
            result[k] = v
    usage, limit = result['cgroupUsageBytes'], result['cgroupLimitBytes']
    if usage is not None and limit is not None and limit > 0:
        result['pressureRatio'] = usage / limit
        if usage / limit >= .95:
            result['warnings'].append('cgroup memory usage >= 95% of actual limit')
        elif usage / limit >= .85:
            result['warnings'].append('cgroup memory usage >= 85% of actual limit')
    else:
        result['warnings'].append('cgroup memory pressure unknown (usage/finite limit unavailable)')
    progress = epoch(row.get('lastProgressUtc'))
    if progress is not None and progress <= now:
        result.update(lastProgressUtc=utc(progress), progressAgeSeconds=now-progress)
    result['replayActive'] = row.get('replayActive') if type(row.get('replayActive')) is bool else None
    index_files = {'raw_logs.ndjson', 'raw_log_tombstones.ndjson', 'observations.ndjson',
                   'dispositions.ndjson', 'quarantine.ndjson', 'rest_raw.ndjson',
                   'source_observations.ndjson', 'reconciliation.ndjson'}
    for prefix, label in (('index', 'index'), ('racingIndex', 'racing index')):
        invalid = row.get(prefix + 'Invalid')
        result[prefix + 'Invalid'] = invalid if type(invalid) is bool else None
        if invalid is True:
            result['warnings'].append(label + ' invalid; fail-stopped until authorized reopen/rebuild')
        active = row.get(prefix + 'RebuildActive')
        result[prefix + 'RebuildActive'] = active if type(active) is bool else None
        filename = row.get(prefix + 'File')
        result[prefix + 'File'] = filename if isinstance(filename, str) and filename in index_files else None
        progress = epoch(row.get(prefix + 'LastProgressUtc'))
        if progress is not None and progress <= now:
            result[prefix + 'LastProgressUtc'] = utc(progress)
            result[prefix + 'ProgressAgeSeconds'] = now - progress
            if active is True and now - progress > 90:
                result['warnings'].append(label + ' rebuild progress stalled > 90s')
    if result['replayActive'] and result['progressAgeSeconds'] is not None and result['progressAgeSeconds'] > 90:
        result['warnings'].append('replay progress stalled > 90s')
    for k in ('inflight', 'retryQueue'):
        if result[k] is not None and result[k] >= 230:
            result['warnings'].append(k + ' near bounded capacity 256')
    return result


def collect(run=RUN, now=None, cache_path=CACHE, health_provider=production_health):
    now = time.time() if now is None else now
    cache = obj(cache_path)
    warnings = []
    start_receipt = obj(run / 'runner-start.json')
    orchestration = obj(run / 'launch-orchestration-receipt.json')
    launch = obj(run / 'launch-receipt.json')
    tokens = {'runner': start_receipt.get('runner', {}),
              'observer': launch.get('childToken', {})}
    tokens['guardian'] = guardian_token(tokens['runner'], orchestration, launch)
    processes = {name: process_status(token) for name, token in tokens.items()}
    memory = memory_status(run, tokens['observer'], now)
    warnings.extend(memory['warnings'])
    report = terminal(run)
    report['restartCountSource'] = 'terminal receipt' if report['restartCount'] is not None else 'unknown'
    if report['restartCount'] is None and type(start_receipt.get('restartCount')) is int and start_receipt['restartCount'] >= 0:
        report['restartCount'] = start_receipt['restartCount']
        report['restartCountSource'] = 'runner start receipt'
    active = START <= now < END
    state = 'SEALED' if now < START else 'RUNNING'
    if report['bindingValid']:
        state = 'COMPLETE' if report['completedLifecycleOnly'] else 'FAILED'
    elif report['present'] or (run / 'REPORT_FAILED.json').exists():
        state = 'FAILED'; warnings.append('terminal receipt unverified')
    elif active and now > START + 5 and not processes['observer']['alive']:
        state = 'FAILED'; warnings.append('observer not verified alive')
    elif now >= END:
        state = 'FAILED'; warnings.append('window ended; committed terminal receipt missing')
    if state in ('SEALED', 'RUNNING'):
        for name in ('runner', 'guardian'):
            if processes[name]['alive'] is not True:
                warnings.append(name + ' not verified alive')
    heartbeat, _, heartbeat_read = tail_rows(run / 'heartbeat.ndjson')
    last_beat = max((epoch(row.get('utc')) for row in heartbeat if epoch(row.get('utc')) is not None), default=None)
    beat_age = max(0, now-last_beat) if last_beat is not None else None
    if active and (beat_age is not None and beat_age > 90 or beat_age is None and now > START+90):
        warnings.append('heartbeat stale')
    inventory = []
    sizes = {}
    for name in FILES:
        s = safe_stat(run / 'shadow-data' / name)
        sizes[name] = s.st_size if s else 0
        inventory.append({'file': name, 'present': s is not None, 'bytes': s.st_size if s else None})
    required_total = sum(sizes.values())
    try:
        total = 0
        with os.scandir(run / 'shadow-data') as entries:
            for i, entry in enumerate(entries):
                if i >= 4096:
                    total = None; warnings.append('evidence inventory exceeds bounded 4096 entries; total unknown'); break
                s = safe_stat(Path(entry.path))
                if s is not None:
                    total += s.st_size
    except OSError:
        total = None
    growth = None
    sample_seconds = None
    previous = cache.get('growth', {})
    prior_time = epoch(previous.get('utc'))
    if prior_time is not None and 60 < now-prior_time < 3600 and isinstance(previous.get('sizes'), dict):
        sample_seconds = round(now-prior_time, 1)
        growth = required_total - sum(previous['sizes'].get(k, 0) for k in FILES)
        if active and now > START+120 and prior_time >= START and growth <= 0:
            warnings.append('evidence not growing')
    if prior_time is None or now-prior_time > 60 or now < prior_time:
        cache['growth'] = {'utc': utc(now), 'sizes': sizes}
    observations, _, obs_read = tail_rows(run / 'shadow-data/source_observations.ndjson')
    polls, polls_complete, polls_read = tail_rows(run / 'shadow-data/poll_telemetry.ndjson')
    rest, _, rest_read = tail_rows(run / 'shadow-data/rest_raw.ndjson')
    sources = []
    for source in SOURCES:
        latest = max((epoch(row.get('completedUtc') or row.get('firstSeenUtc') or row.get('sourceFirstSeenUtc'))
                      for row in observations if row.get('source') == source and epoch(row.get('completedUtc') or row.get('firstSeenUtc') or row.get('sourceFirstSeenUtc')) is not None), default=None)
        source_polls = [row for row in polls if row.get('source') == source]
        latest_poll = max((epoch(row.get('atUtc') or row.get('responseUtc')) for row in source_polls if epoch(row.get('atUtc') or row.get('responseUtc')) is not None), default=None)
        latest_raw = max((epoch(row.get('firstSeenUtc')) for row in rest if row.get('source') == source and epoch(row.get('firstSeenUtc')) is not None), default=None)
        recent = [row for row in source_polls if epoch(row.get('atUtc') or row.get('responseUtc')) is not None and now-60 <= epoch(row.get('atUtc') or row.get('responseUtc')) <= now]
        errors = sum(bool(row.get('error')) or (isinstance(row.get('httpStatus'), int) and row['httpStatus'] >= 400) for row in recent)
        presence = 'not expected before start' if now < START else ('seen in bounded tail' if latest is not None or latest_poll is not None or latest_raw is not None else 'unknown; absent from bounded tail')
        sources.append({'source': source, 'presence': presence, 'latestObservationUtc': utc(latest) if latest is not None else None,
                        'latestPollUtc': utc(latest_poll) if latest_poll is not None else None,
                        'latestRestRawUtc': utc(latest_raw) if latest_raw is not None else None,
                        'recentErrorCount': errors if source != 'CHAIN' else None,
                        'recentPollSampleCount': len(recent) if source != 'CHAIN' else None,
                        'errorScope': 'last minute; bounded poll telemetry tail, not a full-file count' if source != 'CHAIN' else 'not evaluated',
                        'pollFileFullyRead': polls_complete if source != 'CHAIN' else None})
    quarantine_path = run / 'shadow-data/quarantine.ndjson'
    quarantine, q_complete, q_read = tail_rows(quarantine_path)
    q_absent = False
    try:
        quarantine_path.lstat()
    except FileNotFoundError:
        q_absent = (run / 'shadow-data').is_dir()
    except OSError:
        pass
    recovery = True if any(row.get('recoveryRequired') is True or
                          (isinstance(row.get('detail'), dict) and row['detail'].get('recoveryRequired') is True)
                          for row in quarantine) else (False if q_complete or q_absent else None)
    if recovery is True:
        warnings.append('recovery-required flag observed')
    health = cache.get('health', {})
    health = health if isinstance(health, dict) else {}
    checked = epoch(health.get('checkedUtc'))
    if checked is None or not 0 <= now-checked < 60:
        try:
            health = health_provider()
        except Exception:
            health = {'status': 'unknown', 'checkedUtc': utc(now), 'baselineUnchanged': None, 'paperBaseline': None}
    # Strict reduction on both cached and injectable-provider values.
    health = health if isinstance(health, dict) else {}
    health = reduce_health(health, now)
    cache['health'] = health
    health = dict(health)
    health['ageSeconds'] = max(0, now-epoch(health['checkedUtc']))
    if health['ageSeconds'] > 90:
        health['status'] = 'unknown'
    if health['status'] != 'healthy':
        warnings.append('Poly2 health ' + health['status'])
    disk_path = run if run.exists() else run.parent
    disk = os.statvfs(disk_path)
    free = disk.f_bavail * disk.f_frsize
    if free < 10*1024**3:
        warnings.append('disk free below 10 GiB')
    atomic_json(cache_path, cache)
    return {'schemaVersion': 1, 'generatedUtc': utc(now), 'experimentId': run.name,
            'shadowSha': SHA, 'state': state, 'scope': 'Operational status only. COMPLETE means lifecycle completion only.',
            'window': {'startUtc': utc(START), 'endUtc': utc(END),
                       'startMdt': dt.datetime.fromtimestamp(START, ZoneInfo('America/Denver')).strftime('%Y-%m-%d %H:%M %Z'),
                       'endMdt': dt.datetime.fromtimestamp(END, ZoneInfo('America/Denver')).strftime('%Y-%m-%d %H:%M %Z'),
                       'elapsedSeconds': round(max(0, min(END-START, now-START))),
                       'remainingSeconds': round(max(0, END-max(START, now))),
                       'startsInSeconds': round(max(0, START-now)), 'durationSeconds': int(END-START)},
            'processes': processes, 'terminal': report, 'memory': memory,
            'heartbeat': {'latestUtc': utc(last_beat) if last_beat is not None else None, 'ageSeconds': round(beat_age, 1) if beat_age is not None else None,
                          'scope': 'bounded tail; no continuity claim'},
            'evidence': {'files': inventory, 'totalBytes': total, 'requiredBytes': required_total, 'growthBytes': growth, 'sampleSeconds': sample_seconds,
                         'scope': 'total: all regular direct shadow-data files, stat-only; growth: four required files only; shared sizes are not per-source counts; CHAIN raw stat-only'},
            'sources': sources, 'quarantine': {'count': len(quarantine) if q_complete or q_absent else None,
                        'sampleCount': len(quarantine), 'scope': 'file absent' if q_absent else 'complete file' if q_complete else 'bounded tail; full count unknown', 'recoveryRequired': recovery},
            'poly2': health, 'disk': {'availableBytes': free, 'warningThresholdBytes': 10*1024**3},
            'boundedReads': {'maxBytesPerEvidenceFile': LIMIT, 'heartbeatBytes': heartbeat_read, 'sourceObservationBytes': obs_read,
                             'pollTelemetryBytes': polls_read, 'restRawBytes': rest_read, 'quarantineBytes': q_read, 'chainRawBytes': 0},
            'warnings': warnings}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, default=RUN)
    parser.add_argument('--output', type=Path, default=OUTPUT)
    parser.add_argument('--cache', type=Path, default=CACHE)
    args = parser.parse_args()
    args.cache.parent.mkdir(parents=True, exist_ok=True)
    with (args.cache.parent / (args.cache.name + '.lock')).open('a') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print('{"collector":"already running"}')
            return 0
        result = collect(run=args.run, cache_path=args.cache)
        atomic_json(args.output, result, 0o644)
        print(json.dumps({'state': result['state'], 'warnings': result['warnings'],
                          'pids': {k:v['pid'] for k,v in result['processes'].items()},
                          'poly2': result['poly2']['status'], 'boundedReads': result['boundedReads']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
