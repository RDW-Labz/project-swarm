// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  stableInstallDir,
  ensureHandbuildGuard,
  refreshTrackedSettingsHooks,
  hookScriptCommand,
} from '../tools/install.mjs';
import { bumpPointers } from '../tools/swarm/core-12.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';

const execFileAsync = promisify(execFile);

async function tmp(prefix = 'hook-path-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function seedInstallBase(base, { withCurrent = true, withVersions = false } = {}) {
  const tools = path.join(base, 'tools');
  await fs.mkdir(tools, { recursive: true });
  await fs.writeFile(path.join(tools, 'handbuild-guard.mjs'), 'export {}\n');
  await fs.writeFile(path.join(tools, 'orchestrator-hook.mjs'), 'export {}\n');
  await fs.writeFile(path.join(tools, 'swarm.mjs'), 'export {}\n');
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }));
  if (withVersions) {
    const versionDir = path.join(base, 'versions', '9.9.9-deadbeef');
    await fs.mkdir(path.join(versionDir, 'tools'), { recursive: true });
    await fs.writeFile(path.join(versionDir, 'tools', 'swarm.mjs'), 'export {}\n');
    await fs.writeFile(path.join(versionDir, 'tools', 'handbuild-guard.mjs'), 'export {}\n');
    if (withCurrent) await fs.symlink(versionDir, path.join(base, 'current'));
  } else if (withCurrent) {
    const release = path.join(base, 'release');
    await fs.mkdir(path.join(release, 'tools'), { recursive: true });
    await fs.writeFile(path.join(release, 'tools', 'swarm.mjs'), 'export {}\n');
    await fs.writeFile(path.join(release, 'tools', 'handbuild-guard.mjs'), 'export {}\n');
    await fs.symlink(release, path.join(base, 'current'));
  }
}

test('stableInstallDir prefers install base current/ when present', async () => {
  const base = await tmp();
  await seedInstallBase(base, { withCurrent: true, withVersions: false });
  const resolved = stableInstallDir(base);
  assert.equal(resolved, await fs.realpath(path.join(base, 'current')));
});

test('stableInstallDir maps versions/* to sibling current/', async () => {
  const base = await tmp();
  await seedInstallBase(base, { withCurrent: true, withVersions: true });
  const versioned = path.join(base, 'versions', '9.9.9-deadbeef');
  assert.equal(stableInstallDir(versioned), path.join(base, 'current'));
});

test('stableInstallDir keeps base when no current release exists', async () => {
  const base = await tmp();
  await seedInstallBase(base, { withCurrent: false, withVersions: false });
  assert.equal(stableInstallDir(base), base);
});

test('refresh rewrites stale guard hooks in local and tracked settings', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install, { withCurrent: true, withVersions: false });
  const staleGuard = path.join(install, 'tools', 'handbuild-guard.mjs');
  const expected = hookScriptCommand(install, 'handbuild-guard.mjs');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  const trackedFile = path.join(project, '.claude', 'settings.json');
  const otherCmd = 'echo keep-me-exactly';
  await writeJson(localFile, {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `test -f ${JSON.stringify(staleGuard)} && node ${JSON.stringify(staleGuard)} || true` }] }],
      Stop: [{ hooks: [{ type: 'command', command: otherCmd }] }],
    },
  });
  const trackedBefore = `{
  "permissions": { "allow": ["Bash(npm test)"] },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Edit",
        "hooks": [
          { "type": "command", "command": ${JSON.stringify(`test -f ${staleGuard} && node ${JSON.stringify(staleGuard)} || true`)} }
        ]
      }
    ]
  }
}
`;
  await fs.mkdir(path.dirname(trackedFile), { recursive: true });
  await fs.writeFile(trackedFile, trackedBefore);
  assert.equal((await ensureHandbuildGuard(project, install)).status, 'updated');
  const localAfter = await fs.readFile(localFile, 'utf8');
  const local = JSON.parse(localAfter);
  assert.ok(local.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === expected)));
  assert.ok(local.hooks.Stop.some(e => e.hooks.some(h => h.command === otherCmd)));
  const tracked = await refreshTrackedSettingsHooks(project, install);
  assert.equal(tracked.status, 'updated');
  const trackedAfter = await fs.readFile(trackedFile, 'utf8');
  assert.ok(trackedAfter.includes(JSON.stringify(expected)));
  assert.ok(trackedAfter.includes('"allow": ["Bash(npm test)"]'));
  assert.ok(!trackedAfter.includes(staleGuard));
  await assert.rejects(fs.access(path.join(project, '.claude', 'settings.json.bak')), () => true);
});

test('tracked settings.json is not created when missing', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install);
  await writeJson(path.join(project, '.claude', 'settings.local.json'), { hooks: {} });
  assert.equal((await refreshTrackedSettingsHooks(project, install)).status, 'absent');
  await assert.rejects(fs.access(path.join(project, '.claude', 'settings.json')));
});

test('bumpPointers refreshes hooks for pinned projects without moving pointer', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install, { withCurrent: true, withVersions: false });
  const staleGuard = path.join(install, 'tools', 'handbuild-guard.mjs');
  const expected = hookScriptCommand(install, 'handbuild-guard.mjs');
  await writeJson(path.join(project, '.project-swarm.json'), { profile: { project: 'x' }, pinnedVersion: '1.0.0' });
  await writeJson(path.join(project, '.swarm', 'runner-pointer.json'), { install, version: '1.0.0' });
  await writeJson(path.join(install, '.swarm-projects.json'), [project]);
  await writeJson(path.join(project, '.claude', 'settings.local.json'), {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `test -f ${JSON.stringify(staleGuard)} && node ${JSON.stringify(staleGuard)} || true` }] }],
    },
  });
  const before = JSON.parse(await fs.readFile(path.join(project, '.swarm', 'runner-pointer.json'), 'utf8'));
  const result = await bumpPointers(install);
  const projectReal = await fs.realpath(project);
  assert.ok(result.skipped.some(s => s.project === projectReal));
  assert.equal(result.bumped.length, 0);
  const local = JSON.parse(await fs.readFile(path.join(project, '.claude', 'settings.local.json'), 'utf8'));
  assert.ok(local.hooks.PreToolUse.some(e => e.hooks.some(h => h.command === expected)));
  const after = JSON.parse(await fs.readFile(path.join(project, '.swarm', 'runner-pointer.json'), 'utf8'));
  assert.deepEqual(after, before);
});

test('handbuild status reports guard hook path and warns on stale install path', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install, { withCurrent: true, withVersions: false });
  const staleGuard = path.join(install, 'tools', 'handbuild-guard.mjs');
  await writeJson(path.join(project, '.claude', 'settings.local.json'), {
    hooks: {
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: `test -f ${JSON.stringify(staleGuard)} && node ${JSON.stringify(staleGuard)} || true` }] }],
    },
  });
  const { stdout } = await runHandbuildCommand(project, ['status'], { installRoot: install, now: () => Date.now() });
  assert.match(stdout, /guard hook:/);
  assert.match(stdout, /guard hook stable: no/);
  assert.match(stdout, /warning: guard hook path is not under the install current\//);
});
