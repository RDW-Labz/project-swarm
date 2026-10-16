// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun } from '../tools/swarm.mjs';
import { readJournal } from '../tools/journal.mjs';

const exec = promisify(execFile);
const GH = 'gh' + 'p_' + 'a'.repeat(36);
const job = (n, overrides = {}) => ({ id: `job-${n}`, agent: 'ollama', model: 'test-model', prompt: `Update out/${n}.txt with the intended change.`, context: ['input.txt'], outputs: [`out/${n}.txt`], timeoutMs: 5000, ...overrides });
const manifest = (jobs, overrides = {}) => ({ version: 1, concurrency: 32, jobs, ...overrides });
const reply = files => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files }) } }), { headers: { 'content-type': 'application/json' } });
const worker = contents => async (_url, options) => {
  const n = Number(/out\/(\d+)\.txt/.exec(options.body)[1]);
  return reply([{ path: `out/${n}.txt`, content: contents[n] ?? `proposed ${n}\n` }]);
};
const commit = async (root, message) => {
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', message]);
};
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  await fs.writeFile(path.join(root, 'out/0.txt'), 'base 0\n');
  await exec('git', ['init', '-q', root]);
  await commit(root, 'fixture');
  return root;
}
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const exists = p => fs.access(p).then(() => true, () => false);
const rejectsWith = (promise, needle) => promise.then(
  () => assert.fail('expected integrateRun to reject'),
  e => {
    const s = `${e.code ?? ''} ${e.message ?? ''}`;
    assert.ok(s.includes(needle), s);
    assert.ok(!String(e.message ?? '').includes(GH));
    return e;
  });
const journalItems = async root => {
  const journal = await readJournal(root, { kinds: ['blocker'] });
  return Array.isArray(journal) ? journal : journal.items;
};

test('plain integrate blocks a planted token before any write and records a blocker and lesson', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  await rejectsWith(integrateRun(root, run.id, { noChecks: true }), 'security-gate-blocked');
  assert.equal(await read(root, 'out/0.txt'), 'base 0\n');
  const items = await journalItems(root);
  assert.ok(items.some(i => String(i.id).startsWith(`security-${run.id}-`)));
  const lines = (await read(root, '.swarm/project/security-lessons.ndjson')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(GH));
});

test('plain integrate of a clean job writes the proposed content and records no blocker', async t => {
  const root = await fixture(t);
  const text = 'clean change\n';
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: text }) });
  assert.equal(run.status, 'complete', run.error);
  await integrateRun(root, run.id, { noChecks: true });
  assert.equal(await read(root, 'out/0.txt'), text);
  const items = await journalItems(root);
  assert.equal(items.filter(i => String(i.id).startsWith(`security-${run.id}-`)).length, 0);
});

test('plain integrate blocks a go.mod change as unsupported-manifest and writes nothing', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0, { outputs: ['go.mod'], prompt: 'Update go.mod.' })]), { fetchImpl: async () => reply([{ path: 'go.mod', content: 'module example.invalid/x\n' }]) });
  assert.equal(run.status, 'complete', run.error);
  await rejectsWith(integrateRun(root, run.id, { noChecks: true }), 'unsupported-manifest');
  assert.equal(await exists(path.join(root, 'go.mod')), false);
});

test('a project profile with security disabled lets the planted secret through plain integrate', async t => {
  const root = await fixture(t);
  const profile = { version: 1, profile: { sensitive: false, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, security: { enabled: false } } };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify(profile, null, 2) + '\n');
  await commit(root, 'profile');
  const text = `token ${GH}\n`;
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: text }) });
  assert.equal(run.status, 'complete', run.error);
  await integrateRun(root, run.id, { noChecks: true });
  assert.equal(await read(root, 'out/0.txt'), text);
});

test('plain integrate refuses a made-up dependency change before any scanner runs and writes nothing', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await commit(root, 'package');
  const pkg = JSON.stringify({ dependencies: { 'definitely-not-real-pkg': '1.0.0' } }, null, 2) + '\n';
  const run = await runManifest(root, manifest([job(0, { outputs: ['package.json'], prompt: 'Add the dependency to package.json.' })]), { fetchImpl: async () => reply([{ path: 'package.json', content: pkg }]) });
  assert.equal(run.status, 'complete', run.error);
  const securityGate = {
    fetchImpl: async () => new Response('not found', { status: 404 }),
    exec: async argv => ({ exitCode: 0, stdout: argv[0] === 'osv-scanner' ? '{"results":[]}' : '', stderr: '' }),
  };
  await rejectsWith(integrateRun(root, run.id, { noChecks: true, securityGate }), 'Use integrate --queue');
  assert.equal(await read(root, 'package.json'), '{}\n');
});

test('integrateRun with jobs job-0 is gated too', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  await rejectsWith(integrateRun(root, run.id, { noChecks: true, jobs: ['job-0'] }), 'security-gate-blocked');
  assert.equal(await read(root, 'out/0.txt'), 'base 0\n');
});
