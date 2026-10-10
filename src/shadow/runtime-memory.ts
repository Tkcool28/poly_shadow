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
  fatalArchiveFailure?: (error: unknown) => void): { publish:()=>void; stop:()=>void } {
  const file=join(dir,'runtime-memory.json');
  let failureReported=false;
  let retired=false;
  let timer:ReturnType<typeof setInterval>|undefined;
  const cleanup=()=>{try {io.remove(file+'.tmp');} catch { /* absent or inaccessible; retry later */ }};
  const publish=()=>{
    if(retired)return;
    try {
      const value=snapshot();
      io.write(file+'.tmp',JSON.stringify(value)+'\n',{mode:0o600});
      io.rename(file+'.tmp',file);
      try { archive?.(value); } catch (err) {
        if(fatalArchiveFailure){retired=true;if(timer)clearInterval(timer);fatalArchiveFailure(err);return;}
        try {io.diagnose(`[poly-shadow] telemetry archive failed; retrying: ${String(err).slice(0,256)}`);} catch {}
      }
      failureReported=false;
    } catch (err) {
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
  return {publish,stop:()=>{retired=true;if(timer)clearInterval(timer);cleanup();}};
}
