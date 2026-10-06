// Swarm batch AI runtime: field lessons 363, 374a, 375, and 377.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import {
  noteRun,
  runBaseChecks,
  runManifest,
  validateProject,
} from '../tools/swarm.mjs';
import { registerLiveRun, unregisterLiveRun } from '../tools/board.mjs';

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-ai-runtime-'));
  await fs.writeFile(path.join(root, 'input.txt'), 'input');
  await fs.mkdir(path.join(root, 'coordination'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

const job = (overrides = {}) => ({
  id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update the assigned file.',
  context: ['input.txt'], outputs: ['input.txt'], timeoutMs: 5000, ...overrides,
});
const manifest = (jobs, extra = {}) => ({ version: 1, concurrency: 2, jobs, ...extra });
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));`;
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs'; ${script}`], options);
}

test('#363: an absent test output is a pending base check and is not spawned or treated as red', async t => {
  const root = await fixture(t);
  const check = { name: 'new-test', argv: ['node', 'tests/new-output.test.mjs'] };
  let spawns = 0;
  const result = await runBaseChecks(root, manifest([job({ outputs: ['tests/new-output.test.mjs'] })], { checks: [check] }), {
    baseSha: 'pending-base',
    spawnImpl: (...args) => { spawns++; return fake('process.exit(1)')(...args); },
  });
  assert.equal(spawns, 0, 'pending checks must not run against a file that the job will create');
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.pending, ['new-test']);
  assert.deepEqual(result.failures, []);
});

test('#374a: validate reports live conflicts and the startable job subset', async t => {
  const root = await fixture(t);
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-ai-live-'));
  t.after(() => fs.rm(liveDir, { recursive: true, force: true }));
  await registerLiveRun({ runId: 'already-running', root, outputs: ['shared.txt'], dir: liveDir });
  t.after(() => unregisterLiveRun('already-running', { dir: liveDir }));
  const report = await validateProject(root, manifest([
    job({ id: 'blocked', context: ['input.txt'], outputs: ['shared.txt'] }),
    job({ id: 'free', context: ['input.txt'], outputs: ['free.txt'] }),
  ]), { liveDir });
  assert.equal(report.conflicts.length, 1);
  assert.equal(report.conflicts[0].runId, 'already-running');
  assert.deepEqual(report.startableJobs, ['free']);
});

test('#374a: run accepts the validated startable subset without editing the manifest', async t => {
  const root = await fixture(t);
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-ai-live-run-'));
  t.after(() => fs.rm(liveDir, { recursive: true, force: true }));
  const state = await runManifest(root, manifest([
    job({ id: 'blocked', context: ['input.txt'], outputs: ['blocked.txt'] }),
    job({ id: 'free', context: ['input.txt'], outputs: ['free.txt'] }),
  ]), {
    jobs: ['free'],
    liveDir,
    spawnImpl: fake(`fs.writeFileSync('free.txt', 'done'); ${done}`),
  });
  assert.equal(state.status, 'complete');
  assert.deepEqual(state.jobs.map(record => record.id), ['free']);
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(await fs.access(path.join(root, 'blocked.txt')).then(() => true, () => false), false);
});

test('#375: note resolves TASK.md under coordination and never creates a root-level replacement', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'coordination', 'TASK.md'), '# task\n');
  await fs.writeFile(path.join(root, 'TASK.md'), 'root file\n');
  const config = { coordinationDir: 'coordination' };
  await noteRun(root, { text: 'handoff' }, { config, now: () => Date.parse('2026-10-06T12:00:00.000Z') });
  assert.match(await fs.readFile(path.join(root, 'coordination', 'TASK.md'), 'utf8'), /handoff/);
  assert.equal(await fs.readFile(path.join(root, 'TASK.md'), 'utf8'), 'root file\n');
  await fs.rm(path.join(root, 'coordination', 'TASK.md'));
  await assert.rejects(noteRun(root, { text: 'must not create' }, { config }), /note-invalid-path/);
  assert.equal(await fs.readFile(path.join(root, 'TASK.md'), 'utf8'), 'root file\n');
});

test('#375: invalid lesson area errors list the allowed values', async t => {
  const root = await fixture(t);
  const args = ['--root', root, 'lesson', 'add', '--area', 'validate', '--evidence', 'e', '--rule', 'r', '--fix', 'f'];
  const result = await execFileAsync(process.execPath, [path.resolve('tools/swarm.mjs'), ...args], { cwd: path.resolve('.') }).catch(error => error);
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.match(text, /lesson-area-invalid/);
  assert.match(text, /allowed/i);
});

test('#377: job-level contract is hoisted, null tierReason is absent, and sibling output context is pending', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'CONTRACT.md'), 'shared contract');
  const liveDir = await fs.mkdtemp(path.join(os.tmpdir(), 'field-lessons-ai-live-contract-'));
  t.after(() => fs.rm(liveDir, { recursive: true, force: true }));
  const inputManifest = manifest([
    job({ id: 'producer', context: ['CONTRACT.md', 'input.txt'], outputs: ['sibling.txt'], tierReason: null }),
    job({ id: 'contract-writer', contract: 'CONTRACT.md', tierReason: null, context: ['CONTRACT.md', 'sibling.txt'], outputs: ['result.txt'] }),
  ]);
  const report = await validateProject(root, inputManifest, { liveDir });
  assert.ok(report);
  assert.equal(inputManifest.contract, 'CONTRACT.md');
  assert.equal('tierReason' in inputManifest.jobs[0], false);
  assert.equal('tierReason' in inputManifest.jobs[1], false);
  assert.ok(report.warnings.some(warning => /pending \(created by job producer\)/.test(warning.message ?? warning)));
});
