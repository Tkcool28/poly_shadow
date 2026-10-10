#!/usr/bin/env python3
"""Read-only operational snapshot; no observer/runtime CLI, science, or control actions.
Run with Python stdlib. Only public output is the atomic status.json; private
health/growth cache and lock live outside the sealed experiment in scratch.
Every evidence read and receipt is bounded to 128 KiB; raw CHAIN is stat-only.
"""
import datetime as dt
import fcntl
import hashlib
import json
import os
from pathlib import Path
import types
_CLOCK_PATH = Path(__file__).resolve().parents[1] / 'exact_clock.py'
_CLOCK = types.ModuleType('status_exact_clock')
exec(compile(_CLOCK_PATH.read_bytes(), str(_CLOCK_PATH), 'exec', dont_inherit=True), _CLOCK.__dict__)
epoch_micros = _CLOCK.epoch_micros
_BUDGET_PATH = Path(__file__).resolve().parents[1] / 'storage_budget.py'
_BUDGET = types.ModuleType('status_storage_budget')
_BUDGET.__file__ = str(_BUDGET_PATH)
exec(compile(_BUDGET_PATH.read_bytes(), str(_BUDGET_PATH), 'exec', dont_inherit=True), _BUDGET.__dict__)

import stat
import sys
import tempfile
import time
from zoneinfo import ZoneInfo

RUNS_ROOT = Path('/opt/poly-shadow/runs')
POINTER = Path('/var/lib/poly-shadow/current-run.json')
OUTPUT = Path('/var/www/poly-shadow-status/status.json')
CACHE = Path('/root/.hermes/cache/scratch/poly-shadow-status-state.json')
LIMIT = 128 * 1024
WINDOW_SECONDS = 86400
SOURCES = ('CHAIN', 'REST_TRADES', 'REST_ACTIVITY')
FILES = ('raw_logs.ndjson', 'source_observations.ndjson', 'rest_raw.ndjson', 'poll_telemetry.ndjson')
CODES = {'END_WINDOW_COMPLETE', 'MISSED_START', 'OBSERVER_EXITED_EARLY', 'SIGNAL_TERMINATION', 'PRESTART_GATE_FAILED', 'WINDOW_SEAL_FAILED', 'OBSERVER_START_FAILED', 'CLEANUP_FAILED', 'EVIDENCE_MISSING', 'REPORT_FAILED', 'INTERNAL_ERROR', 'EVIDENCE_SINK_FAILURE'}


