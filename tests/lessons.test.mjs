// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runManifest, integrateRun, cancelRun, readState, validateManifest, validateProject, waitRun, inspectRun, inspectResults, redcheckRun } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-lessons-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = jobs => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()] });

function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;
const update = fake(`fs.writeFileSync('input.txt','updated'); ${done}`);

async function waitForJobStatus(root, id, status) {
  for (let i = 0; i < 100; i++) {
    try { const state = await readState(root, id); if (state.jobs[0]?.status === status) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

// --- 1 & 2: wait, and inspect's worker notes/cost -------------------------------------------

test('wait returns immediately for an already-terminal run and reports per-job cost/notes', async t => {
  const root = await fixture(t);
  const notes = ['did the thing'];
  const script = `fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ files_changed: ['input.txt'], notes }))},total_cost_usd:0.5}));`;
  const state = await runManifest(root, manifest(), { spawnImpl: fake(script) });
  const report = await waitRun(root, state.id);
  assert.equal(report.runId, state.id);
  assert.equal(report.status, 'complete');
  assert.equal(report.costUsd, 0.5);
  assert.deepEqual(report.jobs, [{ id: 'writer', status: 'complete', costUsd: 0.5, tokens: null, notes: ['did the thing'] }]);
  assert.ok(report.durationMs >= 0);
});

test('wait polls saved status until a running job reaches a terminal status', async t => {
  const root = await fixture(t);
  const pending = runManifest(root, manifest([job({ timeoutMs: 5000 })]), { id: 'wait-poll', spawnImpl: fake(`setTimeout(()=>{fs.writeFileSync('input.txt','updated');${done}},150)`) });
  for (let i = 0; i < 100; i++) { try { await readState(root, 'wait-poll'); break; } catch {} await new Promise(resolve => setTimeout(resolve, 5)); }
  const report = await waitRun(root, 'wait-poll', { pollMs: 20 });
  assert.equal(report.status, 'complete');
  await pending;
});

test('wait exits 2 on --timeout expiry with status still running, and rejects an unknown run id', async t => {
  const root = await fixture(t);
  const pending = runManifest(root, manifest(), { id: 'cli-wait-timeout', spawnImpl: fake('setInterval(()=>{},1000)') });
  await waitForJobStatus(root, 'cli-wait-timeout', 'running');
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'wait', 'cli-wait-timeout', '--timeout', '0.05']), error => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).status, 'running');
    return true;
  });
  await cancelRun(root, 'cli-wait-timeout');
  await pending;
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'wait', 'no-such-run']), error => {
    assert.equal(error.code, 1);
    return true;
  });
});

test('wait CLI exits 1 when the run failed and 0 with summed cost when it completed', async t => {
  const root = await fixture(t);
  const failed = await runManifest(root, manifest(), { spawnImpl: fake('process.exit(7)') });
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'wait', failed.id]), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).status, 'failed');
    return true;
  });
  const complete = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',total_cost_usd:0.25}));`) });
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'wait', complete.id]);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.status, 'complete');
  assert.equal(parsed.costUsd, 0.25);
  assert.equal(parsed.jobs[0].costUsd, 0.25);
});

test('inspect exposes a worker\'s parsed final JSON result and reported cost, capping notes at 20 items of 500 chars', async t => {
  const root = await fixture(t);
  const notes = Array.from({ length: 25 }, (_, i) => `note-${i}-`.repeat(100));
  const resultLine = JSON.stringify({ files_changed: ['input.txt'], notes });
  const script = `fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(resultLine)},total_cost_usd:0.25}));`;
  const state = await runManifest(root, manifest(), { spawnImpl: fake(script) });
  const report = await inspectRun(root, state.id);
  assert.equal(report.jobs[0].costUsd, 0.25);
  assert.deepEqual(report.jobs[0].result.files_changed, ['input.txt']);
  assert.equal(report.jobs[0].result.notes.length, 20);
  for (const note of report.jobs[0].result.notes) assert.ok(note.length <= 500);
});

