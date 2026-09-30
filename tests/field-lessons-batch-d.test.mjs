// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  runManifest, integrateRun, validateProject, inspectRun, inspectResults, undeclaredMutantsFileWarnings,
} from '../tools/swarm.mjs';
import { ship } from '../tools/ship.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (jobExtra = {}, spec = {}) => ({ version: 1, jobs: [job(jobExtra)], ...spec });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-batch-d-')));
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
const fake = (script = '', result = 'ok') => (_cmd, _args, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','updated');${script};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(result)}}));`], options);

// --- L119: an undeclared mutants-shaped output ---------------------------------------------------

describe('L119: validate warns when a job output looks like a mutants file but is not declared as its mutantsFile', () => {
  test('undeclaredMutantsFileWarnings flags an undeclared match and is quiet once declared', () => {
    const flagged = undeclaredMutantsFileWarnings({ id: 'build', outputs: ['out/post-build-mutants.json'] });
    assert.equal(flagged.length, 1);
    assert.equal(flagged[0].code, 'mutants-file-undeclared');
    assert.equal(flagged[0].jobId, 'build');
    assert.equal(flagged[0].path, 'out/post-build-mutants.json');
    const quiet = undeclaredMutantsFileWarnings({ id: 'build', outputs: ['out/post-build-mutants.json'], mutantsFile: 'out/post-build-mutants.json' });
    assert.equal(quiet.length, 0);
    assert.equal(undeclaredMutantsFileWarnings({ id: 'build', outputs: ['report.json'] }).length, 0, 'a plain .json output not naming mutants is never flagged');
  });

  test('validateProject surfaces the warning for a real manifest job', async t => {
    const root = await fixture(t);
    const report = await validateProject(root, manifest({ outputs: ['input.txt', 'build-mutants.json'] }));
    assert.ok(report.warnings.some(w => w.code === 'mutants-file-undeclared' && w.path === 'build-mutants.json' && w.jobId === 'writer'));
  });

  test('worker preamble states the exact mutantsFile shape for a job that declares one', async t => {
    const root = await fixture(t);
    const m = { version: 1, jobs: [job({ outputs: ['input.txt', 'mutants.json'], mutantsFile: 'mutants.json' })] };
    const spawnImpl = fake("fs.writeFileSync('mutants.json','[]')");
    const state = await runManifest(root, m, { spawnImpl });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer', 'message.txt'), 'utf8');
    assert.match(message, /Your output "mutants\.json" is a mutantsFile/);
    assert.match(message, /\{"name": string, "file": string, "find": string, "replace": string\}/);
  });
});

// --- L120/L122: integrate is all-or-nothing; a bad .json output is flagged at completion ---------

describe('L120/L122: integrate parses and validates every mutants source before writing anything; a bad .json output is flagged at job completion', () => {
  test("a job's own invalid mutantsFile output is flagged at completion and refuses integrate before any project file is written", async t => {
    const root = await fixture(t);
    const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', [
      "const fs=require('fs');",
      "fs.writeFileSync('input.txt','updated');",
      "fs.writeFileSync('mutants.json', JSON.stringify([{name:'a',file:'input.txt',find:'updated',replace:'zzz'}]) + '\\nEXTRA');",
      "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));",
    ].join('')], options);
    const m = { version: 1, jobs: [job({ outputs: ['input.txt', 'mutants.json'], mutantsFile: 'mutants.json' })] };
    const state = await runManifest(root, m, { spawnImpl });
    assert.deepEqual(state.jobs[0].invalidJsonOutputs, ['mutants.json']);
    const inspected = await inspectRun(root, state.id);
    assert.ok(inspected.warnings.includes('output-invalid-json: mutants.json'));

    await assert.rejects(integrateRun(root, state.id, { mutants: true }), /Invalid JSON in mutantsFile: mutants\.json/);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original', 'nothing was written by the refused integration');
    const onDisk = JSON.parse(await fs.readFile(path.join(root, '.swarm/runs', state.id, 'state.json'), 'utf8'));
    assert.equal(onDisk.integratedAt, undefined);
  });

  test('an unrelated --mutants-file with trailing JSON data also refuses before any write', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest(), { spawnImpl: fake() });
    const mutantsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mutants-file-'));
    t.after(() => fs.rm(mutantsDir, { recursive: true, force: true }));
    const badPath = path.join(mutantsDir, 'bad.json');
    await fs.writeFile(badPath, `${JSON.stringify([{ name: 'a', file: 'input.txt', find: 'updated', replace: 'zzz' }])}\nEXTRA`);
    await assert.rejects(integrateRun(root, state.id, { mutants: true, mutantsFile: badPath }), /Invalid JSON in mutants file/);
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'original');
  });

  test('a run left integrationStatus "partial" can be retried without a false snapshot conflict', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest(), { spawnImpl: fake() });
    // Simulate exactly what an interrupted integration leaves behind: the file already carries
    // the proposed bytes, but the run's own record never advanced past the write step.
    await fs.writeFile(path.join(root, 'input.txt'), 'updated');
    const stateFile = path.join(root, '.swarm/runs', state.id, 'state.json');
    const saved = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    saved.integratedAt = new Date().toISOString();
    saved.integratedFiles = ['input.txt'];
    saved.integratedNewFiles = [];
    saved.integrationStatus = 'partial';
    await fs.writeFile(stateFile, JSON.stringify(saved));
    const result = await integrateRun(root, state.id);
    assert.equal(result.status, 'integrated');
    assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), 'updated');
  });
});

