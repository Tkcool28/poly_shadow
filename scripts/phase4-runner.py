#!/usr/bin/env python3
"""Linux stdlib fixed-window lifecycle only. No scientific/export implementation."""
import argparse
import ctypes
import datetime as dt
import fcntl
import hashlib
import io
import json
import math
import importlib.util
import marshal
import struct
import types
import os
from pathlib import Path
import functools

@functools.lru_cache(maxsize=1)
def _exact_clock():
    # Load source bytes only when clocks are consumed, never unchecked .pyc.
    # The observer entry consumes runtime_env only and need not load this dependency.
    path = Path(__file__).with_name('exact_clock.py')
    module = types.ModuleType('runner_exact_clock')
    exec(compile(path.read_bytes(), str(path), 'exec'), module.__dict__)
    return module

def epoch_micros(value):
    return _exact_clock().epoch_micros(value)

import re
import signal
import subprocess
import sys
import time
import uuid

WINDOW_SECONDS = 86400
BRANCH = 'main'
POLY2_SHA = 'bd61efc90a4ff8bfc17b8a31abc4a40dd655f81f'
WALLETS = ['0x82cf2b31d18fca19830e216b98cffa5dbc6c0998',
           '0x924379a79c64b77ad5816ad362122a5f6228658e',
           '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029',
           '0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b',
           '0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227']
BANNED = {'PRIVATE_KEY', 'CLOB_API_KEY', 'CLOB_API_SECRET', 'CLOB_API_PASSPHRASE',
          'FUNDER_ADDRESS', 'RELAYER_API_KEY', 'RELAYER_API_KEY_ADDRESS'}
CODES = {'COMPLETE', 'MISSED_START', 'EARLY_EXIT', 'INTERRUPTED', 'RUNNER_LOST',
         'PREFLIGHT_FAILED', 'SEAL_INVALID', 'DUPLICATE_RUN', 'ORPHAN_DETECTED',
         'LAUNCH_FAILED', 'LAUNCH_LATE', 'CLEANUP_FAILED', 'EVIDENCE_MISSING',
         'REPORT_FAILED', 'INTERNAL_ERROR', 'EVIDENCE_SINK_FAILURE'}

CANONICAL = {
    'COMPLETE': 'END_WINDOW_COMPLETE', 'MISSED_START': 'MISSED_START',
    'EARLY_EXIT': 'OBSERVER_EXITED_EARLY', 'INTERRUPTED': 'SIGNAL_TERMINATION',
    'RUNNER_LOST': 'SIGNAL_TERMINATION', 'PREFLIGHT_FAILED': 'PRESTART_GATE_FAILED',
    'SEAL_INVALID': 'WINDOW_SEAL_FAILED', 'DUPLICATE_RUN': 'PRESTART_GATE_FAILED',
    'ORPHAN_DETECTED': 'PRESTART_GATE_FAILED', 'LAUNCH_FAILED': 'OBSERVER_START_FAILED',
    'LAUNCH_LATE': 'OBSERVER_START_FAILED',
    # Operational extensions: never mislabel a reporting failure as an export.
    'CLEANUP_FAILED': 'CLEANUP_FAILED', 'EVIDENCE_MISSING': 'EVIDENCE_MISSING',
    'REPORT_FAILED': 'REPORT_FAILED', 'INTERNAL_ERROR': 'INTERNAL_ERROR',
    'EVIDENCE_SINK_FAILURE': 'EVIDENCE_SINK_FAILURE',
}
CANONICAL_CLASSIFICATIONS = set(CANONICAL.values()) | {
    'POSTRUN_EXPORT_FAILED', 'COMPARATOR_FAILED', 'DASHBOARD_FAILED'}


def terminal_metadata(receipt, target):
    code = receipt['classification']
    receipt.update(lifecycleCode=code, classification=CANONICAL[code],
                   canonicalFailureReason=None if code == 'COMPLETE' else CANONICAL[code],
                   experimentId=target.name, restartCount=0, restartEvents=[],
                   outageGaps=[], outageGapAssessment='UNKNOWN',
                   outageGapProvenance='no source gaps measured: empty array is not proof of no gaps; stat heartbeat only',
                   observationPhase='COMPLETE' if code == 'COMPLETE' else 'FAILED',
                   observationPhaseScope='observer lifecycle only, not scientific completion',
                   postrun={'export': 'NOT_RUN', 'comparator': 'NOT_RUN', 'dashboard': 'NOT_RUN'})


def publish_report(target, receipt):
    # Stage and hash all bytes before publishing any root success receipt.
    # Root names are visible as one committed bundle only after the commit marker.
    stage = target / ('.report-stage-' + uuid.uuid4().hex)
    stage.mkdir(mode=0o700)
    published = []
    names = ('execution-receipt.json', 'execution-receipt.sha256.json')
    try:
        write_new(stage / names[0], receipt)
        sha = digest(stage / names[0])
        write_new(stage / names[1], {'sha256': sha})
        fsync_dir(stage)
        for name in names:
            rename_new(stage / name, target / name)
            published.append(name)
        fsync_dir(target)
        # Stage marker too: no partially written root commit marker.
        write_new(stage / 'REPORT_COMMITTED.json', {'sha256': sha, 'utc': utc()})
        rename_new(stage / 'REPORT_COMMITTED.json', target / 'REPORT_COMMITTED.json')
        published.append('REPORT_COMMITTED.json')
        fsync_dir(target)
        stage.rmdir()
    except BaseException:
        # Retract ONLY names created by this transaction. Keep failed bytes for
        # audit, never change source evidence or a previous report bundle.
        for name in reversed(published):
            rename_new(target / name, stage / name)
        raise


def report_valid(target):
    try:
        require(not (target / 'REPORT_FAILED.json').exists(), 'REPORT_FAILED', 'Failed report')
        for name in ('execution-receipt.json', 'execution-receipt.sha256.json', 'REPORT_COMMITTED.json'):
            no_symlinks(target / name)
        sha = digest(target / 'execution-receipt.json')
        return (json.loads((target / 'execution-receipt.sha256.json').read_text())['sha256'] == sha
                == json.loads((target / 'REPORT_COMMITTED.json').read_text())['sha256'])
    except (OSError, ValueError, KeyError, Blocked):
        return False


