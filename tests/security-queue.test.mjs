// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runManifest, integrateRun, integrateQueue } from '../tools/swarm.mjs';
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
async function fixture(t, count = 1) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-security-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'out'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input\n');
  for (let n = 0; n < count; n++) await fs.writeFile(path.join(root, `out/${n}.txt`), `base ${n}\n`);
  await exec('git', ['init', '-q', root]);
  await commit(root, 'fixture');
  return root;
}
const read = (root, file) => fs.readFile(path.join(root, file), 'utf8');
const exists = p => fs.access(p).then(() => true, () => false);
const writeProfile = async (root, sensitive) => {
  const profile = { version: 1, profile: { sensitive, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] } } };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify(profile, null, 2) + '\n');
  await commit(root, 'profile');
};
const recorder = (calls, semgrep = { results: [] }) => async argv => {
  calls.push(argv);
  if (argv[0] === 'osv-scanner') return { exitCode: 0, stdout: '{"results":[]}', stderr: '' };
  if (argv[0] === 'semgrep' && argv[1] === '--config') return { exitCode: 0, stdout: JSON.stringify(semgrep), stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};
const MARKER_CHECK = [{ name: 'marker', argv: ['node', '-e', "require('fs').writeFileSync('ran.marker','x')"] }];

test('a planted github token blocks the job, rolls back and records a lesson', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true });
  assert.equal(await read(root, 'out/0.txt'), 'base 0\n');
  assert.deepEqual(result.mergeQueue.checkFailed, [{ job: 'job-0', checks: ['security-gate'] }]);
  assert.equal(result.mergeQueue.securityBlocked.length, 1);
  const entry = result.mergeQueue.securityBlocked[0];
  assert.equal(entry.job, 'job-0');
  assert.ok(entry.blocks.some(b => b.check === 'secret-scan'));
  assert.ok(!JSON.stringify(entry).includes(GH));
  const journal = await readJournal(root, { kinds: ['blocker'] });
  const items = Array.isArray(journal) ? journal : journal.items;
  const item = items.find(i => i.id.startsWith(`security-${run.id}-job-0`));
  assert.ok(item);
  assert.ok(!item.text.includes(GH));
  const lines = (await read(root, '.swarm/project/security-lessons.ndjson')).trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).stage, 'merge');
  assert.ok(!lines[0].includes(GH));
});

test('only the bad job is blocked when a batch bisects', async t => {
  const root = await fixture(t, 2);
  const run = await runManifest(root, manifest([job(0), job(1)]), { fetchImpl: worker({ 1: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true });
  assert.deepEqual(result.mergeQueue.integrated, ['job-0']);
  assert.equal(result.mergeQueue.securityBlocked[0].job, 'job-1');
  assert.equal(await read(root, 'out/0.txt'), 'proposed 0\n');
  assert.equal(await read(root, 'out/1.txt'), 'base 1\n');
});

test('integrateQueue reports security-blocked jobs with partial status', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateQueue(root, run.id, {});
  assert.equal(result.status, 'partial');
  assert.deepEqual(result.securityBlocked.map(e => e.job), ['job-0']);
});

test('a clean job integrates and prose mentioning a password is not blocked', async t => {
  const root = await fixture(t);
  const text = 'The password policy requires rotation every 90 days.\n';
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: text }) });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true });
  assert.deepEqual(result.mergeQueue.securityBlocked, []);
  assert.equal(await read(root, 'out/0.txt'), text);
});

test('a project profile with security disabled lets the planted secret through', async t => {
  const root = await fixture(t);
  const profile = { version: 1, profile: { sensitive: false, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, security: { enabled: false } } };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify(profile, null, 2) + '\n');
  await commit(root, 'profile');
  const text = `token ${GH}\n`;
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: text }) });
  assert.equal(run.status, 'complete', run.error);
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true });
  assert.deepEqual(result.mergeQueue.securityBlocked, []);
  assert.equal(await read(root, 'out/0.txt'), text);
});

async function depRun(t) {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await commit(root, 'package');
  const pkg = JSON.stringify({ dependencies: { 'definitely-not-real-pkg': '1.0.0' } }, null, 2) + '\n';
  const run = await runManifest(root, manifest([job(0, { outputs: ['package.json'], prompt: 'Add the dependency to package.json.' })]), { fetchImpl: async () => reply([{ path: 'package.json', content: pkg }]) });
  assert.equal(run.status, 'complete', run.error);
  return { root, run, pkg };
}

