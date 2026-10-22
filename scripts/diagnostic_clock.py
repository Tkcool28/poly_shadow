"""Bounded host-only synchronization evidence. Never a provider clock correction."""
import datetime as dt
import json
import math
import os
import re
import subprocess
import time

MAX_OFFSET_SECONDS=0.100
MAX_UNCERTAINTY_SECONDS=0.100
MAX_SAMPLE_AGE_SECONDS=120

def parse_tracking(text):
 def number(label):
  m=re.search(r'^'+re.escape(label)+r'\s*:\s*([-+0-9.eE]+)',text,re.M)
  if not m: raise ValueError('MISSING_'+label.upper().replace(' ','_'))
  v=float(m.group(1))
  if not math.isfinite(v): raise ValueError('NONFINITE_CLOCK_VALUE')
  return v
 system=number('System time')
 if 'seconds slow of NTP time' in text: system=-abs(system)
 elif 'seconds fast of NTP time' in text: system=abs(system)
 else: raise ValueError('UNKNOWN_OFFSET_DIRECTION')
 delay=number('Root delay'); dispersion=number('Root dispersion')
 if dispersion<0: raise ValueError('NEGATIVE_DISPERSION')
 return {'estimatedHostOffsetSeconds':system,'rootDistanceSeconds':abs(delay)/2+dispersion,
         'ntpSynchronized':bool(re.search(r'^Leap status\s*:\s*Normal\s*$',text,re.M)),
         'uncertaintyDefinition':'abs(root delay)/2 + root dispersion; chrony tracking'}

def parse_timesync(text):
 def seconds(label):
  m=re.search(r'^\s*'+re.escape(label)+r':\s*([-+0-9.]+)\s*(ns|us|µs|ms|s)\s*$',text,re.M)
  if not m: raise ValueError('TIMESYNC_'+label.upper().replace(' ','_')+'_UNAVAILABLE')
  return float(m.group(1))*{'ns':1e-9,'us':1e-6,'µs':1e-6,'ms':1e-3,'s':1}[m.group(2)]
 distance=seconds('Root distance')
 if distance<0: raise ValueError('NEGATIVE_ROOT_DISTANCE')
 return {'estimatedHostOffsetSeconds':seconds('Offset'),'rootDistanceSeconds':distance,
  'uncertaintyDefinition':'timedatectl timesync-status measured Root distance; offset sign as reported'}

def measure_clock(phase,previous=None,command=None,wall=time.time,monotonic=time.monotonic):
 utc=wall(); mono=monotonic()
 result={'schemaVersion':1,'phase':phase,'observedUtc':dt.datetime.fromtimestamp(utc,dt.timezone.utc).isoformat(timespec='microseconds').replace('+00:00','Z'),
  'hostEpochSeconds':utc,'monotonicSeconds':mono,'measurementSource':'chronyc tracking; timedatectl NTPSynchronized',
  'ntpSynchronized':None,'estimatedHostOffsetSeconds':None,'rootDistanceSeconds':None,'state':'UNKNOWN','reason':None,
  'providerClockOffset':'UNKNOWN_NOT_MEASURED','thresholdSeconds':{'absoluteHostOffset':MAX_OFFSET_SECONDS,'rootDistance':MAX_UNCERTAINTY_SECONDS}}
 if command is None:
  def command(args):
   r=subprocess.run(args,capture_output=True,text=True,timeout=1,env={'PATH':os.environ.get('PATH','/usr/bin:/bin'),'LC_ALL':'C'})
   if r.returncode or len(r.stdout)>16384: raise RuntimeError('CLOCK_COMMAND_UNAVAILABLE')
   return r.stdout
 try:
  sync=command(['timedatectl','show','--property=NTPSynchronized','--value']).strip()
  if sync not in ('yes','no'): raise ValueError('UNKNOWN_NTP_STATE')
  result['ntpSynchronized']=sync=='yes'
  try: result.update(parse_tracking(command(['chronyc','tracking'])))
  except Exception:
   result.update(parse_timesync(command(['timedatectl','timesync-status'])))
   result['measurementSource']='timedatectl timesync-status; NTPSynchronized'
  result['ntpSynchronized']=result['ntpSynchronized'] and sync=='yes'
  result['state']='HEALTHY' if result['ntpSynchronized'] and abs(result['estimatedHostOffsetSeconds'])<=MAX_OFFSET_SECONDS and result['rootDistanceSeconds']<=MAX_UNCERTAINTY_SECONDS else 'UNCERTAIN'
  result['reason']=None if result['state']=='HEALTHY' else 'UNSYNCHRONIZED_OR_THRESHOLD_EXCEEDED'
 except Exception as e: result['reason']=type(e).__name__+': '+str(e)[:160]
 result['measurementDurationSeconds']=monotonic()-mono
 if result['measurementDurationSeconds']>4: result.update(state='UNCERTAIN',reason='MEASUREMENT_TOO_SLOW')
 if previous and (mono<previous['monotonicSeconds'] or abs((utc-previous['hostEpochSeconds'])-(mono-previous['monotonicSeconds']))>0.250):
  result.update(state='UNCERTAIN',reason='WALL_CLOCK_DISCONTINUITY')
 return result

def retain_clock(path,phase,previous=None):
 result=measure_clock(phase,previous)
 with open(path,'a',encoding='utf8') as f:
  f.write(json.dumps(result,allow_nan=False,separators=(',',':'))+'\n'); f.flush(); os.fsync(f.fileno())
 return result
