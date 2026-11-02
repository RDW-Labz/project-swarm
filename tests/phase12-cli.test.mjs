// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runCheckArgv, refreshRepoMap } from '../tools/init.mjs';
import { protectedViolations, validateProfile } from '../tools/init-profile.mjs';

const exec = promisify(execFile);
const swarm = path.join(path.dirname(fileURLToPath(import.meta.url)), '../tools/swarm.mjs');
const temp = async t => {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-p12-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
};
const run = (root, home, args) => exec(process.execPath, [swarm, '--root', root, ...args], { env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG }, input: '' });
const fail = (root, home, args) => run(root, home, args).then(() => assert.fail('expected failure'), error => error);

async function project(t, testScript = 'node -e "process.exit(0)"') {
  const root = await temp(t);
  await exec('git', ['init', '-q', '-b', 'main', root]);
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'tests'));
  await fs.writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '1.0.0', scripts: { test: testScript } }));
  await fs.writeFile(path.join(root, 'src/math.mjs'), 'export function add(a, b) { return a + b; }\n');
  await fs.writeFile(path.join(root, 'tests/math.test.mjs'), "import { add } from '../src/math.mjs';\nconsole.log(add(1, 2));\n");
  await fs.writeFile(path.join(root, '.env'), 'SECRET=1\n');
  await exec('git', ['-C', root, 'add', '.']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'init']);
  return root;
}
const initJson = async (root, home, args = []) => JSON.parse((await run(root, home, ['init', ...args])).stdout.trim().split('\n').pop());
const pointer = async root => JSON.parse(await fs.readFile(path.join(root, '.project-swarm.json'), 'utf8'));
const snapshot = async root => {
  const out = {};
  const walk = async dir => {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full); else { const st = await fs.stat(full); out[path.relative(root, full)] = `${st.size}:${st.mtimeMs}`; }
    }
  };
  await walk(root);
  return out;
};

test('init writes the profile: stack, sensitivity, protected paths, budget, a green base check, and the repo map', async t => {
  const root = await project(t), home = await temp(t);
  const result = await initJson(root, home, ['--not-sensitive', '--base-check', '--protect', 'secrets/', '--max-usd', '3']);
  assert.equal(result.profile.sensitive, false);
  assert.ok(result.profile.protectedPaths.includes('.env'));
  assert.ok(result.profile.protectedPaths.includes('secrets/'));
  assert.equal(result.profile.budget.maxUsd, 3);
  assert.equal(result.profile.baseCheck.status, 'green');
  assert.equal(result.profile.baseCheck.checks[0].name, 'test');
  assert.equal(result.repoMap.files >= 3, true);
  assert.deepEqual((await pointer(root)).profile, result.profile);
  const map = JSON.parse(await fs.readFile(path.join(root, '.swarm/project/repo-map.json'), 'utf8'));
  assert.deepEqual(map.testLinks, [{ test: 'tests/math.test.mjs', source: 'src/math.mjs', by: 'import' }]);
});

test('a failing project is recorded red, with a warning, and the plan carries the base-red risk', async t => {
  const root = await project(t, 'node -e "process.exit(3)"'), home = await temp(t);
  const result = await initJson(root, home, ['--not-sensitive', '--base-check']);
  assert.equal(result.profile.baseCheck.status, 'red');
  assert.ok(result.warnings.some(warning => warning.startsWith('base-red')));
  const plan = (await run(root, home, ['plan', 'add a thing to src'])).stdout;
  assert.match(plan, /base-red: Base checks: RED, already failing before any change: test/);
});

