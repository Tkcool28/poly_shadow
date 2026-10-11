#!/usr/bin/env python3
"""Independently invoked, one-shot read-only spool worker (never launches Poly2).

Holds an advisory exclusive lock through worker exit; crash releases kernel lock.
No DB, network, run creation, current-run pointer, timer or service operations.
"""
import argparse
import fcntl
from pathlib import Path
import subprocess


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('binding')
    parser.add_argument('source_directory')
    parser.add_argument('capture_directory')
    parser.add_argument('--archive')
    args = parser.parse_args()
    root = Path(__file__).resolve().parent.parent
    capture = Path(args.capture_directory).resolve()
    capture.mkdir(parents=True, exist_ok=True)
    with open(capture / '.poly2-capture-worker.lock', 'a+b') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        command = [str(root / 'node_modules/.bin/tsx'), str(root / 'src/compare/poly2-capture-worker.ts'),
                   str(Path(args.binding).resolve()), str(Path(args.source_directory).resolve()), str(capture)]
        if args.archive:
            command.append(str(Path(args.archive).resolve()))
        return subprocess.run(command, cwd=root, check=False).returncode


if __name__ == '__main__':
    raise SystemExit(main())