def utc(t):
    return dt.datetime.fromtimestamp(t, dt.timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')


def epoch(value):
    try:
        return epoch_micros(value) / 1000000 # diagnostic units only
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
        safe_path(path)
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
    except (OSError, ValueError, TypeError):
        return None, False


def safe_path(path):
    path = Path(path)
    if not path.is_absolute() or '..' in path.parts:
        raise ValueError('unsafe path')
    if any(p.is_symlink() for p in (path, *path.parents)):
        raise ValueError('symlink path')
    return path


def strict_pairs(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate key')
        result[key] = value
    return result


def reject_constant(value):
    raise ValueError('nonfinite JSON')


def finite_float(value):
    import math
    result = float(value)
    if not math.isfinite(result):
        raise ValueError('nonfinite JSON number')
    return result


def obj(path):
    try:
        safe_path(path)
        data, complete = read_bytes(path)
        value = json.loads(data, object_pairs_hook=strict_pairs,
                           parse_constant=reject_constant, parse_float=finite_float) if complete and data is not None else None
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError, UnicodeError):
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
    control = obj(run / 'shadow-data/operational-failure.json')
    if control.get('code') == 'EVIDENCE_SINK_FAILURE' and control.get('operationalSinkBroken') is True:
        row = control
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
    result['operationalSinkBroken'] = row.get('operationalSinkBroken') if type(row.get('operationalSinkBroken')) is bool else None
    result['failureClass'] = ('EVIDENCE_SINK_FAILURE' if result['operationalSinkBroken'] is True
                              else row.get('failureClass') if row.get('failureClass') == 'SOURCE_FAILURE' else None)
    sink = row.get('operationalSink')
    result['operationalSink'] = ({k: sink.get(k) for k in ('state', 'code', 'file', 'error')}
                                 if isinstance(sink, dict) and sink.get('state') in ('READY', 'BROKEN') else None)
    if result['operationalSinkBroken'] is True:
        result['dataQuality'] = {'state': 'AT_RISK', 'rules': ['EVIDENCE_SINK_FAILURE']}
        result['warnings'].append('EVIDENCE_SINK_FAILURE')
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
    quality = row.get('dataQuality')
    if result['operationalSinkBroken'] is not True:
        result['dataQuality'] = quality if isinstance(quality, dict) and quality.get('state') in ('GREEN', 'DEGRADED', 'AT_RISK', 'UNKNOWN') else None
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


def unknown_memory():
    # Same public whitelist as a missing snapshot, without touching evidence/proc.
    result = {k: None for k in ('rssBytes', 'heapUsedBytes', 'heapTotalBytes', 'externalBytes',
              'cgroupUsageBytes', 'cgroupLimitBytes', 'inflight', 'retryQueue',
              'replayRows', 'filteredLogs', 'blockCache', 'matchedCache', 'aggregateCache',
              'indexRows', 'racingIndexRows', 'exclusiveDepth', 'pressureRatio', 'sampledUtc',
              'ageSeconds', 'lastProgressUtc', 'progressAgeSeconds', 'replayActive')}
    for prefix in ('index', 'racingIndex'):
        for suffix in ('Invalid', 'RebuildActive', 'File', 'LastProgressUtc', 'ProgressAgeSeconds'):
            result[prefix + suffix] = None
    result.update(status='unknown', identityVerified=False, warnings=[],
                  scope='verified runtime snapshot; cgroup usage includes all members/cache, not heap')
    return result


def utc_epoch(value):
    if not isinstance(value, str):
        raise ValueError('UTC timestamp required')
    return epoch_micros(value) / 1000000 # display/scheduling, never binding authority


def binding_context(run, pointer_path, runs_root):
    """Read-only binding, not launch authority. Only AUTHORIZED pointer state accepted.

    Manifest remains immutable SEALED_NOT_STARTED after launch; terminal markers
    and the window determine inactivity. No ledger hashing or index rebuild here.
    """
    import re
    explicit = run is not None
    try:
        root = safe_path(runs_root)
        pointer = {}
        if not explicit:
            p = safe_path(pointer_path)
            if not p.exists():
                return None, 'NO_ACTIVE_RUN'
            pointer = obj(p)
            fields = {'schemaVersion', 'runDirectory', 'runId', 'approvedShadowSha',
                      'startUtc', 'endUtc', 'lifecycleState'}
            if set(pointer) != fields or type(pointer.get('schemaVersion')) is not int or pointer['schemaVersion'] != 1 or pointer.get('lifecycleState') != 'AUTHORIZED':
                raise ValueError('pointer schema/state')
            run = pointer.get('runDirectory')
            if not isinstance(run, str):
                raise ValueError('directory required')
        run = safe_path(run)
        if run.parent != root or not re.fullmatch(r'phase4-[A-Za-z0-9_-]+', run.name) or not run.is_dir():
            raise ValueError('run outside configured root')
        if (run / 'INVALID').exists() or (run / 'INVALID').is_symlink():
            raise ValueError('invalid seal')
        safe_path(run / 'shadow-data')
        manifest = obj(run / 'run-manifest.json')
        sha = manifest.get('shadowSha')
        window = manifest.get('window', {})
        if not isinstance(window, dict) or not isinstance(sha, str) or not re.fullmatch(r'[0-9a-f]{40}', sha):
            raise ValueError('manifest SHA/window')
        start, end = utc_epoch(window.get('startUtc')), utc_epoch(window.get('endUtc'))
        if manifest.get('state') != 'SEALED_NOT_STARTED' or manifest.get('experimentDirectory') != str(run) or type(manifest.get('durationSeconds')) is not int or manifest['durationSeconds'] != WINDOW_SECONDS or epoch_micros(window['endUtc'])-epoch_micros(window['startUtc']) != WINDOW_SECONDS * 1000000:
            raise ValueError('manifest mismatch')
        if not explicit and (pointer.get('runId') != run.name or pointer.get('approvedShadowSha') != sha or epoch_micros(pointer.get('startUtc')) != epoch_micros(window['startUtc']) or epoch_micros(pointer.get('endUtc')) != epoch_micros(window['endUtc'])):
            raise ValueError('pointer mismatch')
        return {'run': run, 'start': start, 'end': end, 'sha': sha, 'explicit': explicit, 'window': window}, 'VALID'
    except (OSError, ValueError, TypeError, OverflowError):
        return None, 'INVALID_BINDING'


def unbound_status(now, state):
    return {'schemaVersion': 1, 'generatedUtc': utc(now), 'experimentId': None,
            'shadowSha': None, 'state': state, 'currentActive': False, 'currentInactive': True,
            'historical': False, 'binding': {'status': state, 'mode': 'current', 'runDirectory': None},
            'scope': 'Operational status only; no observer activation.',
            'window': {k: None for k in ('startUtc', 'endUtc', 'startMdt', 'endMdt', 'elapsedSeconds', 'remainingSeconds', 'startsInSeconds', 'durationSeconds')},
            'processes': {k: process_status({}) for k in ('runner', 'guardian', 'observer')},
            'memory': unknown_memory(), 'terminal': {'restartCount': None, 'classification': None, 'exitReason': None, 'bindingValid': False},
            'heartbeat': {'latestUtc': None, 'ageSeconds': None},
            'evidence': {'files': [], 'totalBytes': None, 'growthBytes': None, 'sampleSeconds': None},
            'sources': [], 'quarantine': {'count': None, 'sampleCount': 0, 'scope': 'unbound; unknown', 'recoveryRequired': None},
            'poly2': dict(reduce_health({}, now), ageSeconds=None), 'disk': {'availableBytes': None},
            'boundedReads': {'maxBytesPerEvidenceFile': LIMIT, 'chainRawBytes': 0},
            'warnings': [state + ': no trusted current run; telemetry unknown']}


def poly2_capture_status(run, start, end, now, window=None):
    """Bounded diagnostic only; never turns a cached health row into source proof."""
    from decimal import Decimal
    start_exact = epoch_micros(window['startUtc']) if window else int(Decimal(str(start)) * 1000000)
    end_exact = epoch_micros(window['endUtc']) if window else int(Decimal(str(end)) * 1000000)
    path = run / 'poly2-comparison-capture/poly2_capture_health.json'
    unknown = {'state': 'NOT_ARMED', 'quality': 'UNKNOWN_UNPROVEN',
               'lastSuccessUtc': None, 'cursor': None, 'endCoverage': False,
               'failures': None, 'gaps': None, 'count': None, 'error': None,
               'scope': 'prospective capture diagnostic; not producer/cursor proof'}
    if not path.exists():
        return unknown
    value = obj(path)
    bound = value.get('binding', {})
    try:
        canonical_binding = json.dumps(bound, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
        valid = (value.get('version') == 1 and bound.get('shadowRunId') == run.name
                 and epoch_micros(bound.get('window', {}).get('startUtc')) == start_exact
                 and epoch_micros(bound.get('window', {}).get('endUtc')) == end_exact
                 and value.get('bindingSha256') == hashlib.sha256(canonical_binding.encode()).hexdigest()
                 and len(bound.get('cohort', [])) == 5
                 and len(set(bound.get('cohort', []))) == 5
                 and value.get('state') in ('ARMED', 'ACTIVE', 'SEALED', 'FAILED')
                 and value.get('quality') in ('HEALTHY', 'AT_RISK')
                 and all(type(value.get(k)) is int and value[k] >= 0 for k in ('cursor', 'failures', 'count'))
                 and type(value.get('endCoverage')) is bool
                 and isinstance(value.get('gaps'), list)
                 and all(isinstance(g, str) for g in value['gaps'])
                 and (value.get('lastSuccessUtc') is None or epoch(value['lastSuccessUtc']) is not None))
    except (TypeError, ValueError, AttributeError):
        valid = False
    if not valid:
        return {**unknown, 'state': 'UNVERIFIED', 'quality': 'AT_RISK', 'error': 'malformed or misbound capture diagnostic'}
    result = {k: value.get(k) for k in ('state', 'quality', 'lastSuccessUtc', 'cursor', 'endCoverage', 'failures', 'gaps', 'count', 'error')}
    last = epoch(result['lastSuccessUtc'])
    result['ageSeconds'] = max(0, now-last) if last is not None else None
    if result['state'] == 'ACTIVE' and (last is None or now-last > 90):
        result['quality'] = 'AT_RISK'
        result['endCoverage'] = False
        result['error'] = result['error'] or 'capture source receipt stale; continuity unproven'
    if result['gaps'] or result['state'] == 'FAILED':
        result['endCoverage'] = False
        result['quality'] = 'AT_RISK'
    result['scope'] = unknown['scope']
    return result


def operational_status(run, now, terminal_report=None):
    """Read the bounded indexed runtime projection, never infer totals from tails.

    Process liveness is intentionally not an input to evidence quality. Age is;
    dead/retired observer remains a separate lifecycle diagnostic.
    """
    row = obj(run / 'shadow-data/runtime-memory.json')
    control = obj(run / 'shadow-data/operational-failure.json')
    stamp = epoch(row.get('atUtc'))
    age = max(0, now-stamp) if stamp is not None and stamp <= now else None
    fresh = age is not None and age <= 30
    broken = (control.get('code') == 'EVIDENCE_SINK_FAILURE' and control.get('operationalSinkBroken') is True
              or row.get('operationalSinkBroken') is True
              or bool(terminal_report and terminal_report.get('bindingValid') and terminal_report.get('classification') == 'EVIDENCE_SINK_FAILURE'))
    quality = row.get('dataQuality', {})
    quality = quality if isinstance(quality, dict) else {}
    state = 'AT_RISK' if broken else quality.get('state') if fresh and quality.get('state') in ('GREEN','DEGRADED','AT_RISK','UNKNOWN') else 'UNKNOWN'
    result = dict(quality=dict(state=state, rules=['EVIDENCE_SINK_FAILURE'] if broken else
                               [r[:256] for r in quality.get('rules', []) if isinstance(r, str)][:32] if fresh and isinstance(quality.get('rules'), list) else ['runtime projection stale or unavailable']),
                  sinkState='BROKEN' if broken else 'READY' if fresh and row.get('operationalSinkBroken') is False else 'UNKNOWN',
                  failureClass='EVIDENCE_SINK_FAILURE' if broken else 'SOURCE_FAILURE' if fresh and row.get('failureClass') == 'SOURCE_FAILURE' else None,
                  sampledUtc=utc(stamp) if stamp is not None else None, ageSeconds=age, fresh=fresh,
                  scope='whole-run validated-index projection; last-known counts if stale; operational only')
    evidence = row.get('operationalEvidence')
    evidence = evidence if isinstance(evidence, dict) else {}
    def reduced(value, counts=(), clocks=(), flags=(), labels=()):
        value = value if isinstance(value, dict) else {}
        out = {k: value.get(k) if type(value.get(k)) in (int,float) and 0 <= value[k] <= 2**53-1 else None for k in counts}
        out.update({k: value.get(k) if epoch(value.get(k)) is not None else None for k in clocks})
        out.update({k: value.get(k) if type(value.get(k)) is bool else None for k in flags})
        out.update({k: value.get(k)[:128] if isinstance(value.get(k), str) else None for k in labels})
        return out
    q = evidence.get('quarantine', {})
    result['quarantine'] = reduced(q, ('total','unresolved','recovered','terminal','ambiguous','additions5m','additions1h','oldestUnresolvedAgeSeconds'),
                                   ('oldestUnresolvedUtc','latestTimestampUtc'), labels=('latestSource','latestClass'))
    result['quarantine']['classBreakdown'] = reduced(q.get('classBreakdown') if isinstance(q, dict) else {}, ('timeout','503','429','malformed','verifier','backfill','publication','index','reorg','other'))
    chain = evidence.get('chain', {})
    result['chain'] = reduced(chain, ('requests','failures','retries','unresolved','unresolvedQuarantine','oldestFailureAgeSeconds'), ('lastRequestUtc','lastSuccessUtc','oldestFailureUtc'))
    result['chain'].update(recoveryRequired=row.get('recoveryRequired') if type(row.get('recoveryRequired')) is bool else None,
                           latestProgressUtc=row.get('lastProgressUtc') if epoch(row.get('lastProgressUtc')) is not None else None)
    tail = chain.get('tail') if isinstance(chain, dict) else None
    result['chain']['tail'] = reduced(tail, ('finalObservedHeadBlock','finalVerifiedBlock','pendingRetryCount','inflightCount'), ('atUtc',), ('recoveryRequired',), ('coverage',))
    result['rest'] = [reduced(s, ('pages','polls','failures','consecutiveFailures','cursorFailures','completenessFailures','publicationFailures'),
                             ('lastPollUtc','lastSuccessUtc'), ('pageLimitEver',), ('source','lastOutcome','lastStopReason','lastTraversal','completeness'))
                      for s in evidence.get('rest', [])[:2] if isinstance(s, dict) and s.get('source') in ('REST_TRADES','REST_ACTIVITY')] if isinstance(evidence.get('rest'), list) else []
    result['indexes'] = reduced(row, ('indexRows','racingIndexRows'), ('indexLastProgressUtc','racingIndexLastProgressUtc'),
                                ('indexInvalid','racingIndexInvalid','indexRebuildActive','racingIndexRebuildActive'), ('indexFile','racingIndexFile'))
    result['operationalIndex'] = reduced(evidence.get('operationalIndex'), ('schemaVersion',), flags=('indexed',), labels=('rebuildReason',))
    result['sourceHealth'] = []
    for source in row.get('sourceHealth', [])[:3] if isinstance(row.get('sourceHealth'), list) else []:
        if isinstance(source, dict) and source.get('source') in SOURCES:
            h = source.get('quality', {})
            result['sourceHealth'].append(dict(source=source['source'], state=h.get('state') if fresh and isinstance(h, dict) and h.get('state') in ('GREEN','DEGRADED','AT_RISK','UNKNOWN') else 'UNKNOWN'))
    fields = ('rssBytes','heapUsedBytes','heapTotalBytes','externalBytes','cgroupUsageBytes','cgroupLimitBytes','cgroupHighBytes','cgroupSwapUsageBytes','cgroupSwapLimitBytes','inflight','retryQueue','replayRows','filteredLogs','blockCache','matchedCache','aggregateCache','rpcParentLineages','rpcParentLineageCapacity','rpcParentLineageEvictions')
    result['telemetry'] = reduced(row, fields, flags=('rpcParentHistoryTruncated','replayActive'))
    result['telemetry']['cgroupEvents'] = reduced(row.get('cgroupEvents'), ('low','high','max','oom','oom_kill'))
    result['telemetry']['cgroupMemoryStat'] = reduced(row.get('cgroupMemoryStat'), ('anon','file','kernel','slab','sock'))
    psi = row.get('cgroupPsi', {})
    result['telemetry']['cgroupPsi'] = {k: reduced(psi.get(k) if isinstance(psi, dict) else {}, ('avg10','avg60','avg300','total')) for k in ('some','full')}
    storage = row.get('storage', {})
    storage = storage if isinstance(storage, dict) else {}
    result['telemetry']['storageFiles'] = reduced(storage.get('files'), (
        'raw_logs.ndjson','raw_log_tombstones.ndjson','observations.ndjson','source_observations.ndjson',
        'rest_raw.ndjson','poll_telemetry.ndjson','dispositions.ndjson','reconciliation.ndjson',
        'quarantine.ndjson','rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson',
        'quarantine_resolutions.ndjson','rest_poll_receipts.ndjson','runtime_telemetry.ndjson',
        'audit_snapshots.ndjson','chain_tail_proofs.ndjson','operational-index.sqlite','recovery-index.sqlite','racing-index.sqlite'))
    result['telemetry'].update(reduced(storage, ('captureBytes','captureFiles')))
    result['evidenceStreams'] = reduced(evidence.get('streams'), (
        'rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson',
        'rest_poll_receipts.ndjson','runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson'))
    return result


def poly2_operational_status(run, now):
    """Bounded v5 producer diagnostics, read-only enrollment query; no closure authority."""
    import re
    import sqlite3
    directory = run / 'poly2-comparison-capture'
    fence, drain = obj(directory / 'poly2_fence_health.json'), obj(directory / 'poly2_drain_health.json')
    result = dict(state='UNKNOWN', generation=None, expectedInstances=None, enrolledInstances=None, acknowledgements=None,
                  missingAcknowledgements=None, frozenPopulation=None, pendingDecisions=None, outstandingTransactions=None,
                  drainState='UNKNOWN', archiveWatermark=None, closureReadiness='UNKNOWN_UNPROVEN', lastCaptureUtc=None,
                  lastReconciliationUtc=None, tradeCount=None, scope='bound producer diagnostics only; not archive sealing proof')
    def valid(value):
        b = value.get('binding', {})
        try:
            w = b['window']; manifest = obj(run / 'run-manifest.json')['window']
            return (type(value.get('version')) is int and value.get('version') == 1 and b.get('shadowRunId') == run.name
                    and epoch_micros(w['startUtc']) == epoch_micros(manifest['startUtc'])
                    and epoch_micros(w['endUtc']) == epoch_micros(manifest['endUtc'])
                    and value.get('bindingSha256') == hashlib.sha256(json.dumps(b, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode()).hexdigest())
        except (KeyError, TypeError, ValueError):
            return False
    if valid(fence):
        expected = fence.get('expectedWorkers')
        ack = fence.get('acknowledgements')
        if (isinstance(expected, list) and 0 < len(expected) <= 256
                and all(isinstance(w,str) and re.fullmatch(r'(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}',w) for w in expected)
                and len(set(expected)) == len(expected) and {w.split(':')[0] for w in expected} == {'backend','bot'}
                and isinstance(fence['binding'].get('expectedWorkers'), list)
                and all(isinstance(w,str) for w in fence['binding']['expectedWorkers'])
                and sorted(fence['binding']['expectedWorkers']) == sorted(expected)
                and isinstance(ack, list) and all(isinstance(w, str) and w in expected for w in ack)
                and len(ack) == len(set(ack))
                and (fence.get('highWaterMark') is None or type(fence.get('highWaterMark')) is int and fence['highWaterMark'] >= 0)
                and type(fence.get('outstanding')) is int and fence['outstanding'] >= 0):
            result.update(state=fence.get('state') if fence.get('state') in ('ACTIVE','DRAINING','COMPLETE','FROZEN','FAILED') else 'UNKNOWN',expectedInstances=expected,
                          acknowledgements=[w for w in ack if w in expected] if isinstance(ack,list) else None,
                          generation=1 if fence.get('highWaterMark') is not None else 0,
                          archiveWatermark=fence.get('highWaterMark') if type(fence.get('highWaterMark')) is int else None,
                          outstandingTransactions=fence.get('outstanding') if type(fence.get('outstanding')) is int else None,
                          lastCaptureUtc=fence.get('lastQueryUtc') if epoch(fence.get('lastQueryUtc')) is not None else None)
            result['missingAcknowledgements'] = sorted(set(expected)-set(result['acknowledgements'])) if result['acknowledgements'] is not None else None
            try:
                path = safe_path(directory / 'source_fence.sqlite')
                from contextlib import closing
                with closing(sqlite3.connect(path.as_uri()+'?mode=ro', uri=True, timeout=.2)) as db:
                    db.execute('PRAGMA query_only=ON')
                    steps = [0]
                    def bounded_query():
                        steps[0] += 1
                        return int(steps[0] > 1000)
                    db.set_progress_handler(bounded_query, 1000)
                    enrolled = [r[0] for r in db.execute("SELECT DISTINCT json_extract(body,'$.payload.worker') FROM events WHERE json_extract(body,'$.kind')='ENROLL' AND json_extract(body,'$.bindingSha256')=? LIMIT 257", (fence['bindingSha256'],))]
                result['enrolledInstances'] = sorted(w for w in enrolled if w in expected) if len(enrolled) <= 256 else None
            except (OSError,ValueError,sqlite3.Error):
                pass
    if (valid(drain) and drain.get('binding') == fence.get('binding')
            and type(drain.get('frozenCount')) is int and drain['frozenCount'] >= 0
            and isinstance(drain.get('counts'), dict)
            and all(type(v) is int and v >= 0 for v in drain['counts'].values())
            and type(drain['counts'].get('PENDING')) is int
            and type(drain['counts'].get('CAPTURE_ERROR')) is int
            and sum(drain['counts'].values()) == drain['frozenCount']):
        counts = drain.get('counts', {})
        result.update(drainState=drain.get('state') if drain.get('state') in ('ACTIVE','DRAINING','COMPLETE','FAILED','TIMED_OUT','PENDING') else 'UNKNOWN',
                      frozenPopulation=drain.get('frozenCount') if type(drain.get('frozenCount')) is int else None,
                      pendingDecisions=counts.get('PENDING') if isinstance(counts,dict) and type(counts.get('PENDING')) is int else None,
                      lastReconciliationUtc=drain.get('latestQueryUtc') if epoch(drain.get('latestQueryUtc')) is not None else None,
                      tradeCount=drain.get('frozenCount') if type(drain.get('frozenCount')) is int else None)
        if result['state']=='FROZEN' and result['drainState']=='COMPLETE' and drain.get('comparisonEligible') is True and counts['PENDING'] == counts['CAPTURE_ERROR'] == 0 and result['enrolledInstances']==sorted(result['expectedInstances'] or []) and result['missingAcknowledgements']==[] and result['outstandingTransactions']==0:
            result['closureReadiness']='DIAGNOSTIC_READY_REQUIRES_ARCHIVE_VALIDATION'
    for field in ('lastCaptureUtc','lastReconciliationUtc'):
        stamp = epoch(result[field])
        result[field+'AgeSeconds'] = max(0,now-stamp) if stamp is not None else None
    return result


def collect(run=None, now=None, cache_path=CACHE, health_provider=production_health,
            pointer_path=POINTER, runs_root=RUNS_ROOT):
    now = time.time() if now is None else now
    context, binding = binding_context(run, pointer_path, runs_root)
    if context is None:
        return unbound_status(now, binding)
    run = context['run']
    START, END, SHA = context['start'], context['end'], context['sha']
    cache = obj(cache_path)
    if cache.get('runDirectory') != str(run):
        cache = {'runDirectory': str(run)}
    warnings = []
    start_receipt = obj(run / 'runner-start.json')
    orchestration = obj(run / 'launch-orchestration-receipt.json')
    launch = obj(run / 'launch-receipt.json')
    tokens = {'runner': start_receipt.get('runner', {}),
              'observer': launch.get('childToken', {})}
    tokens['guardian'] = guardian_token(tokens['runner'], orchestration, launch)
    processes = {name: process_status(token) for name, token in tokens.items()}
    report = terminal(run)
    terminal_present = report['present'] or (run / 'REPORT_FAILED.json').exists()
    current_active = not context['explicit'] and START <= now < END and not terminal_present and processes['observer'].get('alive') is True
    historical = context['explicit'] or now >= END or terminal_present
    memory = memory_status(run, tokens['observer'], now) if current_active else unknown_memory()
    warnings.extend(memory['warnings'])
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
    disk_quality = _BUDGET.disk_state(free, disk.f_blocks*disk.f_frsize,
                                    max(0, __import__('math').ceil(END + _BUDGET.plan()['maximumDrainGraceSeconds'] - max(START, now))))
    if disk_quality['state'] != 'GREEN':
        warnings.append('runtime disk envelope ' + disk_quality['state'])
    if free < 10*1024**3:
        warnings.append('disk free below 10 GiB')
    operations = operational_status(run, now, report)
    poly2_operations = poly2_operational_status(run, now)
    if operations['quarantine']['total'] is not None:
        quarantine_summary = dict(operations['quarantine'], count=operations['quarantine']['total'], sampleCount=0,
                                  recoveryRequired=operations['chain']['recoveryRequired'], scope=operations['scope'])
    else:
        quarantine_summary = {'count': None, 'sampleCount': len(quarantine), 'scope': 'v2 indexed whole-run projection unavailable; tail is not authority', 'recoveryRequired': recovery}
    atomic_json(cache_path, cache)
    return {'schemaVersion': 1, 'generatedUtc': utc(now), 'experimentId': run.name,
            'shadowSha': SHA, 'state': state, 'currentActive': current_active,
            'currentInactive': not current_active, 'historical': historical,
            'binding': {'status': binding, 'mode': 'historical' if context['explicit'] else 'current', 'runDirectory': str(run)},
            'scope': 'Operational status only. COMPLETE means lifecycle completion only.',
            'window': {'startUtc': context['window']['startUtc'], 'endUtc': context['window']['endUtc'],
                       'clockEvidence': _CLOCK.evidence(context['window'], ['startUtc','endUtc']),
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
            'sources': sources, 'quarantine': quarantine_summary, 'operations': operations, 'poly2Operations': poly2_operations,
            'poly2': health, 'poly2ComparisonCapture': poly2_capture_status(run, START, END, now, context['window']),
            'disk': dict(disk_quality, warningThresholdBytes=10*1024**3),
            'boundedReads': {'maxBytesPerEvidenceFile': LIMIT, 'heartbeatBytes': heartbeat_read, 'sourceObservationBytes': obs_read,
                             'pollTelemetryBytes': polls_read, 'restRawBytes': rest_read, 'quarantineBytes': q_read, 'chainRawBytes': 0},
            'warnings': warnings}


def main():
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run', type=Path, help='Explicit historical read (never live memory)')
    parser.add_argument('--current-run', type=Path, default=POINTER, help='Read-only current-run pointer')
    parser.add_argument('--runs-root', type=Path, default=RUNS_ROOT)
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
        result = collect(run=args.run, cache_path=args.cache, pointer_path=args.current_run, runs_root=args.runs_root)
        atomic_json(args.output, result, 0o644)
        print(json.dumps({'state': result['state'], 'warnings': result['warnings'],
                          'pids': {k:v['pid'] for k,v in result['processes'].items()},
                          'poly2': result['poly2']['status'], 'boundedReads': result['boundedReads']}))
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
