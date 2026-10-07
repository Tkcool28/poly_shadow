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
  io:PublisherIO={write:writeFileSync,rename:renameSync,remove:unlinkSync,diagnose:console.error}): { publish:()=>void; stop:()=>void } {
  const file=join(dir,'runtime-memory.json');
  let failureReported=false;
  const cleanup=()=>{try {io.remove(file+'.tmp');} catch { /* absent or inaccessible; retry later */ }};
  const publish=()=>{
    try {
      io.write(file+'.tmp',JSON.stringify(snapshot())+'\n',{mode:0o600});
      io.rename(file+'.tmp',file);
      failureReported=false;
    } catch (err) {
      cleanup();
      // At most one bounded stderr diagnostic per failure streak. Diagnostics
      // and snapshot IO must never enter the evidence or kill the observer.
      if (!failureReported) {
        failureReported=true;
        try {io.diagnose(`[poly-shadow] memory snapshot failed; retrying: ${String(err).slice(0,256)}`);} catch { /* non-critical */ }
      }
    }
  };
  publish();
  const timer=setInterval(publish,5000);
  return {publish,stop:()=>{clearInterval(timer);cleanup();}};
}