class Blocked(Exception):
    def __init__(self, code, detail):
        super().__init__(detail)
        self.code = code

def require(ok, code, detail):
    if not ok:
        raise Blocked(code, detail)

def utc(t=None):
    return dt.datetime.fromtimestamp(time.time() if t is None else t, dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00', 'Z')

def epoch(s):
    try:
        return epoch_micros(s) / 1000000 # OS scheduling/display only; membership uses integer authority
    except ValueError as error:
        raise Blocked('SEAL_INVALID', str(error)) from error

def digest(p):
    h = hashlib.sha256()
    with Path(p).open('rb') as f:
        for b in iter(lambda: f.read(1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()

def fsync_dir(p):
    fd = os.open(p, os.O_RDONLY | os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)

def write_new(p, value):
    with Path(p).open('x') as f:
        json.dump(value, f, indent=2)
        f.write('\n')
        f.flush()
        os.fsync(f.fileno())
    fsync_dir(Path(p).parent)

def credentials(env):
    names = sorted(k for k in env if k in BANNED or k.startswith(('ARB_', 'SCALP_')))
    require(not names, 'PREFLIGHT_FAILED', 'Forbidden environment names: ' + ','.join(names))

def proc(pid):
    try:
        text = Path(f'/proc/{pid}/stat').read_text()
        fields = text[text.rindex(')') + 2:].split()
        return {'pid': int(pid), 'state': fields[0], 'pgid': int(fields[2]),
                'session': int(fields[3]), 'startTicks': fields[19]}
    except (OSError, ValueError, IndexError):
        return None

def same(token):
    current = proc(token['pid'])
    return current is not None and all(current[k] == token[k] for k in ('pid', 'pgid', 'session', 'startTicks'))

def owner_alive(token):
    current = proc(token['pid'])
    return current is not None and current['state'] != 'Z' and all(
        current[k] == token[k] for k in ('pid', 'pgid', 'session', 'startTicks'))

def group(pid):
    return [v for p in Path('/proc').iterdir() if p.name.isdigit()
            for v in [proc(int(p.name))] if v and v['pgid'] == pid and v['session'] == pid]

def owned_identity(child, token):
    if token.get('ownershipProof') != 'UNREAPED_DIRECT_CHILD_SESSION':
        return same(token)
    # waitid WNOWAIT proves this is still our unreaped direct child. It cannot
    # reuse its PID/PGID before wait(), even when /proc stat is unavailable.
    try:
        child_exited(child)
        return os.getpgid(child.pid) == child.pid and os.getsid(child.pid) == child.pid
    except (ChildProcessError, ProcessLookupError):
        return False


def fallback_token(child):
    token = {'pid': child.pid, 'pgid': child.pid, 'session': child.pid,
             'startTicks': None, 'ownershipProof': 'UNREAPED_DIRECT_CHILD_SESSION'}
    return token if owned_identity(child, token) else None


def stop_owned(child, token, immediate=False, frozen_end=None):
    # Keep the leader unreaped until signalling is finished: a zombie retains its
    # start token/session and reserves the PID/PGID against reuse.
    if not owned_identity(child, token):
        return False
    policy = ((signal.SIGKILL, 2.0),) if immediate else ((signal.SIGTERM, .2), (signal.SIGKILL, 2.0))
    for sig, budget in policy:
        # Cleanup runs with the absolute alarm cancelled. Never let early TERM
        # grace cross the authoritative UTC end, including a clock step.
        if sig == signal.SIGTERM and frozen_end is not None and time.time() >= frozen_end:
            continue
        if not owned_identity(child, token):
            return False
        try:
            os.killpg(token['pgid'], sig)
        except ProcessLookupError:
            pass
        limit = time.monotonic() + budget
        while any(v['state'] != 'Z' for v in group(token['pgid'])):
            remaining = limit - time.monotonic()
            if sig == signal.SIGTERM and frozen_end is not None:
                remaining = min(remaining, frozen_end - time.time())
            if remaining <= 0:
                break
            time.sleep(min(.02, remaining))
    try:
        child.wait(timeout=1)
    except subprocess.TimeoutExpired:
        return False
    # Guardian is a subreaper; collect adopted descendants without unbounded waits.
    limit = time.monotonic() + 1
    while time.monotonic() < limit:
        try:
            pid, _ = os.waitpid(-1, os.WNOHANG)
        except ChildProcessError:
            break
        if not pid:
            if not group(token['pgid']):
                break
            time.sleep(.02)
    return not any(v['state'] != 'Z' for v in group(token['pgid']))

def no_symlinks(p):
    p = Path(os.path.abspath(p))
    require(not any(x.is_symlink() for x in [p, *p.parents]), 'SEAL_INVALID', 'Symlink path forbidden')
    return p

def experiment_path(repo, p):
    repo, p = no_symlinks(repo), no_symlinks(p)
    require(p.parent == repo / 'runs' and re.fullmatch(r'phase4-[A-Za-z0-9_-]+', p.name),
            'SEAL_INVALID', 'Experiment must be a direct phase4-* child of repo/runs')
    return p

def owner_lock(repo):
    runs = no_symlinks(repo / 'runs')
    runs.mkdir(exist_ok=True)
    lockpath = runs / '.phase4-owner.lock'
    require(not lockpath.is_symlink(), 'DUPLICATE_RUN', 'Symlink lock forbidden')
    fd = os.open(lockpath, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(fd)
        raise Blocked('DUPLICATE_RUN', 'Another lifecycle owner holds the lock')
    return fd

def orphans(repo, target):
    # Read-only discovery; never signal discovered (unowned) processes. Do not
    # match arbitrary node/Python/Poly2 processes solely by name.
    found = []
    for p in Path('/proc').iterdir():
        if not p.name.isdigit() or int(p.name) == os.getpid():
            continue
        try:
            cmd = (p / 'cmdline').read_bytes().replace(b'\0', b' ').decode(errors='replace')
            env = (p / 'environ').read_bytes().split(b'\0')
            cwd = os.readlink(p / 'cwd')
            data = next((x.split(b'=', 1)[1].decode(errors='replace') for x in env if x.startswith(b'SHADOW_DATA_DIR=')), None)
            runtime = any(x in cmd for x in ('node', 'npm', 'tsx', 'src/shadow/main.ts'))
            if runtime and ((data is not None)
                            or (cwd == str(repo) and ('src/shadow/main.ts' in cmd or 'npm start' in cmd))):
                found.append(int(p.name))
        except (FileNotFoundError, ProcessLookupError):
            continue
        except PermissionError:
            raise Blocked('PREFLIGHT_FAILED', 'Cannot inspect a process; orphan gate is unknown')
    require(not found, 'ORPHAN_DETECTED', 'Existing Shadow runtime PIDs: ' + ','.join(map(str, found)))

def call(cmd, cwd=None, input=None):
    # Never echo environment, stderr or command output on a safety failure.
    try:
        r = subprocess.run(cmd, cwd=cwd, input=input, text=True, capture_output=True, timeout=45, check=True)
        return r.stdout.strip()
    except (OSError, subprocess.SubprocessError):
        raise Blocked('PREFLIGHT_FAILED', 'Read-only preflight adapter failed') from None

def production_snapshot():
    config = json.loads(call(['docker', 'exec', 'poly2-bot-1', 'python', '-c',
        "import json;from polycopy.config import get_settings;s=get_settings();print(json.dumps({k:getattr(s,k) for k in ['environment','paper_mode','allow_live_trading','order_kill_switch','max_order_size_usd','max_exposure_per_market_usd','max_exposure_global_usd','review_delay_seconds','max_signal_execution_age_seconds','signal_detection_batch_size','execution_batch_size','max_copy_price','ingestion_batch_size','ingestion_max_concurrent_requests','ingestion_poll_interval_seconds','catch_up_pages_per_cycle','settlement_max_checks_per_cycle','candidate_scoring_interval_seconds']}))"]))
    sql = "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT json_build_object('readOnly',current_setting('transaction_read_only'),'wallets',(SELECT json_agg(address ORDER BY address) FROM wallets WHERE approval_state='approved'),'heartbeats',(SELECT json_agg(row_to_json(h)) FROM (SELECT service,max(seen_at) AS last_seen FROM service_heartbeats WHERE service IN ('bot_alive','bot_success') GROUP BY service) h)); ROLLBACK;"
    state = json.loads(call(['docker', 'exec', '-i', 'poly2-postgres-1', 'sh', '-c',
        'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=30000" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], input=sql))
    container = json.loads(call(['docker', 'inspect', '--format', '{{json .State}}', 'poly2-bot-1']))
    result = {'sha': call(['git', '-C', '/opt/poly2', 'rev-parse', 'HEAD']), 'config': config,
              'db': state, 'container': {k: container[k] for k in ('Status', 'Running', 'Restarting', 'StartedAt')},
              'envFileSha256': digest('/opt/poly2/.env'), 'capturedUtc': utc()}
    require(result['sha'] == POLY2_SHA and config['paper_mode'] is True and config['allow_live_trading'] is False,
            'PREFLIGHT_FAILED', 'Poly2 SHA/PAPER gate failed')
    require(state['readOnly'] == 'on' and sorted(state['wallets'] or []) == sorted(WALLETS),
            'PREFLIGHT_FAILED', 'Read-only/fixed-five-wallet gate failed')
    require(container['Running'] and not container['Restarting'] and container['Status'] == 'running',
            'PREFLIGHT_FAILED', 'Poly2 container not stable')
    beats = {r['service']: epoch(r['last_seen']) for r in state['heartbeats'] or []}
    require(all(0 <= time.time() - beats.get(k, 0) < 180 for k in ('bot_alive', 'bot_success')),
            'PREFLIGHT_FAILED', 'Poly2 heartbeat gate failed')
    return result

def classify_untracked(repo):
    # NUL framing avoids Git C-quoting entirely (tabs/newlines/UTF-8 are paths,
    # not records). Never parse porcelain's quoted display with splitlines().
    status = call(['git', 'status', '--porcelain=v1', '-z', '--untracked-files=all'], repo)
    tracked = set(call(['git', 'ls-files', '-z'], repo).split('\0'))
    result = {'evidence': [], 'interpreterCache': []}
    cache = repo / 'scripts/__pycache__'
    for record in filter(None, status.split('\0')):
        require(record.startswith('?? '), 'PREFLIGHT_FAILED', 'Unexpected tracked status')
        name = record[3:]
        p = no_symlinks(repo / name)
        require(p.is_file(), 'PREFLIGHT_FAILED', 'Untracked directories/symlinks forbidden')
        if name.startswith('runs/'):
            # Historical run evidence remains evidence, never runtime/source.
            result['evidence'].append(name)
            continue
        require(p.parent == cache, 'PREFLIGHT_FAILED', 'Untracked content outside runs/cache')
        # Tiny, observed CPython release-format allowlist. Foreign payloads
        # are opaque quarantine, never unmarshalled or used as authority.
        magics = {'cpython-312': bytes.fromhex('cb0d0d0a'),
                  'cpython-314': bytes.fromhex('2b0e0d0a')}
        magics.setdefault(sys.implementation.cache_tag, importlib.util.MAGIC_NUMBER)
        match = re.fullmatch(r'(.+)\.(cpython-[0-9]+)(?:\.opt-[12])?\.pyc', p.name)
        if match is None or match.group(2) not in magics:
            raise Blocked('PREFLIGHT_FAILED', 'Only recognized interpreter cache permitted')
        source = 'scripts/' + match.group(1) + '.py'
        require(source in tracked and no_symlinks(repo / source).is_file(),
                'PREFLIGHT_FAILED', 'Cache must correspond to tracked Python source')
        # Do not execute cached code or require freshness: a preserved pre-edit
        # cache is harmless. Verify interpreter format, not source timestamp.
        require(16 < p.stat().st_size <= 8 * 1024 * 1024, 'PREFLIGHT_FAILED', 'Invalid cache size')
        data = p.read_bytes()
        valid = (data[:4] == magics[match.group(2)] and
                 struct.unpack('<I', data[4:8])[0] in (0, 1, 3))
        if valid and match.group(2) == sys.implementation.cache_tag:
            # Native format gets additional structural checks, but no exec.
            try:
                stream = io.BytesIO(data[16:])
                code = marshal.load(stream)
                valid = (isinstance(code, types.CodeType) and
                         Path(code.co_filename).name == Path(source).name and not stream.read(1))
            except (ValueError, EOFError, TypeError):
                valid = False
        require(valid, 'PREFLIGHT_FAILED', 'Invalid interpreter bytecode')
        result['interpreterCache'].append(name)
    # Include ignored entries too: a mixed/symlinked cache must not be hidden by
    # ignore rules. The exception is exactly direct pyc files already validated.
    if cache.exists() or cache.is_symlink():
        no_symlinks(cache)
        require(cache.is_dir(), 'PREFLIGHT_FAILED', 'Invalid cache directory')
        require({str(p.relative_to(repo)) for p in cache.iterdir()} == set(result['interpreterCache']),
                'PREFLIGHT_FAILED', 'Mixed or hidden cache content forbidden')
    return result


def preflight(repo, expected_sha, target, baseline=None):
    credentials(os.environ)
    require(re.fullmatch('[0-9a-f]{40}', expected_sha) is not None, 'PREFLIGHT_FAILED', 'Explicit full expected Shadow SHA required')
    require(call(['git', 'branch', '--show-current'], repo) == BRANCH and
            call(['git', 'rev-parse', 'HEAD'], repo) == expected_sha, 'PREFLIGHT_FAILED', 'Shadow branch/SHA mismatch')
    require(call(['git', 'rev-parse', 'origin/main'], repo) == expected_sha and
            call(['git', 'rev-list', '--left-right', '--count', 'HEAD...origin/main'], repo).split() == ['0', '0'],
            'PREFLIGHT_FAILED', 'Shadow HEAD/origin main mismatch or divergence')
    tracked = call(['git', 'status', '--porcelain=v1', '--untracked-files=no'], repo)
    require(not tracked, 'PREFLIGHT_FAILED', 'Shadow tracked checkout not clean')
    classification = classify_untracked(repo)
    orphans(repo, target)
    snapshot = production_snapshot()
    if baseline:
        require(all(snapshot[k] == baseline[k] for k in ('sha', 'config', 'envFileSha256', 'container')),
                'PREFLIGHT_FAILED', 'Protected Poly2 baseline changed')
    return {'shadowSha': expected_sha, 'branch': BRANCH, 'poly2': snapshot,
            'untrackedClassification': classification, 'capturedUtc': utc()}

def rename_new(source, target):
    # Atomic directory publication with NOREPLACE (Linux), not exists()+rename().
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.renameat2(-100, os.fsencode(source), -100, os.fsencode(target), 1) != 0:
        raise OSError(ctypes.get_errno(), 'Atomic no-overwrite publication failed')

def seal_files(repo, target, start, end, checks, duration=WINDOW_SECONDS, original_window=None):
    """Core writer; production CLI fixes duration; tests call on isolated repos."""
    target = experiment_path(repo, target)
    window = original_window or {'startUtc': utc(start), 'endUtc': utc(end)}
    require(math.isfinite(start) and math.isfinite(end) and epoch_micros(window['endUtc']) - epoch_micros(window['startUtc']) == duration * 1000000 and epoch_micros(window['startUtc']) > epoch_micros(utc()),
            'SEAL_INVALID', 'Fresh future exact fixed window required')
    require(not target.exists(), 'SEAL_INVALID', 'Never overwrite an experiment')
    stage = target.parent / ('.phase4-stage-' + uuid.uuid4().hex)
    stage.mkdir(mode=0o700)
    published = False
    try:
        (stage / 'shadow-data').mkdir()
        cohort = {'window': window, 'controlled': WALLETS, 'exploratory': []}
        write_new(stage / 'cohorts.json', cohort)
        write_new(stage / 'preflight.json', checks)
        with (stage / 'runner.py').open('xb') as f:
            f.write(Path(__file__).read_bytes()); f.flush(); os.fsync(f.fileno())
        with (stage / 'exact_clock.py').open('xb') as f:
            f.write(Path(__file__).with_name('exact_clock.py').read_bytes()); f.flush(); os.fsync(f.fileno())
        manifest = {'state': 'SEALED_NOT_STARTED', 'experimentDirectory': str(target), 'window': cohort['window'],
                    'controlled': WALLETS, 'exploratory': [], 'shadowSha': checks['shadowSha'], 'poly2Sha': POLY2_SHA,
                    'helperSha256': digest(stage / 'runner.py'), 'timestampParserSha256': digest(stage / 'exact_clock.py'), 'cohortsSha256': digest(stage / 'cohorts.json'),
                    'preflightSha256': digest(stage / 'preflight.json'), 'sealedUtc': utc(), 'durationSeconds': duration}
        write_new(stage / 'run-manifest.json', manifest)
        for name in ('cohorts.json', 'preflight.json', 'runner.py', 'exact_clock.py', 'run-manifest.json'):
            (stage / name).chmod(0o444)
        require(epoch_micros(window['startUtc']) > epoch_micros(utc()), 'MISSED_START', 'Start passed during seal; no publication')
        fsync_dir(stage)
        rename_new(stage, target); published = True
        fsync_dir(target.parent)
        return manifest
    except BaseException:
        failed = target if published else stage
        try:
            write_new(failed / 'INVALID', {'classification': 'SEAL_INVALID', 'utc': utc()})
        except OSError:
            pass
        if published:
            # Retract publication as a second independent fail-closed barrier
            # if final durability failed (even when INVALID cannot be written).
            try:
                rename_new(target, stage)
                fsync_dir(target.parent)
            except OSError:
                pass
        # A missing manifest, leftover stage or INVALID is never runnable.
        raise

def validate(repo, target, expected_sha, duration=WINDOW_SECONDS):
    target = experiment_path(repo, target)
    require(target.is_dir() and not (target / 'INVALID').exists(), 'SEAL_INVALID', 'Missing/invalid seal')
    for name in ('cohorts.json', 'preflight.json', 'runner.py', 'exact_clock.py', 'run-manifest.json', 'shadow-data'):
        no_symlinks(target / name)
    m = json.loads((target / 'run-manifest.json').read_text())
    c = json.loads((target / 'cohorts.json').read_text())
    require(m['state'] == 'SEALED_NOT_STARTED' and m['experimentDirectory'] == str(target) and
            m['shadowSha'] == expected_sha and m['poly2Sha'] == POLY2_SHA and
            m['helperSha256'] == digest(__file__) == digest(target / 'runner.py') and
            m['timestampParserSha256'] == digest(Path(__file__).with_name('exact_clock.py')) == digest(target / 'exact_clock.py') and
            m['cohortsSha256'] == digest(target / 'cohorts.json') and
            m['preflightSha256'] == digest(target / 'preflight.json') and
            c == {'window': m['window'], 'controlled': WALLETS, 'exploratory': []} and
            m['controlled'] == WALLETS and m['exploratory'] == [] and m['durationSeconds'] == duration and
            epoch_micros(m['window']['endUtc']) - epoch_micros(m['window']['startUtc']) == duration * 1000000,
            'SEAL_INVALID', 'Seal hash/cohort/window/SHA mismatch')
    require(not any((target / x).exists() for x in ('execution-receipt.json', 'launch-receipt.json', 'runner-start.json')),
            'DUPLICATE_RUN', 'Experiment already attempted; no restart')
    require(not any((target / 'shadow-data').iterdir()), 'SEAL_INVALID', 'Evidence directory must be empty before launch')
    return m

def evidence_stats(target):
    result = {}
    for f in sorted((target / 'shadow-data').iterdir()):
        require(not f.is_symlink(), 'REPORT_FAILED', 'Evidence symlink forbidden')
        if f.is_file():
            result[f.name] = f.stat().st_size
    return result

def first_observation(target, launch, end):
    # ONE bounded complete line only, after stop. Not a claim of all-source start.
    # Real callers supply original clocks; numeric legacy test seams carry only their available precision.
    from decimal import Decimal
    launch_exact = epoch_micros(launch) if isinstance(launch, str) else int(Decimal(str(launch)) * 1000000)
    end_exact = epoch_micros(end) if isinstance(end, str) else int(Decimal(str(end)) * 1000000)
    result = {'actualObservationStartUtc': None, 'observationStartProvenance': 'not observable: no valid first REST poll evidence',
              'perSourceObservationStartUtc': {'CHAIN': None, 'REST_TRADES': None, 'REST_ACTIVITY': None},
                'perSourceObservationStartProvenance': {},
              'limitations': ['First completed REST poll request start is not all-source startup.',
                              'CHAIN subscription startup and missing source timestamps remain unknown; no no-gap claim.']}
    for name in ('poll_telemetry.ndjson', 'rest_raw.ndjson'):
        f = target / 'shadow-data' / name
        if not f.exists():
            continue
        with f.open('rb') as stream:
            line = stream.readline(65537)
        if len(line) > 65536 or not line.endswith(b'\n'):
            continue
        try:
            row = json.loads(line)
            value = row.get('requestStartUtc')
            if row.get('source') in ('REST_TRADES', 'REST_ACTIVITY') and value and launch_exact <= epoch_micros(value) <= end_exact:
                result['actualObservationStartUtc'] = value
                result['perSourceObservationStartUtc'][row['source']] = value
                result['observationStartProvenance'] = name + ': first complete row requestStartUtc; REST observation only'
                result['perSourceObservationStartProvenance'][row['source']] = result['observationStartProvenance']
                break
        except (ValueError, TypeError, AttributeError, Blocked):
            continue
    raw = target / 'shadow-data/raw_logs.ndjson'
    if raw.exists():
        with raw.open('rb') as stream:
            line = stream.readline(65537)
        if len(line) <= 65536 and line.endswith(b'\n'):
            try:
                value = json.loads(line).get('firstSeenUtc')
                if value and launch_exact <= epoch_micros(value) <= end_exact:
                    result['perSourceObservationStartUtc']['CHAIN'] = value
                    result['perSourceObservationStartProvenance']['CHAIN'] = 'raw_logs.ndjson:firstSeenUtc; first raw evidence arrival, NOT subscription startup'
            except (ValueError, TypeError, AttributeError, Blocked):
                pass
    return result

def inventory(target):
    result = {}
    for f in sorted(target.rglob('*')):
        require(not f.is_symlink(), 'REPORT_FAILED', 'Inventory symlink forbidden')
        if f.is_file() and f.name not in ('execution-receipt.json', 'execution-receipt.sha256.json'):
            result[str(f.relative_to(target))] = {'bytes': f.stat().st_size, 'sha256': digest(f)}
    return result

def child_exited(child):
    return os.waitid(os.P_PID, child.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None

def sink_failure(target):
    # Control-only marker, independent of NDJSON authority. Any present marker
    # (even a partial diagnostic) is fail-closed, never evidence of recovery.
    marker = target / 'shadow-data/operational-failure.json'
    if marker.exists() or marker.is_symlink():
        return True
    memory = target / 'shadow-data/runtime-memory.json'
    if memory.is_file() and not memory.is_symlink():
        try:
            with memory.open('rb') as stream:
                raw = stream.read(65537)
            return len(raw) <= 65536 and json.loads(raw).get('operationalSinkBroken') is True
        except (OSError, ValueError, AttributeError):
            pass
    return False

def supervise(repo, target, m, command, env, parent_token, heartbeat_seconds=30):
    # Independent guardian: not in observer process group; survives runner SIGKILL.
    # Subreaper permits bounded collection of npm/node descendants, including zombies.
    start, end = epoch(m['window']['startUtc']), epoch(m['window']['endUtc'])
    start_exact, end_exact = epoch_micros(m['window']['startUtc']), epoch_micros(m['window']['endUtc'])
    receipt = {'classification': 'INTERNAL_ERROR', 'experimentId': target.name, 'restartCount': 0,
               'restartEvents': [], 'outageGaps': [], 'outageGapAssessment': 'UNKNOWN',
               'frozenWindow': m['window'], 'runnerPid': parent_token['pid'],
               'runnerToken': parent_token, 'guardianPid': os.getpid(), 'cwd': str(repo), 'command': command,
               'runtimeExperimentEnvironment': {k: env[k] for k in ('SHADOW_DATA_DIR', 'SHADOW_WATCHED_WALLETS')},
               'actualProcessLaunchUtc': None, 'actualObservationStartUtc': None, 'actualStopUtc': None,
               'observerGroupGone': None, 'continuity': 'unknown; stat heartbeat cannot prove absence of gaps'}
    child = token = None
    interrupted = []
    handlers = {sig: signal.signal(sig, lambda s, f: interrupted.append(s)) for sig in (signal.SIGINT, signal.SIGTERM)}
    signal.pthread_sigmask(signal.SIG_UNBLOCK, {signal.SIGINT, signal.SIGTERM})
    mono = time.monotonic()
    try:
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'LAUNCH_FAILED', 'Linux subreaper unavailable')
        while epoch_micros(utc()) < start_exact:
            if interrupted:
                raise Blocked('INTERRUPTED', 'Interrupted before launch')
            if not owner_alive(parent_token):
                raise Blocked('RUNNER_LOST', 'Runner died before launch')
            time.sleep(min(.02, max(0, start - time.time())))
        require(epoch_micros(utc()) <= start_exact + 1000000 and epoch_micros(utc()) < end_exact, 'MISSED_START', 'Frozen start missed; no shifted window')
        with (target / 'observer.log').open('xb') as log:
            child = subprocess.Popen(command, cwd=repo, env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
            launch = time.time()
            receipt.update({'childPid': child.pid, 'observerProcessGroup': child.pid,
                            'actualProcessLaunchUtc': utc(launch), 'launchDeviationSeconds': launch - start,
                            'remainingLaunchBudgetSeconds': end - launch})
            token = proc(child.pid)
            captured = token is not None and token['pgid'] == child.pid and token['session'] == child.pid
            if not captured:
                token = fallback_token(child)
            receipt['childToken'] = token
            require(captured, 'LAUNCH_FAILED', 'Could not capture /proc child identity; reserved-child cleanup required')
            def deadline(sig, frame):
                if epoch_micros(utc()) >= end_exact:
                    raise Blocked('COMPLETE', 'Absolute frozen UTC end reached')
                raise Blocked('INTERRUPTED', 'Premature deadline signal; fail closed')
            handlers[signal.SIGALRM] = signal.signal(signal.SIGALRM, deadline)
            signal.setitimer(signal.ITIMER_REAL, max(.000001, end - time.time()))
            write_new(target / 'launch-receipt.json', receipt)
            require(epoch_micros(receipt['actualProcessLaunchUtc']) <= start_exact + 1000000 and epoch_micros(receipt['actualProcessLaunchUtc']) < end_exact, 'LAUNCH_LATE', 'Popen completed beyond fixed tolerance')
            next_beat = 0
            with (target / 'heartbeat.ndjson').open('x') as beats:
                while True:
                    now = time.time()
                    if sink_failure(target):
                        raise Blocked('EVIDENCE_SINK_FAILURE', 'Operational evidence sink broken; no restart')
                    if epoch_micros(utc(now)) >= end_exact:
                        receipt['classification'] = 'COMPLETE'
                        break
                    if interrupted:
                        raise Blocked('INTERRUPTED', 'Runner/guardian interrupted')
                    if not owner_alive(parent_token):
                        raise Blocked('RUNNER_LOST', 'Runner disappeared; guardian stops owned group')
                    if child_exited(child):
                        raise Blocked('EARLY_EXIT', 'Observer exited before frozen end; no restart')
                    if time.monotonic() >= next_beat:
                        row = {'utc': utc(now), 'childAlive': True, 'runnerAlive': owner_alive(parent_token),
                               'evidenceDirectoryExists': (target / 'shadow-data').is_dir(),
                               'experimentId': target.name, 'restartCount': 0, 'elapsedSeconds': now - launch,
                               'remainingSeconds': max(0, end - now), 'evidenceBytes': evidence_stats(target)}
                        beats.write(json.dumps(row) + '\n'); beats.flush()
                        if row['evidenceBytes'] and receipt.get('firstEvidenceSeenUtc') is None:
                            receipt['firstEvidenceSeenUtc'] = utc(now)
                        next_beat = time.monotonic() + heartbeat_seconds
                    # Absolute UTC deadline checked independently of heartbeat/I/O cadence;
                    # no zero timeout and no duration measured from late launch.
                    time.sleep(min(.02, max(.000001, end - time.time())))
    except Blocked as e:
        receipt.update(classification=e.code, failure=str(e))
    except BaseException as e:
        receipt.update(classification='LAUNCH_FAILED' if child is None else 'INTERNAL_ERROR', failure=type(e).__name__)
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig in handlers:
            signal.signal(sig, signal.SIG_IGN)
        receipt['stopRequestedUtc'] = utc()
        receipt['stopDeviationSeconds'] = time.time() - end
        immediate = epoch_micros(utc()) >= end_exact
        receipt['stopSignalPolicy'] = 'FROZEN_END_IMMEDIATE_SIGKILL' if immediate else 'EARLY_STOP_BOUNDED_TERM_THEN_KILL'
        receipt['firstStopSignal'] = 'SIGKILL' if immediate else 'SIGTERM'
        if child is not None and token is not None:
            try:
                receipt['observerLiveGroupGone'] = stop_owned(child, token, immediate=immediate, frozen_end=end)
                members = group(token['pgid'])
                receipt['observerGroupGone'] = not members
                receipt['remainingZombiePids'] = [v['pid'] for v in members if v['state'] == 'Z']
            except BaseException as e:
                receipt['observerLiveGroupGone'] = False
                receipt['observerGroupGone'] = False
                receipt['cleanupErrorType'] = type(e).__name__
            receipt['cleanupAttemptCompletedUtc'] = utc()
            receipt['actualStopUtc'] = receipt['cleanupAttemptCompletedUtc'] if receipt['observerLiveGroupGone'] else None
            receipt['exitCode'] = child.returncode
            if not receipt['observerLiveGroupGone']:
                receipt['classification'] = 'CLEANUP_FAILED'
        elif child is not None:
            receipt['classification'] = 'CLEANUP_FAILED'
            receipt['observerGroupGone'] = False
            receipt['cleanupErrorType'] = 'Group identity unavailable; direct child kill/wait only'
            try:
                child.kill()
                child.wait(timeout=1)
            except (OSError, subprocess.TimeoutExpired) as e:
                receipt['directChildCleanupErrorType'] = type(e).__name__
        receipt['elapsedRunnerMonotonicSeconds'] = time.monotonic() - mono
        try:
            if sink_failure(target) or receipt.get('exitCode') == 74:
                receipt['operationalFailure'] = 'EVIDENCE_SINK_FAILURE'
                if receipt['classification'] in ('COMPLETE', 'EARLY_EXIT'):
                    receipt['classification'] = 'EVIDENCE_SINK_FAILURE'
            if receipt['actualProcessLaunchUtc'] is not None:
                receipt.update(first_observation(target, receipt['actualProcessLaunchUtc'], m['window']['endUtc']))
            if receipt['classification'] == 'COMPLETE' and not any(evidence_stats(target).values()):
                receipt['classification'] = 'EVIDENCE_MISSING'
            receipt['artifactInventory'] = inventory(target)
            # COMPLETE is lifecycle/evidence-presence only, not scientific/export completion.
            receipt['completionScope'] = 'fixed-window lifecycle only; optional export/comparison/dashboard not run'
            terminal_metadata(receipt, target)
            publish_report(target, receipt)
        except BaseException as e:
            receipt['classification'] = 'REPORT_FAILED'
            terminal_metadata(receipt, target)
            try:
                write_new(target / 'REPORT_FAILED.json', {'classification': 'REPORT_FAILED', 'utc': utc(), 'errorType': type(e).__name__})
                # The successful transaction's names have been retracted. This
                # failure receipt is intentionally uncommitted and unusable.
                write_new(target / 'execution-receipt.json', receipt)
            except OSError:
                pass
    return 0 if receipt.get('lifecycleCode') == 'COMPLETE' else 1

def lifecycle(repo, target, m, command, env, heartbeat_seconds=30):
    """Internal core, injectable only via Python API in isolated subprocess tests."""
    parent = proc(os.getpid())
    mask = signal.pthread_sigmask(signal.SIG_BLOCK, {signal.SIGINT, signal.SIGTERM})
    try:
        write_new(target / 'runner-start.json', {'runner': parent, 'utc': utc(),
                                                'experimentId': target.name, 'restartCount': 0})
        guardian = os.fork()
    except BaseException:
        signal.pthread_sigmask(signal.SIG_SETMASK, mask)
        raise
    if guardian == 0:
        try:
            code = supervise(repo, target, m, command, env, parent, heartbeat_seconds)
        except BaseException:
            code = 1
        os._exit(code)
    guard_token = proc(guardian)
    def forward(sig, frame):
        if guard_token and same(guard_token):
            os.kill(guardian, sig)
    old = {sig: signal.signal(sig, forward) for sig in (signal.SIGINT, signal.SIGTERM)}
    signal.pthread_sigmask(signal.SIG_SETMASK, mask)
    try:
        while True:
            try:
                _, status = os.waitpid(guardian, 0)
                return os.waitstatus_to_exitcode(status)
            except InterruptedError:
                continue
    finally:
        for sig, handler in old.items():
            signal.signal(sig, handler)

def observer_command(repo, target):
    target = experiment_path(repo, target)
    return ['systemd-run', '--user', '--scope', '--quiet',
            '--unit=poly-shadow-observer-' + target.name,
            '--property=MemoryMax=4294967296', '--property=MemoryHigh=3221225472',
            '--property=MemorySwapMax=536870912', 'python3', '-B',
            str(repo / 'scripts/phase4-observer-entry.py'), '--run-id', target.name]


def pointer_value(value):
    fields = {'schemaVersion', 'runDirectory', 'runId', 'approvedShadowSha',
              'startUtc', 'endUtc', 'lifecycleState'}
    require(isinstance(value, dict) and set(value) == fields and type(value['schemaVersion']) is int
            and value['schemaVersion'] == 1 and value['lifecycleState'] == 'AUTHORIZED',
            'PREFLIGHT_FAILED', 'Invalid current-run schema/state')
    require(all(isinstance(value[k], str) for k in fields - {'schemaVersion'}),
            'PREFLIGHT_FAILED', 'Invalid current-run types')
    directory = Path(value['runDirectory'])
    require(directory.is_absolute() and directory.name == value['runId'] and
            re.fullmatch(r'phase4-[A-Za-z0-9_-]+', value['runId']) is not None and
            re.fullmatch(r'[0-9a-f]{40}', value['approvedShadowSha']) is not None,
            'PREFLIGHT_FAILED', 'Invalid current-run identity')
    start, end = epoch(value['startUtc']), epoch(value['endUtc'])
    require(math.isfinite(start) and math.isfinite(end) and epoch_micros(value['endUtc']) - epoch_micros(value['startUtc']) == WINDOW_SECONDS * 1000000,
            'PREFLIGHT_FAILED', 'Invalid current-run window')
    return start, end


def decode_current_pointer(raw):
    """Bounded strict JSON: malformed prior authority must never be replaced."""
    require(isinstance(raw, bytes) and len(raw) <= 128 * 1024,
            'PREFLIGHT_FAILED', 'Current-run pointer oversized or invalid')
    def pairs(items):
        value = {}
        for key, item in items:
            require(key not in value, 'PREFLIGHT_FAILED', 'Duplicate current-run key')
            value[key] = item
        return value
    def constant(_):
        raise Blocked('PREFLIGHT_FAILED', 'Nonfinite current-run JSON')
    try:
        value = json.loads(raw, object_pairs_hook=pairs, parse_constant=constant)
    except (ValueError, UnicodeError):
        raise Blocked('PREFLIGHT_FAILED', 'Malformed current-run JSON') from None
    pointer_value(value)
    return value


def current_pointer_path(repo, pointer):
    require(pointer is not None and Path(pointer).is_absolute(), 'PREFLIGHT_FAILED',
            'Explicit absolute --current-run-pointer required for run')
    p = no_symlinks(pointer)
    require(p != repo and repo not in p.parents and p.parent.is_dir(), 'PREFLIGHT_FAILED',
            'Current-run pointer must be outside repo/runs in existing directory')
    require(not p.exists() or p.is_file(), 'PREFLIGHT_FAILED', 'Invalid pointer file')
    return p


def publish_current_run(repo, target, m, pointer):
    """Call ONLY after fresh seal, revision and protected preflight gates.

    External per-pointer lock serializes stale transitions across repositories;
    existing active or malformed pointers cannot be overwritten.
    """
    target = experiment_path(repo, target)
    p = current_pointer_path(repo, pointer)
    value = {'schemaVersion': 1, 'runDirectory': str(target), 'runId': target.name,
             'approvedShadowSha': m['shadowSha'], 'startUtc': m['window']['startUtc'],
             'endUtc': m['window']['endUtc'], 'lifecycleState': 'AUTHORIZED'}
    start, _ = pointer_value(value)
    require(time.time() < start, 'MISSED_START', 'Start passed before current-run publication')
    lock = no_symlinks(p.with_name(p.name + '.lock'))
    fd = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    stage = p.with_name('.' + p.name + '.' + uuid.uuid4().hex)
    old = None
    replaced = False
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        current_pointer_path(repo, p)
        if p.exists():
            with p.open('rb') as stream:
                old = stream.read(128 * 1024 + 1)
            _, old_end = pointer_value(decode_current_pointer(old))
            require(old_end <= time.time(), 'DUPLICATE_RUN', 'Current-run pointer still active')
        write_new(stage, value)
        require(time.time() < start, 'MISSED_START', 'Start passed during current-run publication')
        os.replace(stage, p)
        replaced = True
        fsync_dir(p.parent)
        with p.open('rb') as stream:
            readback = decode_current_pointer(stream.read(128 * 1024 + 1))
        require(readback == value, 'PREFLIGHT_FAILED', 'Current-run readback mismatch')
    except BaseException:
        # Restore exact previous bytes if durability/readback failed. A failed
        # publication never authorizes lifecycle, regardless of rollback errors.
        if replaced:
            if old is None:
                p.unlink()
            else:
                with stage.open('xb') as f:
                    f.write(old); f.flush(); os.fsync(f.fileno())
                os.replace(stage, p)
            fsync_dir(p.parent)
        raise
    finally:
        if stage.exists():
            stage.unlink()
        os.close(fd)
    return value


def runtime_env(target):
    # No keys, inherited app/polling settings, npm config or credential files.
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8',
            'HOME': str(target / 'runtime-home'), 'TMPDIR': str(target / 'runtime-home'),
            'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()),
            'SHADOW_WATCHED_WALLETS': ','.join(WALLETS), 'SHADOW_DATA_DIR': str(target / 'shadow-data')}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('seal', 'run', 'preflight'))
    parser.add_argument('--experiment', required=True)
    parser.add_argument('--expected-shadow-sha', required=True)
    parser.add_argument('--start-utc')
    parser.add_argument('--end-utc')
    parser.add_argument('--approve-seal', action='store_true')
    parser.add_argument('--current-run-pointer')
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    target = None
    validated = False
    fd = None
    try:
        target = experiment_path(repo, args.experiment)
        credentials(os.environ)
        if args.operation == 'run':
            current_pointer_path(repo, args.current_run_pointer)
        # Preflight BEFORE any experiment creation. Lock serializes seal/run only.
        if args.operation == 'preflight':
            print(json.dumps(preflight(repo, args.expected_shadow_sha, target)))
            return 0
        fd = owner_lock(repo)
        if args.operation == 'seal':
            require(args.approve_seal and args.start_utc and args.end_utc, 'SEAL_INVALID', 'Explicit operator approval/start/end required')
            require(not target.exists(), 'SEAL_INVALID', 'Existing run cannot be sealed')
            checks = preflight(repo, args.expected_shadow_sha, target)
            seal_files(repo, target, epoch(args.start_utc), epoch(args.end_utc), checks, original_window={'startUtc': args.start_utc, 'endUtc': args.end_utc})
            return 0
        m = validate(repo, target, args.expected_shadow_sha)
        validated = True
        require(epoch_micros(utc()) < epoch_micros(m['window']['startUtc']), 'MISSED_START', 'Runner not ready before frozen start')
        baseline = json.loads((target / 'preflight.json').read_text())['poly2']
        preflight(repo, args.expected_shadow_sha, target, baseline)
        # Fail before creating HOME/start marker if seal has missed its start.
        require(epoch_micros(utc()) < epoch_micros(m['window']['startUtc']), 'MISSED_START', 'Runner not ready before frozen start')
        env = runtime_env(target)
        (target / 'runtime-home').mkdir()
        publish_current_run(repo, target, m, args.current_run_pointer)
        return lifecycle(repo, target, m, observer_command(repo, target), env)
    except BaseException as e:
        code = e.code if isinstance(e, Blocked) else 'INTERNAL_ERROR'
        refusal = {'classification': code, 'utc': utc(), 'detail': str(e) if isinstance(e, Blocked) else type(e).__name__,
                   'actualProcessLaunchUtc': None, 'actualObservationStartUtc': None, 'actualStopUtc': None}
        terminal_metadata(refusal, target if target is not None else Path(args.experiment))
        # Append a terminal receipt ONLY to a verified fresh seal owned by this
        # invocation. Never touch historical/invalid/duplicate evidence.
        if validated and target is not None and not (target / 'execution-receipt.json').exists() and not (target / 'runner-start.json').exists():
            try:
                publish_report(target, refusal)
            except OSError:
                refusal['receiptWriteFailed'] = True
                refusal['classification'] = 'REPORT_FAILED'
                terminal_metadata(refusal, target)
                try:
                    write_new(target / 'REPORT_FAILED.json', refusal)
                except OSError:
                    pass
        print(json.dumps(refusal), file=sys.stderr)
        return 1
    finally:
        if fd is not None:
            os.close(fd)

if __name__ == '__main__':
    sys.exit(main())
