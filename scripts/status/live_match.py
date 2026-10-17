"""Bounded optional Stage 1 projection for the existing publisher. No network/control."""
import fcntl
import json
import os
from pathlib import Path
import selectors
import stat
import subprocess
import time

CONFIG = Path('/var/lib/poly-shadow/stage1-monitor-config.json')
ROOT = Path(__file__).resolve().parents[2]
LIMIT = 131072

def safe(path):
    path = Path(path).absolute()
    if path.resolve() != path or any(p.is_symlink() for p in (path,*path.parents)):
        raise ValueError('symlink diagnostic path')
    return path

def refresh(run, cache_path, now_utc, config_path=CONFIG):
    unknown = dict(version='stage1-v2', provisional=True, certified=False,
                   authorization=False, state='COMPARISON_NOT_AUTHORIZED', counts=None,
                   coverage='UNKNOWN_UNPROVEN', recent=[], checkpoint=dict(classification='CAPTURE_OR_IDENTITY_BLOCKED'))
    if not config_path.exists():
        return unknown
    try:
        safe(config_path)
        if not config_path.is_file() or config_path.stat().st_size > LIMIT:
            raise ValueError('invalid configuration')
        config = json.loads(config_path.read_text())
        if config.get('runDirectory') != str(run):
            raise ValueError('not current authorized run')
        directory = safe(cache_path.with_name(cache_path.name+'.stage1'))
        if Path(run) in directory.parents or 'runs' in directory.parts:
            raise ValueError('projection must be outside evidence')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        if directory.stat().st_mode & 0o022:
            raise ValueError('private projection required')
        fd=os.open(directory/'refresh.lock',os.O_WRONLY|os.O_CREAT|os.O_NOFOLLOW,0o600)
        with os.fdopen(fd,'w') as lock:
            if not stat.S_ISREG(os.fstat(lock.fileno()).st_mode):
                raise ValueError('regular lock required')
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            child = subprocess.Popen(['/usr/bin/node', '--max-old-space-size=192', '--import', 'tsx', str(ROOT/'src/compare/live-monitor-cli.ts'),
                                      str(config_path), str(directory), now_utc], cwd=ROOT,
                                     stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                     env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
            deadline=time.monotonic()+12; data=bytearray()
            try:
                with selectors.DefaultSelector() as selector:
                    selector.register(child.stdout,selectors.EVENT_READ)
                    while True:
                        remaining=deadline-time.monotonic()
                        if remaining<=0:
                            raise ValueError('projection deadline')
                        if not selector.select(remaining):
                            raise ValueError('projection timeout')
                        chunk=os.read(child.stdout.fileno(),min(4096,LIMIT+1-len(data)))
                        if not chunk:
                            break
                        data.extend(chunk)
                        if len(data)>LIMIT:
                            raise ValueError('projection output bound')
                child.wait(timeout=max(.001,deadline-time.monotonic()))
                value=json.loads(data)
                if value.get('version')!='stage1-v2' or value.get('certified') is not False or value.get('provisional') is not True:
                    raise ValueError('invalid projection')
                return value
            finally:
                if child.poll() is None:
                    child.kill(); child.wait(timeout=2)
                child.stdout.close()
    except (OSError, ValueError, subprocess.SubprocessError):
        return {**unknown, 'state':'MONITOR_UNAVAILABLE'}
