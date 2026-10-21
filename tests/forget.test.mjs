// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isScratchRoot } from '../tools/scratch-roots.mjs';
import {
  FORGET_REGISTRY_ONLY,
  forgetProjects,
  projectId,
  projectsFile,
  runForgetCommand,
} from '../tools/projects.mjs';
import { COMMANDS } from '../tools/completion.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const swarm = path.join(packageRoot, 'tools/swarm.mjs');
const installRoot = packageRoot;

const sha = file => createHash('sha256').update(fsSync.readFileSync(file)).digest('hex');

async function hermeticEnv(t) {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'forget-'));
  const fakeHome = path.join(base, 'home');
  const scratchBase = path.join(base, 'scratch-base');
  await fs.mkdir(fakeHome, { recursive: true });
  await fs.mkdir(scratchBase, { recursive: true });
  await fs.mkdir(path.join(scratchBase, 'worktrees'), { recursive: true });
  const env = {
    SWARM_SCRATCH_BASE: scratchBase,
    HOME: fakeHome,
    SWARM_PROJECTS_FILE: path.join(fakeHome, '.project-swarm', 'projects.json'),
  };
  const opts = { env, home: fakeHome, tmp: path.join(base, 'tmpdir'), installRoot };
  await fs.mkdir(opts.tmp, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return { base, fakeHome, scratchBase, env, opts };
}

