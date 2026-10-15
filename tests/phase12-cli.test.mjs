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
  const result = await initJson(root, home, ['--not-sensitive', '--protect', 'secrets/', '--max-usd', '3']);
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
  const result = await initJson(root, home, ['--not-sensitive']);
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
  await initJson(root, home, ['--not-sensitive']);
  const plan = await run(root, home, ['plan', 'add a thing to src']);
  assert.match(plan.stdout, /plan saved: plan-/);
  assert.ok(!/base-red/.test(plan.stdout));
  const check = await run(root, home, ['init', '--check']);
  assert.ok(!/FAIL/.test(check.stdout));
  assert.equal((await pointer(root)).profile.baseCheck.status, 'green');
});
