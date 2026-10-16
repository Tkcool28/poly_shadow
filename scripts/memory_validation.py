#!/usr/bin/env python3
"""Separate operational memory test; never a Phase 4 scientific run.

Only run --approve-memory-validation launches anything. No duration, command,
wallet, endpoint, resource or unsafe-skip overrides exist in the public CLI.
"""
import argparse
import ctypes
import datetime as dt
import fcntl
import hashlib
import json
import math
import os
from pathlib import Path
import re
import signal
import stat
import subprocess
import sys
import time
import types

ROOT = Path(__file__).resolve().parents[1]


def source_module(name, path):
    module = types.ModuleType(name)
    module.__file__ = str(path)
    exec(compile(path.read_bytes(), str(path), 'exec', dont_inherit=True), module.__dict__)
    return module


R = source_module('memory_reviewed_runner', ROOT / 'scripts/phase4-runner.py')
E = source_module('memory_reviewed_scope', ROOT / 'scripts/phase4-observer-entry.py')
T = source_module('memory_telemetry', ROOT / 'scripts/memory_telemetry.py')
LABEL = T.LABEL
DURATION = 7200
BASELINE = 900
STABILIZED = 1800
CADENCE = 10
ROW_BYTES = 65536
MAX_ROWS = 721
LOG_BYTES = 16 * 1024 ** 2
SERVICE_GRACE = 8  # administrative cleanup only; observer deadline never extended
PROTECTED = ('poly2-bot-1', 'poly2-backend-1', 'poly2-postgres-1', 'poly2-redis-1')


class Abort(Exception):
    pass


def require(value, message):
    if not value:
        raise Abort(message)


def utc(value=None):
    return dt.datetime.fromtimestamp(time.time() if value is None else value, dt.timezone.utc).isoformat().replace('+00:00', 'Z')


def tagged(value):
    return {**value, 'evidenceBoundary': LABEL}


def write_new(path, value):
    R.write_new(path, tagged(value))


def read_json(path):
    return json.loads(T.bounded(path, 262144))


def names(directory):
    ident = directory.name
    require(re.fullmatch(r'memory-[a-z0-9][a-z0-9-]{0,47}', ident), 'Invalid memory test ID')
    return 'poly-shadow-' + ident + '.service', 'phase4-' + ident


def test_path(path, root=ROOT):
    p = Path(os.path.abspath(path))
    require(Path(path).is_absolute() and '..' not in Path(path).parts, 'Absolute direct memory-test path required')
    R.no_symlinks(p)
    require(p.parent == root / 'memory-validation', 'Evidence must be outside scientific runs in memory-validation/')
    names(p)
    return p


def phase(elapsed):
    require(math.isfinite(elapsed) and elapsed >= 0, 'Invalid elapsed time')
    return 'BASELINE' if elapsed < BASELINE else 'STABILIZATION' if elapsed < STABILIZED else 'SUSTAINED' if elapsed < DURATION else 'DEADLINE'


def elapsed(manifest, wall=None, mono=None):
    wall = time.time() if wall is None else wall
    mono = time.monotonic() if mono is None else mono
    return max(wall - manifest['startWall'], mono - manifest['startMono'])


def remaining(manifest):
    return max(0, DURATION - elapsed(manifest))


def environment(directory):
    # Exactly the reviewed observer environment, with isolated HOME/TMP/data.
    value = R.runtime_env(directory)
    value.pop('XDG_RUNTIME_DIR', None)
    return value


def control_env():
    return {'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'HOME': str(Path.home()),
            'XDG_RUNTIME_DIR': '/run/user/' + str(os.getuid()),
            'DBUS_SESSION_BUS_ADDRESS': 'unix:path=/run/user/' + str(os.getuid()) + '/bus',
            'PYTHONDONTWRITEBYTECODE': '1'}


def command(args, input=None, timeout=3, allow_missing=False):
    result = subprocess.run(args, input=input, text=True, stdout=subprocess.PIPE,
                            stderr=subprocess.DEVNULL, timeout=timeout, env=control_env(), check=False)
    require(result.returncode == 0 or allow_missing and 'LoadState=not-found' in result.stdout, 'Control command failed')
    require(len(result.stdout.encode()) <= 65536, 'Control response budget exceeded')
    return result.stdout.strip()


