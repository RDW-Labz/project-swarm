// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runManifest, validateManifest, validateProject, inspectRun } from '../tools/swarm.mjs';
import { codexMessage, git } from '../tools/codex-adapter.mjs';
import { shellMessage } from '../tools/claude-shell.mjs';
import { extraCliMessage } from '../tools/cli-adapters.mjs';
import { outputSchema } from '../tools/api-adapters.mjs';
import { REPORT_PROMPT_LINE, rollupRun } from '../tools/reports.mjs';

const runner = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));
const report = overrides => ({ status: 'complete', summary: 'Finished.', files: [], risks: [], followups: [], ...overrides });
const job = overrides => ({ id: 'worker', agent: 'claude', model: 'sonnet', prompt: 'Review the supplied input.', context: ['input.txt'], outputs: [], timeoutMs: 5000, ...overrides });
const manifest = overrides => ({ version: 1, report: 'short', jobs: [job()], ...overrides });
async function fixture(t, gitRepo = false) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-reports-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'Fixture input.\n');
  if (gitRepo) {
    await git(root, ['init', '-q']);
    await git(root, ['add', 'input.txt']);
    await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture']);
  }
  return root;
}
const fake = value => (_command, _args, options) => spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(typeof value === 'string' ? value : JSON.stringify(value))}}))`], options);

for (const valid of [true, false]) test(`strict API report-only re-ask ${valid ? 'recovers' : 'fails once'}`, async t => {
  const root = await fixture(t);
  let calls = 0;
  const value = report({ files: ['out.txt'] });
  const state = await runManifest(root, manifest({ jobs: [job({ agent: 'ollama', model: 'test-model', outputs: ['out.txt'] })] }), { fetchImpl: async (_url, options) => {
    const body = JSON.parse(options.body);
    const input = JSON.parse(body.messages[1].content);
    calls++;
    if (calls === 2) {
      assert.deepEqual(input.declaredOutputs, []);
      assert.deepEqual(input.files, []);
      assert.match(input.task, /Your files are saved\. Reply with only your final report JSON line and nothing else\.\nProblems with your last report:/);
      assert.match(input.task, /Declared outputs you may list in files: \["out.txt"\]/);
    }
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', prompt_eval_count: 10, eval_count: 5, message: { content: JSON.stringify({ summary: 'done', files: calls === 1 ? [{ path: 'out.txt', content: 'first' }] : [], result: calls === 2 && valid ? value : { files_changed: ['out.txt'] } }) } }));
  } });
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].reportReasked, true);
  assert.equal(state.jobs[0].usage.input_tokens, 10);
  assert.equal(state.jobs[0].status, valid ? 'complete' : 'failed', state.jobs[0].error);
  if (valid) assert.deepEqual(state.jobs[0].report, value);
  else assert.match(state.jobs[0].error, /^report-invalid:/);
  assert.equal(await fs.readFile(path.join(root, state.jobs[0].workspace, 'out.txt'), 'utf8'), 'first');
});

test('codex report-only re-ask restores output bytes in the same worktree', async t => {
  const root = await fixture(t, true);
  let calls = 0, workspace;
  const value = report({ files: ['output.txt'] });
  const state = await runManifest(root, manifest({ jobs: [job({ agent: 'codex', model: 'test-model', outputs: ['output.txt'] })] }), { platform: 'darwin', spawnImpl: (_command, args, options) => {
    calls++;
    if (calls === 1) workspace = options.cwd;
    else {
      assert.equal(options.cwd, workspace);
      assert.ok(args.at(-1).startsWith('Your files are saved. Reply with only your final report JSON line and nothing else.\n'));
    }
    const resultFile = args[args.indexOf('-o') + 1];
    return spawn(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync('output.txt',${JSON.stringify(calls === 1 ? 'first' : 'changed')});fs.writeFileSync(${JSON.stringify(resultFile)},${JSON.stringify(JSON.stringify(calls === 1 ? { files_changed: ['output.txt'] } : value))});`], options);
  } });
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].status, 'complete', state.jobs[0].error);
  assert.equal(state.jobs[0].reportReasked, true);
  assert.deepEqual(state.jobs[0].report, value);
  assert.equal(await fs.readFile(path.join(root, state.jobs[0].workspace, 'output.txt'), 'utf8'), 'first');
  assert.ok(state.warnings.includes('report-reask-restored: worker: output.txt'));
});

test('timeout and non-strict attempts never re-ask reports', async t => {
  const root = await fixture(t);
  let calls = 0;
  const plain = await runManifest(root, manifest({ report: undefined }), { spawnImpl: (...args) => { calls++; return fake('legacy')(...args); } });
  assert.equal(calls, 1);
  assert.equal(plain.jobs[0].reportReasked, undefined);
  calls = 0;
  const timed = await runManifest(root, manifest({ jobs: [job({ timeoutMs: 50 })] }), { spawnImpl: (_command, _args, options) => { calls++; return spawn(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], options); } });
  assert.equal(calls, 1);
  assert.equal(timed.jobs[0].status, 'timeout');
  assert.equal(timed.jobs[0].reportReasked, undefined);
});

