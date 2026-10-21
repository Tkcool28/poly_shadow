import asyncio
import datetime as dt
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import types
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[1]
def load_module(name,path):
    spec=importlib.util.spec_from_file_location(name,path); assert spec and spec.loader
    mod=importlib.util.module_from_spec(spec); spec.loader.exec_module(mod); return mod
exporter=load_module('integration_exporter',ROOT/'scripts/poly2-diagnostic-export.py')
runner=load_module('integration_runner',ROOT/'scripts/uncertified-diagnostic-runner.py')
START=dt.datetime(2026,10,19,0,0,0,tzinfo=dt.timezone.utc)
END=START+dt.timedelta(minutes=1)
TX1='0x'+'11'*32
TX3='0x'+'33'*32

class Result:
    def __init__(self,rows): self.rows=rows
    def fetchall(self): return [types.SimpleNamespace(_mapping=row) for row in self.rows]

class OfflinePoly2:
    def __init__(self):
        self.rows=[]
        for rid,wallet,tx,asset,size,price in ((1,exporter.WALLETS[0],TX1,'7',DecimalText('1.000000'),'0.5'),(2,exporter.WALLETS[0],TX1,'7',DecimalText('1.000000'),'0.5'),(3,exporter.WALLETS[2],TX3,'9',DecimalText('3.000000'),'0.4')):
            traded=START+dt.timedelta(seconds=1); ingested=START+dt.timedelta(seconds=2+rid)
            source=f'data-api:{tx}:{wallet}:{asset}:{size}:{price}:{int(traded.timestamp())}'
            self.rows.append({'source_record_id':rid,'source_event_id':source,'wallet':wallet,'asset_id':asset,'condition_id':'cond-'+asset,'side':'BUY','size':DecimalText(str(size)),'price':DecimalText(price),'traded_at':traded,'ingested_at':ingested})
        self.calls=[]
    async def execute(self,statement,params=None):
        sql=str(statement); params=params or {}; self.calls.append((sql,params))
        if sql.startswith(('SET TRANSACTION','SET LOCAL')): return Result([])
        if 'AS writes_permitted' in sql: return Result([{'writes_permitted':False}])
        if 'current_setting' in sql: return Result([{'read_only':'on','isolation':'repeatable read'}])
        if 'FROM wallets' in sql: return Result([{'address':w} for w in exporter.WALLETS])
        if 'MAX(id)' in sql and 'FROM trades' in sql: return Result([{'max_id':3}])
        if 'MAX(id)' in sql and 'FROM decision_log' in sql: return Result([{'max_id':0}])
        if 'FROM trades AS t' in sql:
            return Result([r for r in self.rows if params['cursor']<r['source_record_id']<=params['high_id'] and params['start_utc']<=r['ingested_at'].isoformat()<=params['end_utc']][:params['limit']])
        if 'FROM signals' in sql: return Result([])
        if 'FROM decision_log' in sql: return Result([])
        raise AssertionError(sql)

def DecimalText(value):
    from decimal import Decimal
    return Decimal(value)

def observation(src,wallet,tx,asset,size,source_sec,seen_sec,identity):
    seen=START+dt.timedelta(seconds=seen_sec); completed=seen+dt.timedelta(milliseconds=250)
    return {'source':src,'identity':identity,'wallet':wallet,'side':'BUY','asset':asset,'size':size,'price':'0.5','sourceTs':source_sec,'blockTimestamp':None,'sourceFirstSeenUtc':seen.isoformat().replace('+00:00','Z'),'completedUtc':completed.isoformat().replace('+00:00','Z'),'role':'UNKNOWN','groupKey':f'econ:{tx}:{asset}:{size}','hydration':'FULL'}

