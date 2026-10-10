/** Offline JSON copies only. No database driver, provider, subprocess, or network. */
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { sealPoly2Archive } from './poly2-archive.js';
import { canonical } from './poly2-snapshot.js';

const [snapshotPath, receiptPath, configPath, outputPath] = process.argv.slice(2);
if (process.argv.length !== 6 || !snapshotPath || !receiptPath || !configPath || !outputPath) throw new Error('usage: tsx src/compare/poly2-export-cli.ts <offline-snapshot.json> <capture-receipt.json> <frozen-config.json> <new-export.json>');
function safeFile(path: string): string {
  const target = realpathSync(path);
  if (!target.endsWith('.json') || target.startsWith('/opt/') || target.startsWith('/proc/') || target.startsWith('/dev/') || !statSync(target).isFile()) throw new Error('export: regular offline JSON copy required; production paths forbidden');
  return target;
}
const paths = [snapshotPath, receiptPath, configPath].map(safeFile);
const out = resolve(realpathSync(dirname(outputPath)), outputPath.split('/').at(-1)!);
if (!out.endsWith('.json') || out.startsWith('/opt/') || out.startsWith('/proc/') || out.startsWith('/dev/') || paths.includes(out)) throw new Error('export: distinct new offline JSON output required');
const [snapshot, captureReceipt, config] = paths.map(p => JSON.parse(readFileSync(p, 'utf8')));
const tool = createHash('sha256');
for (const name of ['poly2-snapshot.ts', 'poly2-archive.ts', 'poly2-export-cli.ts', 'phase4.ts']) tool.update(name).update(readFileSync(fileURLToPath(new URL(name, import.meta.url))));
const archive = sealPoly2Archive({ runId: config.runId, shadowRunId: config.shadowRunId, poly2CodeSha: config.poly2CodeSha,
  exportToolSha256: tool.digest('hex'), cohort: config.controlled, window: config.window, snapshot, captureReceipt });
writeFileSync(out, canonical(archive)+'\n', { flag: 'wx' });
console.log(JSON.stringify({ output: out, rowCount: archive.rows.length, outputSha256: createHash('sha256').update(readFileSync(out)).digest('hex'), completenessScope: archive.manifest.completenessScope, evidenceKind: archive.manifest.evidenceKind }));
