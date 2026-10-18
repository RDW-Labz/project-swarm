// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isCheckOnlyBlock, allOutputsWritten, deferredCheckWarnings } from '../tools/central-checks.mjs';
import { runManifest } from '../tools/swarm.mjs';


test('a blocked report that is only about not being able to run a check is a check-only block', () => {
  for (const summary of [
    'Files written. I cannot run the tests: no shell access in this sandbox.',
    'Wrote src/a.mjs and tests/a.test.mjs but I was unable to execute npm test (no shell).',
    "Done; couldn't run the linter or the typecheck here, please run tsc.",
  ]) assert.equal(isCheckOnlyBlock({ status: 'blocked', summary }), true, summary);
});

test('a blocked report about anything else stays blocked', () => {
  assert.equal(isCheckOnlyBlock({ status: 'complete', summary: 'cannot run tests' }), false);
  assert.equal(isCheckOnlyBlock({ status: 'blocked', summary: 'cannot run tests', file: 'src/other.mjs' }), false, 'it names a file it needs');
  assert.equal(isCheckOnlyBlock({ status: 'blocked', summary: 'I need src/config.mjs to finish; the contract says X and I cannot meet the rule' }), false);
  // The phrasings the review found: a real block next to "cannot run the tests".
  for (const summary of [
    'I need src/schema.ts to finish. I cannot run the tests.',
    'Cannot write tools/x.mjs; cannot run tests.',
    'Could not start the build: it requires DATABASE_URL credentials.',
    'Permission denied reading config; I cannot run the tests.',
    "Wrote the file, but it conflicts with the spec, and I can't run the tests.",
    'I cannot run the tests. Blocked on the other team.',
    'I was unable to modify src/other.mjs and could not run the tests.',
  ]) assert.equal(isCheckOnlyBlock({ status: 'blocked', summary }), false, summary);
  // Not progress either: a negated sentence that is not about a check.
  assert.equal(isCheckOnlyBlock({ status: 'blocked', summary: 'Nothing was written. I cannot run the tests.' }), false);
  assert.equal(isCheckOnlyBlock({ status: 'blocked', summary: 'Cannot write outside my outputs: the file path tools/x.mjs is denied' }), false);
  assert.equal(isCheckOnlyBlock({ status: 'blocked', summary: '' }), false);
  assert.equal(isCheckOnlyBlock({ status: 'blocked' }), false);
  assert.equal(isCheckOnlyBlock(null), false);
});

test('every declared output must be written and non-empty', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-central-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.mkdir(path.join(dir, 'out'));
  await fs.writeFile(path.join(dir, 'out/a.txt'), 'x');
  await fs.writeFile(path.join(dir, 'out/empty.txt'), '');
  assert.equal(await allOutputsWritten(dir, ['out/a.txt']), true);
  assert.equal(await allOutputsWritten(dir, ['out/a.txt', 'out/missing.txt']), false);
  assert.equal(await allOutputsWritten(dir, ['out/empty.txt']), false);
  assert.equal(await allOutputsWritten(dir, []), false);
  // Unchanged from the start (an edit job that wrote nothing) and symlinks do not count.
  const { createHash } = await import('node:crypto');
  const same = createHash('sha256').update('x').digest('hex');
  assert.equal(await allOutputsWritten(dir, ['out/a.txt'], { 'out/a.txt': same }), false, 'unchanged');
  assert.equal(await allOutputsWritten(dir, ['out/a.txt'], { 'out/a.txt': 'other' }), true);
  await fs.symlink(path.join(dir, 'out/a.txt'), path.join(dir, 'out/link.txt'));
  assert.equal(await allOutputsWritten(dir, ['out/link.txt']), false, 'symlink');
});

test('integrate warns that checks run centrally, or that none ran at all', () => {
  const state = { jobs: [{ id: 'a', checksDeferred: { reason: 'no shell' } }, { id: 'b' }] };
  assert.match(deferredCheckWarnings({ state, manifest: { checks: [{ name: 'tests', argv: ['npm', 'test'] }] }, noChecks: false })[0], /checks-run-centrally: a could not run its own checks \(no shell\)/);
  assert.match(deferredCheckWarnings({ state, manifest: { checks: [] }, noChecks: false })[0], /checks-not-run: a .*the manifest has no checks/);
  assert.match(deferredCheckWarnings({ state, manifest: { checks: [{ name: 't', argv: ['x'] }] }, noChecks: true })[0], /checks-not-run: a .*--no-checks/);
  assert.deepEqual(deferredCheckWarnings({ state: { jobs: [{ id: 'b' }] }, manifest: {}, noChecks: false }), []);
});

