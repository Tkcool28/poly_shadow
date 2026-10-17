/** Explicit independent approval required for v2; never self-authorizes a run. */
import {readFileSync,realpathSync,openSync,readSync,closeSync,fstatSync,constants} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {COMPARATOR_VERSION} from './phase4-v2.js';
import {epochMicros} from './exact-clock.js';
import {authorityCanonical} from './production-authority.js';
export const contractPath=resolve(dirname(fileURLToPath(import.meta.url)),'../../docs/shadow/PHASE4_COMPARISON_CONTRACT.md');
export function safePath(path:string):string {
 const p=resolve(path);if(realpathSync(p)!==p)throw Error('symlink evidence path');return p;
}
export function boundedBytes(path:string,max=131072):Buffer {
 safePath(path);const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{const s=fstatSync(fd);if(!s.isFile()||s.size>max)throw Error('bounded regular JSON required');
  const bytes=Buffer.alloc(s.size+1),n=readSync(fd,bytes,0,bytes.length,0);
  if(n!==s.size||fstatSync(fd).size!==s.size)throw Error('JSON changed during bounded read');return bytes.subarray(0,n);
 }finally{closeSync(fd);}
}
export function boundedJson(path:string,max=131072):any {return JSON.parse(boundedBytes(path,max).toString('utf8'));}
export function approveV2(path:string,pin:string,expected:{runId:string;shadowSha:string;window:{startUtc:string;endUtc:string};cohort:string[]}) {
 const bytes=boundedBytes(path),a=JSON.parse(bytes.toString('utf8'));
 if(!/^[a-f0-9]{64}$/.test(pin)||createHash('sha256').update(bytes).digest('hex')!==pin)throw Error('independent comparison approval pin required');
 const contractSha256=createHash('sha256').update(readFileSync(contractPath)).digest('hex');
 if(a.version!==COMPARATOR_VERSION||a.approved!==true||typeof a.approvedBy!=='string'||!a.approvedBy.trim()||a.contractSha256!==contractSha256||a.runId!==expected.runId||a.shadowSha!==expected.shadowSha||authorityCanonical(a.window)!==authorityCanonical(expected.window)||authorityCanonical(a.cohort)!==authorityCanonical(expected.cohort)||epochMicros(a.approvedUtc)>=epochMicros(expected.window.startUtc))throw Error('comparison v2 approval/run/contract mismatch');
 return {version:COMPARATOR_VERSION,contractSha256,approvalPin:pin};
}
