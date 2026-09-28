// SPDX-License-Identifier: Apache-2.0
// Field lessons #198, #199, #200, #201, #203, #205 (swarm 1.26.0 batch L).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  runManifest, integrateRun, validateProject, inspectRun, askRun, runMutantsCurrentTree,
  shellSandboxDeniedCheckWarnings, missingLockPathSourceWarnings,
} from '../tools/swarm.mjs';
import { probeCheckInterpreters } from '../tools/preflight.mjs';
import { git } from '../tools/codex-adapter.mjs';

const execFileAsync = promisify(execFile);
const CLI = fileURLToPath(new URL('../tools/swarm.mjs', import.meta.url));

const job = (extra = {}) => ({ id: 'writer', agent: 'claude', model: 'sonnet', prompt: 'Update input.', context: ['input.txt'], outputs: ['input.txt'], ...extra });
const manifest = (jobExtra = {}, spec = {}) => ({ version: 1, jobs: [job(jobExtra)], ...spec });
const codexJob = (overrides = {}) => ({ id: 'c', agent: 'codex', model: 'test-model', prompt: 'Update the output.', context: ['input.txt'], outputs: ['output.txt'], timeoutMs: 10000, ...overrides });
const fake = () => (_cmd, _args, options) => spawn(process.execPath, ['-e', "require('fs').writeFileSync('input.txt','updated');console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'done'}));"], options);

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-l-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ['init', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Fixture']);
  await git(root, ['config', 'user.email', 'fixture@example.invalid']);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'output.txt'), 'original output');
  await fs.writeFile(path.join(root, '.gitignore'), '.swarm/\n');
  await git(root, ['add', '.']);
  await git(root, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'base']);
  return root;
}

async function askFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-l-ask-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.writeFile(path.join(root, 'input.txt'), 'source');
  return root;
}

async function plainFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-l-plain-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// --- #198: interpreter probe honors an `env VAR=...` prefix's own PATH -------------------------

test('#198: probeCheckInterpreters honors an env prefix\'s own PATH before the toolchains dir/process PATH', async t => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-l-bin-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const fakeprog = path.join(bin, 'fakeprog');
  await fs.writeFile(fakeprog, '#!/bin/sh\nexit 0\n');
  await fs.chmod(fakeprog, 0o755);
  const failures = await probeCheckInterpreters({ checks: [{ name: 'probe-check', argv: ['env', `PATH=${bin}`, 'fakeprog'] }] });
  assert.deepEqual(failures, []);
});

test('#198: a genuinely missing program (even behind an env prefix) is still refused, naming the dirs searched', async t => {
  const bin = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-l-bin-empty-'));
  t.after(() => fs.rm(bin, { recursive: true, force: true }));
  const failures = await probeCheckInterpreters({ checks: [{ name: 'probe-check', argv: ['env', `PATH=${bin}`, 'no-such-prog-xyz'] }] });
  assert.equal(failures.length, 1);
  assert.match(failures[0].error, /searched/);
  assert.ok(failures[0].tried.includes(path.join(bin, 'no-such-prog-xyz')));
});

// --- #199: mutants killedBy/note are documentation-only, compared against the real failure -------

test('#199: killedBy/note are accepted (not refused as unknown fields); a wrong killedBy claim is warned', async t => {
  const root = await plainFixture(t);
  await fs.writeFile(path.join(root, 'target.js'), 'function ok(v){return v<=10}\n');
  const mutantsPath = path.join(root, 'mutants.json');
  await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10', killedBy: 'guard-test', note: 'seen locally' }]));
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('target.js','utf8').includes('v<=10')?0:1)"]);
  const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn);
  assert.equal(result.mutants[0].status, 'killed');
  assert.ok(result.warnings.some(w => /killedBy mismatch/.test(w)), JSON.stringify(result.warnings));
});

