import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

it('Phase 4 never whole-file reads or split/parse-all NDJSON evidence', () => {
  for (const file of ['dashboard.ts', 'cli.ts']) {
    const source = readFileSync(join('src/compare', file), 'utf8');
    expect(source).not.toMatch(/readFileSync\((?:obsFile|rawFile|f),\s*['"]utf8['"]\)/);
    expect(source).not.toContain(".split('\\n')");
  }
  for (const file of ['evidence.ts', 'ndjson.ts']) {
    expect(readFileSync(join('src/compare', file), 'utf8')).not.toMatch(/readFile(?:Sync)?\s*\(/);
  }
});
