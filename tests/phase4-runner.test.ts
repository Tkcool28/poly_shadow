import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';

// Real Linux dummy children in TMPDIR scratch; never invokes npm start,
// production seal/run, Docker, PostgreSQL, network or application observers.
it('Phase4 isolated real-process lifecycle and fail-closed safety', () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const output = execFileSync('python3', [join(root, 'tests/phase4_runner_lifecycle.py')], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(output).toContain('PROOF real future wait/deadline: END_WINDOW_COMPLETE');
  expect(output).toContain('PROOF report transaction:');
  expect(output).toContain('PROOF fixed end:');
  expect(output).toContain('PROOF missing evidence: FAILED phase, exit 1');
  expect(output).toContain('PROOF near-end SIGINT:');
  expect(output).toContain('PROOF near-end SIGTERM:');
  expect(output).toContain('PROOF identity capture failure:');
  expect(output).toContain('PROOF SIGTERM:');
  expect(output).toContain('PROOF SIGKILL runner:');
}, 65_000);
