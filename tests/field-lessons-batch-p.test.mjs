// SPDX-License-Identifier: Apache-2.0
// Swarm batch P: field lessons 229-236 (see .swarm-manifests/contract-p.md).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  eventReaderNoProducerWarnings, utcOnlyWindowTestWarning, sumCreditPreflight,
  validateManifest, validateProject, runManifest, integrateRun,
} from '../tools/swarm.mjs';
import { nonBookkeepingOutputs } from '../tools/openrouter.mjs';
import { ship, releaseTitleVersion } from '../tools/ship.mjs';

async function fixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-batch-p-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const manifest = jobs => ({ version: 1, concurrency: 1, jobs });
const job = (overrides = {}) => ({ id: 'w', agent: 'claude', model: 'sonnet', prompt: 'Do the task.', context: [], outputs: ['out.txt'], timeoutMs: 5000, ...overrides });
function fake(script) {
  return (_command, _args, options) => spawn(process.execPath, ['--input-type=module', '-e', `import fs from 'node:fs';\n${script}`], options);
}
const done = `console.log(JSON.stringify({type:'result',subtype:'success',is_error:false,result:'ok'}));`;

// --- #229: contract's Event names table; validate warns event-reader-no-producer ----------------

test('#229: eventReaderNoProducerWarnings warns for a reader row with an empty producer cell, not for a filled one', () => {
  const withGap = [
    '| event | producer file:line | reader file:line |',
    '|---|---|---|',
    '| gate_prompted | | scoreboard.py:40 |',
  ].join('\n');
  const warnings = eventReaderNoProducerWarnings(withGap);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].code, 'event-reader-no-producer');
  assert.equal(warnings[0].event, 'gate_prompted');

  const withProducer = [
    '| event | producer file:line | reader file:line |',
    '|---|---|---|',
    '| gate_prompted | chat.py:10 | scoreboard.py:40 |',
  ].join('\n');
  assert.deepEqual(eventReaderNoProducerWarnings(withProducer), []);
});

test('#229: validateProject warns event-reader-no-producer when the manifest contract names one', async t => {
  const root = await fixture(t);
  const contractText = [
    '# Contract',
    '## Event names',
    '| event | producer file:line | reader file:line |',
    '|---|---|---|',
    '| gate_prompted | | scoreboard.py:40 |',
  ].join('\n');
  await fs.writeFile(path.join(root, 'CONTRACT.md'), contractText);
  const m = { ...manifest([job({ context: ['CONTRACT.md'] })]), contract: 'CONTRACT.md' };
  const report = await validateProject(root, m);
  assert.ok(report.warnings.some(w => w.code === 'event-reader-no-producer' && w.event === 'gate_prompted'));
});

test('#229: templates/coordination/CONTRACT.md exists with an Event names table and a Time zones line', async () => {
  const text = await fs.readFile(new URL('../templates/coordination/CONTRACT.md', import.meta.url), 'utf8');
  assert.ok(text.includes('Event names'));
  assert.match(text, /producer file:line/);
  assert.ok(text.includes('Time zones'));
  assert.ok(text.split('\n').length <= 40);
});

// --- #230: DeepSeek bookkeeping outputs may include .swarm-manifests/*.md -----------------------

test('#230: nonBookkeepingOutputs allows .swarm-manifests/*.md but still refuses another design .md', () => {
  assert.deepEqual(nonBookkeepingOutputs('deepseek/deepseek-chat', ['.swarm-manifests/p-pr-create.json', '.swarm-manifests/notes.md']), []);
  assert.deepEqual(nonBookkeepingOutputs('deepseek/deepseek-chat', ['docs/design.md']), ['docs/design.md']);
});

test('#230: validateManifest allows a deepseek job writing .swarm-manifests/*.md, refuses another .md naming the cheap-tier rule', () => {
  const allowed = manifest([job({ agent: 'openrouter', model: 'deepseek/deepseek-chat', outputs: ['.swarm-manifests/notes.md'] })]);
  assert.doesNotThrow(() => validateManifest(allowed));
  const refused = manifest([job({ agent: 'openrouter', model: 'deepseek/deepseek-chat', outputs: ['docs/design.md'] })]);
  assert.throws(() => validateManifest(refused), /cheap Claude tier/);
});

// --- #231: maxCredits/creditPreflight, enforced in code before any job runs ----------------------

test('#231: sumCreditPreflight sums cost across preflight rows', () => {
  assert.equal(sumCreditPreflight([{ call: 'a', cost: 1 }, { call: 'b', cost: 2.5 }]), 3.5);
  assert.equal(sumCreditPreflight([]), 0);
});