def unit_state(unit):
    # Fixed field selection: never print arbitrary service environment/config.
    fields = 'Id,LoadState,ActiveState,SubState,MainPID,InvocationID,ControlGroup,BindsTo,After,MemoryHigh,MemoryMax,MemorySwapMax,KillMode,KillSignal,TimeoutStopUSec,Restart,RuntimeMaxUSec,ActiveEnterTimestampMonotonic,Result'
    text = command(['systemctl', '--user', 'show', unit, '--property=' + fields], allow_missing=True)
    return dict(line.split('=', 1) for line in text.splitlines() if '=' in line)


def duration_us(text):
    units = {'d': 86400, 'h': 3600, 'min': 60, 's': 1, 'ms': .001, 'us': .000001}
    parts = re.findall(r'([0-9]+(?:\.[0-9]+)?)(min|ms|us|d|h|s)', text)
    require(parts and ''.join(n + u for n, u in parts) == text.replace(' ', ''), 'Unknown systemd runtime limit')
    return sum(float(n) * units[u] * 1e6 for n, u in parts)


def guard_identity(unit, token=None):
    s = unit_state(unit)
    require(s.get('Id') == unit and s.get('LoadState') == 'loaded' and s.get('ActiveState') == 'active'
            and int(s.get('MainPID', '0')) == os.getpid() and s.get('KillMode') == 'control-group'
            and s.get('Restart') == 'no' and re.fullmatch('[0-9a-f]{32}', s.get('InvocationID', '')),
            'Guardian systemd identity/control mismatch')
    if token:
        require(s['InvocationID'] == token, 'Guardian service incarnation changed')
    require(0 < duration_us(s.get('RuntimeMaxUSec', '')) <= (DURATION + SERVICE_GRACE) * 1e6,
            'Guardian runtime safety bound unavailable')
    return s


def scope_identity(unit, guardian, invocation=None, deadline_mono=None, control_group=None):
    s = unit_state(unit)
    require(s.get('Id') == unit and s.get('ActiveState') == 'active' and s.get('LoadState') == 'loaded'
            and guardian in s.get('BindsTo', '').split() and guardian in s.get('After', '').split()
            and re.fullmatch('[0-9a-f]{32}', s.get('InvocationID', ''))
            and [int(s.get(k, '0')) for k in ('MemoryHigh', 'MemoryMax', 'MemorySwapMax')]
            == [E.HIGH, E.MAX, E.SWAP] and s.get('KillMode') == 'control-group'
            and s.get('KillSignal') == '9' and duration_us(s.get('TimeoutStopUSec', '')) <= 2e6, 'Observer scope manager identity/limits/binding mismatch')
    if invocation:
        require(s['InvocationID'] == invocation, 'Observer scope incarnation changed')
    if control_group:
        require(s.get('ControlGroup') == control_group, 'Observer manager cgroup changed')
    require(0 < duration_us(s.get('RuntimeMaxUSec', '')) <= (DURATION - BASELINE) * 1e6, 'Observer runtime fallback bound unavailable')
    return s


def cgroup_leaf(control_group):
    require(control_group.startswith('/') and '..' not in control_group.split('/'), 'Unsafe manager cgroup path')
    return Path('/sys/fs/cgroup') / control_group.lstrip('/')


def leaf_controls(leaf, inode=None, root=Path('/sys/fs/cgroup')):
    E.no_symlinks(leaf)
    require(leaf.is_dir() and root in leaf.parents, 'Observer leaf unavailable')
    actual = (leaf.stat().st_dev, leaf.stat().st_ino)
    require(inode is None or tuple(inode) == actual, 'Observer cgroup replaced')
    require(E.limit(leaf / 'memory.max') == E.MAX and E.limit(leaf / 'memory.high') == E.HIGH
            and E.limit(leaf / 'memory.swap.max') == E.SWAP
            and T.bounded(leaf / 'memory.oom.group', 32).strip() == '1', 'Unsafe observer cgroup change')
    finite = []
    current = leaf
    for _ in range(64):
        if current == root:
            break
        value = E.limit(current / 'memory.max')
        if value is not None:
            finite.append(value)
        current = current.parent
    require(current == root and finite and min(finite) == E.MAX, 'Effective ancestor memory limit changed')
    return actual