test('--no-base-check and --no-map skip them; a rerun keeps the owner answers and an explicit flag overrides', async t => {
  const root = await project(t), home = await temp(t);
  const first = await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map', '--protect', 'keep/']);
  assert.equal(first.profile.baseCheck.status, 'skipped');
  assert.equal(first.repoMap, null);
  await assert.rejects(fs.stat(path.join(root, '.swarm/project/repo-map.json')));
  const again = await initJson(root, home, ['--no-base-check', '--no-map']);
  assert.equal(again.profile.sensitive, false, 'the earlier answer is kept');
  assert.ok(again.profile.protectedPaths.includes('keep/'));
  assert.equal((await initJson(root, home, ['--sensitive', '--no-base-check', '--no-map'])).profile.sensitive, true);
  assert.equal((await fail(root, home, ['init', '--protect', '../x'])).code, 1);
  assert.equal((await fail(root, home, ['init', '--bogus'])).code, 1);
  assert.equal((await fail(root, home, ['init', '--max-usd', '-1'])).code, 1);
});

test('init --check is read-only, fails on a missing setup, and is clean after init', async t => {
  const root = await project(t), home = await temp(t);
  const before = await fail(root, home, ['init', '--check']);
  assert.match(before.stdout, /FAIL pointer/);
  await initJson(root, home, ['--not-sensitive']);
  const snap = await snapshot(root);
  const after = await run(root, home, ['init', '--check']);
  assert.ok(!/FAIL/.test(after.stdout), after.stdout);
  assert.deepEqual(await snapshot(root), snap, 'nothing was written');
  const json = JSON.parse((await run(root, home, ['init', '--check', '--json'])).stdout);
  assert.equal(json.ok, true);
  assert.deepEqual(json.items.map(item => item.id), ['pointer', 'version', 'profile', 'checks', 'base', 'map', 'ignore', 'pointers', 'protected']);
});

test('swarm map builds and then reuses unchanged files', async t => {
  const root = await project(t), home = await temp(t);
  const first = JSON.parse((await run(root, home, ['map', '--json'])).stdout);
  assert.equal(first.stats.reused, 0);
  const second = JSON.parse((await run(root, home, ['map', '--json'])).stdout);
  assert.equal(second.stats.reused, second.stats.files);
  assert.match((await run(root, home, ['map'])).stdout, /repo map: \d+ files/);
  assert.equal((await fail(root, home, ['map', '--bogus'])).code, 1);
});

test('a manifest that writes a protected path is refused before anything runs', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--no-base-check', '--no-map', '--protect', 'src/']);
  const manifest = { version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs: ['src/new.mjs'] }] };
  await fs.writeFile(path.join(root, 'm.json'), JSON.stringify(manifest));
  const error = await fail(root, home, ['validate', 'm.json']);
  assert.match(error.stdout + error.stderr, /protected-path: job w writes src\/new\.mjs \(protected: src\/\)/);
  await fs.writeFile(path.join(root, 'm.json'), JSON.stringify({ ...manifest, jobs: [{ ...manifest.jobs[0], outputs: ['docs/new.md'] }] }));
  assert.equal(JSON.parse((await run(root, home, ['validate', 'm.json'])).stdout).status, 'valid');
});

test('the profile feeds plan: budget default, sensitive false on the leads; flags still win', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--max-usd', '3', '--no-base-check', '--no-map']);
  const text = (await run(root, home, ['plan', 'add a thing to src'])).stdout;
  assert.match(text, /Budget: \$3\.00/);
  const id = /plan saved: (\S+)/.exec(text)[1];
  const saved = JSON.parse(await fs.readFile(path.join(root, '.swarm/plans', `${id}.json`), 'utf8'));
  assert.equal(saved.manifest.jobs[0].sensitive, false);
  assert.match((await run(root, home, ['plan', 'add a thing to src', '--max-usd', '1'])).stdout, /Budget: \$1\.00/);
});

test('done when: a fresh project goes from init to a plan with no hand edits, and init --check finds nothing wrong', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--base-check']);
  const plan = await run(root, home, ['plan', 'add a thing to src']);
  assert.match(plan.stdout, /plan saved: plan-/);
  assert.ok(!/base-red/.test(plan.stdout));
  const check = await run(root, home, ['init', '--check']);
  assert.ok(!/FAIL/.test(check.stdout));
  assert.equal((await pointer(root)).profile.baseCheck.status, 'green');
});