class OfflineDiagnosticIntegration(unittest.TestCase):
    def test_exporter_runner_artifacts_and_v2_report_end_to_end_offline(self):
        db=OfflinePoly2()
        poly=asyncio.run(exporter.read_export(db,lambda sql:sql,start_utc=START.isoformat(),end_utc=END.isoformat(),run_id='offline-fixture',decision_high_water=0,decision_end_high_water=0,trade_high_water=0,trade_end_high_water=3,shadow_sha='1'*40,poly2_checkout_sha=runner.EXPECTED_POLY2_SHA,runtime_image_id='sha256:'+'a'*64,runtime_revision=runner.EXPECTED_POLY2_SHA,exported_utc='2026-10-19T00:01:00.000000Z'))
        self.assertEqual(poly['coverage']['duplicateDatabaseTradeIdentities'],1)
        self.assertEqual(len(poly['rows']),2)
        self.assertTrue(all(row['decisionEvidence']=='UNKNOWN_NO_AUDIT' and row['paperOutcome'] is None and row['policyEligible'] is None for row in poly['rows']))
        self.assertEqual(poly['coverage']['actualPaperOrderExecutions'],0)
        tx2='0x'+'22'*32; source_sec=int((START+dt.timedelta(seconds=1)).timestamp())
        source_rows=[
            observation('CHAIN',exporter.WALLETS[0],TX1,'7','1.000000',source_sec,2,'chain-1'),
            observation('REST_TRADES',exporter.WALLETS[0],TX1,'7','1.000000',source_sec,3,'rest-1'),
            observation('REST_TRADES',exporter.WALLETS[0],TX1,'7','1.000000',source_sec,3,'rest-1'),
            observation('REST_ACTIVITY',exporter.WALLETS[1],tx2,'8','2.000000',source_sec,4,'activity-2'),
        ]
        pre={'schemaVersion':1,'classification':'UNCERTIFIED_DIAGNOSTIC','mode':'preflight','certified':False,'observedUtc':'2026-10-19T00:00:00.000000Z','cohort':list(exporter.WALLETS),'approvedWallets':list(exporter.WALLETS),'decisionLogIdHighWater':0,'tradeIdHighWater':0}
        end_pre={**pre,'observedUtc':'2026-10-19T00:01:01.000000Z','decisionLogIdHighWater':0,'tradeIdHighWater':3}
        before={'imageId':'sha256:'+'a'*64,'revisionLabel':runner.EXPECTED_POLY2_SHA,'flags':runner.REQUIRED_FLAGS.copy()}
        with tempfile.TemporaryDirectory() as tmp:
            temp=Path(tmp); poly_repo=temp/'poly2'; poly_repo.mkdir(); run_root=temp/'runs'
            args=types.SimpleNamespace(repo=ROOT,poly2_repo=poly_repo,run_root=run_root,poly2_container='offline-fixture',duration_seconds=60,publish_dashboard=True,dashboard_summary=temp/'diagnostic-comparison'/'summary.json')
            def fake_popen(cmd,*,env,**kwargs):
                data_dir=Path(env['SHADOW_DATA_DIR']); data_dir.mkdir(parents=True,exist_ok=True)
                (data_dir/'source_observations.ndjson').write_text(chr(10).join(json.dumps(row) for row in source_rows)+chr(10))
                (data_dir/'rest_poll_receipts.ndjson').write_text(json.dumps({'source':'REST_ACTIVITY','wallet':exporter.WALLETS[1],'responseUtc':'2026-10-19T00:00:10.000000Z','outcome':'HTTP_FAILURE','stopReason':None})+chr(10))
                return types.SimpleNamespace(pid=34567,returncode=0,poll=lambda:0)
            def fake_export(container,script,manifest,path):
                self.assertEqual(manifest['poly2Preflight']['tradeIdHighWater'],0)
                self.assertEqual(manifest['poly2EndPreflight']['tradeIdHighWater'],3)
                bound=asyncio.run(exporter.read_export(db,lambda sql:sql,start_utc=manifest['window']['startUtc'],end_utc=manifest['window']['endUtc'],run_id=manifest['runId'],decision_high_water=manifest['poly2Preflight']['decisionLogIdHighWater'],decision_end_high_water=manifest['poly2EndPreflight']['decisionLogIdHighWater'],trade_high_water=manifest['poly2Preflight']['tradeIdHighWater'],trade_end_high_water=manifest['poly2EndPreflight']['tradeIdHighWater'],shadow_sha=manifest['software']['shadowGitSha'],poly2_checkout_sha=manifest['software']['poly2CheckoutGitSha'],runtime_image_id=manifest['software']['poly2RuntimeImageId'],runtime_revision=manifest['software']['poly2RuntimeRevisionLabel'],exported_utc='2026-10-19T00:01:00.000000Z'))
                runner.atomic_json(path,bound)
            real_run=subprocess.run
            real_popen=subprocess.Popen
            report_results=[]
            def report_only(cmd,**kwargs):
                if any(str(part).endswith('diagnostic-report-cli.ts') for part in cmd):
                    with patch.object(subprocess,'Popen',real_popen): result=real_run(cmd,**kwargs)
                    report_results.append(result)
                    if result.returncode:
                        run_dir=cmd[cmd.index('--run-directory')+1]; export_path=cmd[cmd.index('--poly2-export')+1]
                        debug_script=("import {readFileSync} from 'node:fs'; import {join} from 'node:path'; import {buildDiagnosticReport} from './src/compare/uncertified-diagnostic.ts'; const d="+json.dumps(run_dir)+",m=JSON.parse(readFileSync(join(d,'diagnostic-manifest.json'),'utf8')),e=JSON.parse(readFileSync("+json.dumps(export_path)+",'utf8')); void buildDiagnosticReport({shadowDataDirectory:join(d,'shadow-data'),manifest:m,poly2Export:e}).then(()=>console.log('OK')).catch(x=>{console.error(x?.stack??String(x));process.exitCode=2});")
                        with patch.object(subprocess,'Popen',real_popen): debug=real_run(['node','--import','tsx','--input-type=module','-e',debug_script],cwd=ROOT,capture_output=True,text=True,timeout=60)
                        report_results.append(debug)
                    return result
                raise AssertionError(f'unexpected subprocess: {cmd}')
            times=iter(('2026-10-19T00:00:00.000000Z','2026-10-19T00:01:01.000000Z'))
            from contextlib import ExitStack
            with ExitStack() as stack:
                stack.enter_context(patch.object(runner,'git_value',side_effect=lambda repo,*parts:runner.EXPECTED_BRANCH if parts==('rev-parse','--abbrev-ref','HEAD') else ''))
                stack.enter_context(patch.object(runner,'revision',side_effect=lambda repo:'1'*40 if repo==ROOT else runner.EXPECTED_POLY2_SHA))
                stack.enter_context(patch.object(runner,'inspect_poly2',return_value=before))
                stack.enter_context(patch.object(runner,'preflight',side_effect=(pre,end_pre)))
                stack.enter_context(patch.object(runner,'storage_preflight',return_value={'state':'GREEN','gate':'PASS','requiredFreeBytes':1}))
                stack.enter_context(patch.object(runner,'now_utc',side_effect=lambda:next(times,'2026-10-19T00:01:01.000000Z')))
                stack.enter_context(patch.object(runner.subprocess,'Popen',side_effect=fake_popen))
                stack.enter_context(patch.object(runner,'wait_for_window',return_value={'endedUtc':'2026-10-19T00:01:00.000000Z','early':False}))
                stack.enter_context(patch.object(runner,'stop_process_group',return_value=None))
                stack.enter_context(patch.object(runner,'export_poly2',side_effect=fake_export))
                stack.enter_context(patch.object(runner.subprocess,'run',side_effect=report_only))
                rc=runner.run(args)
            self.assertEqual(rc,0,[(r.returncode,r.stderr,r.stdout) for r in report_results])
            run_dir=next(p for p in run_root.iterdir() if p.is_dir())
            manifest=json.loads((run_dir/'diagnostic-manifest.json').read_text())
            report=json.loads((run_dir/'diagnostic-report.json').read_text())
            written_export=json.loads((run_dir/'poly2-export.json').read_text())
            published_summary=json.loads(args.dashboard_summary.read_text())
            self.assertEqual(published_summary['classification'],'UNCERTIFIED_DIAGNOSTIC')
            self.assertFalse(published_summary['certified'])
            self.assertEqual(published_summary['runId'],manifest['runId'])
            self.assertEqual(manifest['state'],'COMPLETE')
            self.assertEqual(written_export['coverage']['tradeIdRange'],{'after':0,'through':3})
            self.assertEqual(report['classification'],'UNCERTIFIED_DIAGNOSTIC')
            self.assertFalse(report['certified'])
            self.assertEqual(report['priceOpportunity']['state'],'PRICE_ADVANTAGE_UNKNOWN')
            self.assertEqual(report['discovery']['matchingConfidence']['high'],1)
            self.assertEqual(len(report['examples']),1)
            timing={x['method']:x for x in report['timing']}
            self.assertEqual(timing['CHAIN']['signedShadowLead']['medianSeconds'],0.75)
            self.assertEqual(timing['SHADOW_UNION']['detectionLatency']['p90Seconds'],1.25)
            self.assertTrue((args.dashboard_summary.parent/'report.json').exists())
            self.assertTrue((args.dashboard_summary.parent/'evidence-manifest.json').exists())
            self.assertEqual(report['comparison']['oneSidedAbsenceClassification'],'INDETERMINATE')
            self.assertEqual(report['overall']['matched'],1)
            self.assertEqual(report['overall']['indeterminate'],2)
            self.assertEqual(report['overall']['shadowOnlyObserved'],1)
            self.assertEqual(report['overall']['poly2OnlyObserved'],1)
            self.assertEqual(report['overall']['duplicateShadowObservationRows'],1)
            self.assertEqual([w['wallet'] for w in report['wallets']],list(exporter.WALLETS))
            self.assertEqual(sum(w['counts']['matched'] for w in report['wallets']),report['overall']['matched'])
            self.assertEqual(sum(w['counts']['indeterminate'] for w in report['wallets']),report['overall']['indeterminate'])
            lanes={s['source']:s for s in report['sources']}
            self.assertEqual(set(lanes),{'CHAIN','REST_TRADES','REST_ACTIVITY'})
            self.assertGreater(lanes['CHAIN']['observationLatencyFromEvent']['samples'],0)
            self.assertGreater(lanes['REST_TRADES']['observationLatencyFromEvent']['samples'],0)
            self.assertGreater(lanes['REST_ACTIVITY']['observationLatencyFromEvent']['samples'],0)
            self.assertGreater(lanes['REST_ACTIVITY']['completenessWarnings'],0)
            self.assertEqual(report['actualPoly2PaperActions']['paperOrderExecutions'],0)
            self.assertEqual(report['overall']['unknownPoly2DecisionAudits'],2)
            self.assertEqual(report['additionalShadowCandidates']['eligibility'],'UNKNOWN')
            self.assertEqual(report['additionalShadowCandidates']['paperAction'],'NONE_PROVEN')
            self.assertEqual(report['comparison']['coverage']['indeterminate'],2)
            self.assertEqual(report['comparison']['coverage']['shadowOnly'],0)
            self.assertEqual(report['comparison']['coverage']['poly2Only'],0)
            self.assertIsNone(report['comparison']['completenessProof'])
            # A redirected publication directory must fail before creating a file outside the diagnostic path.
            outside=temp/'outside';outside.mkdir()
            linked_dir=temp/'diagnostic-comparison'
            for generated in linked_dir.iterdir(): generated.unlink()
            linked_dir.rmdir();linked_dir.symlink_to(outside,target_is_directory=True)
            (run_dir/'diagnostic-report.json').unlink()
            rejected=subprocess.run(['node','--import','tsx','src/compare/diagnostic-report-cli.ts','--run-directory',str(run_dir),'--poly2-export',str(run_dir/'poly2-export.json'),'--publish-summary',str(linked_dir/'summary.json')],cwd=ROOT,capture_output=True,text=True,timeout=60)
            self.assertEqual(rejected.returncode,2,rejected.stderr)
            self.assertFalse((outside/'summary.json').exists())

if __name__=='__main__': unittest.main()