test('inspect reports a null result and null cost when no line parses as a JSON object', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Just prose, no JSON here.'}));`) });
  const report = await inspectRun(root, state.id);
  assert.equal(report.jobs[0].result, null);
  assert.equal(report.jobs[0].costUsd, null);
});

test('inspect and wait pick the last line that parses as a JSON object, skipping trailing prose', async t => {
  const root = await fixture(t);
  const jsonLine = JSON.stringify({ files_changed: ['input.txt'], notes: ['keep me'] });
  const responseText = `${jsonLine}\ntrailing prose after the JSON line`;
  const script = `fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(responseText)}}));`;
  const state = await runManifest(root, manifest(), { spawnImpl: fake(script) });
  const inspectReport = await inspectRun(root, state.id);
  assert.deepEqual(inspectReport.jobs[0].result.notes, ['keep me']);
  const waitReport = await waitRun(root, state.id);
  assert.deepEqual(waitReport.jobs[0].notes, ['keep me']);
});

// --- 3: validate refuses untracked/ignored codex context files -------------------------------

async function codexFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-codex-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'tracked content');
  await fs.writeFile(path.join(root, '.gitignore'), 'ignored.txt\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture']);
  return root;
}
const codexJob = (overrides = {}) => ({ id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Update the output.', context: ['tracked.txt'], outputs: [], timeoutMs: 5000, ...overrides });
const codexManifest = job => ({ version: 1, jobs: [job] });

test('validate refuses a codex job whose context file is untracked by git', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'not committed');
  await assert.rejects(validateProject(root, codexManifest(codexJob({ context: ['untracked.txt'] }))), /Job writer: codex context file untracked\.txt is not tracked by git \(codex sees HEAD only\)/);
});

test('validate refuses a codex job whose context file is git-ignored', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'ignored.txt'), 'ignored content');
  await assert.rejects(validateProject(root, codexManifest(codexJob({ context: ['ignored.txt'] }))), /Job writer: codex context file ignored\.txt is not tracked by git/);
});

test('validate keeps a tracked but uncommitted codex context file as a warning, not a refusal', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'tracked.txt'), 'modified but still tracked');
  const report = await validateProject(root, codexManifest(codexJob()));
  assert.equal(report.status, 'valid');
  assert.deepEqual(report.warnings[0].files, ['tracked.txt']);
});

test('the codex tracked-file refusal never applies to a non-codex job', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'not committed');
  const claudeManifest = { version: 1, jobs: [{ id: 'reader', agent: 'claude', model: 'sonnet', prompt: 'Read it.', context: ['untracked.txt'], outputs: [], timeoutMs: 5000 }] };
  assert.equal((await validateProject(root, claudeManifest)).status, 'valid');
});

test('run refuses the same untracked codex context before dispatching any worker', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'not committed');
  const state = await runManifest(root, codexManifest(codexJob({ context: ['untracked.txt'] })), { platform: 'darwin', spawnImpl: () => assert.fail('must not spawn') });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /is not tracked by git/);
});

test('validateProject accepts an injected exec, calling it with the expected git argv', async t => {
  const root = await codexFixture(t);
  await fs.writeFile(path.join(root, 'untracked.txt'), 'not committed');
  const calls = [];
  const fakeExec = async (cmd, args) => { calls.push([cmd, args]); return { stdout: '' }; };
  const report = await validateProject(root, codexManifest(codexJob({ context: ['untracked.txt'] })), { exec: fakeExec });
  assert.equal(report.status, 'valid');
  assert.deepEqual(calls[0], ['git', ['-C', root, 'ls-files', '--error-unmatch', '--', 'untracked.txt']]);
});

test('an injected exec that reports a file untracked drives the refusal even for a genuinely tracked file', async t => {
  const root = await codexFixture(t);
  const fakeExec = async () => { throw Object.assign(Error('not tracked'), { code: 1 }); };
  await assert.rejects(validateProject(root, codexManifest(codexJob()), { exec: fakeExec }), /Job writer: codex context file tracked\.txt is not tracked by git/);
});