test('#199: a killedBy claim matching the real failure output is not flagged as a mismatch', async t => {
  const root = await plainFixture(t);
  await fs.writeFile(path.join(root, 'target.js'), 'function ok(v){return v<=10}\n');
  const mutantsPath = path.join(root, 'mutants.json');
  await fs.writeFile(mutantsPath, JSON.stringify([{ name: 'off-by-one', file: 'target.js', find: 'v<=10', replace: 'v<10', killedBy: 'guard-triggered' }]));
  const mutantCheck = JSON.stringify([process.execPath, '-e', "if(require('fs').readFileSync('target.js','utf8').includes('v<=10')){process.exit(0)}else{console.log('guard-triggered');process.exit(1)}"]);
  const result = await runMutantsCurrentTree(root, { mutantsFile: mutantsPath, mutantCheck }, spawn);
  assert.equal(result.mutants[0].status, 'killed');
  assert.ok(!(result.warnings ?? []).some(w => /killedBy mismatch/.test(w)), JSON.stringify(result.warnings));
});

// --- #200: ask never reports a bare "complete" + null result on a parse failure ------------------

function fakeAsk(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const initEvent = model => JSON.stringify({ type: 'system', subtype: 'init', model });

test('#200: a stray "key":value inside an array is repaired instead of yielding complete+null', async t => {
  const root = await askFixture(t);
  const badJson = '{"summary": ["basis":"context-only", "looks fine"]}';
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify(badJson)}}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Ok?' }, { spawnImpl: fakeAsk(script) });
  assert.equal(result.repaired, true);
  assert.deepEqual(result.result, { summary: ['context-only', 'looks fine'] });
});

test('#200: a genuinely unparsable reply is reported "unparsed" with rawPath, never complete+null', async t => {
  const root = await askFixture(t);
  const script = `console.log(${JSON.stringify(initEvent('claude-sonnet-5-20260101'))});console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:${JSON.stringify('Just prose, no JSON here.')}}));`;
  const result = await askRun(root, { model: 'sonnet', context: ['input.txt'], question: 'Ok?' }, { spawnImpl: fakeAsk(script) });
  assert.notEqual(result.status, 'complete');
  assert.equal(result.status, 'unparsed');
  assert.equal(typeof result.rawPath, 'string');
  assert.equal(result.result, undefined);
});

// --- #201: a setup failure names its phase + log tail; a missing uv.lock path source warns -------

test('#201: a failing setup marks the job\'s phase "setup" with the setup log tail, visible via inspect', async t => {
  const root = await fixture(t);
  const setupArgv = [process.execPath, '-e', "console.error('boom: vendored wheel missing'); process.exit(3)"];
  const spawnImpl = (command, args, options) => {
    if (command === 'sandbox-exec') assert.fail('the worker must never be spawned after a failing setup');
    return spawn(command, args, options);
  };
  const state = await runManifest(root, { version: 1, jobs: [codexJob({ setup: [setupArgv] })] }, { platform: 'darwin', spawnImpl });
  assert.equal(state.jobs[0].status, 'failed');
  const inspected = await inspectRun(root, state.id);
  assert.equal(inspected.jobs[0].phase, 'setup');
  assert.match(inspected.jobs[0].setupError, /boom: vendored wheel missing/);
});

test('#201: validate warns when uv.lock names a local path source missing from the tree', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'uv.lock'), '[[package]]\nname = "corepkg"\nversion = "1.2.3"\nsource = { path = "vendor/corepkg-1.2.3-py3-none-any.whl" }\n');
  const result = await validateProject(root, manifest());
  assert.ok(result.warnings.some(w => w.code === 'uv-lock-missing-path-source' && w.path === 'vendor/corepkg-1.2.3-py3-none-any.whl'), JSON.stringify(result.warnings));
});

test('#201: missingLockPathSourceWarnings does not warn when the named path source exists', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'vendor'));
  await fs.writeFile(path.join(root, 'vendor', 'corepkg-1.2.3-py3-none-any.whl'), 'x');
  await fs.writeFile(path.join(root, 'uv.lock'), '[[package]]\nname = "corepkg"\nversion = "1.2.3"\nsource = { path = "vendor/corepkg-1.2.3-py3-none-any.whl" }\n');
  assert.deepEqual(await missingLockPathSourceWarnings(root), []);
});

// --- #203: a failed check at integrate refuses by default; --accept-failed-checks says so loudly -