def poly2_snapshot():
    docker = ['docker', '--host=unix:///var/run/docker.sock']
    inspect = [json.loads(line) for line in command(docker + ['inspect', '--format', '{"Id":{{json .Id}},"Name":{{json .Name}},"State":{{json .State}},"RestartCount":{{.RestartCount}}}'] + list(PROTECTED)).splitlines()]
    containers = {}
    for item in inspect:
        state = item['State']
        name = item['Name'].lstrip('/')
        require(name in PROTECTED and state['Running'] is True and not state['Restarting'] and not state['OOMKilled']
                and state.get('Health', {}).get('Status', 'healthy') == 'healthy', 'Poly2 service unhealthy')
        containers[name] = {'id': item['Id'], 'startedAt': state['StartedAt'], 'restartCount': item['RestartCount']}
    require(set(containers) == set(PROTECTED), 'Poly2 service inventory incomplete')
    config = {}
    for service in ('poly2-bot-1', 'poly2-backend-1'):
        code = "import json;from polycopy.config import get_settings;s=get_settings();print(json.dumps({k:getattr(s,k) for k in ['paper_mode','allow_live_trading','order_kill_switch','shadow_capture_enabled','max_order_size_usd','max_exposure_global_usd']}))"
        c = json.loads(command(docker + ['exec', service, 'python', '-c', code]))
        require(c['paper_mode'] is True and c['allow_live_trading'] is False and c['order_kill_switch'] is False
                and c['shadow_capture_enabled'] is False, 'Poly2 paper/capture safety baseline refused')
        config[service] = c
    sql = "BEGIN TRANSACTION READ ONLY; SELECT json_build_object('readOnly',current_setting('transaction_read_only'),'heartbeats',(SELECT json_agg(row_to_json(h)) FROM (SELECT service,max(seen_at) AS last_seen FROM service_heartbeats WHERE service IN ('bot_alive','bot_success') GROUP BY service) h)); ROLLBACK;"
    db = json.loads(command(docker + ['exec', '-i', 'poly2-postgres-1', 'sh', '-c',
        'PGOPTIONS="-c default_transaction_read_only=on -c statement_timeout=2000" psql -X -q -A -t -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'], input=sql))
    beats = {r['service']: R.epoch(r['last_seen']) for r in db['heartbeats'] or []}
    require(db['readOnly'] == 'on' and all(0 <= time.time() - beats.get(k, 0) < 180 for k in ('bot_alive', 'bot_success')),
            'Poly2 heartbeat degradation or unknown read-only proof')
    return {'containers': containers, 'config': config, 'heartbeatAgeSeconds': {k: time.time() - beats[k] for k in beats},
            'sha': command(['git', '-C', '/opt/poly2', 'rev-parse', 'HEAD']), 'checkedUtc': utc()}


def same_poly2(current, baseline):
    require(all(current[k] == baseline[k] for k in ('containers', 'config', 'sha')), 'Material Poly2 baseline change')