// --- 4: mutation checks -----------------------------------------------------------------------

const mutantManifest = (mutants, mutantCheck) => ({ version: 1, jobs: [job()], ...(mutants !== undefined ? { mutants } : {}), ...(mutantCheck !== undefined ? { mutantCheck } : {}) });

test('validateManifest accepts a well-formed mutants/mutantCheck pair', () => {
  assert.doesNotThrow(() => validateManifest(mutantManifest([{ name: 'm1', file: 'src/a.js', find: 'x', replace: 'y' }], { argv: ['node', '-e', '1'] })));
});

test('validateManifest rejects malformed mutants entries', () => {
  assert.throws(() => validateManifest(mutantManifest(Array.from({ length: 33 }, (_, i) => ({ name: `m${i}`, file: 'a.js', find: 'x', replace: 'y' })))), /at most 32 mutants/);
  assert.throws(() => validateManifest(mutantManifest([{ name: 'm1', file: 'a.js', find: 'x', replace: 'y', extra: true }])), /Unknown mutant field/);
  assert.throws(() => validateManifest(mutantManifest([{ name: '', file: 'a.js', find: 'x', replace: 'y' }])), /Invalid or duplicate mutant name/);
  assert.throws(() => validateManifest(mutantManifest([{ name: 'dup', file: 'a.js', find: 'x', replace: 'y' }, { name: 'dup', file: 'b.js', find: 'x', replace: 'y' }])), /Invalid or duplicate mutant name/);
  for (const bad of ['../escape.js', '.git/config', '.swarm/x', '/tmp/escape']) assert.throws(() => validateManifest(mutantManifest([{ name: 'm1', file: bad, find: 'x', replace: 'y' }])), /path/i);
  assert.throws(() => validateManifest(mutantManifest([{ name: 'm1', file: 'a.js', find: '', replace: 'y' }])), /find must be a non-empty string/);
  assert.throws(() => validateManifest(mutantManifest([{ name: 'm1', file: 'a.js', find: 'x', replace: 7 }])), /replace must be a string/);
});

test('validateManifest rejects malformed mutantCheck', () => {
  assert.throws(() => validateManifest(mutantManifest(undefined, { argv: [] })), /mutantCheck argv must be a non-empty array/);
  assert.throws(() => validateManifest(mutantManifest(undefined, { argv: ['node'], timeoutMs: 10 })), /mutantCheck timeoutMs must be 1000/);
  assert.throws(() => validateManifest(mutantManifest(undefined, { argv: ['node'], extra: true })), /Unknown mutantCheck field/);
  assert.throws(() => validateManifest(mutantManifest(undefined, { argv: [1] })), /mutantCheck argv items must be strings/);
});

test('integrate --mutants applies, checks, and always restores a mutant, reporting killed on a failing check', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', "process.exit(require('fs').readFileSync('input.txt','utf8')==='mutated'?1:0)"] } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  const result = await integrateRun(root, state.id, { mutants: true });
  assert.equal(result.mutants.length, 1);
  assert.equal(result.mutants[0].status, 'killed');
  assert.equal(result.mutants[0].exitCode, 1);
  assert.deepEqual(result.mutantsSummary, { killed: 1, survived: 0, errors: 0 });
  assert.equal(result.mutantsPassed, true);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
});

test('a mutant that a check cannot detect is reported survived and fails --require-checks', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', 'process.exit(0)'] } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  const result = await integrateRun(root, state.id, { mutants: true });
  assert.equal(result.mutants[0].status, 'survived');
  assert.equal(result.mutantsSummary.survived, 1);
  assert.equal(result.mutantsPassed, false);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');

  const secondPlan = { ...plan };
  const secondState = await runManifest(root, secondPlan, { spawnImpl: update, id: 'require-mutants' });
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', secondState.id, '--mutants', '--require-checks']), error => {
    assert.equal(error.code, 1);
    assert.equal(JSON.parse(error.stdout).mutantsPassed, false);
    return true;
  });
});