test('a made-up dependency is blocked by package-check and a real one passes', async t => {
  const exec0 = async argv => ({ exitCode: 0, stdout: argv[0] === 'osv-scanner' ? '{"results":[]}' : '', stderr: '' });
  const { root, run } = await depRun(t);
  const gate = { fetchImpl: async () => new Response('not found', { status: 404 }), exec: exec0 };
  const blocked = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: gate });
  assert.ok(blocked.mergeQueue.securityBlocked[0].blocks.some(b => b.check === 'package-check'));
  assert.equal(await read(root, 'package.json'), '{}\n');
  const registry = async url => {
    const body = String(url).includes('downloads') ? { downloads: 100000 } : { time: { created: new Date(Date.now() - 500 * 864e5).toISOString() }, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': { license: 'MIT' } } };
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  };
  const second = await depRun(t);
  const passed = await integrateRun(second.root, second.run.id, { queue: true, noChecks: true, securityGate: { fetchImpl: registry, exec: exec0 } });
  assert.deepEqual(passed.mergeQueue.securityBlocked, []);
  assert.equal(await read(second.root, 'package.json'), second.pkg);
});

test('a high npm audit vulnerability blocks the job with check vulnerability', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
  await commit(root, 'lockfiles');
  const pair = async () => reply([{ path: 'package.json', content: '{"name":"x"}\n' }, { path: 'package-lock.json', content: '{"lockfileVersion":3}\n' }]);
  const run = await runManifest(root, manifest([job(0, { outputs: ['package.json', 'package-lock.json'], prompt: 'Update the lockfiles.' })]), { fetchImpl: pair });
  assert.equal(run.status, 'complete', run.error);
  const audit = { metadata: { vulnerabilities: { high: 1, total: 1 } }, vulnerabilities: { 'left-pad': { name: 'left-pad', severity: 'high', via: [], range: '*', fixAvailable: false } } };
  const gate = { exec: async argv => argv[0] === 'npm' ? { exitCode: 1, stdout: JSON.stringify(audit), stderr: '' } : { exitCode: 0, stdout: '', stderr: '' } };
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: gate });
  assert.ok(result.mergeQueue.securityBlocked[0].blocks.some(b => b.check === 'vulnerability'));
});

test('the gate runs before project checks: a blocked batch runs no checks and is rolled back', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)], { checks: MARKER_CHECK }), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(run.status, 'complete', run.error);
  const calls = [];
  const result = await integrateRun(root, run.id, { queue: true, securityGate: { exec: recorder(calls) } });
  assert.equal(await exists(path.join(root, 'ran.marker')), false);
  assert.equal(await read(root, 'out/0.txt'), 'base 0\n');
  assert.equal(result.mergeQueue.securityBlocked.length, 1);
  const b = result.mergeQueue.batches.find(x => JSON.stringify(x).includes('job-0'));
  assert.equal(b.security, 'blocked');
});

test('a clean batch records security passed and then runs the project checks', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)], { checks: MARKER_CHECK }), { fetchImpl: worker({ 0: 'clean\n' }) });
  assert.equal(run.status, 'complete', run.error);
  const calls = [];
  const result = await integrateRun(root, run.id, { queue: true, securityGate: { exec: recorder(calls) } });
  assert.equal(await exists(path.join(root, 'ran.marker')), true);
  const b = result.mergeQueue.batches.find(x => JSON.stringify(x).includes('job-0'));
  assert.equal(b.security, 'passed');
});

test('queue securityNotes lists scanners that were skipped as not installed', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'package.json'), '{}\n');
  await fs.writeFile(path.join(root, 'package-lock.json'), '{}\n');
  await commit(root, 'lockfiles');
  const pair = async () => reply([{ path: 'package.json', content: '{"name":"x"}\n' }, { path: 'package-lock.json', content: '{"lockfileVersion":3}\n' }]);
  const run = await runManifest(root, manifest([job(0, { outputs: ['package.json', 'package-lock.json'], prompt: 'Update the lockfiles.' })]), { fetchImpl: pair });
  assert.equal(run.status, 'complete', run.error);
  const exec = async argv => {
    if (argv[0] === 'npm') throw new Error('ENOENT');
    return argv[0] === 'osv-scanner' ? { exitCode: 0, stdout: '{"results":[]}', stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };
  };
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: { exec } });
  assert.ok(result.mergeQueue.securityNotes.some(n => String(n).includes('npm not installed')));
});

