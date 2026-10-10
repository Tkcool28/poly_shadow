/** Explicit offline spool worker. No DB/client imports, timers or trading controls. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readNdjson } from './ndjson.js';
import { ProspectiveCapture, type Binding, type SourceFrame } from './poly2-prospective.js';

const [, , bindingPath, sourceDir, captureDir, archivePath] = process.argv;
if (!bindingPath || !sourceDir || !captureDir) throw new Error('usage: worker <frozen-binding.json> <immutable-source-spool-dir> <capture-dir> [sealed-archive.json]');
const binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as Binding;
const capture = new ProspectiveCapture(captureDir, binding);
let sourceReadComplete = false;
try {
  const sourceHealthPath = join(sourceDir, 'source_capture_health.json');
  if (existsSync(sourceHealthPath)) {
    const health = JSON.parse(readFileSync(sourceHealthPath, 'utf8'));
    if (health.state === 'FAILED' || health.quality === 'AT_RISK') throw new Error('source capture failure: ' + health.error);
  }
  for await (const frame of readNdjson<SourceFrame>(join(sourceDir, 'poly2_source_receipts.ndjson'))) {
    capture.accept(frame);
  }
  sourceReadComplete = true;
  if (archivePath) {
    if (!capture.health().endCoverage) throw new Error('INCOMPLETE: terminal visibility/drain authority unavailable; reader remains recoverable');
    capture.sealToFile(archivePath);
    ProspectiveCapture.validateFile(archivePath, binding.cohort, binding.window, binding.evidenceKind === 'synthetic', binding);
  }
  console.log(JSON.stringify(capture.health()));
} catch (error) {
  if (!sourceReadComplete && capture.health().state !== 'FAILED' && capture.health().state !== 'SEALED') {
    try { capture.gap('source-worker', String(error)); } catch { /* sink may itself be unavailable */ }
  }
  console.error(JSON.stringify({ ...capture.health(), error: String(error) }));
  process.exitCode = 2;
} finally {capture.close();}
