import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
interface PublisherIO {
  write: typeof writeFileSync;
  rename: typeof renameSync;
  remove: typeof unlinkSync;
  diagnose: (message:string) => void;
}
/** Operational snapshot only; never writes scientific evidence. */
export function startMemoryPublisher(dir:string, snapshot:()=>unknown,
  io:PublisherIO={write:writeFileSync,rename:renameSync,remove:unlinkSync,diagnose:console.error},
  archive?: (snapshot: unknown) => void,
  reportFailure?: (error: unknown) => void,
  fatalArchiveFailure?: (error: unknown) => void): { publish:()=>void; stop:()=>void; finish:(stopSources:()=>void)=>void } {
  const file=join(dir,'runtime-memory.json');
  let failureReported=false;
  let retired=false;
  let timer:ReturnType<typeof setInterval>|undefined;
  let attempts=0,failures=0,consecutiveFailures=0,lastAttemptUtc:string|null=null,lastSuccessfulUtc:string|null=null;
  const status=()=>({state:retired?'STOPPED':consecutiveFailures?'RETRYING':'ACTIVE',cadenceSeconds:5,attempts,failures,consecutiveFailures,lastAttemptUtc,lastSuccessfulUtc,nextExpectedUtc:lastAttemptUtc?new Date(Date.parse(lastAttemptUtc)+5000).toISOString():null});
  const cleanup=()=>{try {io.remove(file+'.tmp');} catch { /* absent or inaccessible; retry later */ }};
  const publish=()=>{
    if(retired)return;
    attempts++;lastAttemptUtc=new Date().toISOString();
    try {
      const raw=snapshot();
      const value=raw&&typeof raw==='object'?{...raw,publisher:status()}:raw;
      // Append telemetry even when mutable status publication fails. A broken
      // authoritative archive retires before any later observer continuation.
      try { archive?.(value); } catch (err) {
        if(fatalArchiveFailure){retired=true;if(timer)clearInterval(timer);fatalArchiveFailure(err);return;}
        try {io.diagnose(`[poly-shadow] telemetry archive failed; retrying: ${String(err).slice(0,256)}`);} catch {}
      }
      io.write(file+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});
      io.rename(file+'.tmp',file);
      lastSuccessfulUtc=lastAttemptUtc;consecutiveFailures=0;failureReported=false;
    } catch (err) {
      failures++;consecutiveFailures++;
      cleanup();
      // At most one bounded stderr diagnostic per failure streak. Diagnostics
      // and snapshot IO must never enter the evidence or kill the observer.
      if (!failureReported) {
        failureReported=true;
        try {reportFailure?.(err);} catch (reportError) {
          // An independent reporter may be the authoritative evidence sink.
          // Its failure must retire even during the first publish, before the
          // caller has received a stop handle or any interval has been armed.
          if(fatalArchiveFailure){retired=true;if(timer)clearInterval(timer);fatalArchiveFailure(reportError);return;}
        }
        try {io.diagnose(`[poly-shadow] memory snapshot failed; retrying: ${String(err).slice(0,256)}`);} catch { /* non-critical */ }
      }
    }
  };
  publish();
  if(!retired)timer=setInterval(publish,5000);
  const stop=()=>{retired=true;if(timer)clearInterval(timer);cleanup();};
  return {publish,stop,finish:(stopSources)=>{
    // Synchronous, one-shot shutdown: quiesce cadence, commit the watcher's
    // terminal proof, then project it before retiring. No retry or source IO.
    if(timer)clearInterval(timer);
    try {stopSources();} finally {try {publish();} finally {stop();}}
  }};
}
