/** Control-plane diagnostic, never scientific authority or recovery evidence. */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { selfToken } from './memory.js';
import type { OperationalEvidence } from './operational-evidence.js';
export function installSinkFailureControl(sink:OperationalEvidence,dir:string,retire:()=>void,
  io={write:writeFileSync,diagnose:console.error}) {
  return sink.onBroken((error)=>reportSinkFailureControl(dir,error,sink.failureStatus(),retire,io));
}
export function reportSinkFailureControl(dir:string,error:unknown,status:unknown,retire:()=>void,
  io={write:writeFileSync,diagnose:console.error}) {
    const row={schemaVersion:1,atUtc:new Date().toISOString(),token:selfToken(),
      code:'EVIDENCE_SINK_FAILURE',failureClass:'EVIDENCE_SINK_FAILURE',operationalSinkBroken:true,operationalSink:status,
      dataQuality:{state:'AT_RISK',rules:['EVIDENCE_SINK_FAILURE']},error:String(error)};
    // ENOSPC can prevent BOTH diagnostics. Retirement/exit is unconditional.
    try {io.write(join(dir,'operational-failure.json'),JSON.stringify(row)+'\n',{mode:0o600,flag:'wx'});} catch {}
    try {io.diagnose('[poly-shadow] EVIDENCE_SINK_FAILURE '+String(error));} catch {}
    retire();
}