test('the base check never runs unasked, and runs with a scrubbed environment when asked', async t => {
  const root = await project(t, 'node -e "process.exit(process.env.SECRET_TOKEN_FOR_TEST ? 1 : 0)"'), home = await temp(t);
  const asked = JSON.parse((await exec(process.execPath, [swarm, '--root', root, 'init', '--not-sensitive'], { env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG, SECRET_TOKEN_FOR_TEST: 'x' }, input: '' })).stdout.trim().split('\n').pop());
  assert.equal(asked.profile.baseCheck.status, 'skipped');
  assert.ok(asked.warnings.some(warning => warning.startsWith('base-check-skipped')));
  const ran = JSON.parse((await exec(process.execPath, [swarm, '--root', root, 'init', '--base-check'], { env: { ...process.env, HOME: home, SWARM_CONFIG: process.env.SWARM_CONFIG, SECRET_TOKEN_FOR_TEST: 'x' }, input: '' })).stdout.trim().split('\n').pop());
  assert.equal(ran.profile.baseCheck.status, 'green', 'the secret was not in the check environment');
  assert.equal((await fail(root, home, ['init', '--base-check', '--no-base-check'])).code, 1);
});

test('a check that outlives its timeout, with a child of its own, is cut off and cleaned up', async t => {
  const cwd = await temp(t);
  const started = Date.now();
  await assert.rejects(runCheckArgv([process.execPath, '-e', "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'inherit' }); setTimeout(() => {}, 30000);"], { cwd, timeoutMs: 400 }), /timed out/);
  assert.ok(Date.now() - started < 5000);
  const ok = await runCheckArgv([process.execPath, '-e', 'process.exit(2)'], { cwd, timeoutMs: 5000 });
  assert.equal(ok.exitCode, 2);
});

test('a broken profile fails closed; the pointer and checks file are always protected; open-scope folders count', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map', '--protect', 'keep/']);
  const write = outputs => fs.writeFile(path.join(root, 'm.json'), JSON.stringify({ version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs }] }));
  for (const outputs of [['.project-swarm.json'], ['coordination/checks.json'], ['Keep/x.txt']]) {
    await write(outputs);
    const error = await fail(root, home, ['validate', 'm.json']);
    assert.match(error.stdout + error.stderr, /protected-path/, outputs[0]);
  }
  const profile = { sensitive: true, protectedPaths: ['keep/'] };
  assert.equal(protectedViolations(validateProfile(profile).profile, [{ id: 'o', outputs: ['docs/a.md'], outputDirs: ['keep/'] }]).length, 1);
  const raw = await pointer(root);
  raw.profile.protectedPaths = ['../not-valid'];
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify(raw));
  await write(['docs/a.md']);
  const broken = await fail(root, home, ['validate', 'm.json']);
  assert.match(broken.stdout + broken.stderr, /profile-invalid/);
});

test('the repo map lists a symlink to a device without reading it', async t => {
  const root = await project(t);
  await fs.symlink('/dev/zero', path.join(root, 'zero.js'));
  await exec('git', ['-C', root, 'add', 'zero.js']);
  const started = Date.now();
  const map = await refreshRepoMap(root);
  assert.ok(Date.now() - started < 5000);
  assert.equal(map.files['zero.js'].lang, null);
  assert.deepEqual(map.files['zero.js'].exports, []);
});

