// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBrainCommand, triageRun, preflightManifest, haikuFallback, brainStats, runDigestText, createProjectBrain } from '../tools/brain-commands.mjs';
import { autopilotStep } from '../tools/autopilot.mjs';

const tmp = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-brain-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

// A project brain whose "model" answers from a script, and which records what it was asked.
function fakeProject(answers = {}) {
  const asked = [], savedLog = [];
  return {
    asked, savedLog,
    settings: { enabled: false, concurrency: 1 },
    async ask(request) {
      asked.push(request);
      const answer = typeof answers[request.kind] === 'function' ? answers[request.kind](request) : answers[request.kind] ?? '{}';
      return { text: answer, via: 'local', usage: { inTokens: 10, outTokens: 5 }, paidUsd: 0, ms: 1 };
    },
    async saved(kind, tokens) { savedLog.push([kind, tokens]); },
    async link() { return null; },
    brain: { status: () => ({}) },
    async close() {},
  };
}
const run = (root, command, args, project, extra = {}) => runBrainCommand(root, command, args, { createBrain: () => project, readState: async () => ({ id: 'r1', status: 'failed', jobs: [{ id: 'a', status: 'failed', agent: 'codex', error: 'boom' }, { id: 'b', status: 'complete' }] }), projectProfile: async () => ({ sensitive: false, protectedPaths: ['private/'] }), ...extra });
const options = { options: [{ title: 'Use A', reason: 'simple' }, { title: 'Use B', reason: 'fast' }, { title: 'Use C', reason: 'cheap' }] };

test('think prints a top 3 with reasons, records saved tokens, and refuses bad arguments', async t => {
  const root = await tmp(t), project = fakeProject({ think: JSON.stringify(options) });
  const out = await run(root, 'think', ['Which database?', '--rounds', '1'], project);
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /1\. Use A - simple\n2\. Use B - fast\n3\. Use C - cheap/);
  assert.ok(project.savedLog.some(([kind, tokens]) => kind === 'think' && tokens > 0));
  assert.equal((await run(root, 'think', [], project)).exitCode, 1);
  assert.equal((await run(root, 'think', ['q', '--rounds', '9'], project)).exitCode, 1);
  const json = JSON.parse((await run(root, 'think', ['q', '--json'], fakeProject({ think: JSON.stringify(options) }))).stdout);
  assert.equal(json.top3.length, 3);
});

test('digest reads a file, stdin or a run, in at most 15 lines; sensitive projects never fall back to Haiku', async t => {
  const root = await tmp(t);
  await fs.writeFile(path.join(root, 'build.log'), Array.from({ length: 400 }, (_, n) => (n === 200 ? 'ERROR: boom in x.js' : `line ${n}`)).join('\n'));
  const project = fakeProject({ digest: () => Array.from({ length: 30 }, (_, n) => `finding ${n}`).join('\n') });
  const out = await run(root, 'digest', ['build.log'], project);
  assert.equal(out.stdout.trim().split('\n').length, 15);
  assert.equal(project.asked[0].sensitive, false, 'profile says not sensitive');
  assert.match(project.asked[0].user, /ERROR: boom/, 'error lines survive the prefilter');
  const sensitive = fakeProject({ digest: 'ok' });
  await run(root, 'digest', ['build.log'], sensitive, { projectProfile: async () => ({ sensitive: true, protectedPaths: [] }) });
  assert.equal(sensitive.asked[0].sensitive, true);
  await fs.mkdir(path.join(root, '.swarm/runs/r1'), { recursive: true });
  const viaRun = fakeProject({ digest: 'one line' });
  await run(root, 'digest', ['r1'], viaRun);
  assert.match(viaRun.asked[0].user, /job a failed agent codex error: boom/);
  assert.doesNotMatch(viaRun.asked[0].user, /job b/);
  const piped = fakeProject({ digest: 'x' });
  await run(root, 'digest', ['-'], piped, { stdin: (async function* () { yield Buffer.from('from stdin text'); })() });
  assert.match(piped.asked[0].user, /from stdin text/);
  assert.equal((await run(root, 'digest', ['build.log', '--kind', 'weird'], project)).exitCode, 1);
});

