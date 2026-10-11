/** V5 authority is supplied independently, never read from archive evidence. */
import { createHash, createPublicKey, verify } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { epochMicros } from './exact-clock.js';
import type { Binding } from './poly2-prospective.js';
export type ProductionBinding = Binding & { shadowCodeSha:string; protocolDigest:string; generationId:string; expectedWorkers:string[] };
export interface ProductionAuthority {
  schemaVersion:1; version:'poly2-production-authority-v1'; binding:ProductionBinding;
  cohortSha256:string; requiredWriterServices:['backend','bot']; producerFingerprint:string; approvedUtc:string;
  installations:Record<string,{installationSha256:string; approvedUtc:string}>;
}
export interface AuthorityInput { authority:ProductionAuthority; pin:string }
const check=(v:unknown,s:string):void=>{if(!v)throw new Error('production authority: '+s);};
/** RFC8785/JCS: UTF16 key ordering, ECMAScript number rendering, no invalid Unicode.
 * Python uses the reviewed rfc8785 package, not an imitation float formatter. */
export function authorityCanonical(value:unknown):string {
  const string=(s:string):string=>{check(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(s),'invalid Unicode');return JSON.stringify(s);};
  const encode=(v:unknown):string=>{
    if(v===null)return 'null';
    if(typeof v==='string')return string(v);
    if(typeof v==='boolean')return JSON.stringify(v);
    if(typeof v==='number'){check(Number.isFinite(v)&&(!Number.isInteger(v)||Number.isSafeInteger(v)),'finite safe numeric domain');return JSON.stringify(v);}
    if(Array.isArray(v))return '['+v.map(encode).join(',')+']';
    check(typeof v==='object'&&v!==null&&Object.getPrototypeOf(v)===Object.prototype,'plain JSON value');
    return '{'+Object.keys(v as object).sort().map(k=>string(k)+':'+encode((v as Record<string,unknown>)[k])).join(',')+'}';
  }; return encode(value);
}
export const authorityDigest=(v:unknown):string=>createHash('sha256').update(authorityCanonical(v)).digest('hex');
export function producerFingerprint(pem:string):string {
  const key=createPublicKey(pem);check(key.asymmetricKeyType==='ed25519','Ed25519 producer key required');
  return createHash('sha256').update(key.export({type:'spki',format:'der'})).digest('hex');
}
export function validateAuthority(input:AuthorityInput|undefined,binding:Binding):ProductionAuthority {
  check(input&&/^[a-f0-9]{64}$/.test(input.pin),'independent authority and pin required');
  const a=input!.authority, b=binding as ProductionBinding;
  check(authorityDigest(a)===input!.pin,'independent authority pin mismatch');
  check(authorityCanonical(Object.keys(a).sort())===authorityCanonical(['schemaVersion','version','binding','cohortSha256','requiredWriterServices','producerFingerprint','approvedUtc','installations'].sort()),'complete schema');
  check(a.schemaVersion===1&&a.version==='poly2-production-authority-v1'&&authorityCanonical(a.binding)===authorityCanonical(b),'exact external binding');
  check(b.evidenceKind==='observational'&&[b.runId,b.shadowRunId,b.generationId].every(v=>typeof v==='string'&&v.length>0),'observational run/generation');
  for(const [field,size] of [['poly2CodeSha',40],['shadowCodeSha',40],['componentSha256',64],['protocolDigest',64]] as const)check(new RegExp('^[a-f0-9]{'+size+'}$').test(b[field]),'revision/protocol identity');
  check(b.cohort.length===5&&new Set(b.cohort).size===5&&b.cohort.every(w=>/^0x[a-f0-9]{40}$/.test(w))&&a.cohortSha256===authorityDigest(b.cohort),'exact cohort');
  check(Array.isArray(b.expectedWorkers)&&b.expectedWorkers.length&&new Set(b.expectedWorkers).size===b.expectedWorkers.length&&b.expectedWorkers.every(w=>/^(backend|bot):[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(w))&&['backend','bot'].every(s=>b.expectedWorkers.some(w=>w.startsWith(s+':')))&&authorityCanonical(a.requiredWriterServices)==='["backend","bot"]','complete approved backend/bot roster');
  check(epochMicros(b.window.endUtc)-epochMicros(b.window.startUtc)===86400000000n&&epochMicros(a.approvedUtc)<epochMicros(b.window.startUtc),'preactivation exact24h window');
  check(typeof b.sourcePublicKey==='string'&&producerFingerprint(b.sourcePublicKey)===a.producerFingerprint,'producer fingerprint');
  check(authorityCanonical(Object.keys(a.installations).sort())===authorityCanonical([...b.expectedWorkers].sort()),'approved installations inventory');
  for(const proof of Object.values(a.installations))check(authorityCanonical(Object.keys(proof).sort())==='["approvedUtc","installationSha256"]'&&/^[a-f0-9]{64}$/.test(proof.installationSha256)&&epochMicros(proof.approvedUtc)<=epochMicros(a.approvedUtc),'approved installation proof');
  return a;
}
export function authenticatedBytes(record:Record<string,unknown>, binding:ProductionBinding, authority:ProductionAuthority, stream:'fence'|'drain'):string {
  const unsigned=Object.fromEntries(Object.entries(record).filter(([k])=>k!=='signature'&&k!=='signedPayload'));
  return authorityCanonical({domain:'poly2-v5-authenticated-record-v1',stream,authoritySha256:authorityDigest(authority),bindingSha256:authorityDigest(binding),runId:binding.runId,generationId:binding.generationId,record:unsigned});
}
export function verifyAuthenticated(record:Record<string,unknown>,binding:ProductionBinding,authority:ProductionAuthority,stream:'fence'|'drain'):void {
  const payload=authenticatedBytes(record,binding,authority,stream);
  check(record.signedPayload===payload&&typeof record.signature==='string'&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.signature),'full canonical authenticated payload');
  check(verify(null,Buffer.from(payload),binding.sourcePublicKey!,Buffer.from(record.signature as string,'base64')),'producer signature');
}
export function loadAuthority(path:string,pin:string):AuthorityInput {
  check(path&&pin,'explicit read-only authority location and independent digest required');
  const authority=JSON.parse(readFileSync(path,'utf8')) as ProductionAuthority;
  const input={authority,pin};validateAuthority(input,authority.binding);return input;
}