test('a saved plan made while the project was not sensitive is refused once it is sensitive again', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map']);
  const id = /plan saved: (\S+)/.exec((await run(root, home, ['plan', 'add a thing to src'])).stdout)[1];
  await initJson(root, home, ['--sensitive', '--no-base-check', '--no-map']);
  await exec('git', ['-C', root, 'add', '-A']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'swarm init']);
  const error = await run(root, home, ['go', '--plan', id, '--yes', '--accept-stale']).then(() => null, e => e);
  const out = JSON.parse((error ? error.stdout : '{}').trim().split('\n').pop() || '{}');
  assert.equal(out.status, 'failed');
  assert.match(out.reason, /not sensitive/);
});

const manifestWith = (job) => ({ version: 1, jobs: [{ id: 'w', agent: 'codex', model: 'gpt-6.1-sol', prompt: 'x', context: [], outputs: ['docs/out.md'], ...job }] });
async function validateRefused(root, home, manifest, pattern) {
  await fs.writeFile(path.join(root, 'm.json'), JSON.stringify(manifest));
  const error = await fail(root, home, ['validate', 'm.json']);
  assert.match(error.stdout + error.stderr, pattern);
}

test('a protected file is also refused as job context, unless the owner gives a reason on that job', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map', '--protect', 'secrets/', '--protect', 'notes/internal.md']);
  await fs.mkdir(path.join(root, 'secrets'));
  await fs.writeFile(path.join(root, 'secrets/key.txt'), 'k\n');
  await fs.mkdir(path.join(root, 'notes'));
  await fs.writeFile(path.join(root, 'notes/internal.md'), 'n\n');
  await exec('git', ['-C', root, 'add', '-A']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'notes']);
  for (const context of [['notes/internal.md'], ['secrets/key.txt'], ['SECRETS/key.txt']]) {
    await validateRefused(root, home, manifestWith({ context }), /protected-path: job w reads/);
  }
  await fs.writeFile(path.join(root, 'm.json'), JSON.stringify(manifestWith({ context: ['notes/internal.md', 'secrets/key.txt'], allowProtectedContext: 'the job documents the internal notes' })));
  assert.equal(JSON.parse((await run(root, home, ['validate', 'm.json'])).stdout).status, 'valid');
  for (const reason of ['', '   ', 5, 'x'.repeat(201)]) await validateRefused(root, home, manifestWith({ context: ['notes/internal.md'], allowProtectedContext: reason }), /allowProtectedContext/);
  // writes stay refused even with the reason: it only opens reading
  await validateRefused(root, home, manifestWith({ outputs: ['secrets/new.txt'], allowProtectedContext: 'reading only' }), /protected-path: job w writes/);
  // a lead cannot give its children the exception
  const { validateChildManifest } = await import('../tools/leads.mjs');
  const lead = { id: 'lead', type: 'lead', agent: 'codex', prompt: 'x', outputs: ['goal.json'], area: { goal: 'g', scope: ['docs/'], maxJobs: 2, concurrency: 1 } };
  const { validateLeadArea } = await import('../tools/leads.mjs');
  assert.throws(() => validateChildManifest({ version: 1, jobs: [{ id: 'c', agent: 'codex', prompt: 'x', context: ['notes/internal.md'], outputs: ['docs/a.md'], allowProtectedContext: 'because' }] }, { lead, area: validateLeadArea(lead), parentManifest: {} }), /allowProtectedContext/);
});

