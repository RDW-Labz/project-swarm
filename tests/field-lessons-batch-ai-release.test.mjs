// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { scaffoldJob } from '../tools/scaffold.mjs';
import { auditIntegratedTree } from '../tools/integration-audit.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-ai-release-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.49.0' }));
  await fs.mkdir(path.join(root, 'tests'), { recursive: true });
  await fs.writeFile(path.join(root, 'tests/active-release.test.mjs'), "assert.equal(version, '1.49.0');\n");
  await fs.writeFile(path.join(root, 'tests/other-release.test.mjs'), "assert.match(text, /1\\.49\\.0/);\n");
  await fs.writeFile(path.join(root, 'release-prompt.md'), 'Release job: bump package.json version from 1.49.0 to 1.50.0.\n');
  return root;
}

const releaseOptions = {
  id: 'release', agent: 'claude', model: 'sonnet', tier: 'mid',
  context: ['package.json'], outputs: ['package.json', 'CHANGELOG.md'],
  promptFile: 'release-prompt.md',
};

// Failing-first evidence: this file was run before implementation; it failed on the missing
// integration-audit module, then exposed the missing release-version guard after that module existed.
describe('lessons 371 and 380: release and integrated-tree gates', () => {
  test('371: a version-bump scaffold finds every old active-version test and requires the full suite', async t => {
    const root = await fixture(t);
    const projectFiles = ['package.json', 'tests/active-release.test.mjs', 'tests/other-release.test.mjs'];
    const result = await scaffoldJob(root, releaseOptions, {
      validateManifest: manifest => manifest,
      validateProject: async () => ({ status: 'valid' }),
      listProjectFiles: async () => projectFiles,
      findUncoveredTests: async () => [],
    });
    assert.equal(result.status, 'ok', JSON.stringify(result));
    const manifest = JSON.parse(await fs.readFile(path.join(root, result.file), 'utf8'));
    const [job] = manifest.jobs;
    assert.deepEqual(job.ignoreTests, ['tests/active-release.test.mjs', 'tests/other-release.test.mjs']);
    assert.match(job.prompt, /ignoreTests: tests\/active-release\.test\.mjs.*Active release version assertion/s);
    assert.match(job.prompt, /ignoreTests: tests\/other-release\.test\.mjs.*Active release version assertion/s);
    assert.deepEqual(manifest.checks, [{ name: 'full-suite', argv: ['npm', 'test'] }]);
  });

  test('380: undeclared edits block with the complete file list; a reported check is rerun on the integrated tree', async () => {
    const reruns = [];
    const blocked = await auditIntegratedTree({
      root: '/fixture/integrated',
      declaredOutputs: ['src/main.js'],
      workspaceEdits: ['src/main.js', 'src/helper.js', 'tests/helper.test.mjs'],
      reportedCheck: { argv: ['npm', 'test'], status: 'passed' },
      runCheck: async () => { reruns.push('should-not-run'); return { status: 'passed' }; },
    });
    assert.equal(blocked.status, 'blocked');
    assert.equal(blocked.code, 'undeclared-edit');
    assert.deepEqual(blocked.undeclaredEdits, ['src/helper.js', 'tests/helper.test.mjs']);
    assert.match(blocked.reason, /undeclared-edit.*src\/helper\.js.*tests\/helper\.test\.mjs/s);
    assert.match(blocked.reason, /accept|salvage/i);
    assert.deepEqual(reruns, []);

    const calls = [];
    const mismatch = await auditIntegratedTree({
      root: '/fixture/integrated',
      declaredOutputs: ['src/main.js'],
      workspaceEdits: ['src/main.js'],
      reportedCheck: { argv: ['npm', 'test'], status: 'passed' },
      runCheck: async (argv, options) => {
        calls.push({ argv, options });
        return { status: 'failed', exitCode: 1, tail: 'assertion failed' };
      },
    });
    assert.equal(mismatch.status, 'refused');
    assert.equal(mismatch.code, 'integrated-check-mismatch');
    assert.deepEqual(calls, [{ argv: ['npm', 'test'], options: { cwd: '/fixture/integrated' } }]);
    assert.match(mismatch.reason, /npm test/);
    assert.match(mismatch.reason, /assertion failed/);
  });
});