def preflight(directory, expected_sha):
    directory = test_path(directory)
    require(sys.platform == 'linux', 'Linux required')
    R.credentials(os.environ)
    require(re.fullmatch('[0-9a-f]{40}', expected_sha), 'Full reviewed SHA required')
    require(command(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == expected_sha
            == command(['git', '-C', str(ROOT), 'rev-parse', 'origin/main'])
            and command(['git', '-C', str(ROOT), 'branch', '--show-current']) == 'main'
            and not command(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=no']),
            'Clean reviewed main/origin/main checkout required')
    others = command(['git', '-C', str(ROOT), 'ls-files', '--others', '--exclude-standard', '-z'])
    require(all(p.startswith(('runs/', 'memory-validation/')) for p in others.split('\0') if p),
            'Untracked executable/source content forbidden; use a clean deployment checkout')
    R.orphans(ROOT, directory)
    require(not directory.exists(), 'Exclusive new test directory required; no retry')
    service, run_id = names(directory)
    for unit in (service, 'poly-shadow-observer-' + run_id + '.scope'):
        require(unit_state(unit).get('LoadState') == 'not-found', 'Test unit already exists')
    require('memory' in T.bounded(Path('/sys/fs/cgroup/cgroup.controllers')).split(), 'cgroup v2 memory controller required')
    require(R.proc(os.getpid()) is not None, 'Process ownership cannot be verified')
    fd = R.owner_lock(ROOT)
    os.close(fd)
    return {'shadowSha': expected_sha, 'disk': R.prelaunch_disk(ROOT, directory),
            'host': T.host_snapshot(), 'poly2': poly2_snapshot()}


class Journal:
    def __init__(self, path):
        self.fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        self.rows = 0
        self.bytes = 0

    def append(self, value):
        data = (json.dumps(tagged(value), separators=(',', ':'), allow_nan=False) + '\n').encode()
        require(self.rows < MAX_ROWS and len(data) <= ROW_BYTES, 'Telemetry output budget exceeded')
        view = memoryview(data)
        while view:
            n = os.write(self.fd, view)
            require(n > 0, 'Telemetry short write')
            view = view[n:]
        os.fsync(self.fd)
        self.rows += 1
        self.bytes += len(data)

    def close(self):
        os.close(self.fd)


def scope_command(directory, manifest):
    service, run_id = names(directory)
    return ['systemd-run', '--user', '--scope', '--quiet', '--unit=poly-shadow-observer-' + run_id,
            '--property=MemoryHigh=' + str(E.HIGH), '--property=MemoryMax=' + str(E.MAX),
            '--property=MemorySwapMax=' + str(E.SWAP), '--property=BindsTo=' + service,
            '--property=After=' + service, '--property=KillMode=control-group',
            '--property=KillSignal=SIGKILL', '--property=TimeoutStopSec=2', '--property=RuntimeMaxSec=%.6f' % remaining(manifest),
            '/usr/bin/python3', '-B', str(ROOT / 'scripts/memory-observer-entry.py'), '--directory', str(directory)]


def kill_leaf(leaf, inode, execute=True):
    """Only the retained own leaf descriptor, never a discovered process name."""
    E.no_symlinks(leaf)
    fd = os.open(leaf, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        require(inode is not None and (info.st_dev,info.st_ino) == tuple(inode), 'Cleanup cgroup ownership changed')
        out = os.open('cgroup.kill', os.O_WRONLY | os.O_NOFOLLOW, dir_fd=fd)
        try:
            if execute:
                require(os.write(out,b'1') == 1, 'Cgroup kill short write')
        finally:
            os.close(out)
    finally:
        os.close(fd)


def cleanup(child, token, scope, scope_invocation, leaf, end_wall, inode=None):
    errors = []
    group_gone = child is None
    if child is not None:
        try:
            if leaf and leaf.exists() and inode is not None:
                kill_leaf(leaf,inode)
        except BaseException as exc:
            errors.append('LEAF_KILL_' + type(exc).__name__)
        try:
            s = unit_state(scope)
            if s.get('LoadState') == 'loaded' and s.get('ActiveState') in ('active','activating','deactivating'):
                require(s.get('Id') == scope, 'Cleanup scope name changed')
                if scope_invocation:
                    # Captured incarnation remains owned even if unsafe external
                    # edits removed its binding; do not skip killing that scope.
                    require(s.get('InvocationID') == scope_invocation, 'Cleanup scope incarnation changed')
                else:
                    ident = scope.removeprefix('poly-shadow-observer-phase4-').removesuffix('.scope')
                    guard = 'poly-shadow-' + ident + '.service'
                    require(guard in s.get('BindsTo','').split() and guard in s.get('After','').split(), 'Pre-GO cleanup binding unavailable')
                command(['systemctl','--user','kill','--kill-who=all','--signal=KILL',scope],timeout=1)
            else:
                require(s.get('LoadState') == 'not-found' or s.get('ActiveState') in ('inactive','failed'), 'Scope state unknown')
        except BaseException as exc:
            errors.append('MANAGER_' + type(exc).__name__)
        # This attempt is independent of *every* manager/cgroup operation above.
        try:
            require(token is not None, 'Direct-child ownership unavailable')
            group_gone = R.stop_owned(child,token,immediate=True,frozen_end=end_wall)
        except BaseException as exc:
            errors.append('OWNED_GROUP_' + type(exc).__name__)
        limit = time.monotonic() + 2
        try:
            while leaf and leaf.exists() and T.cgroup_pids(leaf) and time.monotonic() < limit:
                time.sleep(.02)
            empty = (not leaf.exists() or not T.cgroup_pids(leaf)) if leaf else unit_state(scope).get('ActiveState') in ('inactive','failed') or unit_state(scope).get('LoadState') == 'not-found'
        except BaseException as exc:
            empty = False
            errors.append('EMPTY_PROOF_' + type(exc).__name__)
    else:
        empty = True
    return {'complete':bool(group_gone and empty and not errors),'ownedProcessGroupGone':group_gone,
            'observerCgroupEmpty':empty,'errors':errors,'completedUtc':utc()}


def terminal_check(directory, manifest, child, leaf, inode, initial_events, psi_streak):
    """Local bounded reads before intentional kill; never certify an unchecked tail."""
    require(child is not None and leaf is not None and initial_events is not None,
            'TERMINAL_OBSERVER_UNVERIFIABLE')
    leaf_controls(leaf, inode)
    events = T.pairs(T.bounded(leaf / 'memory.events'))
    require(all(k in events for k in ('max', 'oom', 'oom_kill')), 'TERMINAL_EVENTS_UNVERIFIABLE')
    host = T.host_snapshot()
    disk = T.disk_snapshot(directory)
    failure, _ = T.pressure_failure(host, manifest['preflight']['host'], disk,
                                   {'events': events}, initial_events, psi_streak)
    require(not failure, failure or 'TERMINAL_PRESSURE')
    require(not R.child_exited(child), 'OBSERVER_EARLY_EXIT')
    return {'utc':utc(), 'host':host, 'disk':disk, 'memoryEvents':events}


def supervise(directory, manifest):
    """Guardian service core. All injection for tests is by unittest mocks, no CLI bypass."""
    parent = manifest['launcherToken']
    service, run_id = names(directory)
    scope = 'poly-shadow-observer-' + run_id + '.scope'
    receipt = tagged({'status': 'FAILED', 'failure': None, 'actualObserverLaunchUtc': None,
                      'actualObserverAuthorizedUtc': None, 'stopRequestedUtc': None,
                      'startUtc': manifest['startUtc'], 'deadlineUtc': manifest['deadlineUtc'],
                      'restartCount': 0, 'phaseSeconds': [BASELINE, STABILIZED - BASELINE, DURATION - STABILIZED]})
    child = token = leaf = scope_invocation = inode = None
    journal = log = None
    owner = None
    original_handlers = {}
    peaks = {'rssBytes': None, 'pssBytes': None, 'cgroupBytes': 0, 'cgroupSwapBytes': 0}
    phase_first = {}
    phase_stats = {}
    psi_streak = 0
    last_sample = -1
    log_bytes = 0
    initial_events = None
    last_poly2 = None
    last_probe = -float('inf')
    def interrupt(sig, frame):
        raise Abort('DEADLINE' if elapsed(manifest) >= DURATION else 'INTERRUPTED_' + str(sig))
    try:
        for sig in (signal.SIGTERM, signal.SIGINT, signal.SIGALRM):
            original_handlers[sig] = signal.signal(sig, interrupt)
        require(remaining(manifest) > 0, 'DEADLINE')
        signal.setitimer(signal.ITIMER_REAL, max(.000001, remaining(manifest)))
        require(ctypes.CDLL(None).prctl(36, 1, 0, 0, 0) == 0, 'Subreaper unavailable')
        require(R.owner_alive(parent), 'LAUNCHER_LOST')
        guard = guard_identity(service)
        require(T.bounded(Path('/proc/sys/kernel/random/boot_id')).strip() == manifest['bootId'], 'Boot identity mismatch')
        owner = R.owner_lock(ROOT)
        write_new(directory / 'guardian.json', {'token': R.proc(os.getpid()), 'service': service, 'invocationId': guard['InvocationID']})
        journal = Journal(directory / 'memory.jsonl')
        log = os.open(directory / 'observer.log', os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        while True:
            age = elapsed(manifest)
            if age >= DURATION:
                raise Abort('DEADLINE')
            require(abs((time.time() - manifest['startWall']) - (time.monotonic() - manifest['startMono'])) < 2,
                    'CLOCK_STEP')
            require(R.owner_alive(parent), 'LAUNCHER_LOST')
            if child is None and age >= BASELINE:
                require(age < STABILIZED, 'MISSED_STABILIZATION')
                R.orphans(ROOT, directory)
                R.prelaunch_disk(ROOT, directory)
                fresh = poly2_snapshot()
                same_poly2(fresh, manifest['preflight']['poly2'])
                require(elapsed(manifest) < STABILIZED, 'MISSED_STABILIZATION')
                require(command(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == manifest['shadowSha'] and not command(['git', '-C', str(ROOT), 'status', '--porcelain=v1', '--untracked-files=no']), 'Reviewed source changed during baseline')
                child = subprocess.Popen(scope_command(directory, manifest), cwd=ROOT, env=control_env(),
                                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True)
                receipt['actualObserverLaunchUtc'] = utc()
                token = R.proc(child.pid) or R.fallback_token(child)
                require(token and token['pgid'] == child.pid and token['session'] == child.pid, 'Observer client ownership unavailable')
                os.set_blocking(child.stdout.fileno(), False)
            if child:
                for _ in range(4):
                    try:
                        data = os.read(child.stdout.fileno(), 65536) if child.stdout else b''
                    except BlockingIOError:
                        break
                    if not data:
                        break
                    log_bytes += len(data)
                    require(log_bytes <= LOG_BYTES, 'Observer log budget exceeded')
                    os.write(log, data)
                if R.child_exited(child):
                    if leaf and leaf.exists():
                        final_events = T.pairs(T.bounded(leaf / 'memory.events'))
                        receipt['terminalMemoryEvents'] = final_events
                        require(not any(final_events[k] > initial_events[k] for k in ('oom','oom_kill')), 'OBSERVER_OOM')
                    require(unit_state(scope).get('Result') != 'oom-kill', 'OBSERVER_OOM')
                    raise Abort('OBSERVER_EARLY_EXIT')
                ready = directory / 'observer-ready.json'
                if leaf is None and ready.exists():
                    handoff = read_json(ready)
                    require(handoff.get('evidenceBoundary') == LABEL and handoff['guardianInvocation'] == guard['InvocationID'],
                            'Observer readiness custody mismatch')
                    state = scope_identity(scope, service)
                    require(handoff['controlGroup'] == state['ControlGroup'], 'Readiness cgroup mismatch')
                    leaf = cgroup_leaf(state['ControlGroup'])
                    inode = leaf_controls(leaf, handoff['inode'])
                    kill_leaf(leaf,inode,execute=False)  # verify last-resort cleanup before GO
                    require(R.owner_alive(handoff['token']) and handoff['token']['pid'] in T.cgroup_pids(leaf),
                            'Ready helper process identity mismatch')
                    T.observer_snapshot(leaf)  # require all mandatory cgroup telemetry before GO
                    initial_events = T.pairs(T.bounded(leaf / 'memory.events'))
                    require(all(initial_events[k] == 0 for k in ('max', 'oom', 'oom_kill')), 'Observer cgroup already failed')
                    scope_invocation = state['InvocationID']
                    scope_identity(scope, service, scope_invocation, control_group=state['ControlGroup'])
                    original_control_group = state['ControlGroup']
                    require(elapsed(manifest) < STABILIZED and remaining(manifest) > 0, 'MISSED_STABILIZATION')
                    # Acquisition is impossible before this independently verified GO.
                    write_new(directory / 'observer-go.json', {'guardianInvocation': guard['InvocationID'], 'utc': utc()})
                    receipt['actualObserverAuthorizedUtc'] = utc()
                elif leaf is None:
                    require(time.time() - R.epoch(receipt['actualObserverLaunchUtc']) < 15, 'Observer scope readiness timeout')
            slot = int(age // CADENCE)
            if slot != last_sample:
                require(slot < MAX_ROWS, 'Telemetry time budget')
                guard_identity(service, guard['InvocationID'])
                if leaf:
                    scope_identity(scope, service, scope_invocation, control_group=original_control_group)
                    leaf_controls(leaf, inode)
                host = T.host_snapshot()
                observer = T.observer_snapshot(leaf) if leaf else None
                disk = T.disk_snapshot(directory)
                failure, psi_streak = T.pressure_failure(host, manifest['preflight']['host'], disk, observer, initial_events, psi_streak)
                if age - last_probe >= 30:
                    last_poly2 = poly2_snapshot()
                    same_poly2(last_poly2, manifest['preflight']['poly2'])
                    last_probe = age
                evidence = T.evidence_snapshot(directory / 'shadow-data')
                if receipt['actualObserverAuthorizedUtc'] and time.time() - R.epoch(receipt['actualObserverAuthorizedUtc']) > 30:
                    runtime = evidence['acquisition']
                    require(runtime and time.time() - runtime['runtimeMtime'] < 20
                            and not runtime['operationalSinkBroken'] and runtime['dataQuality']['state'] != 'AT_RISK',
                            'OBSERVER_HEALTH_OR_ACQUISITION_FAILED')
                    require(runtime['token']['pid'] in T.cgroup_pids(leaf), 'Observer runtime identity outside owned scope')
                p = phase(age)
                phase_first.setdefault(p, utc())
                sample = {'utc': utc(), 'elapsedSeconds': age, 'phase': p, 'slot': slot,
                          'missedSampleSlots': max(0, slot - last_sample - 1), 'host': host,
                          'observer': observer, 'workloads': T.workloads([r['pid'] for r in observer['processes']] if observer else ()),
                          'disk': disk, 'evidence': evidence, 'poly2': last_poly2, 'poly2ProbeAgeSeconds': age - last_probe,
                          'stopCondition': failure,'observerLogBytes':log_bytes,'telemetryBytesBeforeSample':journal.bytes}
                journal.append(sample)
                record = {'elapsedSeconds':age,'utc':sample['utc'],'rssBytes':observer['treeRssBytes'] if observer else None,'pssBytes':observer['treePssBytes'] if observer else None,'cgroupBytes':observer['memoryCurrentBytes'] if observer else None,'evidenceBytes':evidence['totalSelectedBytes']}
                stats = phase_stats.setdefault(p, {'samples':0,'first':record,'last':record,'minHostMemAvailableBytes':host['memAvailableBytes']})
                stats['samples'] += 1
                stats['last'] = record
                stats['minHostMemAvailableBytes'] = min(stats['minHostMemAvailableBytes'],host['memAvailableBytes'])
                require(slot == last_sample + 1, 'TELEMETRY_SAMPLE_SLOT_MISSED')
                if observer:
                    for key, field in [('rssBytes', 'treeRssBytes'), ('pssBytes', 'treePssBytes'),
                                       ('cgroupBytes', 'memoryCurrentBytes'), ('cgroupSwapBytes', 'swapCurrentBytes')]:
                        value = observer[field]
                        if value is not None:
                            peaks[key] = max(peaks[key] or 0, value)
                require(not failure, failure or 'pressure failure')
                last_sample = slot
            time.sleep(min(.1, remaining(manifest)))
    except BlockingIOError:
        receipt['failure'] = 'CONTROL_OR_LOG_IO_FAILURE'
    except Abort as exc:
        receipt['failure'] = str(exc)
        if str(exc) == 'DEADLINE' and receipt['actualObserverAuthorizedUtc']:
            try:
                receipt['terminalSafety'] = terminal_check(directory, manifest, child, leaf, inode, initial_events, psi_streak)
                require(last_sample == int((DURATION - .000001) // CADENCE), 'INCOMPLETE_TELEMETRY')
                receipt.update(status='COMPLETE', failure=None)
            except BaseException as terminal:
                receipt.update(status='FAILED', failure=str(terminal) if isinstance(terminal, Abort) else 'TERMINAL_' + type(terminal).__name__)
    except BaseException as exc:
        receipt['failure'] = type(exc).__name__
    finally:
        # Never let a second signal interrupt owned cleanup. Manager binding is
        # the independent fallback if this guardian itself receives SIGKILL.
        signal.setitimer(signal.ITIMER_REAL, 0)
        for sig in original_handlers:
            signal.signal(sig, signal.SIG_IGN)
        receipt['stopRequestedUtc'] = utc()
        try:
            receipt['cleanup'] = cleanup(child, token, scope, scope_invocation, leaf, manifest['startWall'] + DURATION,inode)
            require(receipt['cleanup']['complete'], 'Cleanup incomplete or control errors')
        except BaseException as exc:
            receipt.update(status='FAILED', triggerFailure=receipt['failure'], failure='CLEANUP_FAILED', cleanupError=type(exc).__name__)
        for stats in phase_stats.values():
            stats['sampleSpanSeconds'] = stats['last']['elapsedSeconds'] - stats['first']['elapsedSeconds']
            stats['growthBytes'] = {k:stats['last'][k]-stats['first'][k] if stats['last'][k] is not None and stats['first'][k] is not None else None for k in ('rssBytes','pssBytes','cgroupBytes','evidenceBytes')}
        receipt['phases'] = phase_stats
        if receipt['status'] == 'COMPLETE' and set(phase_stats) != {'BASELINE','STABILIZATION','SUSTAINED'}:
            receipt.update(status='FAILED',failure='INCOMPLETE_PHASE_MEASUREMENT')
        if (directory / 'observer-exec.json').exists():
            receipt['observerExecAttempt'] = read_json(directory / 'observer-exec.json')
        receipt.update(actualShutdownUtc=utc(), elapsedSeconds=elapsed(manifest), peaks=peaks,
                       phaseFirstSampleUtc=phase_first, telemetryRows=journal.rows if journal else 0,
                       telemetryBytes=journal.bytes if journal else 0, observerLogBytes=log_bytes,
                       completionScope='operational memory validation only; no scientific comparison')
        try:
            if journal:
                journal.close()
            if log is not None:
                os.fsync(log)
                os.close(log)
            write_new(directory / 'summary.json', receipt)
        finally:
            if owner is not None:
                os.close(owner)
            for sig, handler in original_handlers.items():
                signal.signal(sig, handler)
    return 0 if receipt['status'] == 'COMPLETE' else 1


def guardian(directory):
    R.credentials(os.environ)
    directory = test_path(directory)
    m = read_json(directory / 'manifest.json')
    require(m.get('evidenceBoundary') == LABEL and m['directory'] == str(directory)
            and m['durationSeconds'] == DURATION and m['observerEnvironment'] == environment(directory)
            and command(['git', '-C', str(ROOT), 'rev-parse', 'HEAD']) == m['shadowSha'], 'Invalid memory-only manifest')
    return supervise(directory, m)


def run(directory, expected_sha):
    checks = preflight(directory, expected_sha)
    directory = test_path(directory)
    directory.parent.mkdir(mode=0o700, exist_ok=True)
    directory.mkdir(mode=0o700)  # exclusive; never reuse even after startup refusal
    for name in ('shadow-data', 'runtime-home'):
        (directory / name).mkdir(mode=0o700)
    start_wall, start_mono = time.time(), time.monotonic()
    service, _ = names(directory)
    m = {'directory': str(directory), 'shadowSha': expected_sha, 'preflight': checks,
         'startWall': start_wall, 'startMono': start_mono, 'startUtc': utc(start_wall),
         'deadlineUtc': utc(start_wall + DURATION), 'durationSeconds': DURATION,
         'launcherToken': R.proc(os.getpid()), 'bootId': T.bounded(Path('/proc/sys/kernel/random/boot_id')).strip(),
         'observerEnvironment': environment(directory), 'restartCount': 0}
    write_new(directory / 'manifest.json', m)
    (directory / 'manifest.json').chmod(0o400)
    write_new(directory / 'shadow-data/EVIDENCE_BOUNDARY.json', {'scope': 'Every file in this directory is MEMORY VALIDATION ONLY; original observer journal schemas unchanged'})
    cmd = ['systemd-run', '--user', '--wait', '--quiet', '--unit=' + service.removesuffix('.service'),
           '--service-type=exec', '--property=Restart=no', '--property=KillMode=control-group',
           '--property=TimeoutStopSec=5', '--property=WorkingDirectory=' + str(ROOT),
           '--property=RuntimeMaxSec=%.6f' % (remaining(m) + SERVICE_GRACE),
           '/usr/bin/python3', '-B', str(ROOT / 'scripts/memory_validation.py'), '_guard', '--directory', str(directory)]
    # Manager owns the independent service; this wait client is never the observer.
    child = subprocess.Popen(cmd, env=control_env(), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    handlers = {}
    def stop(sig, frame):
        child.terminate()  # guardian detects launcher disappearance only if launcher exits
        raise Abort('Launcher interrupted; independent guardian will stop its scope')
    try:
        for sig in (signal.SIGTERM, signal.SIGINT):
            handlers[sig] = signal.signal(sig, stop)
        child.wait(timeout=remaining(m) + SERVICE_GRACE + 5)
    except BaseException:
        # Exiting launcher is authoritative parent loss; no ownership guess/kill.
        raise
    finally:
        for sig, handler in handlers.items():
            signal.signal(sig, handler)
    if not (directory / 'summary.json').exists():
        write_new(directory / 'summary.json', {'status':'FAILED','failure':'GUARDIAN_OR_REPORT_LOST','actualShutdownUtc':utc(), 'managerState':unit_state(service), 'cleanupProof':'Manager BindsTo is fallback; no successful completion certified'})
    summary = read_json(directory / 'summary.json')
    require(summary.get('evidenceBoundary') == LABEL and summary.get('status') == 'COMPLETE', 'Memory test failed; inspect retained summary')
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('operation', choices=('preflight', 'run', '_guard'))
    parser.add_argument('--directory', required=True)
    parser.add_argument('--expected-sha')
    parser.add_argument('--approve-memory-validation', action='store_true')
    args = parser.parse_args(argv)
    try:
        if args.operation == '_guard':
            return guardian(args.directory)
        require(args.expected_sha, 'Explicit reviewed SHA required')
        if args.operation == 'preflight':
            print(json.dumps(tagged(preflight(args.directory, args.expected_sha))))
            return 0
        require(args.approve_memory_validation, 'Explicit approval required to run memory validation')
        return run(args.directory, args.expected_sha)
    except BaseException as exc:
        print(json.dumps(tagged({'status': 'REFUSED_OR_FAILED', 'error': str(exc) if isinstance(exc, Abort) else type(exc).__name__})), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
