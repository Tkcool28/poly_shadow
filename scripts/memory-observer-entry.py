#!/usr/bin/env python3
"""Inert verified scope entry. No acquisition before guardian's exclusive GO."""
import argparse
import os
from pathlib import Path
import time
import types

ROOT = Path(__file__).resolve().parents[1]
M = types.ModuleType('memory_entry_controls')
M.__file__ = str(ROOT / 'scripts/memory_validation.py')
exec(compile(Path(M.__file__).read_bytes(), M.__file__, 'exec', dont_inherit=True), M.__dict__)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    args = parser.parse_args(argv)
    directory = M.test_path(args.directory)
    manifest = M.read_json(directory / 'manifest.json')
    M.require(manifest.get('evidenceBoundary') == M.LABEL and manifest['directory'] == str(directory)
              and manifest['observerEnvironment'] == M.environment(directory), 'Memory manifest mismatch')
    M.require(M.BASELINE <= M.elapsed(manifest) < M.STABILIZED, 'Outside fixed startup phase')
    service, run_id = M.names(directory)
    for p in (directory, directory / 'shadow-data', directory / 'runtime-home'):
        M.R.no_symlinks(p)
        M.require(p.is_dir(), 'Isolated directories unavailable')
    # Reuse exact reviewed own-leaf verification, including oom.group write/readback.
    membership = M.T.bounded(Path('/proc/self/cgroup'), 4096)
    controls = M.E.verify_scope(run_id, membership)
    state = M.scope_identity('poly-shadow-observer-' + run_id + '.scope', service)
    leaf = M.cgroup_leaf(state['ControlGroup'])
    inode = M.leaf_controls(leaf)
    M.kill_leaf(leaf,inode,execute=False)
    M.require(membership.strip() == '0::' + state['ControlGroup'], 'Entry outside manager-owned observer leaf')
    guardian = M.read_json(directory / 'guardian.json')
    M.require(M.R.owner_alive(guardian['token']), 'Guardian identity unavailable')
    guard_state = M.unit_state(service)
    M.require(guard_state.get('InvocationID') == guardian['invocationId']
              and int(guard_state.get('MainPID', '0')) == guardian['token']['pid']
              and guard_state.get('ActiveState') == 'active', 'Guardian manager identity mismatch')
    M.write_new(directory / 'observer-ready.json', {'token': M.R.proc(os.getpid()),
                 'guardianInvocation': guardian['invocationId'], 'controlGroup': state['ControlGroup'],
                 'inode': inode, 'controls': controls, 'utc': M.utc()})
    ready_at = time.monotonic()
    go_path = directory / 'observer-go.json'
    while not go_path.exists():
        M.require(time.monotonic() - ready_at < 10 and M.elapsed(manifest) < M.STABILIZED
                  and M.R.owner_alive(guardian['token']), 'GO deadline/guardian lost; no acquisition')
        time.sleep(.02)
    go = M.read_json(go_path)
    M.require(go.get('evidenceBoundary') == M.LABEL and go['guardianInvocation'] == guardian['invocationId']
              and M.elapsed(manifest) < M.STABILIZED and M.remaining(manifest) > 0, 'Invalid/late GO')
    M.scope_identity('poly-shadow-observer-' + run_id + '.scope', service, state['InvocationID'], control_group=state['ControlGroup'])
    M.leaf_controls(leaf, inode)
    M.R.prelaunch_disk(ROOT, directory)
    M.write_new(directory / 'observer-exec.json', {'execAttemptUtc': M.utc(), 'token': M.R.proc(os.getpid())})
    os.chdir(ROOT)
    os.execve('/usr/bin/npm', ['npm', 'start'], M.environment(directory))


if __name__ == '__main__':
    try:
        main()
    except BaseException as exc:
        print('MEMORY_OBSERVER_REFUSED: ' + type(exc).__name__, flush=True)
        raise SystemExit(1)
