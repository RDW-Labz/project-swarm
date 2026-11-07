// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertTestIsolation } from '../tools/test-isolation.mjs';
import { lanesDir } from '../tools/lanes.mjs';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const lanesModule = pathToFileURL(path.join(repoRoot, 'tools/lanes.mjs')).href;

function minimalRunnerEnv(extra = {}) {
  return { PATH: process.env.PATH, HOME: process.env.HOME, ...extra };
}

function runNodeTest({ testFile, importHook, envExtra = {} }) {
  const args = [];
  if (importHook) args.push('--import', importHook);
  args.push('--test', testFile);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env: minimalRunnerEnv(envExtra),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr, combined: `${stdout}\n${stderr}` }));
  });
}

async function writeLanesProbe(dir) {
  const file = path.join(dir, 'lanes-probe.test.mjs');
  const source = `import test from 'node:test';
import { lanesDir } from '${lanesModule}';

test('lanesDir without suite isolation', () => {
  lanesDir();
});
`;
  await fs.promises.writeFile(file, source);
  return file;
}

test('node --test without isolate import fails on real lane path fallback', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swarm-isolation-probe-'));
  try {
    const testFile = await writeLanesProbe(dir);
    const result = await runNodeTest({ testFile });
    assert.notEqual(result.code, 0);
    assert.match(result.combined, /test-not-isolated: lane claims/);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('node --test with isolate import passes lanesDir probe', async () => {
  const tmpBase = process.env.SWARM_TEST_TMP || os.tmpdir();
  const dir = await fs.promises.mkdtemp(path.join(tmpBase, 'swarm-isolation-probe-'));
  try {
    const testFile = await writeLanesProbe(dir);
    const result = await runNodeTest({
      testFile,
      importHook: './tests/_isolate-config.mjs',
      envExtra: { TMPDIR: dir },
    });
    assert.equal(result.code, 0, result.combined);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('explicit SWARM_LANES_DIR bypasses isolation guard under node --test', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swarm-isolation-probe-'));
  const lanesOverride = path.join(dir, 'lanes');
  await fs.promises.mkdir(lanesOverride, { recursive: true });
  try {
    const testFile = await writeLanesProbe(dir);
    const result = await runNodeTest({
      testFile,
      envExtra: { SWARM_LANES_DIR: lanesOverride },
    });
    assert.equal(result.code, 0, result.combined);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('assertTestIsolation is a no-op outside node --test', () => {
  assert.doesNotThrow(() => assertTestIsolation('probe', { HOME: '/tmp/x' }));
});

test('assertTestIsolation is a no-op when SWARM_TEST_ISOLATED is set', () => {
  assert.doesNotThrow(() =>
    assertTestIsolation('probe', {
      NODE_TEST_CONTEXT: 'child',
      SWARM_TEST_ISOLATED: '1',
      HOME: process.env.HOME,
    }),
  );
});

test('assertTestIsolation throws under node --test without isolation', () => {
  assert.throws(
    () => assertTestIsolation('probe', { NODE_TEST_CONTEXT: 'child', HOME: process.env.HOME }),
    /test-not-isolated: probe/,
  );
});

test('lanesDir in isolated suite does not throw', () => {
  assert.doesNotThrow(() => lanesDir());
});