test('digest and draft refuse secret and protected paths and anything outside the project', async t => {
  const root = await tmp(t), project = fakeProject({ digest: 'x', draft: 'x' });
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
  await fs.mkdir(path.join(root, 'private'));
  await fs.writeFile(path.join(root, 'private/notes.md'), 'n');
  await fs.writeFile(path.join(os.tmpdir(), 'brain-outside.txt'), 'o');
  t.after(() => fs.rm(path.join(os.tmpdir(), 'brain-outside.txt'), { force: true }));
  await fs.symlink(path.join(os.tmpdir(), 'brain-outside.txt'), path.join(root, 'link.txt'));
  for (const file of ['.env', 'private/notes.md', '../x', '/etc/hosts', 'link.txt']) {
    const out = await run(root, 'digest', [file], project);
    assert.equal(out.exitCode, 1, file);
    assert.match(out.stdout, /brain-path-refused|ENOENT/, file);
  }
  const draft = await run(root, 'draft', ['docs', 'brief', '--context', '.env'], project);
  assert.equal(draft.exitCode, 1);
  assert.equal(project.asked.length, 0, 'nothing was sent');
});

test('draft drafts locally, polishes with Haiku only for a non-sensitive project, and writes --out without overwriting', async t => {
  const root = await tmp(t);
  const project = fakeProject({ draft: '# Title\nbody text' });
  const out = await run(root, 'draft', ['docs', 'write the intro', '--out', 'docs/intro.md'], project, { projectProfile: async () => ({ sensitive: true, protectedPaths: [] }) });
  assert.equal(out.exitCode, 0);
  assert.match(out.stdout, /# Title/);
  assert.match(out.stdout, /not polished: no-polisher/, 'a sensitive project is never sent to Haiku');
  assert.equal(await fs.readFile(path.join(root, 'docs/intro.md'), 'utf8'), '# Title\nbody text\n');
  const again = await run(root, 'draft', ['docs', 'write the intro', '--out', 'docs/intro.md'], fakeProject({ draft: 'x' }));
  assert.equal(again.exitCode, 1);
  assert.match(again.stdout, /already exists/);
  const protectedOut = await run(root, 'draft', ['docs', 'b', '--out', 'private/x.md'], fakeProject({ draft: 'x' }));
  assert.match(protectedOut.stdout, /brain-path-refused/);
  assert.equal((await run(root, 'draft', ['essay', 'b'], project)).exitCode, 1);
});

test('triageRun gives one verdict per failed job, writes triage.json, and never throws on bad model output', async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.swarm/runs/r1/a'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs/r1/a/response.txt'), 'tail of the response');
  const readState = async () => ({ id: 'r1', jobs: [{ id: 'a', status: 'failed', error: 'timed out', agent: 'codex', attempts: [{}] }, { id: 'b', status: 'complete' }, { id: 'c', status: 'timeout', error: 'slow', attempts: [{}, {}, {}] }] });
  const project = fakeProject({ triage: JSON.stringify({ verdict: 'retry', hint: 'raise the timeout' }) });
  const verdicts = await triageRun(root, 'r1', { project, readState, projectProfile: async () => ({ sensitive: true }) });
  assert.deepEqual(verdicts.map(v => [v.job, v.verdict]), [['a', 'retry'], ['c', 'escalate']], 'a job with 2+ attempts is never retried');
  assert.match(project.asked[0].user, /tail of the response/);
  assert.equal(project.asked[0].sensitive, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, '.swarm/runs/r1/a/triage.json'), 'utf8')).verdict, 'retry');
  const garbage = await triageRun(root, 'r1', { project: fakeProject({ triage: 'not json at all' }), readState, projectProfile: async () => null });
  assert.deepEqual(garbage.map(v => v.verdict), ['needs-human', 'needs-human']);
});

test('autopilot triages before it retries: needs-human becomes a blocker and no retry, retry and escalate go ahead', async t => {
  const calls = [];
  const base = verdicts => ({
    loadRuns: async () => [{ id: 'r1', status: 'failed', counts: { failed: 1 } }], readJournal: async () => [], appendEvent: async (_r, event) => { calls.push(['append', event]); }, readPlan: async () => null,
    checkout: async () => ({ branch: 'swarm/x', dirty: false }), integrate: async () => ({}), resume: async () => {}, startWave: async () => ({}),
    retryFailed: async () => { calls.push(['retry']); return { run: 'r2', status: 'running' }; },
    triage: async () => verdicts,
  });
  const human = await autopilotStep('/x', base([{ job: 'a', verdict: 'needs-human', hint: 'check the key' }]), { now: () => 1, memory: new Set() });
  assert.deepEqual(human.blocked, ['triage-r1-a']);
  assert.ok(!calls.some(call => call[0] === 'retry'));
  const blocker = calls.find(call => call[0] === 'append' && call[1].kind === 'blocker')[1];
  assert.match(blocker.text, /Hint \(untrusted\): check the key/);
  calls.length = 0;
  const ok = await autopilotStep('/x', base([{ job: 'a', verdict: 'retry', hint: 'x' }, { job: 'b', verdict: 'escalate', hint: '' }]), { now: () => 1, memory: new Set() });
  assert.ok(calls.some(call => call[0] === 'retry'));
  assert.deepEqual(ok.blocked, []);
  assert.ok(calls.some(call => call[0] === 'append' && call[1].action === 'triage' && /a:retry b:escalate/.test(call[1].reason)));
  calls.length = 0;
  const broken = base([]); broken.triage = async () => { throw new Error('brain down'); };
  await autopilotStep('/x', broken, { now: () => 1, memory: new Set() });
  assert.ok(calls.some(call => call[0] === 'retry'), 'a triage failure never blocks the retry');
});

