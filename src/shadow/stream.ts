import { openSync, readSync, closeSync, existsSync, fstatSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';

/** Snapshot-length streaming reader; 64KiB buffer + <=1MiB physical line.
 * Oversized/malformed evidence fails closed, with path/physical line. Never skips.
 * Frozen length prevents replay chasing its own appends. UTF-8 survives chunks.
 */
export function* streamRows<T>(file: string): Generator<T> {
 if (!existsSync(file)) return;
 const fd = openSync(file, 'r'); const buffer = Buffer.alloc(64*1024);
 const decoder = new StringDecoder('utf8'); let pending = ''; let physical = 0;
 const limit = 1024*1024;
 const parse = (line: string): T => {
  if (Buffer.byteLength(line) > limit) throw Error(`${file}:${physical}: physical line exceeds limit ${limit}`);
  try { return JSON.parse(line) as T; } catch(cause) { throw Error(`${file}:${physical}: malformed NDJSON`, {cause}); }
 };
 try {
  const end = fstatSync(fd).size; let offset = 0;
  while(offset < end) {
   const n = readSync(fd,buffer,0,Math.min(buffer.length,end-offset),offset); if(!n) break;
   offset += n; pending += decoder.write(buffer.subarray(0,n));
   let start=0, next: number;
   while((next=pending.indexOf('\n',start))!==-1) {
    const line=pending.slice(start,next); physical++;
    if(Buffer.byteLength(line)>limit) throw Error(`${file}:${physical}: physical line exceeds limit ${limit}`);
    if(line.trim()) yield parse(line); start=next+1;
   }
   pending=pending.slice(start);
   if(Buffer.byteLength(pending)>limit) throw Error(`${file}:${physical+1}: physical line exceeds limit ${limit}`);
  }
  pending += decoder.end();
  if(pending.trim()) {physical++; yield parse(pending);}
 } finally {closeSync(fd);}
}
