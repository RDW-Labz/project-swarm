// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, validateProject } from '../tools/swarm.mjs';
import { protectedViolations } from '../tools/init-profile.mjs';

const exec = promisify(execFile);
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const job = (extra = {}) => ({ id: 'job-0', agent: 'ollama', model: 'test-model', prompt: 'Write out/0.txt', context: ['input.txt', '.env.example'], outputs: ['out/0.txt'], timeoutMs: 5000, ...extra });

async function fixture(t, protectedPaths = ['.env', '.env.example', '.env.local']) {
  const temp = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-envex-')));
  const root = path.join(temp, 'repo');
  await fs.mkdir(root);
  t.after(() => fs.rm(temp, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'original\n');
  await fs.writeFile(path.join(root, '.env.example'), 'DATABASE_URL=\nSTRIPE_KEY=\n');
  await fs.writeFile(path.join(root, '.env'), 'DATABASE_URL=postgres://real-secret\n');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n.env\n');
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ version: 1, profile: { sensitive: true, protectedPaths, budget: { maxUsd: 5 }, baseCheck: { status: 'none' } } }));
  await fs.writeFile(path.join(temp, 'config.json'), '{}');
  await exec('git', ['init', '-q', root]);
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'i']);
  return { root, env: { ...process.env, SWARM_CONFIG: path.join(temp, 'config.json'), SWARM_SPEND_DIR: path.join(temp, 'spend') }, liveDir: path.join(temp, 'live') };
}

test('lesson 54: a protected .env.example is readable context, so a wave that lists it can start; it is still never writable', async t => {
  const f = await fixture(t);
  const profile = { protectedPaths: ['.env', '.env.example'] };
  assert.deepEqual(protectedViolations(profile, [{ id: 'a', context: ['.env.example'], outputs: ['src/a.ts'] }]), []);
  assert.equal(protectedViolations(profile, [{ id: 'a', context: ['.env.example'], outputs: ['.env.example'] }]).length, 1, 'writing the template is still refused');
  assert.equal(protectedViolations(profile, [{ id: 'a', context: ['.env'], outputs: ['src/a.ts'] }]).length, 1, 'a real .env is never readable');
  assert.equal(protectedViolations(profile, [{ id: 'a', context: ['.env.local'], outputs: ['src/a.ts'] }]).length, 0, 'not protected by name here');
  await validateProject(f.root, { version: 1, jobs: [job({ prompt: 'p' })] });
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job({ context: ['input.txt', '.env'] })] }), /protected-path|Reserved or secret/);
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job({ outputs: ['.env.example'] })] }), /protected-path|Reserved or secret/);
});

test('lesson 54: the run itself reads the template into the worker (names only), never the real .env', async t => {
  const f = await fixture(t);
  let prompt = '';
  const state = await runManifest(f.root, { version: 1, concurrency: 1, jobs: [job()] }, { ...f, fetchImpl: async (_url, request) => { prompt = request.body; return reply({ done: true, done_reason: 'stop', usage: { prompt_tokens: 60, completion_tokens: 40, total_tokens: 100 }, message: { content: JSON.stringify({ summary: 'done', files: [{ path: 'out/0.txt', content: 'x' }] }) } }); } });
  assert.equal(state.status, 'complete', `${state.error} ${JSON.stringify(state.jobs.map(j => [j.status, j.error]))}`);
  assert.match(prompt, /DATABASE_URL/, 'the worker saw the template');
  assert.doesNotMatch(prompt, /real-secret/);
});

test('lesson 54: a symlink named like the template that leads to the real .env is still refused', async t => {
  const f = await fixture(t);
  await fs.rm(path.join(f.root, '.env.example'));
  await fs.symlink('.env', path.join(f.root, '.env.example'));
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job()] }), /protected-path|Symlink|Reserved|secret|resolves/);
});

test('review fixes: a template that holds a real-looking secret value is not handed to a worker; a link from the template name to another secret is refused', async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.env.example'), `STRIPE_KEY=${['sk', 'live', '51H8aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abcdefgh'].join('_')}\n`);
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job()] }), /real secret value|protected-path/);
  await fs.writeFile(path.join(f.root, '.env.example'), 'STRIPE_KEY=\nPORT=3000\n');
  await validateProject(f.root, { version: 1, jobs: [job()] });
  await fs.writeFile(path.join(f.root, '.env.local'), 'X=1\n');
  await fs.rm(path.join(f.root, '.env.example'));
  await fs.symlink('.env.local', path.join(f.root, '.env.example'));
  await assert.rejects(validateProject(f.root, { version: 1, jobs: [job()] }), /link to the secret|protected-path|Symlink|Reserved/);
});