// --- L121: contextGlob dir-coverage warning -------------------------------------------------------

describe("L121: validate warns when a job's contextGlob entries for one directory cover only some of its filename prefixes", () => {
  async function shotsFixture(t) {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'shots'));
    for (let i = 1; i <= 30; i++) await fs.writeFile(path.join(root, 'shots', `activity-${i}.png`), 'x');
    for (let i = 1; i <= 8; i++) await fs.writeFile(path.join(root, 'shots', `scoreboard-mixed-${i}.png`), 'x');
    return root;
  }

  test('30 covered + 8 uncovered of the same extension in one directory: warns naming both', async t => {
    const root = await shotsFixture(t);
    const report = await validateProject(root, manifest({ context: ['input.txt'], contextGlob: ['shots/activity-*.png'], outputs: ['review.md'] }));
    const warning = report.warnings.find(w => w.code === 'context-directory-drift' && w.dir === 'shots');
    assert.ok(warning, 'expected a context-directory-drift warning');
    assert.equal(warning.dir, 'shots');
    assert.equal(warning.extension, '.png');
    assert.deepEqual(warning.prefixes, ['activity-']);
    assert.equal(warning.present, 30);
    assert.equal(warning.total, 38);
    assert.equal(warning.missing.length, 5);
    assert.ok(warning.missing.every(p => p.startsWith('shots/scoreboard-mixed-')));
  });

  test('a second contextGlob entry for the same directory (multiple entries already work) closes the gap', async t => {
    const root = await shotsFixture(t);
    const report = await validateProject(root, manifest({ context: ['input.txt'], contextGlob: ['shots/activity-*.png', 'shots/scoreboard-*.png'], outputs: ['review.md'] }));
    assert.ok(!report.warnings.some(w => w.code === 'context-directory-drift' && w.dir === 'shots'));
    assert.deepEqual(report.jobs[0].contextGlobCounts, [
      { pattern: 'shots/activity-*.png', count: 30 },
      { pattern: 'shots/scoreboard-*.png', count: 8 },
    ]);
  });

  // Root cause of a warning that stayed quiet (lesson 34): the drift check only ever grouped by
  // directory+extension and required 3+ already-listed files before it would say anything, so a
  // plain (non-glob) context naming just 1-2 files of an obviously numbered series never reached
  // that floor and the rest of the series went unmentioned, same-prefix or not.
  test('a plain (non-glob) context naming just 2 of a numbered series still warns when the directory holds more of the same prefix', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'shots'));
    for (let i = 1; i <= 5; i++) await fs.writeFile(path.join(root, 'shots', `activity-${i}.png`), 'x');
    const report = await validateProject(root, manifest({ context: ['input.txt', 'shots/activity-1.png', 'shots/activity-2.png'], outputs: ['review.md'] }));
    const warning = report.warnings.find(w => w.code === 'context-directory-drift' && w.dir === 'shots');
    assert.ok(warning, 'expected a context-directory-drift warning even with only 2 of 5 files listed');
    assert.equal(warning.present, 2);
    assert.equal(warning.total, 5);
    assert.deepEqual(warning.prefixes, ['activity-']);
    assert.deepEqual(warning.missing, ['shots/activity-3.png', 'shots/activity-4.png', 'shots/activity-5.png']);
  });
});

// --- dropped writes: an edit outside a job's declared outputs is silently discarded ---------------

