// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
const require_readdir = dir => { try { return readdirSync(dir); } catch { return []; } };
const liveEntries = async dir => (await fs.readdir(dir)).filter(name => name !== 'locks');
import { runManifest, validateManifest, validateProject, integrateRun, waitRun, inspectRun, inspectResults } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-sched-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function tmpLiveDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-sched-live-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

const job = (overrides = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.', context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides });
const manifest = (jobs, extra = {}) => ({ version: 1, concurrency: 2, jobs: jobs ?? [job()], ...extra });
const checkManifest = (jobs, checks) => ({ version: 1, concurrency: 2, jobs, checks });

function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
// Different jobs in the same run need different fake behavior; the workspace basename is the job id.
function multiFake(scripts) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${scripts[path.basename(options.cwd)]}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;

async function gitFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'project-swarm-sched-git-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init']);
  return root;
}
// Commits only what is already staged, so a test can leave a file untracked on purpose.
async function gitCommitStaged(root, message = 'fixture') {
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
}
async function gitCommit(root, message = 'fixture') {
  await git(root, ['add', '.']);
  await git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', message]);
}

// --- Board wiring: second-writer refusal and unregister ------------------------------------

test('a second worktree of the same git repo refuses to run when a live run already claims one of its outputs, and starts no job', async t => {
  const repo = await gitFixture(t);
  await fs.writeFile(path.join(repo, 'shared.txt'), 'base');
  await gitCommit(repo, 'init');
  const worktreeA = path.join(repo, 'wt-a'), worktreeB = path.join(repo, 'wt-b');
  await git(repo, ['worktree', 'add', '--detach', worktreeA, 'HEAD']);
  await git(repo, ['worktree', 'add', '--detach', worktreeB, 'HEAD']);
  const rootA = await fs.realpath(worktreeA), rootB = await fs.realpath(worktreeB);
  const liveDir = await tmpLiveDir(t);
  await registerLiveRun({ runId: 'live-elsewhere', root: rootA, outputs: ['shared.txt'], dir: liveDir });
  t.after(() => unregisterLiveRun('live-elsewhere', { dir: liveDir }));
  let spawnCalls = 0;
  await assert.rejects(
    runManifest(rootB, manifest([job({ context: ['shared.txt'], outputs: ['shared.txt'] })]), { spawnImpl: () => { spawnCalls++; throw Error('must not spawn'); }, liveDir }),
    error => {
      assert.match(error.message, /^Refusing to run: shared\.txt is also written by live run live-elsewhere in /);
      assert.equal(error.details.conflicts.length, 1);
      assert.equal(error.details.conflicts[0].runId, 'live-elsewhere');
      return true;
    }
  );
  assert.equal(spawnCalls, 0);
});

