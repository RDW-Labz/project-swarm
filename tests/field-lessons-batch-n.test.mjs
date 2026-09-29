// SPDX-License-Identifier: Apache-2.0
// Swarm batch N: field lessons 185, 210-214, 217 (see .swarm-manifests/contract-n.md).
// Lesson #152: imported directly (not only via the package.json test script) so this file stays
// hermetic even run alone as `node --test tests/field-lessons-batch-n.test.mjs`.
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { executeApi, applyEdit, inlineContext, CONTEXT_BYTE_CAP } from '../tools/api-adapters.mjs';
import { runManifest, integrateRun, validateProject, redcheckRun, readState, noJobRunningWarning, scoutRun } from '../tools/swarm.mjs';
import { ship } from '../tools/ship.mjs';
import { scoutPrompt, normalizeScoutReport, renderScoutMarkdown } from '../tools/scout.mjs';
import { git } from '../tools/codex-adapter.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';
import { idleGaps } from '../tools/session-metrics.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-n-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const env = { OPENAI_API_KEY: 'secret-openai-credential' };
const reply = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const openaiBody = envelopeValue => ({ status: 'completed', model: 'resolved-model', usage: { input_tokens: 1, output_tokens: 1 }, output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify(envelopeValue) }] }] });
const job = (overrides = {}) => ({ id: 'api-job', agent: 'openai', model: 'test-model', context: [], outputs: ['report.md'], prompt: 'Edit the report.', timeoutMs: 2000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 1, jobs });

// --- #185: API envelope `edits` form -----------------------------------------------------------

test('#185: applyEdit refuses a find with zero or multiple matches, and replaces exactly one', () => {
  assert.deepEqual(applyEdit('AAA AAA', 'AAA', 'B'), { error: 'edit-multiple-match' });
  assert.deepEqual(applyEdit('nothing here', 'ZZZ', 'Y'), { error: 'edit-no-match' });
  assert.deepEqual(applyEdit('one TWO three', 'TWO', 'II'), { content: 'one II three' });
});

test('#185: an API worker may reply with edits instead of the whole file; the coordinator applies find/replace', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'report.md'), '# Report\nOLD LINE\nmore text\n');
  const envelopeValue = { summary: 'edited', files: [], edits: [{ path: 'report.md', find: 'OLD LINE', replace: 'NEW LINE' }] };
  const state = await runManifest(root, manifest([job()]), { env, fetchImpl: async () => reply(openaiBody(envelopeValue)) });
  assert.equal(state.status, 'complete', state.jobs[0]?.error);
  await integrateRun(root, state.id);
  assert.equal(await fs.readFile(path.join(root, 'report.md'), 'utf8'), '# Report\nNEW LINE\nmore text\n');
});

test('#185: a find occurring zero or more than once refuses the job as edit-no-match/edit-multiple-match, without this fix any edits form is silently accepted', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'report.md'), 'AAA AAA\n');
  const multi = { summary: 'edited', files: [], edits: [{ path: 'report.md', find: 'AAA', replace: 'B' }] };
  const stateMulti = await runManifest(root, manifest([job({ id: 'multi' })]), { env, fetchImpl: async () => reply(openaiBody(multi)) });
  assert.equal(stateMulti.status, 'failed');
  assert.match(stateMulti.jobs[0].error, /edit-multiple-match: report\.md/);

  const none = { summary: 'edited', files: [], edits: [{ path: 'report.md', find: 'ZZZ', replace: 'B' }] };
  const stateNone = await runManifest(root, manifest([job({ id: 'none' })]), { env, fetchImpl: async () => reply(openaiBody(none)) });
  assert.equal(stateNone.status, 'failed');
  assert.match(stateNone.jobs[0].error, /edit-no-match: report\.md/);
});

test('#185: validate warns large-output-whole for a big declared output on an API job with no edits form requested', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'report.md'), 'x'.repeat(20001));
  const report = await validateProject(root, manifest([job()]));
  const warning = report.warnings.find(w => w.code === 'large-output-whole');
  assert.ok(warning, 'expected a large-output-whole warning');
  assert.equal(warning.jobId, 'api-job');
  assert.equal(warning.path, 'report.md');
  // A small output on the same job never warns.
  await fs.writeFile(path.join(root, 'report.md'), 'small');
  const smallReport = await validateProject(root, manifest([job()]));
  assert.ok(!smallReport.warnings.some(w => w.code === 'large-output-whole'));
});