test('sensitive project runs the local pinned semgrep with metrics off', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'clean\n' }) });
  assert.equal(run.status, 'complete', run.error);
  const calls = [];
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: { exec: recorder(calls) } });
  assert.deepEqual(result.mergeQueue.securityBlocked, []);
  const sg = calls.find(argv => argv[0] === 'semgrep' && argv[1] === '--config');
  assert.ok(sg, 'expected a local semgrep --config call');
  assert.ok(sg[2].endsWith('semgrep-local.yml'));
  assert.ok(sg.includes('--metrics=off'));
  assert.ok(!sg.includes('auto'));
});

test('a job writing go.mod is blocked by the queue as unsupported-manifest', async t => {
  const root = await fixture(t);
  const run = await runManifest(root, manifest([job(0, { outputs: ['go.mod'], prompt: 'Add go.mod.' })]), { fetchImpl: async () => reply([{ path: 'go.mod', content: 'module example.invalid/x\n' }]) });
  assert.equal(run.status, 'complete', run.error);
  const calls = [];
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: { exec: recorder(calls) } });
  assert.deepEqual(result.mergeQueue.checkFailed, [{ job: 'job-0', checks: ['security-gate'] }]);
  assert.equal(result.mergeQueue.securityBlocked.length, 1);
  assert.ok(result.mergeQueue.securityBlocked[0].blocks.some(b => b.check === 'unsupported-manifest'));
  const journal = await readJournal(root, { kinds: ['blocker'] });
  const items = (Array.isArray(journal) ? journal : journal.items).filter(i => i.id.startsWith('security-'));
  assert.ok(items.length > 0);
  assert.ok(items.every(i => i.text.length < 600));
});

test('a go.mod change is allowed when the profile security block lists go.mod in allowUnparsedManifests', async t => {
  const root = await fixture(t);
  const profile = { version: 1, profile: { sensitive: false, protectedPaths: [], budget: { maxUsd: 5 }, baseCheck: { status: 'none', ranAt: null, head: null, checks: [] }, security: { allowUnparsedManifests: ['go.mod'] } } };
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify(profile, null, 2) + '\n');
  await commit(root, 'profile');
  const text = 'module example.invalid/x\n';
  const run = await runManifest(root, manifest([job(0, { outputs: ['go.mod'], prompt: 'Add go.mod.' })]), { fetchImpl: async () => reply([{ path: 'go.mod', content: text }]) });
  assert.equal(run.status, 'complete', run.error);
  const calls = [];
  const result = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: { exec: recorder(calls) } });
  assert.deepEqual(result.mergeQueue.securityBlocked, []);
  assert.equal(await read(root, 'go.mod'), text);
});

test('security tickets are recorded only for a batch that stays integrated', async t => {
  const semgrep = { results: [{ check_id: 'demo.rule', path: 'out/0.txt', start: { line: 1 }, extra: { severity: 'ERROR' } }] };
  const root = await fixture(t);
  await writeProfile(root, false);
  const run = await runManifest(root, manifest([job(0)]), { fetchImpl: worker({ 0: 'clean\n' }) });
  assert.equal(run.status, 'complete', run.error);
  const ok = await integrateRun(root, run.id, { queue: true, noChecks: true, securityGate: { exec: recorder([], semgrep) } });
  assert.equal(ok.mergeQueue.securityTickets.length, 1);
  const bad = await fixture(t);
  await writeProfile(bad, false);
  const badRun = await runManifest(bad, manifest([job(0)]), { fetchImpl: worker({ 0: `token ${GH}\n` }) });
  assert.equal(badRun.status, 'complete', badRun.error);
  const blocked = await integrateRun(bad, badRun.id, { queue: true, noChecks: true, securityGate: { exec: recorder([], semgrep) } });
  assert.equal((blocked.mergeQueue.securityTickets ?? []).length, 0);
});