// Field lesson #161: a find that does not occur exactly once now refuses integrate --mutants
// before any project write, naming the mutant, instead of integrating and reporting an error.
test('a mutant whose find text does not occur exactly once refuses integrate before any write', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'bad', file: 'input.txt', find: 'zzz-not-present', replace: 'y' }], mutantCheck: { argv: [process.execPath, '-e', 'process.exit(0)'] } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  await assert.rejects(integrateRun(root, state.id, { mutants: true }), /Refusing to run mutants: 1 invalid mutant\(s\), nothing mutated: bad: invalid-find \(input\.txt: find matched 0 times\)/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
});

test('a mutant whose find text occurs twice (in the proposed bytes) refuses integrate and no check runs', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'twice', file: 'input.txt', find: 'updated', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', 'process.exit(1)'] } };
  const state = await runManifest(root, plan, { spawnImpl: fake(`fs.writeFileSync('input.txt','updated updated'); ${done}`) });
  await assert.rejects(integrateRun(root, state.id, { mutants: true }), /twice: ambiguous-find \(input\.txt: find matched 2 times\)/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
});

test('a mutation check timeout is reported as an error and still restores the original file', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'hang', file: 'input.txt', find: 'updated', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', 'setInterval(()=>{},1000)'], timeoutMs: 1000 } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  const result = await integrateRun(root, state.id, { mutants: true });
  assert.equal(result.mutants[0].status, 'error');
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
});

test('integrate --mutants without a mutants field in the manifest is a clear error', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  await assert.rejects(integrateRun(root, state.id, { mutants: true }), /No mutants declared/);
});

test('integrate --mutants without mutantCheck declared is a clear error', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }] };
  const state = await runManifest(root, plan, { spawnImpl: update });
  await assert.rejects(integrateRun(root, state.id, { mutants: true }), /No mutantCheck declared/);
});

test('mutants never execute during run, only during integrate --mutants', async t => {
  const root = await fixture(t);
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'flip', file: 'input.txt', find: 'original', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', '1'] } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  assert.equal(state.mutants, undefined);
  assert.equal(state.mutantsSummary, undefined);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  const proposed = await fs.readFile(path.join(root, '.swarm', 'workspaces', state.id, 'writer', 'input.txt'), 'utf8');
  assert.equal(proposed, 'updated');
});

test('integrate --mutants expands {root} inside a mutantCheck argv item to the run\'s absolute project root', async t => {
  const root = await fixture(t);
  const script = "require('fs').writeFileSync('root-received.txt',process.argv[1]);process.exit(1)";
  const plan = { version: 1, jobs: [job()], mutants: [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }], mutantCheck: { argv: [process.execPath, '-e', script, 'PREFIX={root}/marker'] } };
  const state = await runManifest(root, plan, { spawnImpl: update });
  const result = await integrateRun(root, state.id, { mutants: true });
  assert.equal(result.mutants[0].status, 'killed');
  assert.equal(await fs.readFile(path.join(root, 'root-received.txt'), 'utf8'), `PREFIX=${await fs.realpath(root)}/marker`);
});


// --- release lessons: denied reads and independently checked regressions --------------------

const deniedResult = (extra = {}) => `console.log(${JSON.stringify(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Finished', permission_denials: [{ tool_name: 'Read', tool_input: { file_path: 'outside.txt' } }], ...extra }))});`;