// --- #217: API adapters inline context with a byte cap; a null result is never complete -------

test('#217: executeApi inlines a context file into the request body and records contextInlined', async t => {
  let sentBody;
  const result = await executeApi(job({ context: ['notes.txt'] }), [{ path: 'notes.txt', content: 'small note text' }], {
    env, fetchImpl: async (_url, options) => { sentBody = options.body; return reply(openaiBody({ summary: 'ok', files: [{ path: 'report.md', content: 'done' }], edits: [] })); },
  });
  assert.equal(result.status, 'complete', result.error);
  assert.ok(sentBody.includes('small note text'));
  assert.deepEqual(result.contextInlined, [{ path: 'notes.txt', bytes: Buffer.byteLength('small note text'), truncated: false }]);
});

test('#217: a context file over the per-file byte cap is truncated in the request and recorded truncated:true', async t => {
  const big = 'y'.repeat(CONTEXT_BYTE_CAP + 5000);
  let sentBody;
  const result = await executeApi(job({ context: ['big.txt'] }), [{ path: 'big.txt', content: big }], {
    env, fetchImpl: async (_url, options) => { sentBody = options.body; return reply(openaiBody({ summary: 'ok', files: [{ path: 'report.md', content: 'done' }], edits: [] })); },
  });
  assert.equal(result.status, 'complete', result.error);
  assert.ok(!sentBody.includes(big), 'the full oversized file must not ride along whole');
  assert.equal(result.contextInlined[0].truncated, true);
  assert.equal(result.contextInlined[0].bytes, CONTEXT_BYTE_CAP);
});

test('#217: validate refuses context-not-deliverable when an API job\'s context exceeds the total cap', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'huge.txt'), 'z'.repeat(200001));
  await fs.writeFile(path.join(root, 'report.md'), 'ok');
  await assert.rejects(validateProject(root, manifest([job({ context: ['huge.txt'] })])), /context-not-deliverable/);
});

test('#217: a null envelope from an API job is never complete; it fails with reason null-result', async t => {
  const result = await executeApi(job(), [], { env, fetchImpl: async () => reply(openaiBody(null)) });
  assert.equal(result.status, 'failed');
  assert.match(result.error, /null-result/);
});

// --- #210: no-job-running before a hand step; session-metrics lists idle gaps -------------------

test('#210: noJobRunningWarning warns with idle minutes when no run under the root is active', async t => {
  const root = await fixture(t);
  const oldRunId = 'old-run';
  const finishedAt = new Date(Date.now() - 45 * 60000).toISOString();
  await fs.mkdir(path.join(root, '.swarm/runs', oldRunId), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', oldRunId, 'state.json'), JSON.stringify({ status: 'complete', startedAt: finishedAt, finishedAt }));
  const warning = await noJobRunningWarning({ root, env: {}, dir: path.join(root, '.live-empty'), now: () => Date.now() });
  assert.equal(warning.code, 'no-job-running');
  assert.ok(warning.idleMinutes >= 44 && warning.idleMinutes <= 46, `expected ~45, got ${warning.idleMinutes}`);
  assert.match(warning.message, /no-job-running/);
});

test('#210: noJobRunningWarning returns null when a run under a configured root is registered live', async t => {
  const root = await fixture(t);
  const liveDir = path.join(root, '.live');
  await registerLiveRun({ runId: 'active-run', root, outputs: ['x.txt'], dir: liveDir, pid: process.pid });
  t.after(() => unregisterLiveRun('active-run', { dir: liveDir }));
  const warning = await noJobRunningWarning({ root, env: {}, dir: liveDir, isAlive: () => true });
  assert.equal(warning, null);
});

test('#210: noJobRunningWarning reads roots from local config metrics.roots instead of the current root', async t => {
  const rootA = await fixture(t);
  const rootB = await fixture(t);
  const configFile = path.join(rootA, 'swarm-config.json');
  await fs.writeFile(configFile, JSON.stringify({ metrics: { roots: [rootB] } }));
  const liveDir = path.join(rootA, '.live-config');
  // A live run under rootA (not a configured root) must not suppress the warning.
  await registerLiveRun({ runId: 'unrelated-run', root: rootA, outputs: ['x.txt'], dir: liveDir, pid: process.pid });
  t.after(() => unregisterLiveRun('unrelated-run', { dir: liveDir }));
  const warning = await noJobRunningWarning({ root: rootA, env: { SWARM_CONFIG: configFile }, dir: liveDir, isAlive: () => true });
  assert.equal(warning.code, 'no-job-running');
  // A live run registered under the configured root (rootB) does suppress it.
  await registerLiveRun({ runId: 'configured-run', root: rootB, outputs: ['x.txt'], dir: liveDir, pid: process.pid });
  t.after(() => unregisterLiveRun('configured-run', { dir: liveDir }));
  assert.equal(await noJobRunningWarning({ root: rootA, env: { SWARM_CONFIG: configFile }, dir: liveDir, isAlive: () => true }), null);
});

test('#210: the integrate CLI warns no-job-running when no job is actually running', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const fakeSpawn = (_command, _args, options) => spawn(process.execPath, ['-e', "require('fs').writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}))"], options);
  const manifestObj = { version: 1, concurrency: 1, jobs: [{ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'update', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000 }] };
  const state = await runManifest(root, manifestObj, { spawnImpl: fakeSpawn });
  assert.equal(state.status, 'complete');
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', state.id]);
  const result = JSON.parse(stdout);
  assert.ok((result.warnings ?? []).some(w => w.includes('no-job-running')), JSON.stringify(result.warnings));
});