test('preflightManifest only looks at jobs for Claude or Opus and returns their issues', async () => {
  const project = fakeProject({ preflight: JSON.stringify({ issues: ['output is not a file path'] }) });
  const manifest = { jobs: [{ id: 'cheap', agent: 'codex', prompt: 'x', outputs: ['a'] }, { id: 'big', agent: 'claude', prompt: 'x', context: [], outputs: ['b'] }, { id: 'opus', agent: 'anthropic', model: 'claude-opus-5-5', prompt: 'x', outputs: ['c'] }] };
  const out = await preflightManifest(manifest, { project });
  assert.deepEqual(out.map(entry => entry.job), ['big', 'opus']);
  assert.deepEqual(await preflightManifest({ jobs: [manifest.jobs[0]] }, { project }), []);
  assert.equal(project.asked.every(request => request.sensitive === true), true);
});

test('the Haiku fallback prices the call, records it in the Anthropic ledger, and refuses over the cap', async t => {
  const dir = await tmp(t);
  const env = { SWARM_LOGS_DIR: dir, SWARM_ANTHROPIC_API_KEY: 'sk-ant-test-0123456789' };
  let seen;
  const fetchImpl = async (url, init) => { seen = JSON.parse(init.body); return new Response(JSON.stringify({ content: [{ type: 'text', text: 'hello' }], usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 }); };
  const fallback = haikuFallback({ env, fetchImpl });
  const reply = await fallback([{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }], { maxTokens: 50 });
  assert.equal(reply.text, 'hello');
  assert.ok(reply.paidUsd > 0);
  assert.equal(seen.model, 'claude-haiku-5-5');
  assert.equal(seen.system, 'be brief');
  assert.deepEqual(seen.messages, [{ role: 'user', content: 'hi' }]);
  const none = haikuFallback({ env: { SWARM_LOGS_DIR: dir, SWARM_TEST_NO_KEYCHAIN: '1' }, fetchImpl });
  await assert.rejects(none([{ role: 'user', content: 'hi' }]), { code: 'brain-unavailable' });
  await assert.rejects(haikuFallback({ env, fetchImpl: async () => new Response('no', { status: 500 }) })([{ role: 'user', content: 'x' }]), { code: 'brain-unavailable' });
});

test('brain stats totals the ledger; a project brain with no config is down and falls back; the ledger file is private', async t => {
  const root = await tmp(t);
  const project = createProjectBrain({ root, env: { SWARM_CONFIG: process.env.SWARM_CONFIG }, fetchImpl: async () => { throw new Error('no network in tests'); } });
  await assert.rejects(project.ask({ kind: 'think', user: 'x', sensitive: true }), /local brain unavailable/);
  await project.saved('digest', 1234);
  await project.close();
  const stats = await brainStats(root);
  assert.equal(stats.savedTokens, 1234);
  assert.equal(stats.failed, 1);
  const out = await runBrainCommand(root, 'brain', ['stats'], { createBrain: () => fakeProject(), readState: async () => ({}), projectProfile: async () => null });
  assert.match(out.stdout, /orchestrator tokens saved \(estimate\) 1234/);
  const md = await runBrainCommand(root, 'brain', ['stats', '--markdown'], { createBrain: () => fakeProject(), readState: async () => ({}), projectProfile: async () => null });
  assert.match(md.stdout, /Local brain:\*\* 1 calls/);
  const status = await runBrainCommand(root, 'brain', ['status', '--json'], { createBrain: () => fakeProject(), readState: async () => ({}), projectProfile: async () => null });
  assert.equal(JSON.parse(status.stdout).configured, false);
  assert.equal((await runBrainCommand(root, 'brain', ['bogus'], { createBrain: () => fakeProject() })).exitCode, 1);
  assert.match(runDigestText({ id: 'r', status: 'failed', jobs: [{ id: 'x', status: 'failed', error: 'e' }, { id: 'y', status: 'complete' }] }), /job x failed error: e/);
});