test('#231: validate refuses credit-preflight-missing when maxCredits is set but the preflight file cannot be read', async t => {
  const root = await fixture(t);
  const m = manifest([job({ maxCredits: 100 })]);
  await assert.rejects(validateProject(root, m), /credit-preflight-missing/);
});

test('#231: validate refuses credit-cap-exceeded naming the sum, cap and call count', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'preflight.json'), JSON.stringify([{ call: 'gen', cost: 100 }, { call: 'gen', cost: 100 }]));
  const m = manifest([job({ maxCredits: 150, creditPreflight: 'preflight.json' })]);
  await assert.rejects(validateProject(root, m), error => {
    assert.match(error.message, /credit-cap-exceeded/);
    assert.match(error.message, /200/);
    assert.match(error.message, /150/);
    assert.match(error.message, /2 calls/);
    return true;
  });
});

test('#231: validate passes when the preflight total is at or under the cap', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'preflight.json'), JSON.stringify([{ call: 'gen', cost: 50 }]));
  const m = manifest([job({ maxCredits: 150, creditPreflight: 'preflight.json' })]);
  const report = await validateProject(root, m);
  assert.equal(report.status, 'valid');
});

test('#231 legacy: a job manifest with no maxCredits (the pre-#231 shape, as already sits on disk) validates exactly as before, no credit check applied', async t => {
  const root = await fixture(t);
  const legacyManifestText = JSON.stringify(manifest([job()]));
  const m = JSON.parse(legacyManifestText);
  assert.equal(m.jobs[0].maxCredits, undefined);
  const report = await validateProject(root, m);
  assert.equal(report.status, 'valid');
});

// --- #232: output-not-in-base warns at validate; integrate treats absent-from-both as not-written -

test('#232: validate warns output-not-in-base for a declared test output that does not exist yet', async t => {
  const root = await fixture(t);
  const m = manifest([job({ outputs: ['tests/typo-name.test.mjs'] })]);
  const report = await validateProject(root, m);
  assert.ok(report.warnings.some(w => w.code === 'output-not-in-base' && w.path === 'tests/typo-name.test.mjs'));
});

test('#232: validate does not warn output-not-in-base for an ordinary new (non-test) output', async t => {
  const root = await fixture(t);
  const m = manifest([job({ outputs: ['new-source-file.txt'] })]);
  const report = await validateProject(root, m);
  assert.ok(!report.warnings.some(w => w.code === 'output-not-in-base'));
});

test('#232: integrate treats an output absent from both base and workspace as not-written (warning), never a delete', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const m = manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt', 'never-made.txt'] })]);
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  const result = await integrateRun(root, state.id);
  assert.equal(result.status, 'integrated');
  assert.ok(result.warnings.some(w => w === 'output-never-written: never-made.txt'), JSON.stringify(result.warnings));
});

test('#232: integrate still refuses undeclared-delete when the missing output actually existed in base', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  await fs.writeFile(path.join(root, 'existing.txt'), 'here');
  const m = manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt', 'existing.txt'] })]);
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');fs.unlinkSync('existing.txt');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  await assert.rejects(integrateRun(root, state.id), /undeclared-delete/);
});

// --- #233: mutants/integrate --mutants run the baseline once first; refuse mutant-check-broken ---

test('#233: integrate --mutants refuses mutant-check-broken naming the exit code when the shared check cannot even start', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const brokenCheck = ['node', '/no/such/harness.js'];
  const m = {
    ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]),
    mutants: [{ name: 'flip', file: 'input.txt', find: 'updated', replace: 'mutated' }],
    mutantCheck: { argv: brokenCheck },
  };
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  await assert.rejects(integrateRun(root, state.id, { mutants: true }), error => {
    assert.match(error.message, /mutant-check-broken/);
    assert.match(error.message, /exit/);
    return true;
  });
});

test('#233: a mutant that times out post-baseline is reported error, and the summary line says N errored — not a kill', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), "const A='alpha'; const B='beta';\n");
  const checkScript = "const t=require('fs').readFileSync('input.txt','utf8');if(t.includes('BROKEN')){process.exit(1);}else if(t.includes('HANG')){setInterval(()=>{},1000);}else{process.exit(0);}";
  const m = {
    ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]),
    mutants: [
      { name: 'killer', file: 'input.txt', find: "'alpha'", replace: "'BROKEN'" },
      { name: 'hanger', file: 'input.txt', find: "'beta'", replace: "'HANG'" },
    ],
    mutantCheck: { argv: [process.execPath, '-e', checkScript], timeoutMs: 1000 },
  };
  const spawnImpl = fake(done);
  const state = await runManifest(root, m, { spawnImpl });
  const result = await integrateRun(root, state.id, { mutants: true });
  assert.equal(result.mutantsSummary.killed, 1);
  assert.equal(result.mutantsSummary.errors, 1);
  assert.match(result.mutantsSummaryLine, /1 errored — not a kill/);
  assert.equal(await fs.readFile(path.join(root, 'input.txt'), 'utf8'), "const A='alpha'; const B='beta';\n");
});

