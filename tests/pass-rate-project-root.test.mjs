// SPDX-License-Identifier: Apache-2.0

import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateProject, unroutableJobs } from '../tools/swarm.mjs';

const lanes = {
  cursor: { model: 'composer-2.5' },
  codex: { model: 'gpt-6.1-sol' },
  anthropic: { model: 'claude-haiku-5-5' },
  claude: { model: 'sonnet', midModel: 'sonnet', expensiveModel: 'opus' },
};

const env = { HOME: os.tmpdir(), PATH: process.env.PATH };

function writeClaudeFailureRuns(root, count) {
  for (let index = 0; index < count; index += 1) {
    const dir = path.join(root, '.swarm', 'runs', `fail-${index}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'state.json'),
      `${JSON.stringify({ jobs: [{ agent: 'claude', status: 'failed' }] })}\n`,
      'utf8',
    );
  }
}

async function tempProject() {
  const root = await fs.promises.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'pass-rate-root-'));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: root });
  await fs.promises.mkdir(path.join(root, 'src'), { recursive: true });
  return root;
}

function expensiveAutoManifest() {
  return {
    version: 1,
    lanes,
    jobs: [{
      id: 'T-expensive',
      agent: 'auto',
      tier: 'expensive',
      tierReason: 'test fixture',
      prompt: 'build it',
      context: [],
      outputs: ['src/out.ts'],
      acceptance: ['it works'],
    }],
  };
}

test('validateProject ignores cwd pass-rate failures when routing for a different project root', async t => {
  const cwdPollution = await fs.promises.mkdtemp(path.join(process.env.SWARM_TEST_TMP || os.tmpdir(), 'pass-rate-cwd-'));
  writeClaudeFailureRuns(cwdPollution, 6);
  const projectRoot = await tempProject();
  t.after(async () => {
    await fs.promises.rm(cwdPollution, { recursive: true, force: true });
    await fs.promises.rm(projectRoot, { recursive: true, force: true });
  });

  const priorCwd = process.cwd();
  process.chdir(cwdPollution);
  t.after(() => process.chdir(priorCwd));

  const result = await validateProject(projectRoot, expensiveAutoManifest(), { env });
  assert.equal(result.routes[0].agent, 'claude');
  assert.equal(result.routes[0].model, 'opus');
});

test('validateProject exhausts claude when failures live in the project root', async t => {
  const projectRoot = await tempProject();
  writeClaudeFailureRuns(projectRoot, 6);
  t.after(async () => fs.promises.rm(projectRoot, { recursive: true, force: true }));

  const bad = await unroutableJobs(projectRoot, expensiveAutoManifest(), { env });
  assert.deepEqual(bad.map(entry => entry.id), ['T-expensive']);
  assert.match(bad[0].reason, /route-exhausted/);
});