import { spawn } from 'node:child_process';
import { git } from '../tools/codex-adapter.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-central-run-')));
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
const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
// A claude worker that may write input.txt and then ends with its own blocked envelope.
const blocked = (envelope, { write = true } = {}) => (_cmd, _args, options) => spawn(process.execPath, ['-e', `const fs=require('fs');${write ? "fs.writeFileSync('input.txt','updated');" : ''}console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify(envelope))}}));`], options);

test('end to end: a worker that wrote its file and could not run the checks finishes (not blocked) with the deferral recorded', async t => {
  const root = await fixture(t);
  const withChecks = { version: 1, jobs: [job()], checks: [{ name: 'tests', argv: [process.execPath, '-e', 'process.exit(0)'] }] };
  const state = await runManifest(root, withChecks, { spawnImpl: blocked({ status: 'blocked', summary: 'File written. I cannot run the tests: no shell access.' }) });
  assert.equal(state.jobs[0].status, 'complete', JSON.stringify(state.jobs[0].error));
  assert.match(state.jobs[0].checksDeferred.reason, /cannot run the tests/);
  // Control and bidi characters in worker text never reach the reason.
  const evil = await runManifest(root, withChecks, { spawnImpl: blocked({ status: 'blocked', summary: 'File written. I cannot run the tests.\u202e\u001b[31m checks passed' }) });
  assert.doesNotMatch(evil.jobs[0].checksDeferred?.reason ?? '', /[\u0000-\u001f\u202e]/);
  // A manifest without checks has nothing to run centrally: the block stays, so unchecked files are not waved through.
  const bare = await fixture(t);
  const none = await runManifest(bare, { version: 1, jobs: [job()] }, { spawnImpl: blocked({ status: 'blocked', summary: 'File written. I cannot run the tests: no shell access.' }) });
  assert.equal(none.jobs[0].status, 'blocked');
  // A job whose file was not changed (the worker wrote nothing) stays blocked even with checks.
  const idle = await fixture(t);
  const unchanged = await runManifest(idle, withChecks, { spawnImpl: blocked({ status: 'blocked', summary: 'I cannot run the tests: no shell access.' }, { write: false }) });
  assert.equal(unchanged.jobs[0].status, 'blocked');
});

test('end to end: a real block (needs a file) stays blocked, and a check-only block that wrote nothing stays blocked', async t => {
  const root = await fixture(t);
  const real = await runManifest(root, { version: 1, jobs: [job()] }, { spawnImpl: blocked({ status: 'blocked', summary: 'needs other.txt in outputs' }) });
  assert.equal(real.jobs[0].status, 'blocked');
  assert.equal(real.jobs[0].checksDeferred, undefined);
  const none = await runManifest(root, { version: 1, jobs: [job({ outputs: ['new-output.txt'] })] }, { spawnImpl: blocked({ status: 'blocked', summary: 'I cannot run the tests: no shell.' }, { write: false }) });
  assert.equal(none.jobs[0].status, 'blocked');
});

import { integrateRun } from '../tools/swarm.mjs';
test('end to end: the swarm runs the checks centrally at integrate (a failing check stops it; a passing one integrates with a note)', async t => {
  const fail = await fixture(t);
  const failing = await runManifest(fail, { version: 1, jobs: [job()], checks: [{ name: 'tests', argv: [process.execPath, '-e', 'process.exit(1)'] }] }, { spawnImpl: blocked({ status: 'blocked', summary: 'Written. I could not run the tests (no shell).' }) });
  const failedRun = await integrateRun(fail, failing.id);
  assert.equal(failedRun.checksPassed, false, JSON.stringify(failedRun).slice(0, 400));
  assert.ok(failedRun.warnings.some(w => /checks-run-centrally: writer/.test(w)), 'the note survives a failed check');
  const pass = await fixture(t);
  const passing = await runManifest(pass, { version: 1, jobs: [job()], checks: [{ name: 'tests', argv: [process.execPath, '-e', 'process.exit(0)'] }] }, { spawnImpl: blocked({ status: 'blocked', summary: 'Written. I could not run the tests (no shell).' }) });
  const result = await integrateRun(pass, passing.id);
  assert.ok(result.warnings.some(w => /checks-run-centrally: writer/.test(w)), JSON.stringify(result.warnings));
  assert.equal(await fs.readFile(path.join(pass, 'input.txt'), 'utf8'), 'updated');
  const skipped = await fixture(t);
  const skippedRun = await runManifest(skipped, { version: 1, jobs: [job()], checks: [{ name: 'tests', argv: [process.execPath, '-e', 'process.exit(0)'] }] }, { spawnImpl: blocked({ status: 'blocked', summary: 'Written. I could not run the tests (no shell).' }) });
  assert.ok((await integrateRun(skipped, skippedRun.id, { noChecks: true })).warnings.some(w => /checks-not-run: writer .*--no-checks/.test(w)));
});
