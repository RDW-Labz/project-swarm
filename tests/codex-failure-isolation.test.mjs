// SPDX-License-Identifier: Apache-2.0
// U14/U15/U16 field-lessons regression tests (contract EXP-2). Helpers below are copied from
// tests/lessons.test.mjs and tests/codex-adapter.test.mjs rather than imported, per instructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chmodSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManifest, isRunFatalError, validateManifest } from '../tools/swarm.mjs';
import { git, codexMessage } from '../tools/codex-adapter.mjs';

function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'Worker complete'}));`;

async function codexFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-codex-isolation-')));
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

// Case 1: a codex job whose fake exits 0 without ever writing its declared output is a failed
// result (not a coordinator-level throw), and its stdout/stderr survive in the run directory.
test('U15: a missing codex output fails the job and keeps its stdout/stderr logs', async t => {
  const root = await codexFixture(t);
  const state = await runManifest(root, codexManifest(codexJob({ outputs: ['result.txt'] })), {
    platform: 'darwin',
    spawnImpl: (command, args, options) => {
      const resultPath = args[args.indexOf('-o') + 1];
      return fake(`process.stderr.write('CODEX-STDERR-MARKER\\n');process.stdout.write('CODEX-STDOUT-MARKER\\n');fs.writeFileSync(${JSON.stringify(resultPath)},'{}');`)(command, args, options);
    },
  });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].error, /^Missing output \(deletions are never propagated\): /);
  assert.ok(!/Coordinator failed/.test(state.jobs[0].error));
  const stderrLog = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/stderr.log'), 'utf8');
  const providerLog = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/provider.jsonl'), 'utf8');
  assert.match(stderrLog, /CODEX-STDERR-MARKER/);
  assert.match(providerLog, /CODEX-STDOUT-MARKER/);
});

// Case 2: "Codex output-validation failures preserve other completed declared files" in
// tests/lessons.test.mjs already covers a missing output alongside a genuinely written one; not
// duplicated here.

// Case 3: with concurrency 2, one codex job failing immediately (as in case 1) never stops a
// second job that is still running.
test('U14: a job that fails immediately does not stop a concurrent job still running', async t => {
  const root = await codexFixture(t);
  const manifest = {
    version: 1, concurrency: 2,
    jobs: [
      codexJob({ id: 'a', outputs: ['a-output.txt'] }),
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
    ],
  };
  const state = await runManifest(root, manifest, {
    platform: 'darwin',
    spawnImpl: (command, args, options) => {
      if (command === 'sandbox-exec') {
        const resultPath = args[args.indexOf('-o') + 1];
        return fake(`fs.writeFileSync(${JSON.stringify(resultPath)},'{}');`)(command, args, options);
      }
      return fake(`setTimeout(() => { fs.writeFileSync('b-output.txt','done'); ${done} }, 400);`)(command, args, options);
    },
  });
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  assert.equal(a.status, 'failed');
  assert.match(a.error, /^Missing output \(deletions are never propagated\): /);
  assert.equal(b.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, b.workspace, 'b-output.txt'), 'utf8'), 'done');
  assert.equal(state.status, 'failed');
});

// Case 4: a job's own exception fails only that job; its dependents are skipped, while an
// unrelated job completes.
test('U14: dependents of a failed job are skipped while an unrelated job completes', async t => {
  const root = await codexFixture(t);
  const manifest = {
    version: 1, concurrency: 2,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['a-output.txt'], timeoutMs: 5000 },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
      { id: 'c', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['c-output.txt'], timeoutMs: 5000, after: ['a'] },
    ],
  };
  const state = await runManifest(root, manifest, {
    platform: 'darwin',
    spawnImpl: (command, args, options) => {
      const jobId = path.basename(options.cwd);
      if (jobId === 'a') throw Error('fake spawn failure');
      return fake(`fs.writeFileSync('${jobId}-output.txt','done'); ${done}`)(command, args, options);
    },
  });
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  const c = state.jobs.find(job => job.id === 'c');
  assert.equal(a.status, 'failed');
  assert.equal(b.status, 'complete');
  assert.equal(c.status, 'skipped');
  assert.match(c.error, /^after a failed/);
  assert.equal(state.status, 'failed');
});

// Review follow-up (PR #46): a permission-denied state write under .swarm is environmental,
// not job-scoped; it must stop the run outright, so a queued job never starts, by making
// the job's run directory read-only.
test('run-fatal: a permission-denied state write under .swarm stops the run and starts no queued job', async t => {
  const root = await codexFixture(t);
  const id = 'run-fatal-isolation';
  let injected = false;
  const spawnedJobIds = [];
  const manifest = {
    version: 1, concurrency: 1,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['a-output.txt'], timeoutMs: 5000 },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
    ],
  };
  let state;
  try {
    state = await runManifest(root, manifest, {
      id, platform: 'darwin',
      spawnImpl: (command, args, options) => {
        spawnedJobIds.push(path.basename(options.cwd));
        return fake(`setTimeout(() => { fs.writeFileSync('a-output.txt','done'); ${done} }, 400);`)(command, args, options);
      },
      onState(snapshot) {
        if (!injected && snapshot.jobs.find(job => job.id === 'a')?.status === 'running') {
          injected = true;
          // A read-only job run directory refuses the transcript write with EACCES.
          mkdirSync(path.join(root, '.swarm/runs', id, 'a'), { recursive: true });
          chmodSync(path.join(root, '.swarm/runs', id, 'a'), 0o500);
        }
      },
    });
  } finally {
    chmodSync(path.join(root, '.swarm/runs', id, 'a'), 0o755);
  }
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  assert.equal(a.status, 'failed');
  assert.match(a.error, /^Coordinator failed: EACCES/);
  assert.equal(b.status, 'failed');
  assert.match(b.error, /^Coordinator failed: /);
  assert.ok(!spawnedJobIds.includes('b'));
  assert.equal(state.status, 'failed');
  assert.match(state.error, /^EACCES/);
});

test('job-scoped: a plain error inside runOne fails only that job and the queued job still runs', async t => {
  const root = await codexFixture(t);
  let injected = false;
  const manifest = {
    version: 1, concurrency: 1,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['a-output.txt'], timeoutMs: 5000 },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
    ],
  };
  const state = await runManifest(root, manifest, {
    platform: 'darwin',
    progressIntervalMs: 60000,
    spawnImpl: (command, args, options) => {
      const jobId = path.basename(options.cwd);
      if (jobId === 'a') return fake(`fs.writeFileSync('a-output.txt','done'); ${done}`)(command, args, options);
      return fake(`setTimeout(() => { fs.writeFileSync('b-output.txt','done'); ${done} }, 400);`)(command, args, options);
    },
    onState(snapshot) {
      // concurrency 1 + a parked progress ticker: only a's own runOne awaits the save that sees a running (queueSave is one shared chain).
      if (!injected && snapshot.jobs.find(job => job.id === 'a')?.status === 'running') {
        injected = true;
        throw new Error('injected job error');
      }
    },
  });
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  assert.equal(a.status, 'failed');
  assert.equal(a.error, 'Coordinator failed: injected job error');
  assert.equal(b.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, b.workspace, 'b-output.txt'), 'utf8'), 'done');
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'injected job error');
});

test('job-scoped: an ENOENT inside the job\'s own .swarm/workspaces directory fails only that job and the queued job still runs', async t => {
  const root = await codexFixture(t);
  const id = 'workspace-enoent';
  let injected = false;
  const manifest = {
    version: 1, concurrency: 1,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['a-output.txt'], timeoutMs: 5000 },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
    ],
  };
  const state = await runManifest(root, manifest, {
    id,
    platform: 'darwin',
    progressIntervalMs: 60000,
    spawnImpl: (command, args, options) => {
      const jobId = path.basename(options.cwd);
      if (jobId === 'a') return fake(`fs.writeFileSync('a-output.txt','done'); ${done}`)(command, args, options);
      return fake(`setTimeout(() => { fs.writeFileSync('b-output.txt','done'); ${done} }, 400);`)(command, args, options);
    },
    onState(snapshot) {
      // concurrency 1 + a parked progress ticker: only a's own runOne awaits the save that sees a running (queueSave is one shared chain).
      if (!injected && snapshot.jobs.find(job => job.id === 'a')?.status === 'running') {
        injected = true;
        throw Object.assign(new Error('ENOENT: no such file or directory, open'), { code: 'ENOENT', syscall: 'open', path: path.join(root, '.swarm/workspaces', id, 'a', 'gone.txt') });
      }
    },
  });
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  assert.equal(a.status, 'failed');
  assert.equal(a.error, 'Coordinator failed: ENOENT: no such file or directory, open');
  assert.equal(b.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, b.workspace, 'b-output.txt'), 'utf8'), 'done');
  assert.equal(state.status, 'failed');
  assert.equal(state.error, 'ENOENT: no such file or directory, open');
});

test('isRunFatalError: disk/quota codes and .swarm permission errors are fatal; other .swarm errors and near misses are not', () => {
  const root = '/r';
  for (const error of [
    { code: 'ENOSPC' },
    { code: 'EDQUOT' },
    { code: 'EACCES', syscall: 'open', path: '/r/.swarm/runs/x/state.json' },
    { code: 'EPERM', syscall: 'rename', path: '/tmp/a', dest: '/r/.swarm/lock' },
    { code: 'EROFS', syscall: 'open', path: '/r/.swarm/runs/x/state.json' },
    { code: 'EACCES', syscall: 'mkdir', path: '/r/.swarm/workspaces/run-1/a' },
  ]) assert.equal(isRunFatalError(error, root), true, JSON.stringify(error));
  for (const error of [
    new Error('Missing output …'),
    { code: 'EACCES', syscall: 'open', path: '/r/src/a.ts' },
    { code: 'EACCES', syscall: 'open', path: '/r/.swarmish/x' },
    { code: 'EACCES', path: '/r/.swarm/x' },
    { code: 'EISDIR', syscall: 'open', path: '/r/.swarm' },
    { code: 'ENOENT', syscall: 'open', path: '/r/.swarm/workspaces/run-1/a/gone.txt' },
    { code: 'ENOENT', syscall: 'open', path: '/r/.swarm/runs/x/state.json' },
    { code: 'EEXIST', syscall: 'rename', path: '/tmp/a', dest: '/r/.swarm/lock' },
    null,
  ]) assert.equal(isRunFatalError(error, root), false, JSON.stringify(error));
});

// Case 5: codexMessage only swaps in the review-only sentence when every declared output is
// markdown and there is at least one; every other shape keeps today's test sentence.
test('U16: codexMessage tells review-only .md jobs not to run tests, every other job to run them', () => {
  const j = outputs => codexJob({ outputs });
  const noTests = 'Do not run tests, package installs, dev servers or network commands; this job only reads files and writes its declared documents.';
  const runTests = 'Run relevant project tests.';
  const withMd = codexMessage(j(['coordination/review.md']));
  assert.ok(withMd.includes(noTests));
  assert.ok(!withMd.includes(runTests));
  assert.ok(codexMessage(j(['src/a.ts'])).includes(runTests));
  assert.ok(codexMessage(j(['notes.md', 'src/a.ts'])).includes(runTests));
  assert.ok(codexMessage(j([])).includes(runTests));
  assert.ok(codexMessage(codexJob({ outputs: ['src/a.ts'], runTests: false })).includes(noTests));
  assert.ok(codexMessage(codexJob({ outputs: ['review.md'], runTests: true })).includes(runTests));
});

test('validate: runTests must be a boolean and is codex-only', () => {
  const base = { id: 'x', agent: 'claude', model: 'sonnet', prompt: 'Write it.', context: [], outputs: ['x-output.txt'], timeoutMs: 5000 };
  assert.throws(() => validateManifest({ version: 1, jobs: [{ ...base, agent: 'codex', model: 'test-model', runTests: 'no' }] }), /Job x runTests must be a boolean/);
  assert.throws(() => validateManifest({ version: 1, jobs: [{ ...base, runTests: false }] }), /Job x runTests is only supported for agent codex/);
  assert.doesNotThrow(() => validateManifest({ version: 1, jobs: [{ ...base, agent: 'codex', model: 'test-model', runTests: false }] }));
});