test('denial-only success completes, warns in run and inspect results, and integrates', async t => {
  const root = await fixture(t);
  const denials = [{ tool_name: 'Read', tool_input: { file_path: 'outside.txt' } }, { tool_name: 'Grep', tool_input: { pattern: 'x'.repeat(300) } }];
  const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${deniedResult({ permission_denials: denials })}`) });
  assert.equal(state.status, 'complete');
  assert.equal(state.jobs[0].error, null);
  assert.equal(state.warnings[0], 'permission denials: writer: Read outside.txt');
  assert.match(state.warnings[1], /^permission denials: writer: Grep /);
  assert.equal(state.warnings[1].length, 200);
  assert.deepEqual((await inspectResults(root, state.id)).warnings, state.warnings);
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'inspect', state.id, '--results']);
  assert.deepEqual(JSON.parse(stdout).warnings, state.warnings);
  assert.match(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8'), /Read only the files in your context; other reads may be denied\./);
  await integrateRun(root, state.id);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
});

test('denials never mask a nonzero exit, error result, or malformed provider stream', async t => {
  const root = await fixture(t);
  for (const ending of [`${deniedResult()}process.exitCode=7;`, deniedResult({ is_error: true, subtype: 'error_during_execution' }), `console.log('bad json');${deniedResult()}`]) {
    const state = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${ending}`) });
    assert.equal(state.status, 'failed');
    assert.ok(state.jobs[0].keptWorkspace);
    assert.equal(await fs.readFile(path.join(state.jobs[0].keptWorkspace, 'input.txt'), 'utf8'), 'updated');
    await assert.rejects(integrateRun(root, state.id), /Only a complete run/);
  }
});

test('failed workers retain changed declared outputs but unchanged failures do not claim retained work', async t => {
  const root = await fixture(t);
  const changed = await runManifest(root, manifest(), { spawnImpl: fake("fs.writeFileSync('input.txt','partial');process.exit(7)") });
  assert.equal(changed.status, 'failed');
  assert.equal(await fs.readFile(path.join(changed.jobs[0].keptWorkspace, 'input.txt'), 'utf8'), 'partial');
  const unchanged = await runManifest(root, manifest(), { spawnImpl: fake('process.exit(7)') });
  assert.equal(unchanged.jobs[0].keptWorkspace, null);
});

test('denials without a response or changed output fail; a written output alone suffices', async t => {
  const root = await fixture(t);
  const noResult = await runManifest(root, manifest(), { spawnImpl: fake(deniedResult({ result: '' })) });
  assert.equal(noResult.status, 'failed');
  const written = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated');${deniedResult({ result: '' })}`) });
  assert.equal(written.status, 'complete');
  const missing = await runManifest(root, manifest([job({ outputs: ['missing.txt'] })]), { spawnImpl: fake(deniedResult()) });
  assert.equal(missing.status, 'failed');
});

async function regressionRun(t, { integrate = true } = {}) {
  const root = await fixture(t);
  const tests = ['tests/regression.cjs', 'test/regression.cjs', 'src/example.test.cjs', 'src/example.spec.cjs', 'src/example_test.cjs'];
  const testBody = "const assert=require('node:assert/strict');const fs=require('node:fs');assert.equal(fs.readFileSync('input.txt','utf8'),'updated');";
  const files = Object.fromEntries(tests.map(file => [file, testBody]));
  files['input.txt'] = 'updated';
  files['added.txt'] = 'new output';
  const script = `for(const [file,body] of Object.entries(${JSON.stringify(files)})){fs.mkdirSync(file.includes('/')?file.slice(0,file.lastIndexOf('/')):'.',{recursive:true});fs.writeFileSync(file,body);} ${done}`;
  const state = await runManifest(root, manifest([job({ outputs: Object.keys(files) })]), { spawnImpl: fake(script) });
  assert.equal(state.status, 'complete');
  if (integrate) await integrateRun(root, state.id);
  return { root, state, tests, testBody };
}