test('#203: integrate refuses by default when a check fails, naming it; --accept-failed-checks reports integrated-with-failures', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'fails', argv: [process.execPath, '-e', 'process.exit(1)'] }];
  const stateDefault = await runManifest(root, manifest({}, { checks }), { spawnImpl: fake(), id: 'batch-l-203-default' });
  await assert.rejects(execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', stateDefault.id]), error => {
    assert.equal(error.code, 1);
    const parsed = JSON.parse(error.stdout);
    assert.equal(parsed.checksPassed, false);
    assert.ok(parsed.warnings.some(w => /check\(s\) failed: fails/.test(w)), JSON.stringify(parsed.warnings));
    return true;
  });
  const stateAccepted = await runManifest(root, manifest({}, { checks }), { spawnImpl: fake(), id: 'batch-l-203-accepted' });
  const accepted = await execFileAsync(process.execPath, [CLI, '--root', root, 'integrate', stateAccepted.id, '--accept-failed-checks']);
  const parsedAccepted = JSON.parse(accepted.stdout);
  assert.equal(parsedAccepted.status, 'integrated-with-failures');
  assert.ok(parsedAccepted.warnings.some(w => /check\(s\) failed: fails/.test(w)), JSON.stringify(parsedAccepted.warnings));
});

test('#203: integrateRun itself is unchanged (checksPassed still reported); the refusal is the CLI default', async t => {
  const root = await fixture(t);
  const checks = [{ name: 'fails', argv: [process.execPath, '-e', 'process.exit(1)'] }];
  const state = await runManifest(root, manifest({}, { checks }), { spawnImpl: fake() });
  const result = await integrateRun(root, state.id);
  assert.equal(result.status, 'integrated');
  assert.equal(result.checksPassed, false);
});

// --- #205: validate warns on a shell check/prompt naming a path outside the sandbox ---------------

test('#205: validate warns when a shell job\'s check names a path under $HOME the sandbox denies', () => {
  const deniedManifest = {
    version: 1,
    jobs: [{ id: 'w', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Fix it.', context: [], outputs: ['out.txt'] }],
    checks: [{ name: 'check-pins', argv: ['node', '$HOME/.project-swarm/current/tools/swarm.mjs', 'check-pins'] }],
  };
  const warnings = shellSandboxDeniedCheckWarnings(deniedManifest);
  assert.ok(warnings.some(w => w.code === 'shell-sandbox-denied-check' && w.check === 'check-pins'), JSON.stringify(warnings));
});

test('#205: no warning for a shell job whose checks stay inside the project, or for a non-shell job', () => {
  const cleanManifest = {
    version: 1,
    jobs: [{ id: 'w', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Fix it.', context: [], outputs: ['out.txt'] }],
    checks: [{ name: 'unit', argv: ['npm', 'test'] }],
  };
  assert.deepEqual(shellSandboxDeniedCheckWarnings(cleanManifest), []);
  const nonShellManifest = { version: 1, jobs: [job()], checks: [{ name: 'check-pins', argv: ['node', '$HOME/.project-swarm/current/tools/swarm.mjs', 'check-pins'] }] };
  assert.deepEqual(shellSandboxDeniedCheckWarnings(nonShellManifest), []);
});

test('#205: validate warns when a shell job\'s own prompt names a denied path without saying "integrate runs this"', () => {
  const manifestWithPromptPath = {
    version: 1,
    jobs: [{ id: 'w', agent: 'claude', shell: true, model: 'sonnet', prompt: 'Run ~/.project-swarm/current/tools/swarm.mjs yourself.', context: [], outputs: ['out.txt'] }],
  };
  const warnings = shellSandboxDeniedCheckWarnings(manifestWithPromptPath);
  assert.ok(warnings.some(w => w.code === 'shell-sandbox-denied-prompt-path'), JSON.stringify(warnings));
  const manifestExcused = { ...manifestWithPromptPath, jobs: [{ ...manifestWithPromptPath.jobs[0], prompt: 'Do not run ~/.project-swarm yourself; integrate runs this.' }] };
  assert.deepEqual(shellSandboxDeniedCheckWarnings(manifestExcused), []);
});
