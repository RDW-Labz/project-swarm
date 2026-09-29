// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { runManifest, integrateRun, validateManifest, validateProject, inspectResults } from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (extra = {}, spec = {}) => ({ version: 1, jobs: [job(extra)], ...spec });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons116-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  return root;
}
// Always writes input.txt so any job whose outputs include it (the default) completes normally;
// extra script runs after, and result becomes the worker's own final JSON-line message.
const fake = (script = '', result = {}) => (_cmd, _args, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','updated');${script};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(typeof result === 'string' ? result : JSON.stringify(result))}}));`], options);

// --- Lesson A: post-build mutants -------------------------------------------------------------

test('A: validateManifest accepts mutantsFile only when it names one of the job\'s own outputs', () => {
  assert.doesNotThrow(() => validateManifest(manifest({ outputs: ['input.txt', 'mutants.json'], mutantsFile: 'mutants.json' })));
  assert.throws(() => validateManifest(manifest({ mutantsFile: 'mutants.json' })), /mutantsFile must be one of its outputs/);
});

test('A: a job-declared mutantsFile output is used automatically by integrate --mutants, with --mutant-check as fallback', async t => {
  const root = await fixture(t);
  const buildScript = "fs.writeFileSync('mutants.json', JSON.stringify([{name:'off-by-one', file:'input.txt', find:'updated', replace:'x'}]))";
  const state = await runManifest(root, manifest({ outputs: ['input.txt', 'mutants.json'], mutantsFile: 'mutants.json' }), { spawnImpl: fake(buildScript) });
  const result = await integrateRun(root, state.id, {
    mutants: true,
    mutantCheck: JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('input.txt','utf8').includes('updated')?0:1)"]),
  });
  assert.equal(result.mutantsSummary.killed, 1);
  assert.equal(result.mutantsSummary.survived, 0);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
});

test('A: --mutants-file loads post-build mutants from an external file when the manifest declares neither mutants nor mutantCheck', async t => {
  const root = await fixture(t);
  const state = await runManifest(root, manifest({ outputs: ['built.js'] }), { spawnImpl: fake("fs.writeFileSync('built.js','function ok(v){return v<=10}')") });
  const mutantsPath = path.join(root, 'post-build-mutants.json');
  // This exact 'find' string only exists because the build job above just wrote it; it could not
  // have been declared in the manifest before the run.
  await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'off-by-one', file: 'built.js', find: 'v<=10', replace: 'v<10' }]));
  const result = await integrateRun(root, state.id, {
    mutants: true,
    mutantsFile: mutantsPath,
    mutantCheck: JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('built.js','utf8').includes('v<=10')?0:1)"]),
  });
  assert.equal(result.mutantsSummary.killed, 1);
  assert.equal(await fs.readFile(path.join(root, 'built.js'), 'utf8'), 'function ok(v){return v<=10}');
});

// --- Lesson B: a failed job must keep its own error -------------------------------------------

test('B: a non-zero exit keeps its own stderr reason in agentError and agent.log', async t => {
  const root = await fixture(t);
  const crash = (_cmd, _args, options) => spawn(process.execPath, ['-e', "process.stderr.write('Error: out of credits for this account\\n');process.exit(1)"], options);
  const state = await runManifest(root, manifest(), { spawnImpl: crash });
  assert.equal(state.jobs[0].status, 'failed');
  assert.match(state.jobs[0].agentError, /^exit 1: .*out of credits/);
  const log = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/agent.log'), 'utf8');
  assert.match(log, /out of credits/);
});

test('B: a job that reports success but writes none of its declared outputs keeps today\'s status, undisturbed by agentError (#232: never-written, not a delete)', async t => {
  const root = await fixture(t);
  const silent = (_cmd, _args, options) => spawn(process.execPath, ['-e', "process.stderr.write('note: nothing to change\\n');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok, done'}));"], options);
  const state = await runManifest(root, manifest({ outputs: ['new-output.txt'] }), { spawnImpl: silent });
  assert.equal(state.jobs[0].status, 'complete');
  assert.equal(state.jobs[0].agentError, undefined);
  assert.equal(state.jobs[0].error, null);
  const result = await integrateRun(root, state.id);
  assert.equal(result.status, 'integrated');
  assert.ok(result.warnings.some(w => w === 'output-never-written: new-output.txt'), JSON.stringify(result.warnings));
});

test('B: a worker\'s own blocked envelope is reported as job status blocked, not masked by "missing output"', async t => {
  const root = await fixture(t);
  const blockedReply = JSON.stringify({ status: 'blocked', summary: 'needs other.txt in outputs' });
  const blockedWorker = (_cmd, _args, options) => spawn(process.execPath, ['-e', `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(blockedReply)}}));`], options);
  const state = await runManifest(root, manifest({ outputs: ['new-output.txt'] }), { spawnImpl: blockedWorker });
  assert.equal(state.jobs[0].status, 'blocked');
  assert.equal(state.jobs[0].error, 'blocked: needs other.txt in outputs');
  const inspected = await inspectResults(root, state.id);
  assert.equal(inspected.jobs[0].status, 'blocked');
});

// --- Lesson C: review-round context drift -------------------------------------------------------

test('C: validateManifest accepts a simple contextGlob and rejects **', () => {
  assert.doesNotThrow(() => validateManifest(manifest({ contextGlob: ['shots/*.png'] })));
  assert.throws(() => validateManifest(manifest({ contextGlob: ['shots/**/*.png'] })), /no \*\* supported/);
});

test('C: validate warns when context omits new same-directory captures, and contextGlob picks them up instead', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'shots'));
  for (const name of ['a.png', 'b.png', 'c.png']) await fs.writeFile(path.join(root, 'shots', name), 'x');
  // Simulates a later round adding a new capture to the same directory the context already names.
  await fs.writeFile(path.join(root, 'shots', 'd.png'), 'x');

  const withoutGlob = manifest({ context: ['input.txt', 'shots/a.png', 'shots/b.png', 'shots/c.png'], outputs: ['review.md'] });
  const report = await validateProject(root, withoutGlob);
  const drift = report.warnings.find(w => w.code === 'context-directory-drift');
  assert.ok(drift, 'expected a context-directory-drift warning');
  assert.equal(drift.message, 'context lists 3 of 4 .png in shots; missing e.g. shots/d.png');

  const withGlob = manifest({ context: ['input.txt'], contextGlob: ['shots/*.png'], outputs: ['review.md'] });
  const report2 = await validateProject(root, withGlob);
  assert.equal(report2.warnings.some(w => w.code === 'context-directory-drift'), false);
});

test('C: a contextGlob matching no files is a clear validate error', async t => {
  const root = await fixture(t);
  await assert.rejects(validateProject(root, manifest({ contextGlob: ['missing-dir/*.png'] })), /contextGlob matched no files/);
});
