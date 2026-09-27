// SPDX-License-Identifier: Apache-2.0
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import {
  runManifest, integrateRun, validateManifest, validateProject, inspectRun, inspectResults,
  parseContextGlob, tmpToolPathWarnings, coreModuleNoShellWarning, runtimeCheckNoShellWarning,
  costPer1kOutputTokens, evidenceBlock, applyEvidence, runMutantsCurrentTree,
} from '../tools/swarm.mjs';
import { git } from '../tools/codex-adapter.mjs';

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (jobExtra = {}, spec = {}) => ({ version: 1, jobs: [job(jobExtra)], ...spec });
async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lessons-batch-a-')));
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
const fake = (script = '', result = {}) => (_cmd, _args, options) => spawn(process.execPath, ['-e', `const fs=require('fs');fs.writeFileSync('input.txt','updated');${script};console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(typeof result === 'string' ? result : JSON.stringify(result))}}));`], options);

async function plainFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mutants-tree-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// --- L106: /tmp toolchain warnings --------------------------------------------------------------

describe('L106: warn when a named tool path or check argv binary resolves under /tmp', () => {
  test('flags a checks argv[0] under /tmp', () => {
    const warnings = tmpToolPathWarnings({ jobs: [{ id: 'j' }], checks: [{ name: 'unit', argv: ['/tmp/tools/mytool', '--flag'] }] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].code, 'tmp-tool-path');
    assert.match(warnings[0].message, /3 days unread/);
  });

  test('flags a mutantCheck argv[0] under /private/tmp', () => {
    const warnings = tmpToolPathWarnings({ jobs: [], mutantCheck: { argv: ['/private/tmp/x/tool'] } });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].path, '/private/tmp/x/tool');
  });

  test('flags a job readPaths entry under /tmp', () => {
    const warnings = tmpToolPathWarnings({ jobs: [{ id: 'j', readPaths: ['/tmp/toolchain'] }] });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].jobId, 'j');
  });

  test('does not flag an ordinary path', () => {
    const warnings = tmpToolPathWarnings({ jobs: [{ id: 'j', readPaths: ['/opt/toolchain'] }], checks: [{ name: 'unit', argv: ['npm', 'test'] }] });
    assert.equal(warnings.length, 0);
  });

  test('validateProject surfaces the tmp-tool-path warning', async t => {
    const root = await fixture(t);
    const report = await validateProject(root, manifest({}, { checks: [{ name: 'unit', argv: ['/tmp/mytool'] }] }));
    assert.ok(report.warnings.some(w => w.code === 'tmp-tool-path'));
  });
});

// --- L107: core-module-no-shell warning + cost per 1k output tokens -----------------------------