test('a contextGlob that expands to a protected file is refused before any worker starts', async t => {
  const { runManifest } = await import('../tools/swarm.mjs');
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map', '--protect', 'secrets/']);
  await fs.mkdir(path.join(root, 'secrets'));
  await fs.writeFile(path.join(root, 'secrets/key.txt'), 'k\n');
  await exec('git', ['-C', root, 'add', '-A']);
  await exec('git', ['-C', root, '-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '-qm', 'more']);
  let called = false;
  const state = await runManifest(root, { version: 1, jobs: [{ id: 'g', agent: 'ollama', model: 'm', sensitive: false, prompt: 'x', context: ['src/math.mjs'], contextGlob: ['secrets/*.txt'], outputs: ['out/a.txt'], timeoutMs: 5000 }] }, { env: { SWARM_CONFIG: process.env.SWARM_CONFIG, SWARM_SPEND_DIR: path.join(root, '.swarm/spend') }, fetchImpl: async () => { called = true; throw new Error('no'); } });
  assert.equal(state.status, 'failed');
  assert.match(state.error, /protected-path: job g reads secrets\/key\.txt/);
  assert.equal(called, false);
});

test('symlinks are resolved: a path that really points at a protected file or outside the project is refused', async t => {
  const root = await project(t), home = await temp(t);
  await initJson(root, home, ['--not-sensitive', '--no-base-check', '--no-map', '--protect', 'secrets/']);
  await fs.mkdir(path.join(root, 'secrets'));
  await fs.writeFile(path.join(root, 'secrets/key.txt'), 'k\n');
  await fs.mkdir(path.join(root, 'docs'));
  await fs.symlink(path.join(root, 'secrets'), path.join(root, 'docs/innocent'));
  await fs.symlink(path.join(root, '.env'), path.join(root, 'notes.txt'));
  await fs.symlink(os.tmpdir(), path.join(root, 'elsewhere'));
  await validateRefused(root, home, manifestWith({ outputs: ['docs/innocent/new.txt'] }), /protected-path: job w writes docs\/innocent\/new\.txt \(resolves to secrets\/new\.txt; protected: secrets\/\)/);
  await validateRefused(root, home, manifestWith({ context: ['docs/innocent/key.txt'] }), /protected-path: job w reads docs\/innocent\/key\.txt/);
  await validateRefused(root, home, manifestWith({ context: ['notes.txt'] }), /protected-path: job w reads notes\.txt \(resolves to \.env/);
  await validateRefused(root, home, manifestWith({ deletes: ['docs/innocent/key.txt'] }), /protected-path: job w deletes/);
  await validateRefused(root, home, manifestWith({ outputs: ['elsewhere/out.txt'] }), /path-outside-project: job w writes elsewhere\/out\.txt/);
  await validateRefused(root, home, manifestWith({ context: ['elsewhere/passwd'] }), /path-outside-project: job w reads/);
  // an ordinary path still validates
  await fs.writeFile(path.join(root, 'm.json'), JSON.stringify(manifestWith({ context: ['src/math.mjs'], outputs: ['docs/ok.md'] })));
  assert.equal(JSON.parse((await run(root, home, ['validate', 'm.json'])).stdout).status, 'valid');
});

test('swarm go and swarm plan treat a sentence as a goal even when it mentions paths; a manifest path or run id is not a goal', async t => {
  const { isGoalArgument } = await import('../tools/goal.mjs');
  for (const goal of ['fix the a/b path', 'update docs/readme.md and tests/x.test.mjs', 'rename old.json to new.json', 'use C:\\temp\\x as scratch']) assert.equal(isGoalArgument(goal), true, goal);
  for (const notGoal of ['coordination/manifests/phase1.json', 'm.json', 'a/b', '1792095332637-00d5eba7', ' padded ', '']) assert.equal(isGoalArgument(notGoal), false, notGoal);
  const root = await project(t), home = await temp(t);
  const plan = await run(root, home, ['plan', 'update src/math.mjs and the tests/ folder']);
  assert.match(plan.stdout, /plan saved: plan-/);
  const goal = JSON.parse((await fail(root, home, ['go', 'notes about src/config.json'])).stdout);
  assert.equal(goal.status, 'cancelled', 'treated as a goal, and stopped at the approval');
  await fs.writeFile(path.join(root, 'real.json'), '{"version":1}');
  const manifest = await fail(root, home, ['go', 'real.json']);
  assert.ok(!/cancelled|plan saved/.test(manifest.stdout), 'an existing .json file is a manifest');
  const missing = await fail(root, home, ['go', 'nope/missing.json']);
  assert.ok(!/cancelled/.test(missing.stdout));
});
