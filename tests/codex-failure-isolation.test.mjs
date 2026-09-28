// SPDX-License-Identifier: Apache-2.0
// U14/U15/U16 field-lessons regression tests (contract EXP-2). Helpers below are copied from
// tests/lessons.test.mjs and tests/codex-adapter.test.mjs rather than imported, per instructions.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { runManifest } from '../tools/swarm.mjs';
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

// Amendment 1: isolation stays (the other job keeps running), but the run still records the
// first coordinator error, using the same message-write injection as tests/live-progress.test.mjs.
test('Amendment 1: a run-level coordinator error on one job is recorded on state while a concurrent job completes', async t => {
  const root = await codexFixture(t);
  const id = 'amendment1-isolation';
  let injected = false;
  const manifest = {
    version: 1, concurrency: 2,
    jobs: [
      { id: 'a', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['a-output.txt'], timeoutMs: 5000 },
      { id: 'b', agent: 'claude', model: 'sonnet', prompt: 'Write the output.', context: [], outputs: ['b-output.txt'], timeoutMs: 5000 },
    ],
  };
  const state = await runManifest(root, manifest, {
    id, platform: 'darwin',
    spawnImpl: (command, args, options) => {
      if (path.basename(options.cwd) === 'a') throw new Error('Unexpected provider launch for a');
      return fake(`setTimeout(() => { fs.writeFileSync('b-output.txt','done'); ${done} }, 400);`)(command, args, options);
    },
    onState(snapshot) {
      if (!injected && snapshot.jobs.find(job => job.id === 'a')?.status === 'running') {
        injected = true;
        // A directory cannot be atomically replaced by the requested transcript file.
        mkdirSync(path.join(root, '.swarm/runs', id, 'a/message.txt'), { recursive: true });
      }
    },
  });
  const a = state.jobs.find(job => job.id === 'a');
  const b = state.jobs.find(job => job.id === 'b');
  assert.equal(a.status, 'failed');
  assert.match(a.error, /^Coordinator failed: .*(EISDIR|EPERM)/);
  assert.equal(b.status, 'complete');
  assert.equal(await fs.readFile(path.join(root, b.workspace, 'b-output.txt'), 'utf8'), 'done');
  assert.equal(state.status, 'failed');
  assert.match(state.error, /EISDIR|EPERM/);
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
});
