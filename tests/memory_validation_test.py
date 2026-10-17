"""Synthetic memory harness tests. Never run real observer, Docker or systemd."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import signal
import tempfile
import time
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('memory_validation_under_test', ROOT / 'scripts/memory_validation.py')
M = importlib.util.module_from_spec(spec)
spec.loader.exec_module(M)
T = M.T


def host():
    return {'memAvailableBytes':4*T.GIB,'memTotalBytes':8*T.GIB,'swapTotalBytes':4*T.GIB,'swapFreeBytes':3*T.GIB,
            'oomKills':0,'psi':{'some':{'avg10':0},'full':{'avg10':0}}}


def scope():
    return {'Id':'scope','LoadState':'loaded','ActiveState':'active','BindsTo':'guard.service','After':'guard.service',
            'InvocationID':'a'*32,'ControlGroup':'/unit/scope','MemoryHigh':str(M.E.HIGH),'MemoryMax':str(M.E.MAX),
            'MemorySwapMax':str(M.E.SWAP),'KillMode':'control-group','KillSignal':'9','TimeoutStopUSec':'2s',
            'RuntimeMaxUSec':'1h 45min','ActiveEnterTimestampMonotonic':'1'}


class MemoryHarness(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)

    def test_phase_boundaries_exact_fifteen_fifteen_ninety(self):
        for seconds, expected in [(0,'BASELINE'),(899.999,'BASELINE'),(900,'STABILIZATION'),(1799.999,'STABILIZATION'),(1800,'SUSTAINED'),(7199.999,'SUSTAINED'),(7200,'DEADLINE'),(9000,'DEADLINE')]:
            self.assertEqual(M.phase(seconds),expected)
        self.assertEqual((M.BASELINE,M.STABILIZED-M.BASELINE,M.DURATION-M.STABILIZED),(900,900,5400))
        for bad in (-1,float('nan'),float('inf')):
            with self.assertRaises(M.Abort):M.phase(bad)

    def test_absolute_deadline_not_relative_to_late_observer(self):
        manifest={'startWall':1000,'startMono':20}
        self.assertEqual(M.elapsed(manifest,8200,7220),7200)
        self.assertEqual(M.elapsed(manifest,800,7220),7200)  # UTC backwards cannot extend
        self.assertEqual(M.elapsed(manifest,8300,7000),7300)  # UTC forward ends earlier
        with mock.patch.object(M.time,'time',return_value=8200),mock.patch.object(M.time,'monotonic',return_value=7220):
            self.assertEqual(M.remaining(manifest),0)
        self.assertNotIn('actualObserverLaunchUtc',manifest)

    def test_isolation_and_no_scientific_paths(self):
        for p in [ROOT/'runs/phase4-a',ROOT/'memory-validation/nested/memory-a',ROOT/'other/memory-a']:
            with self.assertRaises(M.Abort):M.test_path(str(p))
        self.assertEqual(M.test_path(str(ROOT/'memory-validation/memory-a')),ROOT/'memory-validation/memory-a')
        (self.root/'memory-validation').symlink_to(self.root/'elsewhere')
        with self.assertRaises(Exception):M.test_path(str(self.root/'memory-validation/memory-a'),self.root)
        source=(ROOT/'scripts/memory_validation.py').read_text()
        self.assertNotIn('publish_current_run(',source)
        self.assertNotIn('load_launch_authority(',source)
        self.assertNotIn('shadow_controller',source)

    def test_fixed_real_observer_environment(self):
        env=M.environment(ROOT/'memory-validation/memory-a')
        self.assertEqual(env['SHADOW_V2_CURSOR'],'true')
        self.assertEqual(env['SHADOW_WATCHED_WALLETS'].split(','),M.R.WALLETS)
        self.assertEqual(env['SHADOW_DATA_DIR'],str(ROOT/'memory-validation/memory-a/shadow-data'))
        self.assertNotIn('SHADOW_TRADES_POLL_MS',env)
        self.assertNotIn('SHADOW_ACTIVITY_POLL_MS',env)
        self.assertFalse(any(k.startswith('POLYCOPY') for k in env))

    def test_scope_command_bound_and_no_uncontrolled_shell(self):
        with mock.patch.object(M,'remaining',return_value=6000):
            cmd=M.scope_command(ROOT/'memory-validation/memory-a',{})
        self.assertIn('--scope',cmd)
        for s in ('MemoryMax=4294967296','MemoryHigh=3221225472','MemorySwapMax=536870912',
                  'BindsTo=poly-shadow-memory-a.service','After=poly-shadow-memory-a.service',
                  'KillSignal=SIGKILL','KillMode=control-group','TimeoutStopSec=2','RuntimeMaxSec=6030.000000'):
            self.assertIn('--property='+s,cmd)
        self.assertNotIn('timeout',cmd)
        self.assertNotIn('npm',cmd)

    def test_scope_readback_positive(self):
        with mock.patch.object(M,'unit_state',return_value=scope()):
            self.assertEqual(M.scope_identity('scope','guard.service')['ControlGroup'],'/unit/scope')

    def test_scope_readback_all_safety_failures_before_go(self):
        for key,value in [('BindsTo',''),('After',''),('MemoryMax','0'),('MemoryHigh','0'),('MemorySwapMax','0'),
                          ('KillSignal','15'),('KillMode','process'),('TimeoutStopUSec','90s'),('RuntimeMaxUSec','infinity'),
                          ('RuntimeMaxUSec','0s'),('ActiveState','inactive'),('InvocationID','')]:
            s=scope();s[key]=value
            with self.subTest(key=key,value=value),mock.patch.object(M,'unit_state',return_value=s),self.assertRaises(M.Abort):
                M.scope_identity('scope','guard.service')
        with mock.patch.object(M,'unit_state',return_value=scope()),self.assertRaises(M.Abort):
            M.scope_identity('scope','guard.service',control_group='/different')

    def test_guardian_manager_identity_and_no_restart(self):
        s=scope();s.update(Id='guard',MainPID=str(os.getpid()),Restart='no',RuntimeMaxUSec='2h 8s')
        with mock.patch.object(M,'unit_state',return_value=s):self.assertEqual(M.guard_identity('guard')['MainPID'],str(os.getpid()))
        for key,value in [('MainPID','1'),('Restart','always'),('KillMode','process'),('InvocationID','bad'),('RuntimeMaxUSec','3h')]:
            bad=dict(s);bad[key]=value
            with self.subTest(key=key),mock.patch.object(M,'unit_state',return_value=bad),self.assertRaises(M.Abort):M.guard_identity('guard')

    def leaf(self):
        root=self.root/'cgroup';parent=root/'parent';leaf=parent/'leaf';leaf.mkdir(parents=True)
        for d in (parent,leaf):
            (d/'memory.max').write_text(str(M.E.MAX))
        for name,value in [('memory.high',M.E.HIGH),('memory.swap.max',M.E.SWAP),('memory.oom.group',1)]:
            (leaf/name).write_text(str(value))
        return root,parent,leaf

    def test_own_leaf_and_ancestor_limits_no_corrective_writes(self):
        root,parent,leaf=self.leaf();token=M.leaf_controls(leaf,root=root)
        self.assertEqual(M.leaf_controls(leaf,token,root),token)
        for path in (parent/'memory.max',leaf/'memory.oom.group',leaf/'memory.swap.max'):
            original=path.read_text();path.write_text('0')
            with self.assertRaises(M.Abort):M.leaf_controls(leaf,token,root)
            self.assertEqual(path.read_text(),'0')
            path.write_text(original)
        with self.assertRaises(M.Abort):M.leaf_controls(leaf,(0,0),root)

    def test_host_pressure_and_oom_stop_conditions(self):
        base=host();disk={'freeBytes':30*T.GIB}
        for key,value,reason in [('memAvailableBytes',T.GIB-1,'HOST_MEMAVAILABLE'),('oomKills',1,'HOST_OOM')]:
            current=host();current[key]=value
            self.assertEqual(T.pressure_failure(current,base,disk)[0],reason)
        current=host();current.update(memAvailableBytes=2*T.GIB-1,swapFreeBytes=1)
        self.assertEqual(T.pressure_failure(current,base,disk)[0],'HOST_SWAP_PRESSURE')
        self.assertEqual(T.pressure_failure(base,base,{'freeBytes':10*T.GIB})[0],'DISK_RESERVE')
        current=host();current['psi']['full']['avg10']=11
        self.assertIsNone(T.pressure_failure(current,base,disk)[0])
        self.assertEqual(T.pressure_failure(current,base,disk,psi_streak=1)[0],'HOST_PSI')
        for key in ('max','oom','oom_kill'):
            events=dict(max=0,oom=0,oom_kill=0);new=dict(events);new[key]=1
            self.assertTrue(T.pressure_failure(base,base,disk,{'events':new},events)[0].startswith('OBSERVER_'))
        # MemoryHigh alone is measured pressure, not an OOM claim.
        self.assertIsNone(T.pressure_failure(base,base,disk,{'events':dict(max=0,oom=0,oom_kill=0,high=5)},dict(max=0,oom=0,oom_kill=0))[0])

    def test_bounded_jsonl_and_exclusive_no_retry(self):
        path=self.root/'memory.jsonl';j=M.Journal(path);j.append({'sample':1});j.close()
        self.assertEqual(json.loads(path.read_text())['evidenceBoundary'],M.LABEL)
        with self.assertRaises(FileExistsError):M.Journal(path)
        j=M.Journal(self.root/'overflow.jsonl')
        with self.assertRaises(M.Abort):j.append({'data':'x'*M.ROW_BYTES})
        with mock.patch.object(M,'MAX_ROWS',0),self.assertRaises(M.Abort):j.append({})
        j.close()

    def test_poly2_config_inventory_and_heartbeat_are_read_only(self):
        calls=[]
        now=time.time()
        config=dict(paper_mode=True,allow_live_trading=False,order_kill_switch=False,shadow_capture_enabled=False,max_order_size_usd=10,max_exposure_global_usd=200)
        def invoke(args,input=None,**kw):
            calls.append((args,input))
            if 'inspect' in args:return '\n'.join(json.dumps({'Name':'/'+n,'Id':n,'RestartCount':0,'State':{'Running':True,'Restarting':False,'OOMKilled':False,'StartedAt':'fixed'}}) for n in M.PROTECTED)
            if '-c' in args and 'get_settings' in args[-1]:return json.dumps(config)
            if 'psql' in args[-1]:return json.dumps({'readOnly':'on','heartbeats':[{'service':s,'last_seen':M.utc(now-1)} for s in ('bot_alive','bot_success')]})
            return 'a'*40
        with mock.patch.object(M,'command',side_effect=invoke):v=M.poly2_snapshot()
        self.assertEqual(len(v['containers']),4)
        for service in ('poly2-backend-1','poly2-bot-1'):
            self.assertIs(v['config'][service]['order_kill_switch'],False)
        for key,value in [('order_kill_switch',True),('paper_mode',False),('allow_live_trading',True),('shadow_capture_enabled',True)]:
            with self.subTest(refused_setting=key):
                original=config[key];config[key]=value
                with mock.patch.object(M,'command',side_effect=invoke),self.assertRaisesRegex(M.Abort,'Poly2 paper/capture safety baseline refused'):
                    M.poly2_snapshot()
                config[key]=original
        sql=next(i for a,i in calls if i)
        self.assertIn('BEGIN TRANSACTION READ ONLY',sql);self.assertIn('ROLLBACK',sql)
        self.assertFalse(any('restart' in a or 'stop' in a or 'start' in a for a,i in calls))
        changed=dict(v);changed['sha']='b'*40
        with self.assertRaises(M.Abort):M.same_poly2(changed,v)

    def test_memory_process_state_transition_is_not_pid_reuse(self):
        before={'pid':1,'state':'R','pgid':1,'session':1,'startTicks':'7'}
        after={**before,'state':'S'}
        with mock.patch.object(T,'process_token',side_effect=[before,after]),mock.patch.object(T,'bounded',return_value='Rss: 4 kB\nPss: 3 kB'):
            self.assertEqual(T.process_memory(1)['pssBytes'],3072)
        after={**after,'startTicks':'8'}
        with mock.patch.object(T,'process_token',side_effect=[before,after]),mock.patch.object(T,'bounded',return_value='Rss: 4 kB\nPss: 3 kB'):
            self.assertIsNone(T.process_memory(1)['rssBytes'])

    def test_cgroup_tree_includes_nested_new_sessions(self):
        leaf=self.root/'leaf';child=leaf/'nested';child.mkdir(parents=True)
        (leaf/'cgroup.procs').write_text('7\n8\n');(child/'cgroup.procs').write_text('9\n')
        self.assertEqual(T.cgroup_pids(leaf),[7,8,9])
        with mock.patch.object(T,'MAX_PIDS',2),self.assertRaises(ValueError):T.cgroup_pids(leaf)

    def test_evidence_growth_includes_wal_and_all_journals(self):
        for name in ('chain_tail_proofs.ndjson','rpc_publications.ndjson','racing-index.sqlite-wal'):(self.root/name).write_text('123')
        value=T.evidence_snapshot(self.root)
        self.assertEqual(value['totalSelectedBytes'],9)
        self.assertIsNone(value['acquisition'])

    def test_cli_refuses_without_explicit_run_approval(self):
        with mock.patch.object(M,'run') as run:
            self.assertEqual(M.main(['run','--directory',str(ROOT/'memory-validation/memory-a'),'--expected-sha','a'*40]),1)
            run.assert_not_called()
        with self.assertRaises(SystemExit):M.main(['run','--directory','/tmp/x','--duration','1'])


    def test_scientific_runner_remains_byte_identical(self):
        self.assertEqual(hashlib.sha256((ROOT/'scripts/phase4-runner.py').read_bytes()).hexdigest(),'15b0628fad53ca3d9ffa459409c3c4302febb3d725485f426a1c58bb29eaf065')

    def test_entry_refuses_controls_before_acquisition(self):
        entry=M.source_module('memory_entry_under_test',ROOT/'scripts/memory-observer-entry.py')
        directory=self.root/'memory-a';directory.mkdir()
        (directory/'shadow-data').mkdir();(directory/'runtime-home').mkdir()
        manifest={'evidenceBoundary':M.LABEL,'directory':str(directory),'observerEnvironment':entry.M.environment(directory)}
        for error_at in ('scope-verify','scope-binding'):
            with self.subTest(point=error_at),mock.patch.object(entry.M,'test_path',return_value=directory), \
                 mock.patch.object(entry.M,'read_json',return_value=manifest),mock.patch.object(entry.M,'elapsed',return_value=1000), \
                 mock.patch.object(entry.M.T,'bounded',return_value='0::/scope'),mock.patch.object(entry.M.E,'verify_scope',side_effect=M.Abort('bad controls') if error_at=='scope-verify' else None), \
                 mock.patch.object(entry.M,'scope_identity',side_effect=M.Abort('bad binding')),mock.patch.object(entry.os,'execve') as execute:
                with self.assertRaises(Exception):entry.main(['--directory',str(directory)])
                execute.assert_not_called()
                self.assertFalse((directory/'observer-go.json').exists())
                self.assertFalse((directory/'observer-ready.json').exists())

    def test_guardian_loss_never_becomes_success(self):
        directory=self.root/'memory-a'
        directory.parent.mkdir(exist_ok=True)
        checks={'host':host(),'poly2':{}}
        process=mock.Mock();process.wait.return_value=1
        with mock.patch.object(M,'preflight',return_value=checks),mock.patch.object(M,'test_path',return_value=directory), \
             mock.patch.object(M,'unit_state',return_value={'ActiveState':'failed'}),mock.patch.object(M.subprocess,'Popen',return_value=process):
            with self.assertRaises(M.Abort):M.run(directory,'a'*40)
        summary=json.loads((directory/'summary.json').read_text())
        self.assertEqual(summary['failure'],'GUARDIAN_OR_REPORT_LOST')
        self.assertEqual(summary['evidenceBoundary'],M.LABEL)
        self.assertEqual(summary['status'],'FAILED')
        args=process.mock_calls


    def test_cleanup_does_not_skip_owned_group_when_manager_fails(self):
        child=mock.Mock();token={'pid':123}
        with mock.patch.object(M,'unit_state',side_effect=M.Abort('manager unavailable')),mock.patch.object(M.R,'stop_owned',return_value=True) as stop:
            result=M.cleanup(child,token,'scope','a'*32,None,100)
        stop.assert_called_once_with(child,token,immediate=True,frozen_end=100)
        self.assertFalse(result['complete'])
        self.assertTrue(result['ownedProcessGroupGone'])
        self.assertIn('MANAGER_Abort',result['errors'])

    def test_cleanup_known_incarnation_killed_even_if_binding_removed(self):
        child=mock.Mock();s=scope();s.update(BindsTo='',After='')
        with mock.patch.object(M,'unit_state',return_value=s),mock.patch.object(M,'command') as call,mock.patch.object(M.R,'stop_owned',return_value=True):
            result=M.cleanup(child,{'pid':123},'scope','a'*32,None,100)
        self.assertTrue(any('--signal=KILL' in c.args[0] for c in call.mock_calls))
        self.assertFalse(result['observerCgroupEmpty'])  # no retained leaf lacks empty proof

    def test_manager_abort_race_requires_all_independent_stop_proofs(self):
        leaf=self.root/'leaf';leaf.mkdir();(leaf/'cgroup.procs').write_text('')
        inode=(leaf.stat().st_dev,leaf.stat().st_ino)
        active=scope()
        for final,group_gone,exited,pids,expected in [
            ({'LoadState':'not-found'},True,0,[],True),
            ({**active,'ActiveState':'inactive'},True,0,[],True),
            ({**active,'ActiveState':'failed'},True,0,[],True),
            (active,True,0,[],False),
            ({**active,'ActiveState':'inactive','InvocationID':'b'*32},True,0,[],False),
            ({'LoadState':'not-found'},False,0,[],False),
            ({'LoadState':'not-found'},True,None,[],False),
            ({'LoadState':'not-found'},True,0,[123],False),
        ]:
            with self.subTest(final=final,group_gone=group_gone,exited=exited,pids=pids):
                child=mock.Mock();child.poll.return_value=exited
                with mock.patch.object(M,'unit_state',side_effect=[active,final]),mock.patch.object(M,'command',side_effect=M.Abort('unit vanished during kill')),mock.patch.object(M,'kill_leaf'),mock.patch.object(M.R,'stop_owned',return_value=group_gone),mock.patch.object(T,'cgroup_pids',return_value=pids),mock.patch.object(M.time,'monotonic',side_effect=[0,3]):
                    result=M.cleanup(child,{'pid':123},'scope','a'*32,leaf,100,inode)
                self.assertEqual(result['complete'],expected,result)
                self.assertEqual(result['benignManagerKillRace'],expected)
                self.assertEqual(result['managerKillError'],'MANAGER_Abort')
                if not expected:self.assertIn('MANAGER_Abort',result['errors'])

    def test_manager_race_without_verified_leaf_inode_fails_closed(self):
        leaf=self.root/'absent-leaf';child=mock.Mock();child.poll.return_value=0
        with mock.patch.object(M,'unit_state',side_effect=[scope(),{'LoadState':'not-found'}]),mock.patch.object(M,'command',side_effect=M.Abort('unit gone')),mock.patch.object(M.R,'stop_owned',return_value=True):
            result=M.cleanup(child,{'pid':123},'scope','a'*32,leaf,100,None)
        self.assertFalse(result['complete']);self.assertIn('MANAGER_Abort',result['errors'])

    def test_bounded_memory_stat_categories_preserve_existing_telemetry(self):
        leaf=self.root/'memory-leaf';leaf.mkdir();(leaf/'cgroup.procs').write_text('')
        for name,value in [('memory.current','101'),('memory.peak','202'),('memory.swap.current','3'),('memory.events','max 0\noom 0\noom_kill 0')]:
            (leaf/name).write_text(value)
        values={k:i+10 for i,k in enumerate(T.MEMORY_STAT_CATEGORIES)}
        (leaf/'memory.stat').write_text('\n'.join(f'{k} {v}' for k,v in values.items())+'\nanon 999\nunknown_category 123')
        snapshot=T.observer_snapshot(leaf)
        self.assertEqual(snapshot['memoryStatBytes'],values)
        self.assertEqual(snapshot['memoryCurrentBytes'],101);self.assertEqual(snapshot['memoryPeakBytes'],202)
        self.assertEqual(snapshot['swapCurrentBytes'],3);self.assertEqual(snapshot['events']['oom'],0)
        self.assertTrue(snapshot['rssComplete']);self.assertEqual(snapshot['treePssBytes'],0)
        (leaf/'memory.stat').write_text('active_file 1')
        with self.assertRaises(KeyError):T.observer_snapshot(leaf)
        (leaf/'memory.stat').write_text('x'*16385)
        with self.assertRaises(ValueError):T.observer_snapshot(leaf)


    def test_owned_leaf_kill_descriptor_and_wrong_inode_refusal(self):
        leaf=self.root/'leaf';leaf.mkdir();(leaf/'cgroup.kill').write_text('0')
        inode=(leaf.stat().st_dev,leaf.stat().st_ino)
        M.kill_leaf(leaf,inode,execute=False)
        self.assertEqual((leaf/'cgroup.kill').read_text(),'0')
        M.kill_leaf(leaf,inode)
        self.assertEqual((leaf/'cgroup.kill').read_text(),'1')
        with self.assertRaises(M.Abort):M.kill_leaf(leaf,(0,0))
        self.assertEqual(M.tagged({'evidenceBoundary':'wrong'})['evidenceBoundary'],M.LABEL)

    def test_terminal_interval_failures_cannot_certify_success(self):
        leaf=self.root/'leaf';leaf.mkdir()
        events=leaf/'memory.events';events.write_text('max 0\noom 0\noom_kill 0\n')
        manifest={'preflight':{'host':host()}}
        with mock.patch.object(M,'leaf_controls'),mock.patch.object(T,'host_snapshot',return_value=host()),mock.patch.object(T,'disk_snapshot',return_value={'freeBytes':30*T.GIB}),mock.patch.object(M.R,'child_exited',return_value=False) as exited:
            args=(self.root,manifest,mock.Mock(),leaf,(1,2),{'max':0,'oom':0,'oom_kill':0},0)
            self.assertIn('memoryEvents',M.terminal_check(*args))
            events.write_text('max 0\noom 1\noom_kill 0\n')
            with self.assertRaisesRegex(M.Abort,'OBSERVER_OOM'):M.terminal_check(*args)
            events.write_text('max 0\noom 0\noom_kill 0\n');exited.return_value=True
            with self.assertRaisesRegex(M.Abort,'OBSERVER_EARLY_EXIT'):M.terminal_check(*args)
            events.unlink()
            with self.assertRaises(FileNotFoundError):M.terminal_check(*args)



if __name__ == '__main__':unittest.main()
