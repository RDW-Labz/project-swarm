// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { assertTestIsolation } from '../tools/test-isolation.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('assertTestIsolation throws in node --test without SWARM_TEST_ISOLATED', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-isolation-probe-'));
  const probe = path.join(tmpDir, 'probe.test.mjs');
  fs.writeFileSync(
    probe,
    `import test from 'node:test';\nimport { assertTestIsolation } from '${path.join(root, 'tools/test-isolation.mjs')}';\ntest('probe', () => assertTestIsolation('probe resource'));\n`,
  );
  const failEnv = { ...process.env };
  delete failEnv.SWARM_TEST_ISOLATED;
  delete failEnv.NODE_TEST_CONTEXT;
  const failRun = spawnSync(process.execPath, ['--test', probe], {
    encoding: 'utf8',
    env: failEnv,
  });
  assert.notEqual(failRun.status, 0);
  assert.match(`${failRun.stdout}${failRun.stderr}`, /test-not-isolated/);
  assert.match(`${failRun.stdout}${failRun.stderr}`, /probe resource/);
});

test('assertTestIsolation succeeds in node --test with SWARM_TEST_ISOLATED', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-isolation-probe-'));
  const probe = path.join(tmpDir, 'probe-ok.test.mjs');
  fs.writeFileSync(
    probe,
    `import test from 'node:test';\nimport { assertTestIsolation } from '${path.join(root, 'tools/test-isolation.mjs')}';\ntest('probe', () => assertTestIsolation('probe resource'));\n`,
  );
  const okEnv = { ...process.env, SWARM_TEST_ISOLATED: '1' };
  delete okEnv.NODE_TEST_CONTEXT;
  const okRun = spawnSync(process.execPath, ['--test', probe], {
    encoding: 'utf8',
    env: okEnv,
  });
  assert.equal(okRun.status, 0);
});

test('package.json test script imports isolation setup', () => {
  const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.test, /--import \.\/tests\/_isolate-config\.mjs/);
});

test('CI workflow runs npm test', () => {
  const ci = readFileSync(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  assert.match(ci, /npm test/);
});

test('assertTestIsolation never throws when NODE_TEST_CONTEXT is unset', () => {
  assertTestIsolation('anything', { SWARM_TEST_ISOLATED: undefined });
  assertTestIsolation('anything', {});
});
