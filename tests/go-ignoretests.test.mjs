// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, readState, validateProject } from '../tools/swarm.mjs';

const exec = promisify(execFile);
const lead = (letter, area = {}) => ({ id: `lead-${letter}`, agent: 'ollama', model: 'test-model', type: 'lead', prompt: `Plan area ${letter}`, context: ['input.txt'], outputs: [`plans/${letter}.json`], area: { goal: `Document area ${letter}`, scope: ['docs/'], agents: ['ollama'], concurrency: 4, ...area } });
const worker = { id: 'worker-0', agent: 'ollama', model: 'test-model', prompt: 'Write docs/notes.md', context: ['input.txt'], outputs: ['docs/notes.md'] };
const manifest = jobs => ({ version: 1, concurrency: 5, jobs });
const reply = (file, content) => new Response(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 60, eval_count: 40, message: { content: JSON.stringify({ summary: 'done', files: [{ path: file, content }] }) } }), { headers: { 'content-type': 'application/json' } });

async function fixture(t) {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ignoretests-'));
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  const root = path.join(temp, 'repo');
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original input\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await fs.writeFile(path.join(root, 'docs/notes.md'), '# notes\n');
  await fs.writeFile(path.join(root, 'tests/notes.test.mjs'), "import fs from 'node:fs';\nfs.readFileSync('docs/notes.md', 'utf8');\n");
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'fixture']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}

function fetchFor() {
  return async (_url, request) => {
    const text = JSON.stringify(JSON.parse(request.body));
    if (/Plan area a/.test(text)) return reply('plans/a.json', JSON.stringify({ version: 1, jobs: [worker] }));
    return reply('docs/notes.md', '# notes\nupdated\n');
  };
}

test('lead child with a cross-referenced test completes with ignoreTests', async t => {
  const options = await fixture(t);
  const state = await runManifest(options.root, manifest([lead('a')]), { ...options, fetchImpl: fetchFor() });
  assert.equal(state.jobs[0].status, 'complete', JSON.stringify(state));
  assert.ok(state.jobs[0].childRun);
  const child = await readState(options.root, state.jobs[0].childRun);
  assert.equal(child.status, 'complete', JSON.stringify(child.jobs.map(j => j.error)));
  assert.equal(child.jobs.length, 1);
});

test('a person-written manifest still refuses an uncovered test reference', async t => {
  const options = await fixture(t);
  const job = { id: 'worker-0', agent: 'ollama', model: 'test-model', prompt: 'Write docs/notes.md', context: ['input.txt'], outputs: ['docs/notes.md'] };
  await assert.rejects(validateProject(options.root, manifest([job]), { env: options.env }), /Uncovered test references/);
});