for (const status of ['complete', 'blocked', 'failed']) test(`Claude same-session report re-ask saves ${status} and sums reported tokens`, async t => {
  const root = await fixture(t);
  let calls = 0;
  const value = report({ status });
  const state = await runManifest(root, manifest(), { spawnImpl: (_command, args, options) => {
    calls++;
    if (calls === 2) assert.equal(args[args.indexOf('--resume') + 1], 'fixture-session');
    const reply = calls === 1 ? 'legacy' : JSON.stringify(value);
    return spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'system',subtype:'init',session_id:'fixture-session'}));console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(reply)},usage:{total_tokens:7}}));`], options);
  } });
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].reportReasked, true);
  assert.equal(state.jobs[0].usage.total_tokens, 14);
  assert.equal(state.jobs[0].status, status, state.jobs[0].error);
  assert.deepEqual(state.jobs[0].report, value);
});

test('shell attempts never re-ask reports', async t => {
  const root = await fixture(t, true);
  let calls = 0;
  const state = await runManifest(root, manifest({ jobs: [job({ shell: true })] }), {
    platform: 'darwin', env: { ...process.env, SWARM_CLAUDE_WORKER_API_KEY: 'fixture-worker-key' },
    shellHooks: { access: async () => {}, resolveClaude: async () => process.execPath, scanListeningPorts: async () => [] },
    spawnImpl: (...args) => { calls++; return fake('legacy')(...args); },
  });
  assert.equal(calls, 1, state.jobs[0].error);
  assert.equal(state.jobs[0].reportReasked, undefined);
  assert.match(state.jobs[0].error, /^report-invalid:/);
});

test('strict API jobs retry provider limits, validate the result and clear attempt errors', async t => {
  const root = await fixture(t);
  let calls = 0;
  const state = await runManifest(root, manifest({ jobs: [job({ agent: 'ollama', model: 'test-model' })], lanes: { ollama: { backoff: { baseMs: 1, maxMs: 1 } } } }), { fetchImpl: async () => {
    if (++calls === 1) return new Response('rate limited', { status: 429, headers: { 'retry-after': '0.001' } });
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [], result: report() }) } }));
  } });
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].status, 'complete', state.jobs[0].error);
  assert.equal(state.jobs[0].reportErrors, undefined);
  assert.deepEqual(state.jobs[0].report, report());
});

test('API envelopes without a strict result fail and dependent workers get no report', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest({ jobs: [job({ agent: 'ollama', model: 'test-model' }), job({ id: 'dependent', after: ['worker'] })] }), { fetchImpl: async () => new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'prose', files: [] }) } })) });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /^report-invalid: no final report/);
  assert.equal(state.jobs[1].status, 'skipped');
  assert.equal(state.jobs[1].report, undefined);
  assert.equal(state.jobs[1].reportErrors, undefined);
});

test('report mode validates both levels and applies strict prompts idempotently with job types', async t => {
  for (const mode of [false, null, '', 'long', 1]) {
    for (const input of [manifest({ report: mode }), manifest({ report: undefined, jobs: [job({ report: mode })] })]) assert.throws(() => validateManifest(input), { code: 'report-invalid-mode', message: 'report must be "short"' });
  }
  const root = await fixture(t);
  for (const input of [manifest(), manifest({ report: undefined, jobs: [job({ report: 'short' })] }), manifest({ jobs: [job({ type: 'review' })] })]) {
    const applied = await validateProject(root, input);
    assert.equal(applied.jobs[0].report, 'short');
    assert.equal(applied.jobs[0].prompt.split(REPORT_PROMPT_LINE).length - 1, 1);
    const twice = await validateProject(root, { ...input, jobs: input.jobs.map((job, index) => ({ ...job, report: applied.jobs[index].report, prompt: applied.jobs[index].prompt })) });
    assert.equal(twice.jobs[0].prompt.split(REPORT_PROMPT_LINE).length - 1, 1);
  }
});

for (const status of ['complete', 'blocked', 'failed']) test(`strict ${status} reports are saved and control job status`, async t => {
  const root = await fixture(t), value = report({ status });
  const state = await runManifest(root, manifest(), { spawnImpl: fake(value) });
  assert.equal(state.jobs[0].status, status, state.jobs[0].error);
  assert.deepEqual(state.jobs[0].report, value);
  if (status !== 'complete') assert.match(state.jobs[0].error, status === 'blocked' ? /^blocked: Finished\./ : /^worker-reported-failed: Finished\./);
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
  assert.deepEqual(saved.jobs[0].report, value);
  assert.deepEqual((await inspectRun(root, state.id)).jobs[0].report, value);
});

for (const value of ['prose reply', { files_changed: [], notes: ['legacy'] }]) test(`strict invalid ${typeof value} reports fail after one report re-ask`, async t => {
  const root = await fixture(t);
  let calls = 0;
  const state = await runManifest(root, manifest(), { spawnImpl: (...args) => { calls++; return fake(value)(...args); } });
  assert.equal(calls, 2);
  assert.equal(state.jobs[0].reportReasked, true);
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /^report-invalid:/);
  assert.ok(state.jobs[0].reportErrors.length);
  assert.equal(state.jobs[0].report, undefined);
  assert.deepEqual((await inspectRun(root, state.id)).jobs[0].reportErrors, state.jobs[0].reportErrors);
});

test('non-strict legacy reports preserve status and short reports work without opting in', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest({ report: undefined }), { spawnImpl: fake({ files_changed: [], notes: ['legacy'] }) });
  assert.equal(state.jobs[0].status, 'complete');
  assert.deepEqual(state.jobs[0].report, { ...report({ summary: 'legacy' }), legacy: true });
  const short = await runManifest(root, manifest({ report: undefined }), { spawnImpl: fake(report()) });
  assert.deepEqual(short.jobs[0].report, report());
});

test('strict codex prompt removes legacy instructions and resolves reports from the worktree writer', async t => {
  const root = await fixture(t, true);
  const value = report({ files: ['output.txt'] });
  const plan = manifest({ jobs: [job({ agent: 'codex', model: 'test-model', outputs: ['output.txt'] })] });
  let prompt;
  const state = await runManifest(root, plan, { platform: 'darwin', spawnImpl: (_command, args, options) => {
    prompt = args.at(-1);
    const resultFile = args[args.indexOf('-o') + 1];
    return spawn(process.execPath, ['-e', `const fs=require('node:fs');fs.writeFileSync('output.txt','done');fs.writeFileSync(${JSON.stringify(resultFile)},${JSON.stringify(JSON.stringify(value))});`], options);
  } });
  assert.equal(state.jobs[0].status, 'complete', state.jobs[0].error);
  assert.deepEqual(state.jobs[0].report, value);
  assert.equal(prompt.split(REPORT_PROMPT_LINE).length - 1, 1);
  assert.doesNotMatch(prompt, /files_changed|Report checksRun as/);
  const plain = codexMessage(job({ agent: 'codex', outputs: [] }));
  assert.match(plain, /Finish with exactly one JSON line \{"files_changed":\[\.\.\.\],"notes":\[\.\.\.\]\}/);
  assert.doesNotMatch(plain, /This replaces any other final-line format/);
});

test('strict schema and CLI prompts ask for the short report in the envelope result', () => {
  const strict = job({ report: 'short', prompt: 'Review.\n\n' + REPORT_PROMPT_LINE });
  const schema = outputSchema([], [], strict);
  assert.ok(schema.required.includes('result'));
  assert.deepEqual(schema.properties.result.required, ['status', 'summary', 'files', 'risks', 'followups']);
  assert.equal(outputSchema([]).required.includes('result'), false);
  assert.match(extraCliMessage(strict, []), /envelope result object is the short report/);
  assert.doesNotMatch(shellMessage({ ...strict, shell: true }), /Include "checksRun"/);
});

test('API reports use the envelope result and 300-job stub runs produce compact CLI rollups', { timeout: 60000 }, async t => {
  const root = await fixture(t);
  const jobs = Array.from({ length: 300 }, (_, i) => job({ id: `j-${i}`, agent: 'ollama', model: 'test-model' }));
  let calls = 0;
  const state = await runManifest(root, manifest({ concurrency: 32, jobs }), { fetchImpl: async (_url, options) => {
    calls++;
    const body = JSON.parse(options.body);
    assert.match(body.messages[0].content, /envelope result object must be the short report/);
    const value = report({ summary: 's'.repeat(500), risks: ['r'.repeat(195) + String(calls)], followups: ['f'.repeat(195) + String(calls)] });
    return new Response(JSON.stringify({ done: true, done_reason: 'stop', message: { content: JSON.stringify({ summary: 'done', files: [], edits: [], result: value }) } }));
  } });
  assert.equal(calls, 300);
  assert.equal(state.status, 'complete', state.jobs.find(job => job.error)?.error);
  assert.equal(state.jobs.filter(job => job.report?.status === 'complete').length, 300);
  assert.ok(Buffer.byteLength(JSON.stringify(rollupRun(state))) < 4096);
  for (const flags of [[], ['--text']]) {
    const cli = spawnSync(process.execPath, [runner, '--root', root, 'rollup', state.id, '--top', '2', ...flags], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    if (flags.length) assert.match(cli.stdout, /300 jobs/);
    else { assert.equal(JSON.parse(cli.stdout).total, 300); assert.ok(Buffer.byteLength(cli.stdout) < 4096); }
  }
  for (const top of ['0', '51', '1.5', 'no']) assert.notEqual(spawnSync(process.execPath, [runner, '--root', root, 'rollup', state.id, '--top', top]).status, 0);
  assert.notEqual(spawnSync(process.execPath, [runner, '--root', root, 'rollup', 'missing']).status, 0);
});