test('a live run registration is removed after a run completes, fails, or throws before it can start', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);

  const completed = await runManifest(root, manifest(), { spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${done}`), liveDir });
  assert.equal(completed.status, 'complete');
  assert.deepEqual(await liveEntries(liveDir), []);

  const failed = await runManifest(root, manifest(), { spawnImpl: fake('process.exit(3)'), liveDir });
  assert.equal(failed.status, 'failed');
  assert.deepEqual(await liveEntries(liveDir), []);

  // Pre-creating the claim file makes runManifestBody's own claim write throw (EEXIST) after
  // registration already happened, exercising the finally-unregister-on-throw path.
  const id = 'throws-before-claim';
  await fs.mkdir(path.join(root, '.swarm/runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm/runs', id, 'claim'), '');
  let spawnCalls = 0;
  await assert.rejects(
    runManifest(root, manifest(), { id, liveDir, spawnImpl: () => { spawnCalls++; throw Error('must not spawn'); } }),
    /EEXIST/
  );
  assert.equal(spawnCalls, 0);
  assert.deepEqual(await liveEntries(liveDir), []);
});

// --- `after` job chains -----------------------------------------------------------------------

test('validateManifest validates after: unknown id, self-reference, duplicates, empty array, codex agent, and cycles', () => {
  assert.throws(() => validateManifest(manifest([job(), job({ id: 'b', outputs: ['b.txt'], after: ['missing'] })])), /Job b after names unknown job missing/);
  assert.throws(() => validateManifest(manifest([job({ after: ['writer'] })])), /Job writer after names itself/);
  assert.throws(() => validateManifest(manifest([job(), job({ id: 'b', outputs: ['b.txt'], after: ['writer', 'writer'] })])), /Job b has duplicate entries in after/);
  assert.throws(() => validateManifest(manifest([job(), job({ id: 'b', outputs: ['b.txt'], after: [] })])), /after must be a non-empty array/);
  assert.throws(() => validateManifest(manifest([job(), job({ id: 'b', agent: 'codex', model: 'test-model', context: ['input.txt'], outputs: [], after: ['writer'] })])), /after is not supported for codex jobs yet/);
  assert.throws(() => validateManifest(manifest([job({ id: 'a', after: ['b'] }), job({ id: 'b', outputs: ['b.txt'], after: ['a'] })])), /after cycle: a -> b -> a/);
  assert.doesNotThrow(() => validateManifest(manifest([job(), job({ id: 'b', outputs: ['b.txt'], after: ['writer'] })])));
});

test('a dependent job starts only after its "after" jobs complete, and sees their changed outputs copied into its workspace', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const jobs = [
    job({ id: 'a', outputs: ['a.txt'] }),
    job({ id: 'b', outputs: ['b.txt'], after: ['a'] }),
  ];
  const state = await runManifest(root, manifest(jobs), {
    liveDir,
    spawnImpl: multiFake({
      a: `fs.writeFileSync('a.txt','from-a'); ${done}`,
      b: `const seen = fs.readFileSync('a.txt','utf8'); fs.writeFileSync('b.txt', seen + '-seen'); ${done}`,
    }),
  });
  assert.equal(state.status, 'complete');
  const recordA = state.jobs.find(j => j.id === 'a'), recordB = state.jobs.find(j => j.id === 'b');
  assert.ok(Date.parse(recordB.startedAt) >= Date.parse(recordA.finishedAt));
  assert.equal(await fs.readFile(path.join(root, recordB.workspace, 'a.txt'), 'utf8'), 'from-a');
  assert.equal(await fs.readFile(path.join(root, recordB.workspace, 'b.txt'), 'utf8'), 'from-a-seen');
});

test('a failed dependency makes its dependent skipped, naming the dependency and its status, and the dependent never starts', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const jobs = [
    job({ id: 'a', outputs: ['a.txt'] }),
    job({ id: 'b', outputs: ['b.txt'], after: ['a'] }),
  ];
  const state = await runManifest(root, manifest(jobs), {
    liveDir,
    spawnImpl: multiFake({
      a: 'process.exit(5);',
      b: `fs.writeFileSync('b.txt','should not run'); ${done}`,
    }),
  });
  assert.equal(state.status, 'failed');
  const recordA = state.jobs.find(j => j.id === 'a'), recordB = state.jobs.find(j => j.id === 'b');
  assert.equal(recordA.status, 'failed');
  assert.equal(recordB.status, 'skipped');
  assert.equal(recordB.error, 'after a failed');
  assert.equal(recordB.startedAt, null);
});

// --- `repeat` and `{new}` ---------------------------------------------------------------------

test('validateManifest rejects a malformed check repeat and accepts the boundary values', () => {
  assert.throws(() => validateManifest(checkManifest([job()], [{ name: 'x', argv: ['node'], repeat: 0 }])), /Check repeat must be 1–20/);
  assert.throws(() => validateManifest(checkManifest([job()], [{ name: 'x', argv: ['node'], repeat: 21 }])), /Check repeat must be 1–20/);
  assert.throws(() => validateManifest(checkManifest([job()], [{ name: 'x', argv: ['node'], repeat: 1.5 }])), /Check repeat must be 1–20/);
  assert.doesNotThrow(() => validateManifest(checkManifest([job()], [{ name: 'x', argv: ['node'], repeat: 1 }])));
  assert.doesNotThrow(() => validateManifest(checkManifest([job()], [{ name: 'x', argv: ['node'], repeat: 20 }])));
});

test('a check with repeat stops at the first failing run and reports runs/failedRun', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const counterScript = "const fs=require('fs');let n=0;try{n=Number(fs.readFileSync('counter.txt','utf8'))}catch{};n++;fs.writeFileSync('counter.txt',String(n));process.exit(n===2?1:0)";
  const checks = [{ name: 'flaky', argv: [process.execPath, '-e', counterScript], repeat: 5 }];
  const state = await runManifest(root, checkManifest([job()], checks), { liveDir, spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${done}`) });
  const result = await integrateRun(root, state.id);
  assert.equal(result.checks[0].status, 'failed');
  assert.equal(result.checks[0].runs, 2);
  assert.equal(result.checks[0].failedRun, 2);
  assert.equal((await fs.readFile(path.join(root, 'counter.txt'), 'utf8')).trim(), '2');
});

