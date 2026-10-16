"""Real Linux dummy-process tests with a synthetic systemd control plane.

No production systemd, Docker, RPC, npm or Shadow observer is started.
"""
import importlib.util
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('memory_lifecycle_fixture',ROOT/'scripts/memory_validation.py')
M=importlib.util.module_from_spec(spec);spec.loader.exec_module(M)


def write(path,value):path.write_text(json.dumps(value))


def alive(token):return M.R.owner_alive(token)


def kill_fixture(directory):
    path=directory/'tokens.json'
    if path.exists():
        for token in json.loads(path.read_text()):
            if M.R.same(token):
                try:os.kill(token['pid'],signal.SIGKILL)
                except ProcessLookupError:pass
        (directory/'leaf/cgroup.procs').write_text('')


def dummy(directory,mode):
    # Escaping PGID/session still belongs to the synthetic cgroup inventory.
    grandchild=subprocess.Popen([sys.executable,'-c','import time;time.sleep(30)'],start_new_session=True)
    tokens=[M.R.proc(os.getpid()),M.R.proc(grandchild.pid)]
    write(directory/'tokens.json',tokens)
    (directory/'leaf/cgroup.procs').write_text(str(os.getpid())+'\n'+str(grandchild.pid)+'\n')
    M.write_new(directory/'observer-ready.json',{'token':tokens[0],'guardianInvocation':'a'*32,
        'controlGroup':'/fixture/scope','inode':[1,2]})
    while not (directory/'observer-go.json').exists():time.sleep(.005)
    if mode=='early':return
    if mode=='end-oom':
        while time.time()<json.loads((directory/'fixture-clock.json').read_text())['end']-.08:time.sleep(.005)
        (directory/'leaf/memory.events').write_text('max 0\noom 1\noom_kill 0\n')
    while True:time.sleep(.05)


def fixture(directory,mode):
    M.DURATION=1.8;M.BASELINE=.3;M.STABILIZED=.7;M.CADENCE=.2;M.MAX_ROWS=20
    directory.mkdir(exist_ok=True)
    (directory/'leaf').mkdir(exist_ok=True);(directory/'leaf/cgroup.procs').write_text('')
    (directory/'shadow-data').mkdir(exist_ok=True)
    (directory/'leaf/memory.events').write_text('max 0\noom 0\noom_kill 0\n')
    parent=M.R.proc(os.getppid())
    start=time.time();mono=time.monotonic()
    h={'memAvailableBytes':4*M.T.GIB,'memTotalBytes':8*M.T.GIB,'swapTotalBytes':4*M.T.GIB,'swapFreeBytes':3*M.T.GIB,'oomKills':0,'psi':{'some':{'avg10':0},'full':{'avg10':0}}}
    poly={'containers':{},'config':{},'sha':'a'*40}
    manifest={'launcherToken':parent,'startWall':start,'startMono':mono,'startUtc':M.utc(start),
              'deadlineUtc':M.utc(start+M.DURATION),'bootId':M.T.bounded(Path('/proc/sys/kernel/random/boot_id')).strip(),
              'preflight':{'host':h,'poly2':poly},'shadowSha':'a'*40}
    write(directory/'fixture-clock.json',{'end':start+M.DURATION})
    write(directory/'guard-token.json',M.R.proc(os.getpid()))
    def snapshot():
        now=dict(h)
        if mode=='pressure' and time.monotonic()-mono>.85:now['memAvailableBytes']=512*1024**2
        return now
    def observe(leaf):
        rows=[M.T.process_memory(int(p)) for p in (leaf/'cgroup.procs').read_text().split()]
        return {'processes':rows,'treeRssBytes':sum(r.get('rssBytes') or 0 for r in rows),
                'treePssBytes':None,'memoryCurrentBytes':123456789,'swapCurrentBytes':0,
                'events':{'max':0,'oom':int(mode=='oom' and time.monotonic()-mono>.85),'oom_kill':0}}
    def control(args,**kwargs):
        if args[:3]==['systemctl','--user','kill']:kill_fixture(directory);return ''
        if 'rev-parse' in args:return 'a'*40
        return ''
    def state(unit):
        return {'Id':unit,'LoadState':'loaded','ActiveState':'active','InvocationID':'b'*32,
                'BindsTo':'poly-shadow-'+directory.name+'.service','After':'poly-shadow-'+directory.name+'.service',
                'ControlGroup':'/fixture/scope','Result':'success','ActiveEnterTimestampMonotonic':'1'}
    leaf=directory/'leaf'
    with mock.patch.object(M,'guard_identity',return_value={'InvocationID':'a'*32}),\
         mock.patch.object(M,'scope_identity',side_effect=lambda *a,**k:state(a[0])),\
         mock.patch.object(M,'leaf_controls',return_value=(1,2)),\
         mock.patch.object(M,'kill_leaf',side_effect=lambda leaf,inode,execute=True:kill_fixture(directory) if execute else None),\
         mock.patch.object(M,'cgroup_leaf',return_value=leaf),\
         mock.patch.object(M,'unit_state',side_effect=state),\
         mock.patch.object(M,'poly2_snapshot',return_value=poly),\
         mock.patch.object(M,'command',side_effect=control),\
         mock.patch.object(M.R,'owner_lock',side_effect=lambda _:os.open('/dev/null',os.O_RDONLY)),\
         mock.patch.object(M.R,'orphans'),mock.patch.object(M.R,'prelaunch_disk'),\
         mock.patch.object(M,'scope_command',return_value=[sys.executable,'-B',__file__,'dummy',str(directory),mode]),\
         mock.patch.object(M.T,'host_snapshot',side_effect=snapshot),\
         mock.patch.object(M.T,'observer_snapshot',side_effect=observe),\
         mock.patch.object(M.T,'disk_snapshot',return_value={'freeBytes':30*M.T.GIB}),\
         mock.patch.object(M.T,'workloads',return_value={'topRssProcesses':[]}):
        return M.supervise(directory,manifest)