describe("dropped writes: inspect/integrate warn when a job's own report, or its actual workspace diff, names a path outside its declared outputs", () => {
  test('a file the worker actually wrote outside its outputs is caught by the workspace diff, in both inspect and integrate', async t => {
    const root = await fixture(t);
    const spawnImpl = fake("fs.writeFileSync('extra.txt','oops')");
    const state = await runManifest(root, manifest(), { spawnImpl });
    assert.deepEqual(state.jobs[0].droppedWrites, ['extra.txt']);
    const inspected = await inspectRun(root, state.id);
    assert.ok(inspected.warnings.includes('dropped write: extra.txt (not in outputs)'));
    await assert.rejects(integrateRun(root, state.id), /dropped-writes: writer: extra\.txt/);
    const integrated = await integrateRun(root, state.id, { acceptDropped: true });
    assert.ok(integrated.warnings.includes('dropped write: extra.txt (not in outputs)'));
    assert.equal(await fs.readFile(path.join(root, 'extra.txt'), 'utf8').catch(() => null), null, 'a dropped write is never integrated');
  });

  test('a self-reported "changed" path outside outputs also warns via inspect --results, even with no real workspace file', async t => {
    const root = await fixture(t);
    const spawnImpl = fake('', JSON.stringify({ changed: ['other.txt'] }));
    const state = await runManifest(root, manifest(), { spawnImpl });
    const results = await inspectResults(root, state.id);
    assert.ok(results.warnings.includes('dropped write: other.txt (not in outputs)'));
  });

  test('the worker preamble states that edits outside outputs are discarded', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest(), { spawnImpl: fake() });
    const message = await fs.readFile(path.join(root, '.swarm/runs', state.id, 'writer/message.txt'), 'utf8');
    assert.match(message, /Edits outside these outputs are discarded/);
  });
});

// --- outputs before integrate: inspect --results shows each output's workspace copy -------------

describe('outputs before integrate: inspect --results lists, per job, where each declared output sits on disk and, for .json outputs, whether it parses', () => {
  test('an absolute workspace path per output, and jsonValid only for .json outputs', async t => {
    const root = await fixture(t);
    const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', [
      "const fs=require('fs');",
      "fs.writeFileSync('input.txt','updated');",
      "fs.writeFileSync('report.json','not json');",
      "console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));",
    ].join('')], options);
    const m = { version: 1, jobs: [job({ outputs: ['input.txt', 'report.json'] })] };
    const state = await runManifest(root, m, { spawnImpl });
    const results = await inspectResults(root, state.id);
    const outputs = results.jobs[0].outputs;
    const reportEntry = outputs.find(o => o.path === 'report.json');
    assert.equal(reportEntry.jsonValid, false);
    assert.ok(path.isAbsolute(reportEntry.workspacePath));
    assert.ok(reportEntry.workspacePath.endsWith(path.join('.swarm', 'workspaces', state.id, 'writer', 'report.json')));
    const inputEntry = outputs.find(o => o.path === 'input.txt');
    assert.equal(inputEntry.jsonValid, undefined);
  });
});

// --- L123: mutants only count against a green base ------------------------------------------------

describe('L123: integrate --mutants skips mutants against a red base; ship refuses a required Mutation check section for one', () => {
  test('a failed check turns every declared mutant into skipped-red-base, not a killed/survived verdict', async t => {
    const root = await fixture(t);
    const failingCheck = { name: 'unit', argv: [process.execPath, '-e', "console.error('AssertionError: expected 1 to equal 2');process.exit(1)"] };
    const m = {
      version: 1, jobs: [job()], checks: [failingCheck],
      mutants: [{ name: 'm1', file: 'input.txt', find: 'updated', replace: 'zzz' }],
      mutantCheck: { argv: [process.execPath, '-e', 'process.exit(0)'] },
    };
    const state = await runManifest(root, m, { spawnImpl: fake() });
    const result = await integrateRun(root, state.id, { mutants: true });
    assert.equal(result.checksPassed, false);
    assert.equal(result.mutantsPassed, false);
    assert.equal(result.mutants.length, 1);
    assert.equal(result.mutants[0].status, 'skipped-red-base');
    assert.equal(result.mutantsSummary.skipped, 1);
    assert.equal(result.mutantsSummary.killed, 0);
    assert.ok(result.warnings.includes('mutants skipped: red base (checks failed)'));
  });

  test('ship refuses a required "Mutation check" section when the run\'s mutants came from a red base', async t => {
    const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ship-redbase-')));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const payloadPath = path.join(root, 'pr.json');
    await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
    const exec = async (cmd, args) => {
      if (cmd === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git\n', stderr: '' };
      throw new Error(`unexpected exec: ${cmd} ${args.join(' ')}`);
    };
    const result = await ship({
      root, payloadPath,
      manifest: { version: 1, jobs: [], mutants: [{ name: 'a', file: 'x', find: 'y', replace: 'z' }] },
      requireSections: ['Mutation check'], mutantsSkippedRedBase: true,
      runChecks: async () => [], exec, sleep: async () => {}, now: () => Date.now(),
    });
    assert.equal(result.status, 'refused');
    assert.match(result.reason, /red base/);
  });
});
