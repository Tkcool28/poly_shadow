/** GitHub metadata only: reserve this explicit authorization, never retry. */
import {readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
const e=JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH,'utf8'));
const branch='test/corrected-v2-evidence-campaign-v1-1',base='1f911ad00d2e98bfd553a0de7dd101746221e531';
if(process.env.GITHUB_REPOSITORY!=='Tkcool28/poly_shadow'||process.env.GITHUB_RUN_ATTEMPT!=='1'||e.action!=='labeled'||e.label?.name!=='authorize-v2-evidence-v1-1'||e.pull_request?.head?.ref!==branch||e.pull_request?.base?.sha!==base)throw Error('AUTHORIZATION_BINDING');
const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();if(head!==e.pull_request.head.sha)throw Error('HEAD_BINDING');
for(const [file,expected]of [['adapter.ts','f7a3fcaabdd5277efb53a528d5626d49127dc32d'],['replay.ts','f4b1539296c25ab649dbc19a176c04b4b8d2633c']])if(execFileSync('git',['rev-parse',`HEAD:research/v2-cursor-v1/${file}`],{encoding:'utf8'}).trim()!==expected)throw Error('MERGED_IMPLEMENTATION_CHANGED');
const url='https://api.github.com/repos/Tkcool28/poly_shadow/actions/workflows/v2-bounded-evidence.yml/runs?event=pull_request&per_page=100';
const response=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${process.env.GH_TOKEN}`,Accept:'application/vnd.github+json'}});
if(!response.ok)throw Error(`RUN_HISTORY_HTTP_${response.status}`);
const reader=response.body.getReader();let body=Buffer.alloc(0);try{while(true){const r=await reader.read();if(r.done)break;if(body.length+r.value.length>1048576){await reader.cancel();throw Error('RUN_HISTORY_BOUND')}body=Buffer.concat([body,r.value])}}finally{reader.releaseLock()}
const runs=JSON.parse(body).workflow_runs;if(!Array.isArray(runs)||runs.length>=100)throw Error('RUN_HISTORY_UNPROVEN');
const prior=runs.filter(r=>r.name==='corrected-v2-evidence-v1-1'&&r.head_branch===branch&&String(r.id)!==process.env.GITHUB_RUN_ID&&r.conclusion!=='skipped');
if(prior.length)throw Error('AUTHORIZATION_ALREADY_CONSUMED');
console.log(JSON.stringify({authorization:'corrected-v2-v1-1',head,base,priorAuthorizedRuns:prior.length,run:process.env.GITHUB_RUN_ID}));
