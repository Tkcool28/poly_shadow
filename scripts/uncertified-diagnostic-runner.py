#!/usr/bin/env python3
"""Run an isolated, bounded PAPER-only UNCERTIFIED_DIAGNOSTIC comparison."""
from __future__ import annotations
import argparse
import ctypes
import hashlib
import datetime as dt
import fcntl
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
POLY2_REPO = Path('/opt/poly2')
DEFAULT_RUN_ROOT = Path('/var/lib/poly-shadow/diagnostics')
DEFAULT_DASHBOARD_SUMMARY = Path('/var/www/poly-shadow-status/diagnostic-comparison/summary.json')
EXPECTED_BRANCH = 'feat/uncertified-diagnostic-comparison-v1'
EXPECTED_POLY2_SHA = '219ad2c66442632b5e41506ba485062420a27c15'
WALLETS = (
 '0x82cf2b31d18fca19830e216b98cffa5dbc6c0998',
 '0x924379a79c64b77ad5816ad362122a5f6228658e',
 '0xd38b71f3e8ed1af71983e5c309eac3dfa9b35029',
 '0xf5286079ada8dcfeaa44f7f1c87e1ec37c127e5b',
 '0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227',
)
REQUIRED_FLAGS = {'POLYCOPY_PAPER_MODE':'true','POLYCOPY_ALLOW_LIVE_TRADING':'false','POLYCOPY_ORDER_KILL_SWITCH':'false','POLYCOPY_SHADOW_CAPTURE_ENABLED':'false'}
FORBIDDEN_OUTPUTS = (Path('/var/lib/poly-shadow/current-run.json'), Path('/var/www/poly-shadow-status/status.json'), Path('/opt/poly-shadow/runs'))