// --- #234: ship refuses release-version-mismatch --------------------------------------------------

function shipFixtureExec(script, { packageJson = null, changelog = null } = {}) {
  let index = 0;
  return async (file, args) => {
    if (file === 'git' && args[0] === 'remote') return { code: 0, stdout: 'https://github.com/acme/widgets.git\n', stderr: '' };
    if (file === 'git' && args[0] === 'merge-base') return { code: 1, stdout: '', stderr: 'no merge base' };
    if (file === 'git' && args[0] === 'diff' && args.includes('--name-only')) return { code: 0, stdout: '', stderr: '' };
    if (file === 'git' && args[0] === 'show' && args[1] === 'HEAD:package.json') return packageJson ?? { code: 1, stdout: '', stderr: 'not found' };
    if (file === 'git' && args[0] === 'show' && args[1] === 'HEAD:CHANGELOG.md') return changelog ?? { code: 1, stdout: '', stderr: 'not found' };
    const entry = script[index++];
    return typeof entry === 'function' ? entry(file, args) : entry;
  };
}
const shipOk = (stdout = '') => ({ code: 0, stdout, stderr: '' });
const shipRev = sha => shipOk(`${sha}\n`);
const authorEmailExecOk = async args => (args[0] === 'config' ? shipOk('me@example.com\n') : shipOk(''));

test('releaseTitleVersion reads a version from a "Release X.Y.Z: ..." title, a bare version, or neither', () => {
  assert.equal(releaseTitleVersion('Release 1.30.0: field lessons 229-236'), '1.30.0');
  assert.equal(releaseTitleVersion('1.30.0'), '1.30.0');
  assert.equal(releaseTitleVersion('Add feature'), null);
});

test('#234: ship refuses release-version-mismatch when the PR title names a version package.json disagrees with', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Release 1.30.0: field lessons', head: 'release-branch', base: 'main', body: 'body text' }));
  const exec = shipFixtureExec([shipOk(''), shipRev('sha123')], { packageJson: shipOk(JSON.stringify({ version: '1.20.0' })), changelog: shipOk('## 1.30.0\n') });
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    runChecks: async () => { throw new Error('must not run'); }, sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'release-version-mismatch');
  assert.match(result.reason, /1\.20\.0/);
});

test('#234: ship refuses release-version-mismatch when the CHANGELOG top heading is still Unreleased', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Release 1.30.0: field lessons', head: 'release-branch', base: 'main', body: 'body text' }));
  const exec = shipFixtureExec([shipOk(''), shipRev('sha123')], { packageJson: shipOk(JSON.stringify({ version: '1.30.0' })), changelog: shipOk('## Unreleased\n') });
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    runChecks: async () => { throw new Error('must not run'); }, sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'refused');
  assert.equal(result.code, 'release-version-mismatch');
  assert.match(result.reason, /Unreleased/);
});

test('#234: ship proceeds normally once the title, package.json and CHANGELOG heading all agree', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Release 1.30.0: field lessons', head: 'release-branch', base: 'main', body: 'body text' }));
  const exec = shipFixtureExec([
    shipOk(''), // git status
    shipRev('sha123'), // rev-parse HEAD
    shipOk(''), // push
    shipOk('[]'), // pr list
    shipOk(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' })), // pr create
    shipOk(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })), // pr view
  ], { packageJson: shipOk(JSON.stringify({ version: '1.30.0' })), changelog: shipOk('## 1.30.0\n') });
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
});

test('#234: ship never checks release version for an ordinary PR title', async t => {
  const root = await fixture(t);
  const payloadPath = path.join(root, 'pr.json');
  await fs.writeFile(payloadPath, JSON.stringify({ title: 'Add feature', head: 'feature-branch', base: 'main', body: 'body text' }));
  const exec = shipFixtureExec([
    shipOk(''), shipRev('sha123'), shipOk(''), shipOk('[]'),
    shipOk(JSON.stringify({ number: 9, html_url: 'https://example.com/pr/9' })),
    shipOk(JSON.stringify({ state: 'OPEN', headRefOid: 'sha123', mergeStateStatus: 'CLEAN', statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }] })),
  ]);
  const result = await ship({
    root, repo: 'acme/widgets', payloadPath, exec, merge: false, authorEmailExec: authorEmailExecOk,
    runChecks: async () => [{ name: 'unit', status: 'passed', exitCode: 0, tail: '' }],
    sleep: async () => {}, now: () => 0,
  });
  assert.equal(result.status, 'ready', JSON.stringify(result));
});

