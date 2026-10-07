#!/usr/bin/env python3
"""Fail-closed observer scope entry; fixed npm start, never arbitrary exec.

The independent lifecycle guardian is NOT in this scope. systemd v249 lacks
MemoryOOMGroup: set the kernel flag only on our verified exact own scope.
"""
import argparse
import types
import json
import os
from pathlib import Path
import re
import sys

MAX = 4294967296
HIGH = 3221225472
SWAP = 536870912

class ScopeBlocked(Exception):
    pass


def require(ok, detail):
    if not ok:
        raise ScopeBlocked(detail)


def safe_run_id(run_id):
    require(isinstance(run_id, str) and re.fullmatch(r'phase4-[A-Za-z0-9_-]+', run_id) is not None,
            'Invalid observer run ID')
    return run_id


def no_symlinks(path):
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'Symlink scope/path forbidden')


def limit(path):
    no_symlinks(path)
    text = path.read_text().strip()
    require(text == 'max' or re.fullmatch(r'[0-9]+', text) is not None, 'Malformed memory limit')
    return None if text == 'max' else int(text)


def verify_scope(run_id, cgroup_text, cgroup_root=Path('/sys/fs/cgroup')):
    """Pure-fixture-friendly read/check plus exact leaf oom write; no exec."""
    try:
        name = 'poly-shadow-observer-' + safe_run_id(run_id) + '.scope'
        rows = cgroup_text.splitlines()
        require(len(rows) == 1 and rows[0].startswith('0::/'), 'Unified cgroup v2 required')
        relative = Path(rows[0][4:])
        require(not relative.is_absolute() and relative.parts and
                not any(part in ('.', '..') for part in relative.parts) and relative.name == name,
                'Observer is not in its exact approved scope')
        root = Path(cgroup_root)
        leaf = root / relative
        no_symlinks(leaf)
        require(leaf.is_dir(), 'Missing observer cgroup')
        finite = []
        current = leaf
        while True:
            if current == root and not (current / 'memory.max').exists():
                # Unified hierarchy root has no resource-control interface.
                # Missing limits anywhere below root remain a hard failure.
                break
            value = limit(current / 'memory.max')
            if value is not None:
                finite.append(value)
            if current == root:
                break
            current = current.parent
        require(finite and min(finite) == MAX and limit(leaf / 'memory.max') == MAX,
                'Effective/leaf MemoryMax is not exactly 4 GiB')
        require(limit(leaf / 'memory.high') == HIGH and limit(leaf / 'memory.swap.max') == SWAP,
                'MemoryHigh/MemorySwapMax mismatch')
        oom = leaf / 'memory.oom.group'
        no_symlinks(oom)
        oom.write_text('1\n')
        require(oom.read_text().strip() == '1', 'Kernel group-OOM readback failed')
        # Re-read every finite ancestor after the only write, not just leaf
        # controls: a tighter parent would make the promised cap inaccurate.
        current = leaf
        verified_finite = []
        while True:
            if current == root and not (current / 'memory.max').exists():
                break
            value = limit(current / 'memory.max')
            if value is not None:
                verified_finite.append(value)
            if current == root:
                break
            current = current.parent
        require(verified_finite and min(verified_finite) == MAX and
                limit(leaf / 'memory.max') == MAX and limit(leaf / 'memory.high') == HIGH
                and limit(leaf / 'memory.swap.max') == SWAP,
                'Observer scope controls changed during verification')
        return {'scope': name, 'effectiveMemoryMax': min(finite),
                'memoryHigh': HIGH, 'memorySwapMax': SWAP, 'memoryOomGroup': 1}
    except (OSError, ValueError, IndexError) as exc:
        raise ScopeBlocked('Observer cgroup verification unavailable: ' + type(exc).__name__) from None


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-id', required=True)
    args = parser.parse_args(argv)
    try:
        run_id = safe_run_id(args.run_id)
        # No CLI/env override for cgroup root, repo, program or runtime config.
        controls = verify_scope(run_id, Path('/proc/self/cgroup').read_text())
        repo = Path(__file__).resolve().parents[1]
        target = repo / 'runs' / run_id
        for path in (target, target / 'shadow-data', target / 'runtime-home'):
            no_symlinks(path)
            require(path.is_dir(), 'Missing approved runtime directory')
        # -B prevents writes, NOT cache reads. Bypass import machinery entirely:
        # only exact approved helper source bytes can supply runtime_env.
        source = repo / 'scripts/phase4-runner.py'
        no_symlinks(source)
        require(source.is_file(), 'Runtime helper unavailable')
        runner = types.ModuleType('phase4_runtime')
        runner.__file__ = str(source)
        exec(compile(source.read_bytes(), str(source), 'exec'), runner.__dict__)
        env = runner.runtime_env(target)
        env.pop('XDG_RUNTIME_DIR', None)  # npm has no reason to access user manager.
        print(json.dumps({'observerMemoryControls': controls}), flush=True)
        os.chdir(repo)
        os.execve('/usr/bin/npm', ['npm', 'start'], env)
    except (ScopeBlocked, OSError) as exc:
        print('OBSERVER_SCOPE_BLOCKED: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