test('redcheck runs regression tests against base, preserves every test naming pattern, restores new and existing outputs', async t => {
  const { root, state, tests, testBody } = await regressionRun(t);
  await fs.chmod(path.join(root, 'input.txt'), 0o755);
  const result = await redcheckRun(root, state.id, [process.execPath, 'tests/regression.cjs']);
  assert.equal(result.status, 'red');
  assert.equal(result.exitCode, 1);
  assert.deepEqual(result.restored, ['input.txt', 'added.txt']);
  assert.match(result.tail, /AssertionError/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal((await fs.stat(path.join(root, 'input.txt'))).mode & 0o777, 0o755);
  assert.equal(await fs.readFile(path.join(root, 'added.txt'), 'utf8'), 'new output');
  for (const file of tests) assert.equal(await fs.readFile(path.join(root, file), 'utf8'), testBody);
});

test('redcheck green means the command did not detect the old implementation and caps output', async t => {
  const { root, state } = await regressionRun(t);
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', "process.stdout.write('é'.repeat(3000))"]);
  assert.equal(result.status, 'green');
  assert.equal(result.exitCode, 0);
  assert.equal(result.tail, 'é'.repeat(2000));
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
});

test('redcheck restores all job outputs on spawn errors, timeouts, and signal termination', async t => {
  const { root, state } = await regressionRun(t);
  for (const [argv, options] of [
    [['missing-redcheck-executable'], {}],
    [[process.execPath, '-e', '1'], { spawnImpl: () => { throw Error('launch failed'); } }],
    [[process.execPath, '-e', 'setInterval(()=>{},1000)'], { timeoutMs: 50 }],
    [[process.execPath, '-e', "process.kill(process.pid,'SIGTERM')"], {}],
  ]) {
    const result = await redcheckRun(root, state.id, argv, options);
    assert.equal(result.status, 'error');
    assert.equal(result.exitCode, null);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
    assert.equal(await fs.readFile(path.join(root, 'added.txt'), 'utf8'), 'new output');
  }
});

test('redcheck refuses unrelated edits before any mutation or command execution', async t => {
  const { root, state } = await regressionRun(t);
  await fs.writeFile(path.join(root, 'added.txt'), 'coordinator edit');
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', '1'], { spawnImpl: () => assert.fail('must not run') });
  assert.equal(result.status, 'error');
  assert.match(result.tail, /Redcheck conflict: added.txt/);
  assert.deepEqual(result.restored, []);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal(await fs.readFile(path.join(root, 'added.txt'), 'utf8'), 'coordinator edit');
});

test('redcheck accepts a complete unintegrated run and restores job versions afterward', async t => {
  const { root, state } = await regressionRun(t, { integrate: false });
  const script = "const fs=require('node:fs');if(fs.readFileSync('input.txt','utf8')!=='original'||fs.existsSync('added.txt'))process.exit(2);process.exit(1)";
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', script]);
  assert.equal(result.status, 'red');
  assert.equal(result.exitCode, 1);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  assert.equal(await fs.readFile(path.join(root, 'added.txt'), 'utf8'), 'new output');
});

test('redcheck uses verified git base bytes for hash-only records', async t => {
  const root = await codexFixture(t);
  const state = await runManifest(root, manifest([job({ context: ['tracked.txt'], outputs: ['tracked.txt'] })]), { spawnImpl: fake(`fs.writeFileSync('tracked.txt','updated');${done}`) });
  await integrateRun(root, state.id);
  const saved = await readState(root, state.id);
  delete saved.jobs[0].baseWorkspace;
  await fs.writeFile(path.join(root, '.swarm/runs', state.id, 'state.json'), JSON.stringify(saved));
  const result = await redcheckRun(root, state.id, [process.execPath, '-e', "process.exit(require('fs').readFileSync('tracked.txt','utf8')==='tracked content'?1:0)"]);
  assert.equal(result.status, 'red');
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'updated');
  saved.jobs[0].baseHashes['tracked.txt'] = 'bad-hash';
  await fs.writeFile(path.join(root, '.swarm/runs', state.id, 'state.json'), JSON.stringify(saved));
  const refused = await redcheckRun(root, state.id, [process.execPath, '-e', '1']);
  assert.equal(refused.status, 'error');
  assert.match(refused.tail, /Base content unavailable or mismatched/);
  assert.equal(await fs.readFile(path.join(root, 'tracked.txt'), 'utf8'), 'updated');
});

