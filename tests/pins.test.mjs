// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { bumpPointers, updateProjects } from '../tools/swarm.mjs';
import { pruneVersions, snapshotVersion } from '../tools/install.mjs';
import {
  pinOf, isPinned, pinnedVersions, readPins, resolveRegisteredProject,
  pinProject, unpinProject,
} from '../tools/pins.mjs';
import { projectOverview } from '../tools/board-data.mjs';
import { COMMANDS } from '../tools/completion.mjs';
import { COMMAND_META } from '../tools/watch-command-meta.mjs';

const execFileAsync = promisify(execFile);
const profile = { budget: { maxUsd: 25 }, ui: { screens: ['a'] } };

async function tmp(t, prefix = 'swarm-pins-') {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return fs.realpath(d);
}

async function minimalInstall(t, version = '2.0.0') {
  const install = await tmp(t, 'swarm-pins-install-');
  await fs.mkdir(path.join(install, 'tools'), { recursive: true });
  await fs.writeFile(path.join(install, 'tools/swarm.mjs'), '// stub\n');
  await fs.mkdir(path.join(install, 'skills/project-swarm'), { recursive: true });
  await fs.writeFile(path.join(install, 'skills/project-swarm/SKILL.md'), '---\nname: x\n---\n{{SWARM_RUNNER}}\n');
  await fs.writeFile(path.join(install, 'SECURITY.md'), 's\n');
  await fs.writeFile(path.join(install, 'CONTRIBUTING.md'), 'c\n');
  await fs.mkdir(path.join(install, 'docs'));
  await fs.writeFile(path.join(install, 'docs/guide.md'), 'g\n');
  await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'project-swarm', version }));
  return install;
}

test('pinOf and isPinned honor pinnedVersion over version and pinned:true', () => {
  assert.equal(pinOf({ version: '1.0.0', pinned: true }), '1.0.0');
  assert.equal(pinOf({ version: '1.0.0', pinnedVersion: '1.2.0', pinned: true }), '1.2.0');
  assert.equal(isPinned({ pinned: true }), true);
  assert.equal(isPinned({ pinnedVersion: '1.1.0' }), true);
  assert.equal(isPinned({ version: '1.0.0' }), false);
});

test('bumpPointers skips pinned projects without touching files or hooks', async t => {
  const install = await minimalInstall(t, '1.140.0');
  const unpinned = await tmp(t);
  const pinnedField = await tmp(t);
  const pinnedVer = await tmp(t);
  await fs.writeFile(path.join(unpinned, '.project-swarm.json'), JSON.stringify({ install, version: '1.137.0', profile }));
  const pinnedBytes = JSON.stringify({ install, version: '1.130.0', pinned: true, profile });
  await fs.writeFile(path.join(pinnedField, '.project-swarm.json'), pinnedBytes);
  const pinnedVerBytes = JSON.stringify({ install, version: '1.130.0', pinned: true, pinnedVersion: '1.125.0', profile });
  await fs.writeFile(path.join(pinnedVer, '.project-swarm.json'), pinnedVerBytes);
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([unpinned, pinnedField, pinnedVer]));
  const beforeField = await fs.readFile(path.join(pinnedField, '.project-swarm.json'), 'utf8');
  const beforeVer = await fs.readFile(path.join(pinnedVer, '.project-swarm.json'), 'utf8');
  const r = await bumpPointers(install);
  assert.deepEqual(r.bumped.map(b => b.from), ['1.137.0']);
  assert.deepEqual(r.skipped.map(s => s.pinnedAt).sort(), ['1.125.0', '1.130.0']);
  assert.equal(await fs.readFile(path.join(pinnedField, '.project-swarm.json'), 'utf8'), beforeField);
  assert.equal(await fs.readFile(path.join(pinnedVer, '.project-swarm.json'), 'utf8'), beforeVer);
  await assert.rejects(fs.access(path.join(pinnedField, '.claude/settings.local.json')));
  assert.equal(JSON.parse(await fs.readFile(path.join(unpinned, '.project-swarm.json'), 'utf8')).version, '1.140.0');
});

test('pruneVersions keeps pinned old releases beyond the newest five', async t => {
  const source = await tmp(t);
  const versionsDir = path.join(source, 'versions');
  await fs.mkdir(versionsDir, { recursive: true });
  const dirs = [];
  for (let index = 0; index < 7; index += 1) {
    const dir = path.join(versionsDir, `1.0.${index}-aaaaaaaa`);
    await fs.mkdir(dir);
    await fs.utimes(dir, new Date(index * 1000), new Date(index * 1000));
    dirs.push(dir);
  }
  await fs.symlink(dirs[6], path.join(source, 'current'));
  await pruneVersions(source, { protect: new Set(['1.0.1']) });
  const remaining = new Set(await fs.readdir(versionsDir));
  assert.ok(remaining.has('1.0.1-aaaaaaaa'));
  assert.ok(!remaining.has('1.0.0-aaaaaaaa'));
});

test('unreadable pointer does not break prune protect collection', async t => {
  const install = await minimalInstall(t);
  const good = await tmp(t);
  await fs.writeFile(path.join(good, '.project-swarm.json'), JSON.stringify({ install, version: '9.9.9', pinnedVersion: '9.9.9' }));
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([good, '/missing/project']));
  const broken = await tmp(t);
  await fs.writeFile(path.join(broken, '.project-swarm.json'), '{ bad');
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([good, broken]));
  const { unreadable } = await readPins(install);
  assert.equal(unreadable.length, 1);
  const map = await pinnedVersions(install);
  assert.deepEqual([...map.keys()], ['9.9.9']);
});

