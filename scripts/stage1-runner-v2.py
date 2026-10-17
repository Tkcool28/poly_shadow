#!/usr/bin/env python3
"""Explicit v2 approval gate delegating to the immutable 24h lifecycle runner.

No authority, approval, capture or experiment is created automatically.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import sys
import types

ROOT=Path(__file__).resolve().parents[1]
R=types.ModuleType('frozen_phase4_runner');R.__file__=str(ROOT/'scripts/phase4-runner.py')
exec(compile(Path(R.__file__).read_bytes(),R.__file__,'exec',dont_inherit=True),R.__dict__)

def approval(path,pin,run_id,sha,window,cohort):
    path=R.no_symlinks(Path(path))
    if not path.is_file() or path.stat().st_size>131072:
        raise ValueError('bounded comparison approval required')
    raw=path.read_bytes();a=json.loads(raw)
    contract=hashlib.sha256((ROOT/'docs/shadow/PHASE4_COMPARISON_CONTRACT.md').read_bytes()).hexdigest()
    if (hashlib.sha256(raw).hexdigest()!=pin or a.get('version')!='stage1-v2' or a.get('approved') is not True
        or not isinstance(a.get('approvedBy'),str) or not a['approvedBy'].strip()
        or a.get('contractSha256')!=contract or a.get('runId')!=run_id or a.get('shadowSha')!=sha
        or a.get('window')!=window or a.get('cohort')!=cohort
        or R.epoch_micros(a.get('approvedUtc'))>=R.epoch_micros(window['startUtc'])):
        raise ValueError('explicit independently pinned pre-start v2 approval required')
    return a

def main(argv=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--comparison-approval',required=True)
    parser.add_argument('--comparison-approval-sha256',required=True)
    a,rest=parser.parse_known_args(argv)
    # Parse bindings without altering any legacy launch option or safety gate.
    p=argparse.ArgumentParser(add_help=False)
    p.add_argument('operation',choices=('preflight','seal','run'))
    p.add_argument('--experiment',required=True)
    p.add_argument('--expected-shadow-sha',required=True)
    p.add_argument('--production-authority',required=True)
    p.add_argument('--authority-sha256',required=True)
    args,_=p.parse_known_args(rest)
    target=R.experiment_path(ROOT,args.experiment)
    authority=R.load_launch_authority(ROOT,target,args.expected_shadow_sha,args.production_authority,args.authority_sha256)
    approval(a.comparison_approval,a.comparison_approval_sha256,target.name,args.expected_shadow_sha,authority['binding']['window'],R.WALLETS)
    os.execv(sys.executable,[sys.executable,'-B',str(ROOT/'scripts/phase4-runner.py'),*rest])

if __name__=='__main__':
    main()
