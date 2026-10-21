// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateManifest,
  validateProject,
  runManifest,
  resumeRun,
} from '../tools/swarm.mjs';
import {
  formatUncoveredTestReferencesError,
  ignoreTestsPromptLineCoversTest,
  ignoreTestsReasonCoversJob,
} from '../tools/swarm/core-31.mjs';

const job = (overrides = {}) => ({
  id: 'writer',
  agent: 'claude',
  model: 'sonnet',
  prompt: 'Update the assigned file.',
  context: ['input.txt'],
  outputs: ['input.txt'],
  timeoutMs: 5000,
  ...overrides,
});
const manifest = jobs => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()] });
const ignorePaths = n => Array.from({ length: n }, (_, i) => `tests/ignore-${i}.test.mjs`);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ignore-tests-reason-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function widgetFixture(t) {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'widget.mjs'), 'export const widget = 1;');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'widget.test.mjs'), "import { widget } from '../widget.mjs';");
  return root;
}

test('100 ignoreTests entries without ignoreTestsReason pass validateManifest', () => {
  assert.doesNotThrow(() => validateManifest(manifest([job({ ignoreTests: ignorePaths(100) })])));
});

test('101 ignoreTests without ignoreTestsReason fail with the legacy cap message', () => {
  assert.throws(
    () => validateManifest(manifest([job({ ignoreTests: ignorePaths(101) })])),
    /ignoreTests must be an array of at most 100 files/,
  );
});

test('101 ignoreTests with a valid ignoreTestsReason pass', () => {
  assert.doesNotThrow(() => validateManifest(manifest([job({
    ignoreTests: ignorePaths(101),
    ignoreTestsReason: 'ticket output is imported by many unrelated tests',
  })])));
});

test('1000 ignoreTests with ignoreTestsReason pass and 1001 fail', () => {
  assert.doesNotThrow(() => validateManifest(manifest([job({
    ignoreTests: ignorePaths(1000),
    ignoreTestsReason: 'bulk ignore for ticket-manifest wiring',
  })])));
  assert.throws(
    () => validateManifest(manifest([job({
      ignoreTests: ignorePaths(1001),
      ignoreTestsReason: 'bulk ignore for ticket-manifest wiring',
    })])),
    /at most 1000 files/,
  );
});

test('ignoreTestsReason without ignoreTests is rejected', () => {
  assert.throws(
    () => validateManifest(manifest([job({ ignoreTestsReason: 'needs a list' })])),
    /ignoreTestsReason requires an ignoreTests array/,
  );
});

test('empty, overlong, and non-string ignoreTestsReason values are rejected', () => {
  for (const reason of ['', '   ', 5, 'x'.repeat(201)]) {
    assert.throws(
      () => validateManifest(manifest([job({ ignoreTests: ['tests/a.test.mjs'], ignoreTestsReason: reason })])),
      /ignoreTestsReason/,
    );
  }
});

test('ignoreTestsReason satisfies uncovered coverage without per-test prompt lines', async t => {
  const root = await widgetFixture(t);
  const manifestDoc = manifest([job({
    context: [],
    outputs: ['widget.mjs'],
    ignoreTests: ['tests/widget.test.mjs'],
    ignoreTestsReason: 'coordinator runs unrelated widget tests after integration',
  })]);
  assert.equal((await validateProject(root, manifestDoc)).status, 'valid');
});

test('per-test ignoreTests prompt lines still satisfy uncovered coverage', async t => {
  const root = await widgetFixture(t);
  const prompt = "Update widget.mjs.\nignoreTests: tests/widget.test.mjs — Existing test is outside this job's declared outputs; the coordinator runs it after integration.";
  const manifestDoc = manifest([job({ context: [], outputs: ['widget.mjs'], ignoreTests: ['tests/widget.test.mjs'], prompt })]);
  assert.equal((await validateProject(root, manifestDoc)).status, 'valid');
  assert.ok(ignoreTestsPromptLineCoversTest(prompt, 'tests/widget.test.mjs'));
});

test('formatUncoveredTestReferencesError prints ignoreTestsReason when the job carries it', () => {
  const jobs = [{ id: 'writer', ignoreTestsReason: 'bulk wiring reason' }];
  const message = formatUncoveredTestReferencesError([{ job: 'writer', output: 'widget.mjs', test: 'tests/widget.test.mjs' }], jobs);
  assert.match(message, /ignoreTestsReason: bulk wiring reason/);
  assert.ok(ignoreTestsReasonCoversJob(jobs[0]));
});

test('a job without ignoreTestsReason is unchanged for validateManifest', () => {
  const base = job({ ignoreTests: ['tests/a.test.mjs'] });
  assert.doesNotThrow(() => validateManifest(manifest([base])));
  assert.equal('ignoreTestsReason' in base, false);
});

test('ignoreTestsReason survives save and resume of a run', async t => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'ignore-tests-reason-resume-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'tests', 'extra.test.mjs'), 'export {};');
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  const options = { env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
  const calls = [];
  const fetchImpl = async (_url, request) => {
    const n = Number(/out\/(\d+)\.txt/.exec(request.body)[1]);
    calls.push(n);
    return new Response(JSON.stringify({
      done: true,
      done_reason: 'stop',
      prompt_eval_count: 60,
      eval_count: 40,
      message: { content: JSON.stringify({ summary: 'done', files: [{ path: `out/${n}.txt`, content: `output ${n}\n` }] }) },
    }), { headers: { 'content-type': 'application/json' } });
  };
  const workerJob = (n, extra = {}) => ({
    id: `job-${n}`,
    agent: 'ollama',
    model: 'test-model',
    prompt: `Write out/${n}.txt`,
    context: ['input.txt'],
    outputs: [`out/${n}.txt`],
    timeoutMs: 5000,
    ...extra,
  });
  const spec = {
    version: 1,
    concurrency: 1,
    budget: { maxTokens: 250 },
    jobs: [
      workerJob(0, {
        ignoreTests: ['tests/extra.test.mjs'],
        ignoreTestsReason: 'resume check',
      }),
      workerJob(1),
      workerJob(2),
      workerJob(3),
    ],
  };
  const paused = await runManifest(root, spec, { ...options, fetchImpl });
  assert.equal(paused.status, 'paused', JSON.stringify(paused.jobs?.map(j => j.status)));
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', paused.id, 'manifest.json'), 'utf8'));
  assert.equal(saved.jobs[0].ignoreTestsReason, 'resume check');
  const resumed = await resumeRun(root, paused.id, {
    ...options,
    fetchImpl,
    raises: [{ key: 'maxTokens', value: 1000 }],
    reason: 'finish approved work',
  });
  assert.equal(resumed.status, 'complete');
  const afterResume = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', paused.id, 'manifest.json'), 'utf8'));
  assert.equal(afterResume.jobs[0].ignoreTestsReason, 'resume check');
});

test('swarm validate accepts a manifest with ignoreTestsReason and returns it on the job', async t => {
  const root = await widgetFixture(t);
  const result = await validateProject(root, manifest([job({
    context: [],
    outputs: ['widget.mjs'],
    ignoreTests: ['tests/widget.test.mjs'],
    ignoreTestsReason: 'shown on validate output',
  })]));
  assert.equal(result.status, 'valid');
  assert.equal(result.jobs[0].ignoreTestsReason, 'shown on validate output');
  assert.deepEqual(result.jobs[0].ignoreTests, ['tests/widget.test.mjs']);
});
