// SPDX-License-Identifier: Apache-2.0
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TEST_FILES = [
  'tests/concurrency-guard.test.mjs',
  'tests/handbuild-hook-hardening.test.mjs',
  'tests/field-lessons-batch-m2.test.mjs',
  'tests/local-lane-review.test.mjs',
  'tests/lane-health-core.test.mjs',
  'tests/lane-health-persist.test.mjs',
  'tests/server-restart-round4.test.mjs',
  'tests/cpu-runner.test.mjs',
].map(f => path.join(repoRoot, f));

const rounds = Math.max(1, parseInt(process.env.STRESS_ROUNDS ?? '5', 10) || 5);
const concurrency = Math.max(1, parseInt(process.env.STRESS_CONCURRENCY ?? '8', 10) || 8);

function tailLines(text, max = 200) {
  const lines = String(text ?? '').split('\n');
  if (lines.length <= max) return lines.join('\n');
  return lines.slice(-max).join('\n');
}

for (let i = 1; i <= rounds; i++) {
  const start = Date.now();
  const result = spawnSync(
    process.execPath,
    [
      '--import',
      path.join(repoRoot, 'tests/_isolate-config.mjs'),
      '--test',
      '--test-timeout=600000',
      `--test-concurrency=${concurrency}`,
      ...TEST_FILES,
    ],
    { cwd: repoRoot, encoding: 'utf8', env: process.env },
  );
  const ms = Date.now() - start;
  const ok = result.status === 0;
  console.log(`stress round ${i}/${rounds} (concurrency ${concurrency}): ${ok ? 'pass' : 'fail'} (${ms} ms)`);
  if (!ok) {
    if (result.stdout) {
      console.error('--- stdout (tail) ---');
      console.error(tailLines(result.stdout));
    }
    if (result.stderr) {
      console.error('--- stderr (tail) ---');
      console.error(tailLines(result.stderr));
    }
    if (result.error) console.error(result.error);
    process.exit(1);
  }
}

console.log(`test:stress: ${rounds} rounds passed`);
