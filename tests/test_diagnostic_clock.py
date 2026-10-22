import importlib.util
from pathlib import Path
import unittest
spec=importlib.util.spec_from_file_location('diagnostic_clock_fixture',Path(__file__).resolve().parents[1]/'scripts/diagnostic_clock.py')
c=importlib.util.module_from_spec(spec);spec.loader.exec_module(c)
TRACK='''System time     : 0.003561 seconds fast of NTP time
Root delay      : 0.004000 seconds
Root dispersion : 0.002493 seconds
Leap status     : Normal
'''
class ClockEvidence(unittest.TestCase):
 def sample(self,text=TRACK,sync='yes',previous=None,utc=1000,mono=50):
  return c.measure_clock('FIXTURE',previous,command=lambda args:sync if args[0]=='timedatectl' else text,wall=lambda:utc,monotonic=lambda:mono)
 def test_healthy_synchronized(self):
  r=self.sample();self.assertEqual(r['state'],'HEALTHY');self.assertAlmostEqual(r['estimatedHostOffsetSeconds'],.003561);self.assertAlmostEqual(r['rootDistanceSeconds'],.004493);self.assertEqual(r['providerClockOffset'],'UNKNOWN_NOT_MEASURED')
 def test_unavailable(self):
  def fail(args):raise FileNotFoundError('missing')
  r=c.measure_clock('START',command=fail);self.assertEqual(r['state'],'UNKNOWN');self.assertIsNone(r['estimatedHostOffsetSeconds'])
 def test_excessive_offset_uncertainty_and_unsynchronized(self):
  for text in (TRACK.replace('.003561','1.003561'),TRACK.replace('.002493','1.002493'),TRACK.replace('Normal','Not synchronised')):
   self.assertEqual(self.sample(text)['state'],'UNCERTAIN')
  self.assertEqual(self.sample(sync='no')['state'],'UNCERTAIN')
 def test_discontinuity_and_monotonic_order(self):
  previous=self.sample();self.assertEqual(self.sample(previous=previous,utc=1001,mono=51)['state'],'HEALTHY')
  self.assertEqual(self.sample(previous=previous,utc=1003,mono=51)['reason'],'WALL_CLOCK_DISCONTINUITY')
  self.assertEqual(self.sample(previous=previous,utc=999,mono=49)['state'],'UNCERTAIN')
 def test_invalid_and_signed_offsets(self):
  self.assertEqual(self.sample(TRACK.replace('fast','slow'))['estimatedHostOffsetSeconds'],-.003561)
  self.assertEqual(self.sample(TRACK.replace('0.003561','nan'))['state'],'UNKNOWN')
if __name__=='__main__':unittest.main()

class TimesyncEvidence(unittest.TestCase):
 def test_timesyncd_fallback(self):
  def command(args):
   if args[0]=='chronyc': raise FileNotFoundError('no chronyc')
   return 'yes' if 'show' in args else '   Offset: +3.561ms\n   Root distance: 4.493ms\n'
  r=c.measure_clock('START',command=command)
  self.assertEqual(r['state'],'HEALTHY');self.assertAlmostEqual(r['rootDistanceSeconds'],.004493)
