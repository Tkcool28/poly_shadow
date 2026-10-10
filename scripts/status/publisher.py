#!/usr/bin/env python3
"""Independent unlimited operational publisher. Never launches/controls observers.

Repository implementation only; installing/enabling its service is separately
unauthorized. Uses collector's bounded read-only binding and atomic public JSON.
"""
import argparse
import importlib.util
import math
from pathlib import Path
import signal
import threading
import time

_spec = importlib.util.spec_from_file_location('status_collector', Path(__file__).with_name('collector.py'))
collector = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(collector)
CADENCE_SECONDS = 60
MAXIMUM_DRAIN_GRACE_SECONDS = 7200


def horizon_proof(cadence=CADENCE_SECONDS, window=86400, drain=MAXIMUM_DRAIN_GRACE_SECONDS):
    if not math.isfinite(cadence) or cadence <= 0:
        raise ValueError('positive cadence required')
    return dict(windowSeconds=window, maximumDrainGraceSeconds=drain, cadenceSeconds=cadence,
                requiredAttempts=math.ceil((window+drain)/cadence)+1,
                maximumAttempts=None, finiteLifecycle=False, canExhaust=False)


class Publisher:
    def __init__(self, output, cache, pointer=collector.POINTER, runs_root=collector.RUNS_ROOT,
                 cadence=CADENCE_SECONDS, now=time.time, collect=collector.collect, write=collector.atomic_json):
        horizon_proof(cadence)
        self.output, self.cache, self.pointer, self.runs_root = map(Path, (output, cache, pointer, runs_root))
        self.state_path = self.cache.with_name(self.cache.name+'.publisher.json')
        self.cadence, self.now, self.collect, self.write = cadence, now, collect, write
        prior = collector.obj(self.state_path)
        self.state = dict(schemaVersion=1, state='STARTING', attempts=0, failures=0, consecutiveFailures=0,
                          lastAttemptUtc=None, lastSuccessfulUtc=None, nextExpectedUtc=None, error=None,
                          cadenceSeconds=cadence, lifecycle='PERSISTENT_UNLIMITED', horizon=horizon_proof(cadence))
        if prior.get('schemaVersion') == 1:
            for k in ('attempts', 'failures', 'consecutiveFailures'):
                if type(prior.get(k)) is int and prior[k] >= 0:
                    self.state[k] = prior[k]
            for k in ('lastAttemptUtc', 'lastSuccessfulUtc'):
                if collector.epoch(prior.get(k)) is not None:
                    self.state[k] = prior[k]

    def cycle(self):
        now = self.now()
        self.state.update(state='PUBLISHING', attempts=self.state['attempts']+1,
                          lastAttemptUtc=collector.utc(now), nextExpectedUtc=collector.utc(now+self.cadence))
        try:
            result = self.collect(now=now, cache_path=self.cache, pointer_path=self.pointer, runs_root=self.runs_root)
            # A visible atomic publication necessarily completed this success;
            # previous file remains last-known on failure, never falsely updated.
            published = dict(self.state, state='ACTIVE', lastSuccessfulUtc=collector.utc(now), consecutiveFailures=0, error=None)
            result['publisher'] = published
            self.write(self.output, result, 0o644)
            self.state = published
        except Exception as error:
            self.state.update(state='RETRYING', failures=self.state['failures']+1,
                              consecutiveFailures=self.state['consecutiveFailures']+1,
                              error=type(error).__name__)  # no secrets/paths/payloads in public diagnostics
        success = self.state['state'] == 'ACTIVE'
        try:
            self.write(self.state_path, self.state)
        except OSError:
            # ENOSPC must not retire the independent publisher or control sources.
            pass
        return success

    def run(self, stopped, monotonic=time.monotonic):
        # Constant memory; skip missed slots, never catch up with a tight storm.
        while not stopped.is_set():
            deadline = monotonic()+self.cadence
            self.cycle()
            stopped.wait(max(0, deadline-monotonic()))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--output', type=Path, default=collector.OUTPUT)
    p.add_argument('--cache', type=Path, default=collector.CACHE)
    p.add_argument('--current-run', type=Path, default=collector.POINTER)
    p.add_argument('--runs-root', type=Path, default=collector.RUNS_ROOT)
    p.add_argument('--cadence-seconds', type=float, default=CADENCE_SECONDS)
    a = p.parse_args()
    # Exclusive publisher lock outside sealed evidence, shared across restarts.
    import fcntl
    a.cache.parent.mkdir(parents=True, exist_ok=True)
    with a.cache.with_name(a.cache.name+'.publisher.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        stopped = threading.Event()
        for s in (signal.SIGTERM, signal.SIGINT):
            signal.signal(s, lambda *_: stopped.set())
        Publisher(a.output, a.cache, a.current_run, a.runs_root, a.cadence_seconds).run(stopped)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