// --- #211/#212: scout license exceptions, replaceable allowlist, asset preset, sections --------

const scoutFake = script => (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
const scoutInitEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });
const scoutResultEvent = report => JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(report), total_cost_usd: 0.01 }));
async function briefFile(root, text) {
  await fs.writeFile(path.join(root, 'brief.txt'), text);
  return 'brief.txt';
}

test('#211: normalizeScoutReport exempts one named package+license from the gate; a different package with the same license is still rejected', () => {
  const raw = {
    picks: [
      { name: 'gsap', url: 'https://example.com/a/gsap', license: 'Custom-EULA' },
      { name: 'other-lib', url: 'https://example.com/a/other-lib', license: 'Custom-EULA' },
    ],
  };
  const result = normalizeScoutReport(raw, { exceptions: [{ name: 'gsap', license: 'Custom-EULA' }] });
  assert.equal(result.picks.length, 1);
  assert.equal(result.picks[0].name, 'gsap');
  assert.equal(result.picks[0].licenseException, true);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].name, 'other-lib');
});

test('#211: scoutRun --allow-license keeps the named exception and marks it, end to end', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Find an animation library; GSAP is a named exception.');
  const report = { picks: [{ name: 'gsap', url: 'https://example.com/a/gsap', license: 'Custom-EULA' }], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(scoutInitEvent('claude-sonnet-5-20260101'))});console.log(${scoutResultEvent(report)});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find an animation library', allowLicense: [{ name: 'gsap', license: 'Custom-EULA' }] }, { spawnImpl: scoutFake(script) });
  assert.equal(result.picks, 1);
  assert.equal(result.rejected, 0);
  const reportJson = JSON.parse(await fs.readFile(path.join(root, result.report), 'utf8'));
  assert.equal(reportJson.picks[0].licenseException, true);
});

test('#212: normalizeScoutReport with kind assets keeps CC0/CC-BY picks and flags attribution for CC-BY only', () => {
  const raw = { picks: [
    { name: 'cc0-asset', url: 'https://example.com/a/cc0', license: 'CC0-1.0' },
    { name: 'ccby-asset', url: 'https://example.com/a/ccby', license: 'CC-BY-4.0' },
  ] };
  const result = normalizeScoutReport(raw, { kind: 'assets' });
  assert.equal(result.picks.length, 2);
  const cc0 = result.picks.find(p => p.name === 'cc0-asset');
  const ccby = result.picks.find(p => p.name === 'ccby-asset');
  assert.ok(!cc0.attribution);
  assert.equal(ccby.attribution, true);
});