async function writeRegistry(env, projects) {
  const file = projectsFile(env);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify({ version: 1, projects }, null, 2)}\n`);
  return file;
}

async function miniProject(root, { pointer = true } = {}) {
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'state.json'), '{"ok":true}\n');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'app.mjs'), 'export const v = 1;\n');
  if (pointer) {
    await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ install: installRoot }));
  }
}

function projectEntry(root, name) {
  const at = new Date().toISOString();
  const real = fsSync.realpathSync.native(root);
  return { id: projectId(real), root: real, name, addedAt: at, lastSeen: at };
}

test('isScratchRoot segment rule (tmp, Test, tests, __tests__, normal, testing, home)', async t => {
  const { base, fakeHome, env, opts } = await hermeticEnv(t);
  const tmpPath = path.join(base, 'tmp', 'proj');
  const testPath = path.join(base, 'Test', 'proj');
  const testsPath = path.join(base, 'nested', 'tests', 'proj');
  const dunderPath = path.join(base, 'nested', '__tests__', 'proj');
  const normal = path.join(base, 'owner-apps', 'parts');
  const testingPath = path.join(base, 'owner-apps', 'testing', 'proj');
  for (const dir of [tmpPath, testPath, testsPath, dunderPath, normal, testingPath]) {
    await fs.mkdir(dir, { recursive: true });
  }
  assert.equal(isScratchRoot(tmpPath, opts), true);
  assert.equal(isScratchRoot(testPath, opts), true);
  assert.equal(isScratchRoot(testsPath, opts), true);
  assert.equal(isScratchRoot(dunderPath, opts), true);
  assert.equal(isScratchRoot(normal, opts), false);
  assert.equal(isScratchRoot(testingPath, opts), false);
  assert.equal(isScratchRoot(fakeHome, opts), false);
});

test('forget removes one registry row and leaves project files byte-identical', async t => {
  const { base, env, opts } = await hermeticEnv(t);
  const keep = path.join(base, 'keep');
  const drop = path.join(base, 'drop');
  await miniProject(keep);
  await miniProject(drop);
  const entries = [projectEntry(keep, 'keep'), projectEntry(drop, 'drop')];
  const file = await writeRegistry(env, entries);
  const before = {
    pointer: sha(path.join(drop, '.project-swarm.json')),
    source: sha(path.join(drop, 'src', 'app.mjs')),
    swarm: sha(path.join(drop, '.swarm', 'project', 'state.json')),
  };
  const res = await forgetProjects({ paths: [drop], file, env, home: opts.home, installRoot });
  assert.equal(res.exitCode, 0);
  assert.match(res.stdout, new RegExp(FORGET_REGISTRY_ONLY));
  assert.match(res.stdout, /listed again the next time swarm runs inside them/);
  const after = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.deepEqual(after.map(p => p.id), [entries[0].id]);
  assert.equal(sha(path.join(drop, '.project-swarm.json')), before.pointer);
  assert.equal(sha(path.join(drop, 'src', 'app.mjs')), before.source);
  assert.equal(sha(path.join(drop, '.swarm', 'project', 'state.json')), before.swarm);
});

test('forget gone folder by stored path and by id', async t => {
  const { base, env, opts } = await hermeticEnv(t);
  const gone = path.join(base, 'gone-proj');
  await miniProject(gone);
  const entry = projectEntry(gone, 'gone');
  const file = await writeRegistry(env, [entry]);
  await fs.rm(gone, { recursive: true, force: true });
  const byPath = await forgetProjects({ paths: [entry.root], file, env, home: opts.home, installRoot });
  assert.equal(byPath.exitCode, 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).projects.length, 0);
  await writeRegistry(env, [entry]);
  const byId = await forgetProjects({ paths: [entry.id], file, env, home: opts.home, installRoot });
  assert.equal(byId.exitCode, 0);
  assert.equal(JSON.parse(await fs.readFile(file, 'utf8')).projects.length, 0);
});

test('forget --missing and --scratch bulk limits and --yes', async t => {
  const { base, scratchBase, env, opts } = await hermeticEnv(t);
  const real = path.join(base, 'real-app');
  await fs.mkdir(real, { recursive: true });
  const missingRoots = Array.from({ length: 4 }, (_, i) => path.join(base, `missing-${i}`));
  const scratchRoots = [
    path.join(scratchBase, 'wt-a'),
    path.join(scratchBase, 'wt-b'),
    path.join(scratchBase, 'wt-c'),
    path.join(scratchBase, 'wt-d'),
    path.join(base, 'tmp', 'seg-proj'),
  ];
  for (const root of [...missingRoots, ...scratchRoots, real]) await fs.mkdir(root, { recursive: true });
  const projects = [
    ...missingRoots.map((root, i) => projectEntry(root, `m${i}`)),
    ...scratchRoots.map((root, i) => projectEntry(root, `s${i}`)),
    projectEntry(real, 'real'),
  ];
  for (const root of missingRoots) await fs.rm(root, { recursive: true, force: true });
  const file = await writeRegistry(env, projects);
  const refused = await forgetProjects({ missing: true, file, env, home: opts.home, installRoot });
  assert.equal(refused.exitCode, 1);
  assert.match(refused.stdout, /--yes/);
  const missingOk = await forgetProjects({ missing: true, yes: true, file, env, home: opts.home, installRoot });
  assert.equal(missingOk.exitCode, 0);
  let left = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.equal(left.length, 6);
  const scratchOnly = [
    ...scratchRoots.map((root, i) => projectEntry(root, `s${i}`)),
    projectEntry(real, 'real'),
  ];
  await writeRegistry(env, scratchOnly);
  const scratchRefused = await forgetProjects({ scratch: true, file, env, home: opts.home, installRoot });
  assert.equal(scratchRefused.exitCode, 1);
  const scratchOk = await forgetProjects({ scratch: true, yes: true, file, env, home: opts.home, installRoot });
  assert.equal(scratchOk.exitCode, 0);
  left = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, projectEntry(real, 'real').id);
});

test('forget --dry-run, install root refusal, unknown path, order, concurrency', async t => {
  const { base, env, opts } = await hermeticEnv(t);
  const a = path.join(base, 'a');
  const b = path.join(base, 'b');
  const c = path.join(base, 'c');
  for (const root of [a, b, c]) await fs.mkdir(root, { recursive: true });
  const entries = [projectEntry(a, 'a'), projectEntry(b, 'b'), projectEntry(c, 'c')];
  const file = await writeRegistry(env, entries);
  const dry = await forgetProjects({ paths: [b], dryRun: true, file, env, home: opts.home, installRoot });
  assert.equal(dry.exitCode, 0);
  assert.match(dry.stdout, /would forget/);
  assert.match(dry.stdout, /dry run: registry unchanged/);
  assert.deepEqual(JSON.parse(await fs.readFile(file, 'utf8')).projects.map(p => p.id), entries.map(p => p.id));
  const installEntry = projectEntry(installRoot, 'install');
  await writeRegistry(env, [...entries, installEntry]);
  const refuse = await forgetProjects({ paths: [installRoot], file, env, home: opts.home, installRoot });
  assert.equal(refuse.exitCode, 1);
  assert.match(refuse.stdout, /install root itself/);
  const unknown = await forgetProjects({ paths: [path.join(base, 'nope')], file, env, home: opts.home, installRoot });
  assert.equal(unknown.exitCode, 1);
  assert.match(unknown.stdout, /not registered/);
  await writeRegistry(env, entries);
  const mid = await forgetProjects({ paths: [b], file, env, home: opts.home, installRoot });
  assert.equal(mid.exitCode, 0);
  assert.deepEqual(
    JSON.parse(await fs.readFile(file, 'utf8')).projects.map(p => p.id),
    [entries[0].id, entries[2].id],
  );
  await writeRegistry(env, entries);
  const [one, two] = await Promise.all([
    forgetProjects({ paths: [a], file, env, home: opts.home, installRoot }),
    forgetProjects({ paths: [c], file, env, home: opts.home, installRoot }),
  ]);
  assert.equal(one.exitCode, 0);
  assert.equal(two.exitCode, 0);
  const left = JSON.parse(await fs.readFile(file, 'utf8')).projects;
  assert.equal(left.length, 1);
  assert.equal(left[0].id, entries[1].id);
});

test('swarm forget CLI and completion metadata', async t => {
  const { base, env, opts } = await hermeticEnv(t);
  const root = path.join(base, 'cli-proj');
  await fs.mkdir(root, { recursive: true });
  const entry = projectEntry(root, 'cli');
  await writeRegistry(env, [entry]);
  assert.ok(COMMANDS.some(c => c.name === 'forget'));
  const help = spawnSync(process.execPath, [swarm, 'forget', '--help'], {
    encoding: 'utf8',
    env: { ...env, SWARM_CONFIG: process.env.SWARM_CONFIG },
  });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: swarm forget PATH\.\.\./);
  assert.match(help.stdout, /--dry-run/);
  assert.match(help.stdout, new RegExp(FORGET_REGISTRY_ONLY));
  const run = args => spawnSync(process.execPath, [swarm, 'forget', ...args], {
    encoding: 'utf8',
    env: { ...env, SWARM_CONFIG: process.env.SWARM_CONFIG },
  });
  const ok = run([root]);
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(FORGET_REGISTRY_ONLY));
  await writeRegistry(env, [entry]);
  const viaCmd = await runForgetCommand([root], { env, home: opts.home, installRoot });
  assert.equal(viaCmd.exitCode, 0);
  assert.match(viaCmd.stdout, new RegExp(FORGET_REGISTRY_ONLY));
});