def launch_parent(directory,mode):
    guard=subprocess.Popen([sys.executable,'-B',__file__,'fixture',str(directory),mode],start_new_session=True)
    write(directory/'guardian-pid.json',{'pid':guard.pid})
    guard.wait()


def fake_manager(directory):
    while not (directory/'guard-token.json').exists():time.sleep(.005)
    token=json.loads((directory/'guard-token.json').read_text())
    while alive(token):time.sleep(.005)
    kill_fixture(directory)
    write(directory/'manager-cleanup.json',{'syntheticBindsTo':True,'utc':M.utc()})


@unittest.skipUnless(sys.platform=='linux' and M.R.proc(os.getpid()) is not None,'Linux readable /proc required; CI supplies it')
class MemoryLifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.addCleanup(self.tmp.cleanup)
        self.directory=Path(self.tmp.name)/'memory-fixture';self.directory.mkdir()
        self.children=[]
        self.addCleanup(self.cleanup)

    def cleanup(self):
        kill_fixture(self.directory)
        for p in self.children:
            if p.poll() is None:p.kill()
            try:p.wait(timeout=3)
            except subprocess.TimeoutExpired:pass
        path=self.directory/'guard-token.json'
        if path.exists():
            token=json.loads(path.read_text())
            if M.R.same(token):
                try:os.kill(token['pid'],signal.SIGKILL)
                except ProcessLookupError:pass

    def spawn(self,operation,mode='normal'):
        p=subprocess.Popen([sys.executable,'-B',__file__,operation,str(self.directory),mode],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
        self.children.append(p);return p

    def wait_file(self,name):
        end=time.monotonic()+6
        while time.monotonic()<end:
            try:return json.loads((self.directory/name).read_text())
            except (FileNotFoundError,json.JSONDecodeError):time.sleep(.01)
        self.fail('Missing fixture artifact '+name)

    def assert_no_observer(self):
        tokens=self.wait_file('tokens.json')
        end=time.monotonic()+3
        while any(alive(t) for t in tokens) and time.monotonic()<end:time.sleep(.02)
        self.assertFalse(any(alive(t) for t in tokens),'Dummy observer descendant orphaned')

    def test_complete_deadline_and_all_phases(self):
        p=self.spawn('fixture');p.communicate(timeout=7)
        report=self.wait_file('summary.json')
        self.assertEqual(report['status'],'COMPLETE',report)
        self.assertEqual(set(report['phases']),{'BASELINE','STABILIZATION','SUSTAINED'})
        self.assertLess(M.R.epoch(report['stopRequestedUtc'])-M.R.epoch(report['deadlineUtc']),.2)
        self.assertTrue(report['cleanup']['observerCgroupEmpty']);self.assert_no_observer()

    def test_early_exit_oom_and_host_pressure_are_failures(self):
        for mode,reason in [('early','OBSERVER_EARLY_EXIT'),('oom','OBSERVER_OOM'),('pressure','HOST_MEMAVAILABLE'),('end-oom','OBSERVER_OOM')]:
            with self.subTest(mode=mode):
                # Each mode gets exclusively new fixture files.
                self.directory=Path(self.tmp.name)/('memory-'+mode);self.directory.mkdir()
                p=self.spawn('fixture',mode);p.communicate(timeout=7)
                report=self.wait_file('summary.json')
                self.assertEqual(report['failure'],reason,report);self.assertEqual(report['status'],'FAILED')
                self.assert_no_observer()

    def test_guardian_term_cleans_escaped_descendant(self):
        p=self.spawn('fixture');self.wait_file('observer-go.json');p.send_signal(signal.SIGTERM);p.communicate(timeout=7)
        self.assertEqual(self.wait_file('summary.json')['failure'],'INTERRUPTED_15');self.assert_no_observer()

    def test_launcher_sigkill_independent_guardian_cleans(self):
        p=self.spawn('parent');self.wait_file('observer-go.json');p.kill();p.communicate(timeout=3)
        report=self.wait_file('summary.json')
        self.assertEqual(report['failure'],'LAUNCHER_LOST',report);self.assert_no_observer()

    def test_guardian_sigkill_manager_binding_fallback(self):
        # Real process death + synthetic manager implementation of BindsTo. Actual
        # manager properties are independently required/read back before GO.
        manager=self.spawn('manager')
        p=self.spawn('fixture');self.wait_file('observer-go.json');p.kill();p.communicate(timeout=3)
        self.wait_file('manager-cleanup.json');manager.communicate(timeout=3);self.assert_no_observer()
        self.assertFalse((self.directory/'summary.json').exists(),'Killed guardian cannot certify success')


if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1] in ('fixture','dummy','parent','manager'):
        operation=sys.argv[1];directory=Path(sys.argv[2]);mode=sys.argv[3] if len(sys.argv)>3 else 'normal'
        if operation=='fixture':raise SystemExit(fixture(directory,mode))
        if operation=='dummy':dummy(directory,mode)
        if operation=='parent':launch_parent(directory,mode)
        if operation=='manager':fake_manager(directory)
    else:unittest.main()