def now_utc():
 return dt.datetime.now(dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z')
def parse_utc(v):
 if not isinstance(v,str): raise ValueError('timestamp required')
 x=dt.datetime.fromisoformat(v[:-1]+'+00:00' if v.endswith('Z') else v)
 if x.tzinfo is None: raise ValueError('timezone required')
 return x.astimezone(dt.timezone.utc)
def add_seconds(v,seconds): return (parse_utc(v)+dt.timedelta(seconds=seconds)).isoformat(timespec='microseconds').replace('+00:00','Z')

def atomic_json(path:Path,value,mode=0o600):
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
 tmp=path.with_name('.'+path.name+'.'+uuid.uuid4().hex+'.tmp')
 data=(json.dumps(value,separators=(',',':'),allow_nan=False)+'\n').encode()
 fd=os.open(tmp,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,mode)
 try:
  with os.fdopen(fd,'wb') as f: f.write(data); f.flush(); os.fsync(f.fileno())
  os.replace(tmp,path)
  d=os.open(path.parent,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
  try: os.fsync(d)
  finally: os.close(d)
 finally:
  try: tmp.unlink()
  except FileNotFoundError: pass

def no_symlink_path(p:Path):
 p=Path(os.path.abspath(p))
 if any(x.is_symlink() for x in (p,*p.parents)): raise ValueError('symlink path forbidden')
 return p

def assert_isolated_path(path:Path):
 p=no_symlink_path(path)
 for forbidden in FORBIDDEN_OUTPUTS:
  if p==forbidden or p.is_relative_to(forbidden) or forbidden.is_relative_to(p): raise ValueError('certified or official status path forbidden')
 return p

def git_value(repo:Path,*args):
 r=subprocess.run(['git','-C',str(repo),*args],capture_output=True,text=True,timeout=15,check=True)
 return r.stdout.strip()
def revision(repo:Path):
 sha=git_value(repo,'rev-parse','HEAD')
 if not re.fullmatch(r'[a-f0-9]{40}',sha): raise ValueError('invalid git revision')
 return sha

def inspect_poly2(container:str,expected_sha:str):
 fmt='{{.State.Running}}|{{.Image}}|{{index .Config.Labels "org.opencontainers.image.revision"}}|{{index .Config.Labels "com.docker.compose.service"}}|{{json .Config.Env}}'
 p=subprocess.run(['docker','inspect','--format',fmt,container],capture_output=True,text=True,timeout=20)
 if p.returncode: raise RuntimeError('POLY2_CONTAINER_INSPECT_FAILED')
 parts=p.stdout.rstrip('\n').split('|',4)
 if len(parts)!=5 or parts[0]!='true' or parts[3]!='backend' or not re.fullmatch(r'sha256:[a-f0-9]{64}',parts[1]): raise RuntimeError('POLY2_BACKEND_IDENTITY_UNVERIFIED')
 label=parts[2] if parts[2] not in ('','<no value>') else None
 if label!=expected_sha: raise RuntimeError('POLY2_RUNTIME_REVISION_MISMATCH')
 try: env=dict(x.split('=',1) for x in json.loads(parts[4]) if isinstance(x,str) and '=' in x)
 except (ValueError,TypeError): raise RuntimeError('POLY2_RUNTIME_CONFIG_UNREADABLE')
 flags={k:env.get(k) for k in REQUIRED_FLAGS}
 if flags!=REQUIRED_FLAGS: raise RuntimeError('POLY2_PAPER_CAPTURE_GUARD_FAILED')
 return {'imageId':parts[1],'revisionLabel':label,'flags':flags}

def preflight(container:str,script:bytes):
 cmd=([sys.executable,'-','--dsn-file',str(container)] if isinstance(container,Path) else ['docker','exec','-i',container,'python','-'])
 p=subprocess.run(cmd+['--mode','preflight'],input=script,capture_output=True,timeout=120)
 if p.returncode: raise RuntimeError('POLY2_READ_ONLY_PREFLIGHT_FAILED')
 try: value=json.loads(p.stdout)
 except (ValueError,UnicodeError): raise RuntimeError('POLY2_PREFLIGHT_OUTPUT_INVALID')
 if value.get('classification')!='UNCERTIFIED_DIAGNOSTIC' or value.get('certified') is not False or value.get('mode')!='preflight' or value.get('cohort')!=list(WALLETS) or value.get('approvedWallets')!=list(WALLETS): raise RuntimeError('POLY2_APPROVED_COHORT_MISMATCH')
 for key in ('tradeIdHighWater','decisionLogIdHighWater'):
  if type(value.get(key)) is not int or value[key]<0: raise RuntimeError('POLY2_PREFLIGHT_HIGH_WATER_INVALID')
 return value

def storage_preflight(repo:Path,data_dir:Path):
 d=json.dumps(str(data_dir))
 code = "import {statfsSync} from 'node:fs'; import {storagePlan,diskState,assertPrelaunchDisk} from './src/shadow/storage-budget.ts'; const s=statfsSync("+d+"), free=Number(s.bavail)*Number(s.bsize), cap=Number(s.blocks)*Number(s.bsize), remaining=storagePlan.windowSeconds+storagePlan.maximumDrainGraceSeconds; const state=diskState(free,remaining,cap); let gate='PASS'; try{assertPrelaunchDisk("+d+")}catch{gate='FAIL'}; console.log(JSON.stringify({...state,gate})); if(gate!=='PASS')process.exitCode=7;"
 p=subprocess.run(['node','--import','tsx','--input-type=module','-e',code],cwd=repo,capture_output=True,text=True,timeout=30)
 try: value=json.loads(p.stdout.strip().splitlines()[-1])
 except (ValueError,IndexError): raise RuntimeError('STORAGE_PREFLIGHT_UNAVAILABLE')
 if p.returncode or value.get('gate')!='PASS' or value.get('state')!='GREEN': raise RuntimeError('STORAGE_PREFLIGHT_BLOCKED')
 value['enforcedResourceEnvelope']=resource_envelope()
 return value

def resource_envelope(root=Path('/sys/fs/cgroup'),membership=Path('/proc/self/cgroup')):
 """Require operator-installed kernel limits; never create/change a cgroup."""
 rows=membership.read_text().splitlines()
 unified=[r.split(':',2)[2] for r in rows if r.startswith('0::')]
 if len(unified)!=1 or '..' in Path(unified[0]).parts: raise RuntimeError('RESOURCE_CGROUP_UNVERIFIED')
 path=root/unified[0].lstrip('/')
 values={name:(path/name).read_text().strip() for name in ('memory.max','memory.swap.max','cpu.max','pids.max')}
 try:
  memory=int(values['memory.max']); swap=int(values['memory.swap.max']); pids=int(values['pids.max'])
  quota,period=map(int,values['cpu.max'].split())
  if not (0<memory<=4*1024**3 and 0<=swap<=512*1024**2 and 0<pids<=256 and 0<quota<=period): raise ValueError()
 except ValueError: raise RuntimeError('FINITE_RESOURCE_LIMITS_REQUIRED')
 return {'memoryMaxBytes':memory,'swapMaxBytes':swap,'cpuQuota':quota,'cpuPeriod':period,'pidsMax':pids,'enforcement':'KERNEL_CGROUP_V2'}

def resource_usage(root=Path('/sys/fs/cgroup'),membership=Path('/proc/self/cgroup')):
 try:
  unified=[r.split(':',2)[2] for r in membership.read_text().splitlines() if r.startswith('0::')]
  if len(unified)!=1 or '..' in Path(unified[0]).parts: raise ValueError()
  path=root/unified[0].lstrip('/')
  cpu=dict(line.split() for line in (path/'cpu.stat').read_text().splitlines())
  return {'state':'MEASURED','scope':'DIAGNOSTIC_CGROUP_INCLUDING_REPORTER',
    'memoryCurrentBytes':int((path/'memory.current').read_text()),
    'memoryPeakBytes':int((path/'memory.peak').read_text()),
    'cpuUsageMicroseconds':int(cpu['usage_usec']),'cpuThrottledMicroseconds':int(cpu.get('throttled_usec','0'))}
 except (OSError,ValueError,KeyError): return {'state':'UNKNOWN','reason':'CGROUP_USAGE_UNAVAILABLE'}

def publish_progress(args,value):
 if not args.publish_dashboard: return
 path=assert_isolated_path(getattr(args,'publisher_snapshot',None) or args.dashboard_summary)
 if 'diagnostic-comparison' not in path.parts: raise ValueError('diagnostic public directory required')
 path.parent.mkdir(parents=True,exist_ok=True,mode=0o755)
 public=dict(value)
 retro=public.get('retrospectiveAndUnknown')
 if isinstance(retro,dict): public['retrospectiveAndUnknown']={k:len(v) for k,v in retro.items()}
 atomic_json(path,public,0o644)

def evidence_inventory(run_dir):
 files=[]
 for path in sorted(run_dir.rglob('*')):
  if path.is_symlink(): raise RuntimeError('EVIDENCE_SYMLINK_REFUSED')
  if not path.is_file() or path.name in ('diagnostic-report.json','evidence-manifest.json','diagnostic-manifest.json'): continue
  if len(files)>=128: raise RuntimeError('EVIDENCE_FILE_LIMIT')
  digest=hashlib.sha256()
  with path.open('rb') as f:
   for block in iter(lambda:f.read(65536),b''): digest.update(block)
  files.append({'file':str(path.relative_to(run_dir)),'bytes':path.stat().st_size,'sha256':digest.hexdigest()})
 return {'classification':'UNCERTIFIED_DIAGNOSTIC','files':files,'rawEvidencePublic':False}

def check_retained_limit(directory,cap=6*1024**3):
 total=0
 with os.scandir(directory) as entries:
  for i,item in enumerate(entries):
   if i>=128 or item.is_symlink(): raise RuntimeError('EVIDENCE_FILE_LIMIT')
   if item.is_file(follow_symlinks=False): total+=item.stat(follow_symlinks=False).st_size
   if total>cap: raise RuntimeError('RUN_EVIDENCE_DISK_CAP')
 return total

def progress_projection(base,state=None):
 return {'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'state':state or base['state'],
  'runId':base['runId'],'window':base.get('window',{}),'plannedEndUtc':base.get('plannedEndUtc'),
  'generatedUtc':now_utc(),'failureType':base.get('failureType'),'runKind':base.get('runKind'),
  'overall':{},'wallets':[{'wallet':w,'counts':{}} for w in WALLETS],
  'sources':[{'source':s,'state':'UNKNOWN_UNPROVEN','uncertainty':'No completed snapshot yet'} for s in ('CHAIN','REST_TRADES','REST_ACTIVITY')],
  'priceOpportunity':{'state':'PRICE_ADVANTAGE_UNKNOWN'}}

def storage_telemetry(repo:Path,data_dir:Path,elapsed_seconds:float):
 code="import {storageTelemetry} from './src/shadow/storage-budget.ts'; console.log(JSON.stringify(storageTelemetry("+json.dumps(str(data_dir))+","+str(max(0,elapsed_seconds))+")));"
 p=subprocess.run(['node','--import','tsx','--input-type=module','-e',code],cwd=repo,capture_output=True,text=True,timeout=15)
 try: value=json.loads(p.stdout.strip().splitlines()[-1])
 except (ValueError,IndexError): raise RuntimeError('STORAGE_MONITOR_UNAVAILABLE')
 if p.returncode or not isinstance(value.get('disk'),dict) or value['disk'].get('state') not in ('GREEN','DEGRADED','AT_RISK','UNKNOWN'):
  raise RuntimeError('STORAGE_MONITOR_INVALID')
 return value

def export_poly2(container:str,script:bytes,manifest:dict,output:Path):
 cmd=([sys.executable,'-','--dsn-file',str(container)] if isinstance(container,Path) else ['docker','exec','-i',container,'python','-'])
 cmd+=['--mode','export','--start-utc',manifest['window']['startUtc'],'--end-utc',manifest['window']['endUtc'],
      '--run-id',manifest['runId'],'--decision-log-high-water',str(manifest['poly2Preflight']['decisionLogIdHighWater']),
      '--decision-log-end-high-water',str(manifest['poly2EndPreflight']['decisionLogIdHighWater']),
      '--trade-id-high-water',str(manifest['poly2Preflight']['tradeIdHighWater']),'--trade-id-end-high-water',str(manifest['poly2EndPreflight']['tradeIdHighWater']),
      '--shadow-sha',manifest['software']['shadowGitSha'],'--poly2-checkout-sha',manifest['software']['poly2CheckoutGitSha'],'--runtime-image-id',manifest['software']['poly2RuntimeImageId']]
 if manifest['software']['poly2RuntimeRevisionLabel']: cmd+=['--runtime-revision',manifest['software']['poly2RuntimeRevisionLabel']]
 p=subprocess.run(cmd,input=script,capture_output=True,timeout=180)
 if p.returncode: raise RuntimeError('POLY2_READ_ONLY_EXPORT_FAILED')
 try: value=json.loads(p.stdout)
 except (ValueError,UnicodeError): raise RuntimeError('POLY2_EXPORT_OUTPUT_INVALID')
 if value.get('classification')!='UNCERTIFIED_DIAGNOSTIC' or value.get('certified') is not False or value.get('runId')!=manifest['runId']: raise RuntimeError('POLY2_EXPORT_BINDING_INVALID')
 atomic_json(output,value)

def process_group_alive(pgid):
 """Return whether a non-zombie process remains in the collector's session."""
 proc=Path('/proc')
 if proc.is_dir():
  for entry in proc.iterdir():
   if not entry.name.isdigit(): continue
   try:
    stat=(entry/'stat').read_text()
    fields=stat[stat.rfind(')')+2:].split()
    if len(fields)>=3 and int(fields[2])==pgid and fields[0]!='Z': return True
   except (FileNotFoundError,PermissionError,ProcessLookupError,ValueError):
    continue
  return False
 try: os.killpg(pgid,0); return True
 except ProcessLookupError: return False
 except PermissionError: return True

def set_subreaper():
 libc=ctypes.CDLL(None,use_errno=True); prior=ctypes.c_int()
 if libc.prctl(37,ctypes.byref(prior),0,0,0)!=0 or libc.prctl(36,1,0,0,0)!=0:
  raise RuntimeError('LINUX_CHILD_SUBREAPER_REQUIRED')
 return prior.value

def reap_group(pgid):
 """Only adopted children in our collector's owned process group."""
 while True:
  try: pid,_=os.waitpid(-pgid,os.WNOHANG)
  except ChildProcessError: return True
  if pid==0: return False

def stop_process_group(child,grace_seconds=35,killpg=os.killpg,group_alive=process_group_alive,monotonic=time.monotonic,sleep=time.sleep,force_escalation=None):
 """Stop and verify the collector leader and all live descendants in its session."""
 pgid=child.pid
 try: killpg(pgid,signal.SIGTERM)
 except ProcessLookupError: pass
 except PermissionError: raise RuntimeError('COLLECTOR_GROUP_SIGNAL_DENIED')
 deadline=monotonic()+grace_seconds
 while (child.poll() is None or group_alive(pgid)) and monotonic()<deadline and not (force_escalation and force_escalation()):
  try: child.wait(timeout=min(0.05,max(0.001,deadline-monotonic())))
  except subprocess.TimeoutExpired: pass
  sleep(min(0.05,max(0,deadline-monotonic())))
 if child.poll() is None or group_alive(pgid):
  try: killpg(pgid,signal.SIGKILL)
  except ProcessLookupError: pass
  except PermissionError: raise RuntimeError('COLLECTOR_GROUP_KILL_DENIED')
  deadline=monotonic()+5
  while (child.poll() is None or group_alive(pgid)) and monotonic()<deadline:
   try: child.wait(timeout=min(0.05,max(0.001,deadline-monotonic())))
   except subprocess.TimeoutExpired: pass
   sleep(min(0.05,max(0,deadline-monotonic())))
 if group_alive(pgid): raise RuntimeError('COLLECTOR_GROUP_DID_NOT_EXIT')
 try: child.wait(timeout=0.1)
 except subprocess.TimeoutExpired: raise RuntimeError('COLLECTOR_LEADER_DID_NOT_EXIT')
 # A group of zombies is no longer running, but still must be reaped by the
 # runner's subreaper rather than left for an unrelated init process.
 deadline=monotonic()+5
 while not reap_group(pgid):
  if monotonic()>=deadline: raise RuntimeError('COLLECTOR_DESCENDANTS_NOT_REAPED')
  try: killpg(pgid,signal.SIGKILL)
  except ProcessLookupError: pass
  sleep(0.02)

def wait_for_window(child,duration_seconds,monotonic=time.monotonic,wall=now_utc,check_storage=None,check_interval=5.0,signal_state=None):
 deadline=monotonic()+duration_seconds; next_check=monotonic()+check_interval
 while True:
  if signal_state is not None and signal_state['count']:
   return {'endedUtc':wall(),'early':True,'interrupted':True,'signal':signal_state['name']}
  now=monotonic(); remaining=deadline-now
  if remaining<=0: return {'endedUtc':wall(),'early':False,'interrupted':False}
  if check_storage is not None and now>=next_check:
   check_storage(); next_check=now+check_interval
  try: child.wait(timeout=min(0.25,remaining))
  except subprocess.TimeoutExpired: continue
  return {'endedUtc':wall(),'early':True,'interrupted':False}

def _run(args,signal_state):
 repo=no_symlink_path(args.repo); poly_repo=no_symlink_path(args.poly2_repo); root=assert_isolated_path(args.run_root)
 if not repo.is_dir() or not poly_repo.is_dir(): raise RuntimeError('REPOSITORY_PATH_MISSING')
 if git_value(repo,'status','--porcelain','--untracked-files=all'): raise RuntimeError('SHADOW_WORKTREE_NOT_CLEAN')
 shadow_sha=revision(repo); poly2_sha=revision(poly_repo)
 if poly2_sha!=EXPECTED_POLY2_SHA: raise RuntimeError('POLY2_CHECKOUT_REVISION_MISMATCH')
 before=inspect_poly2(args.poly2_container,poly2_sha)
 script=(repo/'scripts/poly2-diagnostic-export.py').read_bytes()
 export_source=getattr(args,'poly2_dsn_file',None) or args.poly2_container
 start_pre=preflight(export_source,script)
 root.mkdir(parents=True,exist_ok=True,mode=0o700)
 run_id='diagnostic-'+dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')+'-'+uuid.uuid4().hex[:8]
 run_dir=assert_isolated_path(root/run_id); run_dir.mkdir(mode=0o700)
 data_dir=run_dir/'shadow-data'; data_dir.mkdir(mode=0o700)
 base={'schemaVersion':1,'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'state':'READY','runId':run_id,'cohort':list(WALLETS),'software':{'shadowGitSha':shadow_sha,'poly2CheckoutGitSha':poly2_sha,'poly2RuntimeImageId':before['imageId'],'poly2RuntimeRevisionLabel':before['revisionLabel'],'runtimeStable':False},'poly2Preflight':start_pre,'safety':{'paperMode':True,'liveTradingAllowed':False,'killSwitch':False,'captureEnabled':False,'workerRestarted':False,'databaseWrites':0,'certifiedPointerWritten':False}}
 child=None; boundary_start=None; boundary_end=None; interrupted=False; exit_code=None
 try:
  storage=storage_preflight(repo,data_dir); base['resourcePreflight']=storage
  base['resourceAtStart']=resource_usage()
  base['runKind']='TWENTY_FOUR_HOUR_DIAGNOSTIC' if args.duration_seconds==86400 else 'BOUNDED_SMOKE_TEST'
  env=os.environ.copy(); env.update(SHADOW_WATCHED_WALLETS=','.join(WALLETS),SHADOW_DATA_DIR=str(data_dir),SHADOW_V2_CURSOR='true')
  for key in list(env):
   if key in ('PRIVATE_KEY','CLOB_API_KEY','CLOB_API_SECRET','CLOB_API_PASSPHRASE','FUNDER_ADDRESS','RELAYER_API_KEY','RELAYER_API_KEY_ADDRESS') or key.startswith(('ARB_','SCALP_')): raise RuntimeError('SHADOW_CREDENTIAL_GUARD_FAILED')
  if signal_state['count']: raise RuntimeError('INTERRUPTED_BEFORE_LAUNCH')
  boundary_start=now_utc(); planned_end=add_seconds(boundary_start,args.duration_seconds)
  base.update({'state':'RUNNING','startedUtc':boundary_start,'plannedEndUtc':planned_end,'durationSeconds':args.duration_seconds,'window':{'startUtc':boundary_start,'endUtc':planned_end},'frozenWindow':{'startUtc':boundary_start,'endUtc':planned_end}})
  atomic_json(run_dir/'diagnostic-manifest.json',base)
  publish_progress(args,progress_projection(base))
  child=subprocess.Popen(['node','--max-old-space-size=3072','--import','tsx','src/shadow/main.ts'],cwd=repo,env=env,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
  signal_state['child']=child
  base['startupCoverageGap']={'startUtc':boundary_start,'collectorSpawnReturnedUtc':now_utc(),
    'coverage':'UNKNOWN_UNPROVEN','reason':'SOURCE_STARTUP_BEFORE_FIRST_HEALTH_RECEIPTS_NOT_PROVEN'}
  atomic_json(run_dir/'diagnostic-manifest.json',base)
  deadline_state={'observed':False,'aliveAtDeadline':False,'observedUtc':None}
  deadline_lock=threading.Lock()
  # Independent deadline remains effective while live export/report work runs.
  def deadline_stop():
   with deadline_lock:
    if deadline_state['observed']: return
    deadline_state.update(observed=True,aliveAtDeadline=child.poll() is None,observedUtc=now_utc())
    if deadline_state['aliveAtDeadline']:
     try: os.killpg(child.pid,signal.SIGTERM)
     except ProcessLookupError: deadline_state['aliveAtDeadline']=False
  deadline_timer=threading.Timer(max(0,(parse_utc(planned_end)-parse_utc(now_utc())).total_seconds()),deadline_stop)
  deadline_timer.daemon=True; deadline_timer.start()
  monitor_started=time.monotonic()
  next_projection=monitor_started+60
  def check_disk():
   nonlocal next_projection
   observed=storage_telemetry(repo,data_dir,time.monotonic()-monitor_started)
   observed['resourceUsage']=resource_usage()
   if observed['disk']['state']!='GREEN': raise RuntimeError('STORAGE_BUDGET_EXHAUSTED')
   check_retained_limit(data_dir)
   wall_elapsed=(parse_utc(now_utc())-parse_utc(boundary_start)).total_seconds()
   if abs(wall_elapsed-(time.monotonic()-monitor_started))>2: raise RuntimeError('WALL_CLOCK_DISCONTINUITY')
   if args.publish_dashboard and time.monotonic()>=next_projection and parse_utc(now_utc())<parse_utc(planned_end):
    next_projection=time.monotonic()+60
    if inspect_poly2(args.poly2_container,poly2_sha)!=before: raise RuntimeError('POLY2_RUNTIME_CHANGED_DURING_OBSERVATION')
    preview={**base,'state':'INCOMPLETE','window':{'startUtc':boundary_start,'endUtc':now_utc()},
      'software':{**base['software'],'runtimeStable':True},'poly2EndPreflight':preflight(export_source,script)}
    atomic_json(run_dir/'diagnostic-preview-manifest.json',preview)
    export_poly2(export_source,script,preview,run_dir/'poly2-live-export.json')
    cmd=['node','--max-old-space-size=384','--import','tsx','src/compare/diagnostic-report-cli.ts','--run-directory',str(run_dir),
      '--manifest-name','diagnostic-preview-manifest.json','--poly2-export',str(run_dir/'poly2-live-export.json'),'--preview','--publish-summary',str(assert_isolated_path(getattr(args,'publisher_snapshot',None) or args.dashboard_summary))]
    result=subprocess.run(cmd,cwd=repo,capture_output=True,text=True,timeout=60)
    if result.returncode: raise RuntimeError('LIVE_REPORT_FAILED')
   atomic_json(run_dir/'diagnostic-checkpoint.json',{'observedUtc':now_utc(),'state':base['state'],'window':base['window'],'resource':observed})
  try:
   waited=wait_for_window(child,max(0,(parse_utc(planned_end)-parse_utc(now_utc())).total_seconds()),check_storage=check_disk,signal_state=signal_state)
   if not waited['early']: deadline_stop()
   if deadline_state['aliveAtDeadline'] and not waited.get('interrupted'): waited['early']=False
   boundary_end=min(waited['endedUtc'],planned_end) if waited['early'] else planned_end
   stop_process_group(child,grace_seconds=10,force_escalation=lambda:signal_state['count']>1)
   interrupted=bool(waited.get('interrupted') or signal_state['count'])
  except KeyboardInterrupt:
   interrupted=True; boundary_end=now_utc(); signal_state.update({'number':signal.SIGINT,'name':'SIGINT','count':max(1,signal_state['count'])}); stop_process_group(child,grace_seconds=10,force_escalation=lambda:signal_state['count']>1)
  base['observedThroughUtc']=boundary_end
  exit_code=child.returncode
  deadline_timer.cancel()
  base['collectorDeadlineObservation']=deadline_state
  if boundary_end is None: boundary_end=now_utc()
  if interrupted:
   signum=signal_state['number'] or signal.SIGINT
   base.update({'state':'INCOMPLETE','window':{'startUtc':boundary_start,'endUtc':boundary_end},'endedUtc':now_utc(),
    'collectorShutdownCompletedUtc':now_utc(),'collectorExitCode':exit_code,'collectorEndedAtRequestedDuration':False,
    'interrupted':True,'terminationSignal':signal_state['name'] or 'SIGINT','failureType':signal_state['name'] or 'SIGINT'})
   atomic_json(run_dir/'diagnostic-manifest.json',base)
   publish_progress(args,progress_projection(base))
   print(json.dumps({'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'runId':run_id,'state':'INCOMPLETE','runDirectory':str(run_dir),'failureType':signal_state['name'] or 'SIGINT','result':'INTERRUPTED'},separators=(',',':')),file=sys.stderr)
   return 128+signum
  after=inspect_poly2(args.poly2_container,poly2_sha); stable=before==after
  # Bounded lag horizon, distinct from the observation interval.
  lag_seconds=getattr(args,'late_arrival_grace_seconds',0)
  if lag_seconds: time.sleep(lag_seconds)
  end_pre=preflight(export_source,script)
  base.update({'window':{'startUtc':boundary_start,'endUtc':boundary_end},'endedUtc':now_utc(),'plannedEndUtc':planned_end,'poly2EndPreflight':end_pre,'software':{**base['software'],'runtimeStable':stable},'collectorExitCode':exit_code,'collectorEndedAtRequestedDuration':deadline_state['aliveAtDeadline'],'interrupted':False,'poly2RuntimeStable':stable})
  complete=(not interrupted and deadline_state['aliveAtDeadline'] and boundary_end==planned_end and exit_code==0 and stable and end_pre['cohort']==list(WALLETS))
  base['state']='INCOMPLETE'; base['reportState']='FINALIZING';
  if not complete: base['failureType']='COLLECTOR_DEADLINE_NOT_PROVEN' if not deadline_state['aliveAtDeadline'] else 'COLLECTOR_NONZERO_EXIT_OR_BASELINE_CHANGED'
  atomic_json(run_dir/'diagnostic-manifest.json',base)
  if not stable: raise RuntimeError('POLY2_RUNTIME_CHANGED_DURING_OBSERVATION')
  export_poly2(export_source,script,base,run_dir/'poly2-export.json')
  cmd=['node','--max-old-space-size=384','--import','tsx','src/compare/diagnostic-report-cli.ts','--run-directory',str(run_dir),'--poly2-export',str(run_dir/'poly2-export.json')]
  if args.publish_dashboard: cmd+=['--publish-summary',str(assert_isolated_path(getattr(args,'publisher_snapshot',None) or args.dashboard_summary))]
  report=subprocess.run(cmd,cwd=repo,capture_output=True,text=True,timeout=300)
  if report.returncode: raise RuntimeError('DIAGNOSTIC_REPORT_FAILED')
  # COMPLETE is written only after export and report successfully exist.
  report_path=run_dir/'diagnostic-report.json'
  if not report_path.is_file(): raise RuntimeError('REPORT_ARTIFACT_MISSING')
  if report_path.exists():
   final=json.loads(report_path.read_text()); final['state']='COMPLETE' if complete else 'INCOMPLETE'
   final['resourceMeasurements']={'atStart':base['resourceAtStart'],'atEnd':resource_usage()}
   atomic_json(report_path,final); publish_progress(args,final)
   inventory=evidence_inventory(run_dir); atomic_json(run_dir/'evidence-manifest.json',inventory)
   base['finalReportSha256']=hashlib.sha256(report_path.read_bytes()).hexdigest()
   if args.publish_dashboard:
    public=args.dashboard_summary.parent
    atomic_json(assert_isolated_path(public/'report.json'),final,0o644)
    atomic_json(assert_isolated_path(public/'evidence-manifest.json'),inventory,0o644)
    atomic_json(assert_isolated_path(public/'report-sha256.json'),{'sha256':base['finalReportSha256']},0o644)
  base['state']='COMPLETE' if complete else 'INCOMPLETE'; base['reportState']='AVAILABLE'
  base['resourceAtEnd']=resource_usage()
  base['observationContinuity']='SOURCE_GAPS_DISCLOSED_NOT_PROVEN_CONTINUOUS'
  atomic_json(run_dir/'diagnostic-manifest.json',base)
  print(json.dumps({'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'runId':run_id,'state':base['state'],'runDirectory':str(run_dir),'report':str(run_dir/'diagnostic-report.json'),'dashboardPublished':bool(args.publish_dashboard)},separators=(',',':')))
  return 130 if interrupted else (0 if complete else 2)
 except Exception as exc:
  if 'deadline_timer' in locals(): deadline_timer.cancel()
  failure=str(exc) if re.fullmatch(r'[A-Z][A-Z0-9_]{2,80}',str(exc)) else type(exc).__name__
  if child is not None:
   try: boundary_end=boundary_end or now_utc(); stop_process_group(child,grace_seconds=10,force_escalation=lambda:signal_state['count']>1)
   except Exception: failure='CollectorStopFailed'
  base.update({'state':'FAILED' if child is None else 'INCOMPLETE','failureType':failure,'endedUtc':now_utc()})
  if signal_state['count']:
   base.update({'interrupted':True,'terminationSignal':signal_state['name'],'failureType':signal_state['name']})
  if boundary_start:
   if child is None:
    base['launchAttemptUtc']=boundary_start
    base.pop('window',None)
    base.pop('startedUtc',None)
   else:
    base['window']={'startUtc':boundary_start,'endUtc':boundary_end or now_utc()}
    base['collectorExitCode']=child.returncode
  atomic_json(run_dir/'diagnostic-manifest.json',base)
  publish_progress(args,progress_projection(base))
  print(json.dumps({'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'runId':run_id,'state':base['state'],'runDirectory':str(run_dir),'error':failure,'result':'FAILED_CLOSED'},separators=(',',':')),file=sys.stderr)
  return 2

def run(args):
 previous_subreaper=set_subreaper()
 signal_state={'count':0,'number':None,'name':None}
 previous={}
 def record_signal(number,_frame):
  signal_state['count']+=1
  if signal_state['number'] is None:
   signal_state['number']=number; signal_state['name']=signal.Signals(number).name
  child=signal_state.get('child')
  if child is not None:
   try: os.killpg(child.pid,signal.SIGTERM if signal_state['count']==1 else signal.SIGKILL)
   except ProcessLookupError: pass
 for number in (signal.SIGTERM,signal.SIGINT):
  previous[number]=signal.getsignal(number); signal.signal(number,record_signal)
 fd=None
 try:
  root=assert_isolated_path(args.run_root); root.mkdir(parents=True,exist_ok=True,mode=0o700)
  fd=os.open(root/'diagnostic-owner.lock',os.O_CREAT|os.O_WRONLY|os.O_NOFOLLOW,0o600)
  fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
  return _run(args,signal_state)
 finally:
  if fd is not None: os.close(fd)
  for number,handler in previous.items(): signal.signal(number,handler)
  if ctypes.CDLL(None).prctl(36,previous_subreaper,0,0,0)!=0: raise RuntimeError('SUBREAPER_RESTORE_FAILED')


def main(argv=None):
 p=argparse.ArgumentParser(description=__doc__); sub=p.add_subparsers(dest='command',required=True); r=sub.add_parser('run')
 r.add_argument('--poly2-container',required=True); r.add_argument('--repo',type=Path,default=ROOT); r.add_argument('--poly2-repo',type=Path,default=POLY2_REPO); r.add_argument('--run-root',type=Path,default=DEFAULT_RUN_ROOT)
 r.add_argument('--poly2-dsn-file',type=Path,required=True)
 r.add_argument('--publisher-snapshot',type=Path,help='separate private snapshot consumed by existing status publisher')
 r.add_argument('--duration-seconds',type=int,required=True); r.add_argument('--publish-dashboard',action='store_true'); r.add_argument('--dashboard-summary',type=Path,default=DEFAULT_DASHBOARD_SUMMARY)
 r.add_argument('--late-arrival-grace-seconds',type=int,default=30)
 a=p.parse_args(argv)
 if not 60<=a.duration_seconds<=86400: p.error('--duration-seconds must be 60..86400')
 if not 0<=a.late_arrival_grace_seconds<=60: p.error('--late-arrival-grace-seconds must be 0..60')
 try: return run(a)
 except Exception as exc:
  print(json.dumps({'classification':'UNCERTIFIED_DIAGNOSTIC','certified':False,'error':type(exc).__name__,'result':'FAILED_CLOSED'},separators=(',',':')),file=sys.stderr)
  return 2
if __name__=='__main__': raise SystemExit(main())
