import { createReadStream, constants, openSync, fstatSync, closeSync } from 'node:fs';

/** Offline evidence only. Decode UTF-8 across chunks; retain at most one line.
 * Blank physical lines are ignored, as in the legacy split/trim reader.
 * No sampling, size cutoff or malformed-row recovery: evidence fails closed.
 */
export async function* readNdjson<T = Record<string, unknown>>(
  file: string,
  highWaterMark = 64 * 1024,
  limits: {maxBytes?:number;maxRows?:number;maxLineBytes?:number;onBytes?:(n:number)=>void;onRecord?:()=>void;allowIncompleteTail?:boolean;freezeAtOpen?:boolean} = {},
): AsyncGenerator<T> {
  const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  const initial=fstatSync(fd);
  if(!initial.isFile()){closeSync(fd);throw new Error(`${file}: NDJSON input is not a regular file`)}
  if(limits.freezeAtOpen&&initial.size===0){closeSync(fd);return;}
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark, fd, autoClose:true, ...(limits.freezeAtOpen?{end:initial.size-1}:{}) });
  let pending = '';
  let lineNumber = 0;
  let bytesRead = 0;
  let rowsRead = 0;
  const maxBytes=limits.maxBytes??Number.POSITIVE_INFINITY,maxRows=limits.maxRows??Number.POSITIVE_INFINITY,maxLineBytes=limits.maxLineBytes??Number.POSITIVE_INFINITY;
  const parse = (line: string): T => {
    try { return JSON.parse(line) as T; }
    catch (cause) { throw new Error(`${file}:${lineNumber}: malformed NDJSON`, { cause }); }
  };
  try {
    for await (const chunk of stream) {
      const text=chunk as string, chunkBytes=Buffer.byteLength(text,'utf8');
      bytesRead+=chunkBytes;
      if(bytesRead>maxBytes)throw new Error(`${file}: NDJSON byte limit exceeded`);
      limits.onBytes?.(chunkBytes);
      pending += text;
      if(Buffer.byteLength(pending,'utf8')>maxLineBytes+highWaterMark)throw new Error(`${file}: NDJSON line limit exceeded`);
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        lineNumber++;
        const line=pending.slice(start,end);
        if (Buffer.byteLength(line,'utf8') > maxLineBytes) throw new Error(`${file}:${lineNumber}: NDJSON line limit exceeded`);
        if (line.trim()) {
          rowsRead++;
          if(rowsRead>maxRows)throw new Error(`${file}: NDJSON row limit exceeded`);
          limits.onRecord?.();
          yield parse(line);
        }
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending.trim() && !limits.allowIncompleteTail) {
      lineNumber++;
      if(Buffer.byteLength(pending,'utf8')>maxLineBytes)throw new Error(`${file}:${lineNumber}: NDJSON line limit exceeded`);
      rowsRead++;
      if(rowsRead>maxRows)throw new Error(`${file}: NDJSON row limit exceeded`);
      limits.onRecord?.();
      yield parse(pending);
    }
  } finally {
    stream.destroy();
  }
}