test('a check with repeat that always passes runs exactly `repeat` times and reports no failedRun', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const checks = [{ name: 'steady', argv: [process.execPath, '-e', 'process.exit(0)'], repeat: 3 }];
  const state = await runManifest(root, checkManifest([job()], checks), { liveDir, spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${done}`) });
  const result = await integrateRun(root, state.id);
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.checks[0].runs, 3);
  assert.equal(result.checks[0].failedRun, undefined);
});

test('{new} and {new:.ext} expand only to files absent when the run started, and a zero-match placeholder skips', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const newScript = "require('fs').writeFileSync('new-received.json', JSON.stringify(process.argv.slice(1)))";
  const checks = [
    { name: 'new-only', argv: [process.execPath, '-e', newScript, '{new}'] },
    { name: 'zero-match', argv: [process.execPath, '-e', 'process.exit(1)', '{new:.py}'] },
  ];
  const state = await runManifest(root, checkManifest([job({ outputs: ['input.txt', 'created.txt'] })], checks), {
    liveDir,
    spawnImpl: fake(`fs.writeFileSync('input.txt','updated');fs.writeFileSync('created.txt','x'); ${done}`),
  });
  const result = await integrateRun(root, state.id);
  assert.deepEqual(result.files.sort(), ['created.txt', 'input.txt']);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'new-received.json'), 'utf8')), ['created.txt']);
  assert.equal(result.checks[0].status, 'passed');
  assert.equal(result.checks[1].status, 'skipped');
});

// --- Codex contract ----------------------------------------------------------------------------

test('the codex call site passes the manifest contract into codexMessage, and the untracked-context refusal skips the contract path', async t => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, 'CONTRACT.md'), 'the shared contract text');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'tracked');
  await git(root, ['add', 'tracked.txt']);
  await gitCommitStaged(root, 'fixture');
  const liveDir = await tmpLiveDir(t);
  const codexJob = { id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Do the task.', context: ['CONTRACT.md', 'tracked.txt'], outputs: [], timeoutMs: 5000 };
  const codexManifest = { version: 1, jobs: [codexJob], contract: 'CONTRACT.md' };
  const state = await runManifest(root, codexManifest, {
    platform: 'darwin',
    liveDir,
    // CONTRACT.md stays untracked; the fake process only needs to exit so the run settles.
    spawnImpl: (_command, _args, options) => spawn(process.execPath, ['-e', 'process.exit(1)'], options),
  });
  assert.doesNotMatch(state.error ?? '', /is not tracked by git/);
  const messageText = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
  assert.match(messageText, /Shared contract \(CONTRACT\.md\)\. Read it first; it wins over any other file:/);
  assert.match(messageText, /the shared contract text/);
});

// --- Tokens and cost -----------------------------------------------------------------------

test('wait, inspect, and inspect --results roll up per-job tokens into a run total and list jobs with no reported cost', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const jobs = [
    job({ id: 'a', outputs: ['a.txt'] }),
    job({ id: 'b', outputs: ['b.txt'] }),
  ];
  const state = await runManifest(root, manifest(jobs), {
    liveDir,
    spawnImpl: multiFake({
      a: `fs.writeFileSync('a.txt','x'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',usage:{total_tokens:100},total_cost_usd:0.5}));`,
      b: `fs.writeFileSync('b.txt','y'); console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`,
    }),
  });
  assert.equal(state.status, 'complete');

  const waited = await waitRun(root, state.id);
  assert.deepEqual(waited.jobs.map(j => ({ id: j.id, tokens: j.tokens, costUsd: j.costUsd })), [{ id: 'a', tokens: 100, costUsd: 0.5 }, { id: 'b', tokens: null, costUsd: null }]);
  assert.equal(waited.tokens, 100);
  assert.equal(waited.costUsd, 0.5);
  assert.deepEqual(waited.costNotReported, ['b']);

  const inspected = await inspectRun(root, state.id);
  assert.equal(inspected.tokens, 100);
  assert.deepEqual(inspected.costNotReported, ['b']);
  assert.equal(inspected.jobs.find(j => j.id === 'a').tokens, 100);
  assert.equal(inspected.jobs.find(j => j.id === 'b').tokens, null);

  const results = await inspectResults(root, state.id);
  assert.equal(results.tokens, 100);
  assert.deepEqual(results.costNotReported, ['b']);
  assert.equal(results.jobs.find(j => j.id === 'a').tokens, 100);
  assert.equal(results.jobs.find(j => j.id === 'b').tokens, null);
});