test('redcheck CLI prints one JSON line, exits 0 on red and 1 on green or error, and passes argv literally', async t => {
  const { root, state } = await regressionRun(t);
  const { stdout } = await execFileAsync(process.execPath, [CLI, '--root', root, 'redcheck', state.id, '--test', process.execPath, 'tests/regression.cjs']);
  assert.equal(stdout.trim().split('\n').length, 1);
  assert.equal(JSON.parse(stdout).status, 'red');
  for (const [command, status] of [
    [[process.execPath, '-e', 'process.stdout.write(process.argv.slice(1).join("|"))', '--', '--root', 'literal;arg'], 'green'],
    [['missing-redcheck-executable'], 'error'],
    [[], 'error'],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'redcheck', state.id, '--test', ...command]), error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout.trim().split('\n').length, 1);
      const result = JSON.parse(error.stdout);
      assert.equal(result.status, status);
      if (status === 'green') assert.equal(result.tail, '--root|literal;arg');
      return true;
    });
  }
});

test('redcheck refuses failed runs, altered metadata, and an active integration lock', async t => {
  const root = await fixture(t);
  const failed = await runManifest(root, manifest(), { spawnImpl: fake('process.exit(7)') });
  assert.equal((await redcheckRun(root, failed.id, [process.execPath, '-e', '1'])).status, 'error');
  const state = await runManifest(root, manifest(), { spawnImpl: update });
  await fs.mkdir(path.join(root, '.swarm/integration.lock'));
  const locked = await redcheckRun(root, state.id, [process.execPath, '-e', '1']);
  assert.equal(locked.status, 'error');
  assert.ok((await fs.stat(path.join(root, '.swarm/integration.lock'))).isDirectory());
  await fs.rmdir(path.join(root, '.swarm/integration.lock'));
  state.jobs[0].outputs.push('unowned.txt');
  await fs.writeFile(path.join(root, '.swarm/runs', state.id, 'state.json'), JSON.stringify(state));
  assert.match((await redcheckRun(root, state.id, [process.execPath, '-e', '1'])).tail, /metadata does not match/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
});


test('failed Codex jobs keep a changed declared output in their actual worktree', async t => {
  const root = await codexFixture(t);
  const state = await runManifest(root, codexManifest(codexJob({ outputs: ['tracked.txt'] })), {
    platform: 'darwin',
    spawnImpl: fake("fs.writeFileSync('tracked.txt','partial work');process.exit(7)"),
  });
  assert.equal(state.status, 'failed');
  const kept = state.jobs[0].keptWorkspace;
  assert.equal(kept, path.join(root, '.swarm/runs', state.id, 'worktrees/writer'));
  assert.equal(await fs.readFile(path.join(kept, 'tracked.txt'), 'utf8'), 'partial work');
  assert.equal((await git(root, ['worktree', 'list', '--porcelain'])).includes(kept), true);
  await assert.rejects(integrateRun(root, state.id), /Only a complete run/);
});


test('Codex output-validation failures preserve other completed declared files', async t => {
  const root = await codexFixture(t);
  const state = await runManifest(root, codexManifest(codexJob({ outputs: ['tracked.txt', 'missing.txt'] })), {
    platform: 'darwin',
    spawnImpl: (_command, args, options) => {
      const resultPath = args[args.indexOf('-o') + 1];
      return fake(`fs.writeFileSync('tracked.txt','finished work');fs.writeFileSync(${JSON.stringify(resultPath)},'{}')`)(_command, args, options);
    },
  });
  assert.equal(state.status, 'failed');
  assert.match(state.jobs[0].error, /Missing output/);
  assert.equal(await fs.readFile(path.join(state.jobs[0].keptWorkspace, 'tracked.txt'), 'utf8'), 'finished work');
  await assert.rejects(integrateRun(root, state.id), /Only a complete run/);
});