test('update --projects lists pinned separately and --yes does not replace them', async t => {
  const install = await minimalInstall(t, '1.1.0');
  const pinned = await tmp(t);
  await fs.mkdir(path.join(pinned, 'tools'), { recursive: true });
  await fs.writeFile(path.join(pinned, 'tools/swarm.mjs'), '// old');
  await fs.mkdir(path.join(pinned, 'skills/project-swarm'), { recursive: true });
  await fs.writeFile(path.join(pinned, 'skills/project-swarm/SKILL.md'), 'old');
  await fs.writeFile(path.join(pinned, '.project-swarm.json'), JSON.stringify({ install, version: '1.0.0', pinnedVersion: '1.0.0', profile }));
  const dry = await updateProjects(install, { projects: [pinned] });
  assert.equal(dry.pinned.length, 1);
  assert.equal(dry.pinned[0].action, 'pinned');
  assert.equal(dry.projects.length, 0);
  const applied = await updateProjects(install, { projects: [pinned], yes: true });
  assert.equal(applied.pinned[0].pinnedAt, '1.0.0');
  assert.equal(JSON.parse(await fs.readFile(path.join(pinned, '.project-swarm.json'), 'utf8')).pinnedVersion, '1.0.0');
  assert.equal(await fs.readFile(path.join(pinned, 'tools/swarm.mjs'), 'utf8'), '// old');
});

test('pin and unpin round trip keep profile; install missing version from tag without moving current', async t => {
  const install = await tmp(t, 'swarm-pins-git-');
  await execFileAsync('git', ['init'], { cwd: install });
  await execFileAsync('git', ['checkout', '-b', 'main'], { cwd: install });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: install });
  await execFileAsync('git', ['config', 'user.name', 'T'], { cwd: install });
  await fs.mkdir(path.join(install, 'tools'), { recursive: true });
  await fs.writeFile(path.join(install, 'tools/swarm.mjs'), '// v1\n');
  await fs.mkdir(path.join(install, 'skills/project-swarm'), { recursive: true });
  await fs.writeFile(path.join(install, 'skills/project-swarm/SKILL.md'), '---\nname: x\n---\n{{SWARM_RUNNER}}\n');
  await fs.writeFile(path.join(install, 'SECURITY.md'), 's\n');
  await fs.writeFile(path.join(install, 'CONTRIBUTING.md'), 'c\n');
  await fs.mkdir(path.join(install, 'docs'));
  await fs.writeFile(path.join(install, 'docs/guide.md'), 'g\n');
  await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'project-swarm', version: '1.0.0' }));
  await execFileAsync('git', ['add', '-A'], { cwd: install });
  await execFileAsync('git', ['commit', '-m', 'v1'], { cwd: install });
  await execFileAsync('git', ['tag', 'v1.0.0'], { cwd: install });
  await fs.writeFile(path.join(install, 'package.json'), JSON.stringify({ name: 'project-swarm', version: '2.0.0' }));
  await fs.writeFile(path.join(install, 'tools/swarm.mjs'), '// v2\n');
  await execFileAsync('git', ['add', '-A'], { cwd: install });
  await execFileAsync('git', ['commit', '-m', 'v2'], { cwd: install });
  const currentDir = await snapshotVersion(install, '2.0.0');
  await fs.symlink(currentDir, path.join(install, 'current'));
  const project = await tmp(t);
  await fs.writeFile(path.join(project, '.project-swarm.json'), JSON.stringify({ install, version: '2.0.0', profile }));
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([project]));
  const pinned = await pinProject(install, project, '1.0.0');
  assert.equal(pinned.installed, true);
  const pointer = JSON.parse(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'));
  assert.deepEqual(pointer.profile, profile);
  assert.equal(pointer.pinnedVersion, '1.0.0');
  assert.equal(await fs.realpath(path.join(install, 'current')), currentDir);
  const un = await unpinProject(project);
  assert.equal(un.changed, true);
  const after = JSON.parse(await fs.readFile(path.join(project, '.project-swarm.json'), 'utf8'));
  assert.deepEqual(after.profile, profile);
  assert.equal(after.pinned, undefined);
  await assert.rejects(pinProject(install, project, '9.9.9'), /tag v9\.9\.9 does not exist/);
});

test('resolveRegisteredProject accepts name, id and path', async t => {
  const install = await tmp(t);
  const project = await tmp(t);
  await fs.writeFile(path.join(install, '.swarm-projects.json'), JSON.stringify([project]));
  const byPath = await resolveRegisteredProject(install, project);
  const byName = await resolveRegisteredProject(install, path.basename(project));
  const byId = await resolveRegisteredProject(install, byPath.id);
  assert.equal(byPath.root, project);
  assert.equal(byName.root, project);
  assert.equal(byId.root, project);
});

test('board overview exposes pinnedVersion and board.js badge text', async t => {
  const install = await tmp(t);
  const project = { id: 'abc', name: 'demo', root: await tmp(t) };
  await fs.writeFile(path.join(project.root, '.project-swarm.json'), JSON.stringify({ install, version: '1.0.0', pinnedVersion: '1.0.0' }));
  const overview = await projectOverview(project, [], { summary: async () => ({}) });
  assert.equal(overview.pinnedVersion, '1.0.0');
  const boardJs = await fs.readFile(fileURLToPath(new URL('../tools/watch-assets/board.js', import.meta.url)), 'utf8');
  assert.match(boardJs, /pinned at '\s*\+\s*p\.pinnedVersion/);
});

test('completion metadata includes pin and unpin', () => {
  assert.ok(COMMANDS.some(c => c.name === 'pin'));
  assert.ok(COMMANDS.some(c => c.name === 'unpin'));
  assert.ok(COMMAND_META.pin);
  assert.ok(COMMAND_META.unpin);
});