test('wait reports null tokens and every job in costNotReported when no job reports usage or cost', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const state = await runManifest(root, manifest(), { liveDir, spawnImpl: fake(`fs.writeFileSync('input.txt','updated'); ${done}`) });
  const waited = await waitRun(root, state.id);
  assert.equal(waited.tokens, null);
  assert.deepEqual(waited.costNotReported, ['writer']);
});

test('a running run is on the board while its jobs run, and gone once it ends', async t => {
  const root = await fixture(t);
  const liveDir = await tmpLiveDir(t);
  const seen = [];
  const state = await runManifest(root, manifest([job()]), {
    liveDir,
    onState: () => { seen.push(...require_readdir(liveDir)); },
    spawnImpl: fake(`fs.writeFileSync('input.txt','x'); ${done}`),
  });
  assert.equal(state.status, 'complete');
  assert.ok(seen.includes(`${state.id}.json`), 'the run registered itself before its first state save');
  assert.deepEqual(await liveEntries(liveDir), []);
});

test('validate lets a codex job read the untracked manifest contract, and still refuses any other untracked context file', async t => {
  const root = await gitFixture(t);
  await fs.writeFile(path.join(root, 'CONTRACT.md'), 'contract');
  await fs.writeFile(path.join(root, 'NOTES.md'), 'untracked notes');
  await fs.writeFile(path.join(root, 'tracked.txt'), 'tracked');
  await git(root, ['add', 'tracked.txt']);
  await gitCommitStaged(root, 'fixture');
  const codexJob = context => ({ id: 'writer', agent: 'codex', model: 'test-model', prompt: 'Do the task.', context, outputs: [], timeoutMs: 5000 });
  await validateProject(root, { version: 1, jobs: [codexJob(['CONTRACT.md', 'tracked.txt'])], contract: 'CONTRACT.md' });
  await assert.rejects(validateProject(root, { version: 1, jobs: [codexJob(['CONTRACT.md', 'NOTES.md', 'tracked.txt'])], contract: 'CONTRACT.md' }), /codex context file NOTES\.md is not tracked by git/);
  await assert.rejects(validateProject(root, { version: 1, jobs: [codexJob(['CONTRACT.md', 'tracked.txt'])] }), /codex context file CONTRACT\.md is not tracked by git/);
});
