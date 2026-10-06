import { createReadStream } from 'node:fs';

/** Offline evidence only. Decode UTF-8 across chunks; retain at most one line.
 * Blank physical lines are ignored, as in the legacy split/trim reader.
 * No sampling, size cutoff or malformed-row recovery: evidence fails closed.
 */
export async function* readNdjson<T = Record<string, unknown>>(
  file: string,
  highWaterMark = 64 * 1024,
): AsyncGenerator<T> {
  const stream = createReadStream(file, { encoding: 'utf8', highWaterMark });
  let pending = '';
  let lineNumber = 0;
  const parse = (line: string): T => {
    try { return JSON.parse(line) as T; }
    catch (cause) { throw new Error(`${file}:${lineNumber}: malformed NDJSON`, { cause }); }
  };
  try {
    for await (const chunk of stream) {
      pending += chunk as string;
      let start = 0;
      let end: number;
      while ((end = pending.indexOf('\n', start)) !== -1) {
        const line = pending.slice(start, end);
        lineNumber++;
        if (line.trim()) yield parse(line);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending.trim()) { lineNumber++; yield parse(pending); }
  } finally {
    stream.destroy();
  }
}