test('#212: scoutRun --kind assets survives real picks the fixed code-license list alone would reject', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Find CC0 game assets.');
  const report = { picks: [
    { name: 'kenney-pack', url: 'https://example.com/a/kenney', license: 'CC0-1.0' },
  ], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(scoutInitEvent('claude-sonnet-5-20260101'))});console.log(${scoutResultEvent(report)});`;
  const result = await scoutRun(root, { model: 'sonnet', brief, goal: 'find game assets', kind: 'assets' }, { spawnImpl: scoutFake(script) });
  assert.equal(result.picks, 1);
  assert.equal(result.rejected, 0);
});

test('#212: --licenses replaces the built-in allowlist outright', async t => {
  const root = await fixture(t);
  const brief = await briefFile(root, 'Find a library under our own house license.');
  const report = { picks: [{ name: 'house-lib', url: 'https://example.com/a/house-lib', license: 'House-License-1.0' }], rejected: [], top: [] };
  const script = `console.log(${JSON.stringify(scoutInitEvent('claude-sonnet-5-20260101'))});console.log(${scoutResultEvent(report)});`;
  const withoutFlag = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library' }, { spawnImpl: scoutFake(script), id: 'scout-no-licenses' });
  assert.equal(withoutFlag.picks, 0);
  const withFlag = await scoutRun(root, { model: 'sonnet', brief, goal: 'find a library', licenses: 'House-License-1.0' }, { spawnImpl: scoutFake(script), id: 'scout-with-licenses' });
  assert.equal(withFlag.picks, 1);
});

test('#212: a brief-requested section survives into report.md, which the fixed Top/Picks/Rejected layout used to drop', () => {
  const report = { picks: [], rejected: [], top: [], sections: { 'bundling rules': 'Bundle every asset under vendor/assets.' } };
  const markdown = renderScoutMarkdown(report, { goal: 'g', id: 'scout-1', model: 'sonnet' });
  assert.match(markdown, /## bundling rules/);
  assert.match(markdown, /Bundle every asset under vendor\/assets\./);
});

// --- #213: ship refuses author-email-mismatch before push -------------------------------------

function shipExecFixture(script) {
  const calls = [];
  let index = 0;
  const exec = async (file, args, opts) => {
    if (file === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git', stderr: '' };
    if (file === 'git' && args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'no package' };
    calls.push({ file, args, opts });
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args, opts) : entry;
  };
  return { exec, calls };
}
const shipOk = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const shipRev = sha => shipOk(`${sha}\n`);

async function shipFixture(t) {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
  return { root, payloadPath };
}

test('#213: ship refuses author-email-mismatch, naming the commit sha, before pushing', async t => {
  const { root, payloadPath } = await shipFixture(t);
  const { exec, calls } = shipExecFixture([shipOk(''), shipRev('sha123')]);
  const authorEmailExec = async args => {
    if (args[0] === 'config') return { code: 0, stdout: 'me@example.com\n', stderr: '' };
    return { code: 0, stdout: `deadbee1${'0'.repeat(32)}\x1fother@example.com\x1fother@example.com\n`, stderr: '' };
  };
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, authorEmailExec,
    runChecks: async () => { throw new Error('checks must not run'); },
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'author-email-mismatch');
  assert.match(result.reason, /author-email-mismatch: deadbee1.*\(other@example\.com\)/);
  // Never reached push: only status/rev-parse were called on the shared exec.
  assert.equal(calls.some(call => call.args[0] === 'push'), false);
});

test('#213: a GitHub noreply commit email is fine; the ship proceeds past the email check', async t => {
  const { root, payloadPath } = await shipFixture(t);
  const { exec } = shipExecFixture([
    shipOk(''), shipRev('sha123'), shipOk(''), shipOk('[]'),
    shipOk(JSON.stringify({ number: 7, html_url: 'https://example.com/pr/7' })),
    shipOk(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const authorEmailExec = async args => {
    if (args[0] === 'config') return { code: 0, stdout: 'me@example.com\n', stderr: '' };
    return { code: 0, stdout: `${'a'.repeat(40)}\x1f12345+bot@users.noreply.github.com\x1f12345+bot@users.noreply.github.com\n`, stderr: '' };
  };
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, authorEmailExec, merge: false,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.notEqual(result.status, 'refused');
  assert.equal(result.status, 'ready');
});

// --- #214: redcheck --commit reverts one commit's diff on a temp worktree at HEAD -------------

async function gitFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-redcheck-commit-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  return root;
}
async function commitAll(root, message) {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}
async function fakeRunState(root, id) {
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'state.json'), JSON.stringify({ status: 'complete', root, id, jobs: [] }));
}

test('#214: redcheck --commit reverts only that commit\'s diff on a temp worktree, proving a stacked run red, then removes the worktree', async t => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, 'greet.mjs'), "export function greet(){return 'hi';}\n");
  await commitAll(root, 'initial');
  await fs.writeFile(path.join(root, 'greet.mjs'), "export function greet(){return 'hello';}\n");
  const commitA = await commitAll(root, 'run A: greet says hello');
  // A later, stacked run adds the regression test for run A's own change, plus an unrelated file
  // — the old base/job-hash restoration used to refuse here ("differs from both base and job
  // versions") once a later run touched the same tree; --commit never looks at that bookkeeping.
  await fs.writeFile(path.join(root, 'greet.test.mjs'), "import { greet } from './greet.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet(), 'hello');\n");
  await fs.writeFile(path.join(root, 'unrelated.mjs'), 'export const x = 1;\n');
  await commitAll(root, 'run B: regression test plus an unrelated stacked change');
  await fakeRunState(root, 'run-a');
  const result = await redcheckRun(root, 'run-a', [process.execPath, 'greet.test.mjs'], { commit: commitA });
  assert.equal(result.status, 'red', JSON.stringify(result));
  assert.match(result.tail, /AssertionError/);
  // The temp worktree is removed; HEAD's own greet.mjs still says 'hello'.
  assert.equal(await fs.readFile(path.join(root, 'greet.mjs'), 'utf8'), "export function greet(){return 'hello';}\n");
  const worktrees = (await git(root, ['worktree', 'list'])).trim().split('\n');
  assert.equal(worktrees.length, 1, 'the temporary worktree must be removed');
});

test('#214: redcheck --commit reports importOnly when every failure is a missing-export SyntaxError', async t => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, 'lib.mjs'), 'export function foo(){return 1;}\n');
  await commitAll(root, 'initial');
  await fs.writeFile(path.join(root, 'lib.mjs'), 'export function foo(){return 1;}\nexport function bar(){return 2;}\n');
  const commitA = await commitAll(root, 'run A: add bar');
  await fs.writeFile(path.join(root, 'bar.test.mjs'), "import { bar } from './lib.mjs';\nbar();\n");
  await commitAll(root, 'run B: stacked test using bar');
  await fakeRunState(root, 'run-a2');
  const result = await redcheckRun(root, 'run-a2', [process.execPath, 'bar.test.mjs'], { commit: commitA });
  assert.notEqual(result.status, 'green');
  assert.equal(result.importOnly, true, JSON.stringify(result));
});

test('#214: redcheck --commit run as the real CLI subprocess reverts only that commit and reports red', async t => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, 'greet.mjs'), "export function greet(){return 'hi';}\n");
  await commitAll(root, 'initial');
  await fs.writeFile(path.join(root, 'greet.mjs'), "export function greet(){return 'hello';}\n");
  const commitA = await commitAll(root, 'run A: greet says hello');
  await fs.writeFile(path.join(root, 'greet.test.mjs'), "import { greet } from './greet.mjs';\nimport assert from 'node:assert/strict';\nassert.equal(greet(), 'hello');\n");
  await commitAll(root, 'run B: stacked change on top');
  await fakeRunState(root, 'run-cli');
  const { stdout } = await execFileAsync(process.execPath, [
    CLI, '--root', root, 'redcheck', 'run-cli', '--commit', commitA, '--test', process.execPath, 'greet.test.mjs',
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.status, 'red', JSON.stringify(result));
  assert.match(result.tail, /AssertionError/);
  // HEAD's own greet.mjs is untouched: only a throwaway worktree had the commit reverted.
  assert.equal(await fs.readFile(path.join(root, 'greet.mjs'), 'utf8'), "export function greet(){return 'hello';}\n");
});

test('#210: session-metrics idleGaps lists only gaps at or above 5 minutes, oldest first', () => {
  const records = [
    { startedAt: '2026-09-28T10:00:00.000Z', finishedAt: '2026-09-28T10:05:00.000Z' },
    { startedAt: '2026-09-28T10:06:00.000Z', finishedAt: '2026-09-28T10:10:00.000Z' }, // 1 min gap: excluded
    { startedAt: '2026-09-28T10:45:00.000Z', finishedAt: '2026-09-28T10:50:00.000Z' }, // 35 min gap: included
  ];
  assert.deepEqual(idleGaps(records), [{ start: '2026-09-28T10:10:00.000Z', end: '2026-09-28T10:45:00.000Z', minutes: 35 }]);
  assert.deepEqual(idleGaps(records, { minMinutes: 60 }), []);
});
