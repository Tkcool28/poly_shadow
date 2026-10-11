import { readFileSync, statfsSync, lstatSync, opendirSync } from 'node:fs';
import { join, dirname } from 'node:path';
export const storagePlan = JSON.parse(readFileSync(new URL('../../docs/shadow/storage-budget-v2.json',import.meta.url),'utf8')) as {
 windowSeconds:number;maximumDrainGraceSeconds:number;telemetryCadenceSeconds:number;publisherCadenceSeconds:number;alertReserveBytes:number;marginRatio:number;families:Record<string,{expectedBytesPerSecond:number;upperBytesPerSecond:number}>;
};
/** Explicit engineering envelope, not a forecast or an upstream volume proof. */
export function storageBudget(seconds=storagePlan.windowSeconds+storagePlan.maximumDrainGraceSeconds){
 if(!Number.isSafeInteger(seconds)||seconds<0)throw Error('invalid storage horizon');
 const families=Object.fromEntries(Object.entries(storagePlan.families).map(([k,r])=>[k,{expectedBytes:Math.ceil(r.expectedBytesPerSecond*seconds),upperBytes:Math.ceil(r.upperBytesPerSecond*seconds)}]));
 const expectedBytes=Object.values(families).reduce((n,r)=>n+r.expectedBytes,0),upperBytes=Object.values(families).reduce((n,r)=>n+r.upperBytes,0);
 const marginBytes=Math.ceil(upperBytes*storagePlan.marginRatio);
 return {seconds,families,expectedBytes,upperBytes,marginBytes,reserveBytes:storagePlan.alertReserveBytes,requiredFreeBytes:upperBytes+marginBytes+storagePlan.alertReserveBytes};
}
export function diskState(availableBytes:number|null,remainingSeconds:number,capacityBytes:number|null=null){
 const budget=storageBudget(remainingSeconds);
 const state=availableBytes===null?'UNKNOWN':availableBytes<storagePlan.alertReserveBytes?'AT_RISK':availableBytes<budget.requiredFreeBytes?'DEGRADED':'GREEN';
 return {state,availableBytes,capacityBytes,usePercent:availableBytes!==null&&capacityBytes!==null&&capacityBytes>0?100*(1-availableBytes/capacityBytes):null,...budget};
}
export function assertPrelaunchDisk(dir:string,read:(path:string)=>{bavail:number|bigint;bsize:number|bigint;blocks:number|bigint}=statfsSync){const s=read(dir);const state=diskState(Number(s.bavail)*Number(s.bsize),storagePlan.windowSeconds+storagePlan.maximumDrainGraceSeconds,Number(s.blocks)*Number(s.bsize));if(state.state!=='GREEN')throw Error(`PRELAUNCH_DISK_GATE: ${state.availableBytes} available; ${state.requiredFreeBytes} required`);return state;}
const inventoryNames=['raw_logs.ndjson','raw_log_tombstones.ndjson','observations.ndjson','source_observations.ndjson','rest_raw.ndjson','poll_telemetry.ndjson','dispositions.ndjson','reconciliation.ndjson','quarantine.ndjson','rpc_lineage.ndjson','rpc_recoveries.ndjson','quarantine_v2.ndjson','quarantine_resolutions.ndjson','rest_poll_receipts.ndjson','runtime_telemetry.ndjson','audit_snapshots.ndjson','chain_tail_proofs.ndjson','operational-index.sqlite','recovery-index.sqlite','racing-index.sqlite'];
function size(file:string){try{const s=lstatSync(file);return s.isFile()?s.size:null;}catch{return null;}}
/** Fixed inventory; bounded stat-only capture scan, no raw evidence parsing. */
export function storageTelemetry(dir:string,elapsedSeconds:number){
 const files=Object.fromEntries(inventoryNames.map(n=>[n,size(join(dir,n))]));
 const captureDir=join(dirname(dir),'poly2-comparison-capture');let captureBytes:number|null=0,captureFiles=0;
 try{const d=opendirSync(captureDir);try{let e;while((e=d.readSync())){if(++captureFiles>4096){captureBytes=null;break;}const n=size(join(captureDir,e.name));if(n!==null)captureBytes+=n;}}finally{d.closeSync();}}catch{captureBytes=null;}
 let disk;try{const s=statfsSync(dir);disk=diskState(Number(s.bavail)*Number(s.bsize),Math.max(0,Math.ceil(storagePlan.windowSeconds+storagePlan.maximumDrainGraceSeconds-elapsedSeconds)),Number(s.blocks)*Number(s.bsize));}catch{disk=diskState(null,storagePlan.windowSeconds+storagePlan.maximumDrainGraceSeconds);}
 return {files,captureBytes,captureFiles,disk};
}