describe('L107: outputs touching this runner\'s own core module warn when the agent has no shell; inspect shows cost per 1k output tokens', () => {
  test('warns for a non-codex job whose outputs include tools/swarm.mjs', () => {
    const warning = coreModuleNoShellWarning({ id: 'edit-core', agent: 'claude', outputs: ['tools/swarm.mjs'] });
    assert.equal(warning.code, 'core-module-no-shell');
    assert.match(warning.message, /consider a checker job/);
  });

  test('is silent for codex (has shell) and for unrelated outputs', () => {
    assert.equal(coreModuleNoShellWarning({ id: 'a', agent: 'codex', outputs: ['tools/swarm.mjs'] }), null);
    assert.equal(coreModuleNoShellWarning({ id: 'a', agent: 'claude', outputs: ['tools/other.mjs'] }), null);
  });

  test('validateProject surfaces the core-module-no-shell warning', async t => {
    const root = await fixture(t);
    const report = await validateProject(root, manifest({ outputs: ['input.txt', 'tools/swarm.mjs'] }));
    assert.ok(report.warnings.some(w => w.code === 'core-module-no-shell' && w.jobId === 'writer'));
  });

  test('costPer1kOutputTokens divides cost by output tokens per 1k, else null', () => {
    assert.equal(costPer1kOutputTokens({ costUsd: 0.02, usage: { output_tokens: 500 } }), 0.04);
    assert.equal(costPer1kOutputTokens({ costUsd: null, usage: { output_tokens: 500 } }), null);
    assert.equal(costPer1kOutputTokens({ costUsd: 0.02, usage: {} }), null);
    assert.equal(costPer1kOutputTokens({ costUsd: 0.02, usage: null }), null);
  });

  test('inspect reports costPer1kOutputTokens when both cost and output tokens are reported', async t => {
    const root = await fixture(t);
    const spawnImpl = (_cmd, _args, options) => spawn(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok',usage:{output_tokens:500},total_cost_usd:0.02}));"], options);
    const state = await runManifest(root, manifest(), { spawnImpl });
    const inspected = await inspectRun(root, state.id);
    assert.equal(inspected.jobs[0].costPer1kOutputTokens, 0.04);
  });
});

// --- L109: preChecks before checks on a changed lockfile ----------------------------------------

describe('L109: manifest preChecks run before checks when an integrated file is a lockfile', () => {
  const lockfileJob = () => job({ outputs: ['input.txt', 'package-lock.json'] });

  test('warns when a lockfile changed and no preChecks is declared', async t => {
    const root = await fixture(t);
    const spawnImpl = fake("fs.writeFileSync('package-lock.json','{}')");
    const state = await runManifest(root, { version: 1, jobs: [lockfileJob()] }, { spawnImpl });
    const result = await integrateRun(root, state.id);
    assert.deepEqual(result.warnings, ['lockfile changed, env not synced']);
    assert.equal(result.preChecks, undefined);
  });

  test('runs declared preChecks in order before checks, and adds no warning', async t => {
    const root = await fixture(t);
    const spawnImpl = fake("fs.writeFileSync('package-lock.json','{}')");
    const state = await runManifest(root, { version: 1, jobs: [lockfileJob()], preChecks: [[process.execPath, '-e', 'process.exit(0)']] }, { spawnImpl });
    const result = await integrateRun(root, state.id);
    assert.equal(result.warnings, undefined);
    assert.equal(result.preChecks.length, 1);
    assert.equal(result.preChecks[0].status, 'passed');
  });

  test('does not run when no lockfile is among the integrated files', async t => {
    const root = await fixture(t);
    const state = await runManifest(root, manifest(), { spawnImpl: fake() });
    const result = await integrateRun(root, state.id);
    assert.equal(result.warnings, undefined);
    assert.equal(result.preChecks, undefined);
  });
});

// --- L110: compact `failures` array on integrate + `--evidence` on validate/run -----------------

describe('L110: integrate reports a compact failures array; --evidence appends prior failures to every job prompt', () => {
  test('integrate reports a compact failures array for a failed check', async t => {
    const root = await fixture(t);
    const failingCheck = { name: 'unit', argv: [process.execPath, '-e', "console.error('AssertionError: expected 1 to equal 2');process.exit(1)"] };
    const state = await runManifest(root, manifest({}, { checks: [failingCheck] }), { spawnImpl: fake() });
    const result = await integrateRun(root, state.id);
    assert.equal(result.checksPassed, false);
    assert.equal(result.failures.length, 1);
    assert.equal(result.failures[0].name, 'unit');
    assert.ok(result.failures[0].lines.some(line => line.includes('AssertionError')));
  });

  test('integrate reports an empty failures array when every check passes', async t => {
    const root = await fixture(t);
    const passingCheck = { name: 'unit', argv: [process.execPath, '-e', 'process.exit(0)'] };
    const state = await runManifest(root, manifest({}, { checks: [passingCheck] }), { spawnImpl: fake() });
    const result = await integrateRun(root, state.id);
    assert.deepEqual(result.failures, []);
  });

  test('evidenceBlock formats a fixed heading with each failure\'s lines verbatim', () => {
    const block = evidenceBlock([{ name: 'unit', lines: ['AssertionError: expected 1 to equal 2'] }]);
    assert.match(block, /^## Evidence: prior check failures/);
    assert.match(block, /### unit/);
    assert.match(block, /AssertionError: expected 1 to equal 2/);
    assert.equal(evidenceBlock([]), '');
    assert.equal(evidenceBlock(undefined), '');
  });

  test('applyEvidence appends the block to every job prompt and is a no-op with no failures', () => {
    const m = { version: 1, jobs: [{ id: 'a', prompt: 'Do X.' }, { id: 'b', prompt: 'Do Y.' }] };
    const failures = [{ name: 'unit', lines: ['AssertionError: expected 1 to equal 2'] }];
    const updated = applyEvidence(m, failures);
    for (const j of updated.jobs) {
      assert.match(j.prompt, /## Evidence: prior check failures/);
      assert.match(j.prompt, /AssertionError: expected 1 to equal 2/);
    }
    assert.equal(m.jobs[0].prompt, 'Do X.', 'the original manifest is not mutated');
    assert.equal(applyEvidence(m, []), m);
  });
});

// --- L113: a runtime-check failure quoted into a no-shell job's prompt --------------------------

describe('L113: warn when a job prompt quotes a runtime-check failure and the agent has no shell', () => {
  test('fires for a check-name style failure (harness/e2e/playwright/preview)', () => {
    const warning = runtimeCheckNoShellWarning({ id: 'j', agent: 'claude', prompt: 'The playwright check failed on click.' });
    assert.equal(warning.code, 'runtime-check-no-shell');
    assert.match(warning.message, /consider a shell agent or --evidence/);
  });

  test('fires when both "Timeout" and "waitFor" appear', () => {
    const warning = runtimeCheckNoShellWarning({ id: 'j', agent: 'claude', prompt: 'Timeout waiting: page.waitFor(".ready") never resolved.' });
    assert.ok(warning);
  });

  test('is silent for codex (has shell) and for unrelated prompts', () => {
    assert.equal(runtimeCheckNoShellWarning({ id: 'j', agent: 'codex', prompt: 'playwright e2e harness failure' }), null);
    assert.equal(runtimeCheckNoShellWarning({ id: 'j', agent: 'claude', prompt: 'Fix the off-by-one bug in the parser.' }), null);
  });

  test('validateProject surfaces the runtime-check-no-shell warning', async t => {
    const root = await fixture(t);
    const report = await validateProject(root, manifest({ prompt: 'The e2e harness reported: Timeout: page.waitFor(".ready") failed.' }));
    assert.ok(report.warnings.some(w => w.code === 'runtime-check-no-shell' && w.jobId === 'writer'));
  });
});

// --- L115: contextGlob filename prefix + validate echoes matched counts ------------------------

describe('L115: contextGlob accepts a filename prefix; validate echoes the expanded count per pattern', () => {
  test('parseContextGlob accepts dir/prefix*.ext alongside dir/*.ext', () => {
    assert.deepEqual(parseContextGlob('shots/screenshot-*.png'), { dir: 'shots', prefix: 'screenshot-', ext: '.png' });
    assert.deepEqual(parseContextGlob('shots/*.png'), { dir: 'shots', prefix: '', ext: '.png' });
  });

  test('validateManifest accepts a prefixed contextGlob and still rejects **', () => {
    assert.doesNotThrow(() => validateManifest(manifest({ contextGlob: ['shots/screenshot-*.png'] })));
    assert.throws(() => validateManifest(manifest({ contextGlob: ['shots/**/*.png'] })), /no \*\* supported/);
  });

  test('validate expands only prefix-matching files and echoes the match count per pattern', async t => {
    const root = await fixture(t);
    await fs.mkdir(path.join(root, 'shots'));
    for (const name of ['screenshot-a.png', 'screenshot-b.png', 'other.png']) await fs.writeFile(path.join(root, 'shots', name), 'x');
    const report = await validateProject(root, manifest({ context: ['input.txt'], contextGlob: ['shots/screenshot-*.png'], outputs: ['review.md'] }));
    assert.deepEqual(report.jobs[0].contextGlobCounts, [{ pattern: 'shots/screenshot-*.png', count: 2 }]);
    const files = report.jobs[0].files.map(f => f.path);
    assert.ok(files.includes('shots/screenshot-a.png'));
    assert.ok(files.includes('shots/screenshot-b.png'));
    assert.ok(!files.includes('shots/other.png'));
  });
});

// --- L116: resultMissing on an unparsable JSON-only reply, with one cheap re-ask ----------------

describe('L116: an unparsable JSON-only reply is marked resultMissing, with one cheap same-session re-ask for claude', () => {
  test('sets resultMissing when the prompt demands JSON, the reply is unparsable, and no session id was observed', async t => {
    const root = await fixture(t);
    const m = { version: 1, jobs: [job({ prompt: 'Return JSON only with your answer.' })] };
    const spawnImpl = fake('', 'not json, just prose');
    const state = await runManifest(root, m, { spawnImpl });
    assert.equal(state.jobs[0].resultMissing, true);
    const inspected = await inspectRun(root, state.id);
    assert.equal(inspected.jobs[0].resultMissing, true);
    const inspectedResults = await inspectResults(root, state.id);
    assert.equal(inspectedResults.jobs[0].resultMissing, true);
  });

  test('does not set resultMissing when the prompt has no JSON demand, even with a prose reply', async t => {
    const root = await fixture(t);
    const spawnImpl = fake('', 'just prose, no JSON demanded');
    const state = await runManifest(root, manifest(), { spawnImpl });
    assert.equal(state.jobs[0].resultMissing, undefined);
  });

  test('recovers via one cheap re-ask on the same session and clears resultMissing', async t => {
    const root = await fixture(t);
    const m = { version: 1, jobs: [job({ prompt: 'Reply with ONLY this JSON object.' })] };
    let calls = 0;
    const capturedArgs = [];
    const spawnImpl = (_cmd, args, options) => {
      calls++;
      capturedArgs.push(args);
      const script = calls === 1
        ? `const fs=require('fs');fs.writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,session_id:'sess-1',result:${JSON.stringify('not json, just prose')}}));`
        : `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(JSON.stringify({ status: 'done' }))}}));`;
      return spawn(process.execPath, ['-e', script], options);
    };
    const state = await runManifest(root, m, { spawnImpl });
    assert.equal(calls, 2);
    assert.equal(state.jobs[0].resultMissing, false);
    const secondArgs = capturedArgs[1];
    assert.ok(secondArgs.includes('--resume'));
    assert.equal(secondArgs[secondArgs.indexOf('--resume') + 1], 'sess-1');
    const inspected = await inspectRun(root, state.id);
    assert.equal(inspected.jobs[0].resultMissing, undefined);
    assert.deepEqual(inspected.jobs[0].result, { status: 'done' });
  });
});

// --- L117: `mutants` runs directly on the current tree ------------------------------------------

describe('L117: mutants runs killed/survived/invalid mutation testing directly on the current tree', () => {
  test('reports killed, survived, invalid, and the first failing test line, restoring the file afterward', async t => {
    const root = await plainFixture(t);
    const original = 'function ok(v){return v<=10}\n';
    await fs.writeFile(path.join(root, 'target.js'), original);
    const mutantsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mutants-file-'));
    t.after(() => fs.rm(mutantsDir, { recursive: true, force: true }));
    const mutantsPath = path.join(mutantsDir, 'mutants.json');
    await fs.writeFile(mutantsPath, JSON.stringify([
      { name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10' },
      { name: 'always-true', file: 'target.js', find: 'return v<=10', replace: 'return true; //v<=10' },
      { name: 'no-such-string', file: 'target.js', find: 'NOPE_NOT_PRESENT', replace: 'x' },
    ]));
    const mutantCheck = JSON.stringify([process.execPath, '-e', "const ok=require('fs').readFileSync('target.js','utf8').includes('v<=10');if(!ok){console.error('AssertionError: expected v<=10 guard to remain');process.exit(1);}else process.exit(0);"]);
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn);
    assert.equal(result.mutantsSummary.killed, 1);
    assert.equal(result.mutantsSummary.survived, 1);
    assert.equal(result.mutantsSummary.invalid, 1);
    assert.equal(result.mutantsPassed, false);
    const killed = result.mutants.find(m => m.name === 'off-by-one');
    assert.equal(killed.status, 'killed');
    assert.match(killed.firstFailingLine, /AssertionError: expected v<=10 guard to remain/);
    const survived = result.mutants.find(m => m.name === 'always-true');
    assert.equal(survived.status, 'survived');
    assert.equal(survived.firstFailingLine, null);
    const invalid = result.mutants.find(m => m.name === 'no-such-string');
    assert.equal(invalid.status, 'invalid');
    assert.equal(invalid.firstFailingLine, null);
    assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
  });

  test('stops before the next mutant once interrupted, but still restores the one in flight', async t => {
    const root = await plainFixture(t);
    const original = 'function ok(v){return v<=10}\n';
    await fs.writeFile(path.join(root, 'target.js'), original);
    const mutantsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mutants-file-'));
    t.after(() => fs.rm(mutantsDir, { recursive: true, force: true }));
    const mutantsPath = path.join(mutantsDir, 'mutants.json');
    await fs.writeFile(mutantsPath, JSON.stringify([
      { name: 'first', file: 'target.js', find: 'v<=10', replace: 'v<10' },
      { name: 'second', file: 'target.js', find: 'return v<=10', replace: 'return true; //v<=10' },
    ]));
    const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('v<=10')?0:1)"]);
    let checks = 0;
    const isInterrupted = () => checks++ > 0;
    const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn, isInterrupted);
    assert.equal(result.mutants.length, 1);
    assert.equal(result.mutants[0].name, 'first');
    assert.equal(await fs.readFile(path.join(root, 'target.js'), 'utf8'), original);
  });

  test('refuses with no mutants and refuses with no mutant check', async t => {
    const root = await plainFixture(t);
    await fs.writeFile(path.join(root, 'target.js'), 'x');
    const mutantsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-mutants-file-'));
    t.after(() => fs.rm(mutantsDir, { recursive: true, force: true }));
    const emptyPath = path.join(mutantsDir, 'empty.json');
    await fs.writeFile(emptyPath, '[]');
    await assert.rejects(runMutantsCurrentTree(root, { mutantsFile: emptyPath, mutantCheck: '["true"]' }, spawn), /No mutants declared/);
    const onePath = path.join(mutantsDir, 'one.json');
    await fs.writeFile(onePath, JSON.stringify([{ name: 'a', file: 'target.js', find: 'x', replace: 'y' }]));
    await assert.rejects(runMutantsCurrentTree(root, { mutantsFile: onePath }, spawn), /--mutant-check/);
  });
});
