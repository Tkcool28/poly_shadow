import { openSync, readSync, closeSync } from 'node:fs';
import { resolve } from 'node:path';
/** Only allowlisted self/cgroup control files; bounded reads, no environment,
 * command line, credentials or other process metadata. v2 finite limit only.
 */
function bounded(file: string): string | null {
 try { const fd=openSync(file,'r'); try { const b=Buffer.alloc(4096); return b.subarray(0,readSync(fd,b,0,b.length,0)).toString().trim(); } finally {closeSync(fd);} } catch { return null; }
}
export function cgroupMemory(root='/sys/fs/cgroup', membership=bounded('/proc/self/cgroup')): {cgroupUsageBytes:number|null; cgroupLimitBytes:number|null} {
 const line=membership?.split('\n').find(l=>l.startsWith('0::'));
 const path=line?.slice(3);root=resolve(root);
 if(!path || !path.startsWith('/') || path.split('/').includes('..')) return {cgroupUsageBytes:null,cgroupLimitBytes:null};
 let dir=resolve(root,'.'+path);
 const num=(file:string)=>{const s=bounded(file); if(!s || !/^\d+$/.test(s)) return null; const n=Number(s);return Number.isSafeInteger(n) && n>=0?n:null;};
 let usage=num(`${dir}/memory.current`), limit:number|null=null;
 // The smallest visible finite ancestor limit governs this workload. Read
 // usage FROM THAT SAME GROUP, not leaf RSS/heap or host total memory.
 for(let depth=0;depth<64;depth++) {
  const candidate=num(`${dir}/memory.max`);
  if(candidate!==null && (limit===null || candidate<limit)) {limit=candidate;usage=num(`${dir}/memory.current`);}
  if(dir===root) break;dir=resolve(dir,'..');
 }
 return {cgroupUsageBytes:usage,cgroupLimitBytes:limit};
}
export function selfToken() {
 const stat=bounded('/proc/self/stat'); const f=stat?.slice(stat.lastIndexOf(')')+2).split(/\s+/);
 return f ? {pid:process.pid,pgid:Number(f[2]),session:Number(f[3]),startTicks:f[19]} : null;
}