// --- #235: utc-only-window-tests -------------------------------------------------------------------

test('#235: utcOnlyWindowTestWarning warns when a date-window output has no non-UTC test, silent once one exists', () => {
  const files = new Map([
    ['scoreboard.py', 'def window():\n    return datetime.now(timezone.utc).date()\n'],
    ['tests/test_scoreboard.py', 'def test_window(): assert True\n'],
  ]);
  const noZone = utcOnlyWindowTestWarning({ id: 'w', outputs: ['scoreboard.py'], context: ['tests/test_scoreboard.py'] }, files);
  assert.equal(noZone.code, 'utc-only-window-tests');

  const withZone = new Map(files);
  withZone.set('tests/test_scoreboard.py', 'from datetime import timezone, timedelta\ntz = timezone(timedelta(hours=-5))\n');
  assert.equal(utcOnlyWindowTestWarning({ id: 'w', outputs: ['scoreboard.py'], context: ['tests/test_scoreboard.py'] }, withZone), null);
});

test('#235: validate warns utc-only-window-tests for a job output touching a date-window comparison with no non-UTC test', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'scoreboard.py'), 'def window():\n    return datetime.now(timezone.utc).date()\n');
  await fs.writeFile(path.join(root, 'tests/test_scoreboard.py'), 'def test_window(): assert True\n');
  const m = manifest([job({ context: ['tests/test_scoreboard.py'], outputs: ['scoreboard.py'] })]);
  const report = await validateProject(root, m);
  assert.ok(report.warnings.some(w => w.code === 'utc-only-window-tests'));
});

test('#235: validate does not warn utc-only-window-tests once a context test names a non-UTC zone', async t => {
  const root = await fixture(t);
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'scoreboard.py'), 'def window():\n    return datetime.now(timezone.utc).date()\n');
  await fs.writeFile(path.join(root, 'tests/test_scoreboard.py'), 'from datetime import timezone, timedelta\ntz = timezone(timedelta(hours=-5))\n');
  const m = manifest([job({ context: ['tests/test_scoreboard.py'], outputs: ['scoreboard.py'] })]);
  const report = await validateProject(root, m);
  assert.ok(!report.warnings.some(w => w.code === 'utc-only-window-tests'));
});

// --- #236: preChecks always run before checks; a broken preCheck is checks-not-runnable, never
//           a red base; --mutants-file resolves against this run's own outputs -------------------

test('#236: preChecks run before checks even when this run touched no lockfile', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const m = { ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]), preChecks: [[process.execPath, '-e', 'process.exit(0)']] };
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  const result = await integrateRun(root, state.id);
  assert.equal(result.preChecks.length, 1);
  assert.equal(result.preChecks[0].status, 'passed');
});

test('#236: a preCheck that cannot even start (ENOENT) refuses checks-not-runnable, never a red base', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'input.txt'), 'original');
  const m = { ...manifest([job({ id: 'w', context: ['input.txt'], outputs: ['input.txt'] })]), preChecks: [['/no/such/binary-here', '--version']] };
  const spawnImpl = fake(`fs.writeFileSync('input.txt','updated');${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  await assert.rejects(integrateRun(root, state.id), /checks-not-runnable/);
});

test('#236: --mutants-file resolves against this run\'s own outputs when the root copy is not written yet', async t => {
  const root = await fixture(t);
  await fs.writeFile(path.join(root, 'target.txt'), 'const A=1;\n');
  const mutantsJson = JSON.stringify([{ name: 'flip', file: 'target.txt', find: 'A=1', replace: 'A=2' }]);
  const m = manifest([job({ id: 'w', context: ['target.txt'], outputs: ['.swarm-manifests/p-mutants.json'] })]);
  const spawnImpl = fake(`fs.mkdirSync('.swarm-manifests',{recursive:true});fs.writeFileSync('.swarm-manifests/p-mutants.json',${JSON.stringify(mutantsJson)});${done}`);
  const state = await runManifest(root, m, { spawnImpl });
  const mutantCheck = JSON.stringify([process.execPath, '-e', "process.exit(require('fs').readFileSync('target.txt','utf8').includes('A=2')?1:0)"]);
  // Note: at the point this file's own mutants source is read, integrate has not yet copied
  // .swarm-manifests/p-mutants.json to the project root — it is still only in `writes`.
  const result = await integrateRun(root, state.id, { mutants: true, mutantsFile: '.swarm-manifests/p-mutants.json', mutantCheck });
  assert.equal(result.mutantsSummary.killed, 1);
});
