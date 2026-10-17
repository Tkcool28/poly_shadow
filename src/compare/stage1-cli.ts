/** Governed v2 final report: explicit approval plus existing v5 sealed authority. */
import {readFileSync,mkdirSync,writeFileSync,existsSync} from 'node:fs';
import {join,resolve,basename} from 'node:path';
import {loadAuthority} from './production-authority.js';
import {validateFencedArchiveFile} from './poly2-fenced-archive.js';
import {compareV2,readShadowGroupsV2} from './phase4-v2.js';
import {approveV2,safePath,boundedJson} from './stage1-approval.js';
const [, ,run,archive,out,authorityPath,pin,approvalPath,approvalPin]=process.argv;
if(!run||!archive||!out||!authorityPath||!pin||!approvalPath||!approvalPin)throw Error('stage1-cli <run> <v5-sealed-export> <out> <authority> <authorityPin> <v2approval> <approvalPin>');
const a=loadAuthority(authorityPath,pin),b=a.authority.binding;
const approved=approveV2(approvalPath,approvalPin,{runId:b.shadowRunId,shadowSha:b.shadowCodeSha,window:b.window,cohort:b.cohort});
safePath(run);const m=boundedJson(join(run,'run-manifest.json'));
if(basename(run)!==b.shadowRunId||m.state!=='SEALED_NOT_STARTED'||m.durationSeconds!==86400||existsSync(join(run,'INVALID'))||existsSync(join(run,'shadow-data/EVIDENCE_BOUNDARY.json'))||JSON.stringify(m.window)!==JSON.stringify(b.window)||m.shadowSha!==b.shadowCodeSha||m.experimentDirectory!==run||m.productionAuthority?.sha256!==pin||m.evidenceBoundary)throw Error('v2 scientific run binding required');
const cohort=(w:string)=>b.cohort.includes(w.toLowerCase())?'CONTROLLED_OVERLAP' as const:null;
const data=validateFencedArchiveFile(archive,b.cohort,b.window,false,a);
const groups=await readShadowGroupsV2(join(run,'shadow-data'),cohort,b.window);
const result=compareV2(data,groups,b.window,cohort,{shadowComplete:false,poly2Complete:true,proof:'validated v5 committed-ingestion closure '+data.manifest.payloadSha256});
const output=resolve(out),input=resolve(run);if(output.split('/').includes('runs')||output.split('/').includes('memory-validation')||output===input||output.startsWith(input+'/')||output===resolve(archive)||output.startsWith(resolve(archive)+'/'))throw Error('Output must be outside immutable run and input archive');
safePath(resolve(out,'..'));mkdirSync(out);writeFileSync(join(out,'comparison-stage1-v2.json'),JSON.stringify({...result,approval:approved},null,2),{flag:'wx'});
