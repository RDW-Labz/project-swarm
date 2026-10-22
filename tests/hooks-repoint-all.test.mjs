// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  CHECKPOINT_HOOK,
  hookScriptCommand,
  refreshProjectInstallHooks,
  ORCHESTRATOR_HOOK_EVENTS,
} from '../tools/install.mjs';
import { bumpPointers } from '../tools/swarm/core-12.mjs';
import { runHandbuildCommand } from '../tools/handbuild-commands.mjs';
import { installGitHooks, refreshGitHooksCheckScript, HOOK_MARKER } from '../tools/git-hooks.mjs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function tmp(prefix = 'hooks-repoint-') {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

function staleScriptCommand(versionDir, script, arg) {
  const scriptPath = path.join(versionDir, 'tools', script);
  const inner = `test -f ${JSON.stringify(scriptPath)} && node ${JSON.stringify(scriptPath)}${arg ? ` ${arg}` : ''} || true`;
  return inner;
}

async function seedInstallBase(base) {
  const versionDir = path.join(base, 'versions', '1.165.2-abc');
  const releaseDir = path.join(base, 'release-current');
  for (const root of [versionDir, releaseDir]) {
    await fs.mkdir(path.join(root, 'tools'), { recursive: true });
    for (const name of ['handbuild-guard.mjs', 'orchestrator-hook.mjs', 'githook-check.mjs', 'swarm.mjs']) {
      await fs.writeFile(path.join(root, 'tools', name), 'export {}\n');
    }
  }
  const currentLink = path.join(base, 'current');
  await fs.rm(currentLink, { recursive: true, force: true });
  await fs.symlink(releaseDir, currentLink);
  await fs.writeFile(path.join(base, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.165.2' }));
}

async function initGitRepo(root) {
  await execFileAsync('git', ['init'], { cwd: root });
  await execFileAsync('git', ['config', 'user.email', 't@example.com'], { cwd: root });
  await execFileAsync('git', ['config', 'user.name', 't'], { cwd: root });
}

function orchestratorHooksStale(versionDir) {
  const hooks = {};
  for (const [event, arg] of Object.entries(ORCHESTRATOR_HOOK_EVENTS)) {
    hooks[event] ??= [];
    hooks[event].push({
      ...(event === 'PreToolUse' || event === 'PostToolUse' ? { matcher: '*' } : {}),
      hooks: [{ type: 'command', command: staleScriptCommand(versionDir, 'orchestrator-hook.mjs', arg) }],
    });
  }
  return hooks;
}

function assertAllCurrent(localText, install) {
  const guard = hookScriptCommand(install, 'handbuild-guard.mjs');
  assert.ok(localText.includes(JSON.stringify(guard)));
  for (const arg of Object.values(ORCHESTRATOR_HOOK_EVENTS)) {
    const cmd = hookScriptCommand(install, 'orchestrator-hook.mjs', arg);
    assert.ok(localText.includes(JSON.stringify(cmd)), `missing orchestrator ${arg}`);
  }
  assert.ok(localText.includes(JSON.stringify(CHECKPOINT_HOOK)));
  assert.ok(!localText.includes(path.join('versions', '1.165.2-abc', 'tools')));
}

test('handbuild install re-points orchestrator, guard, and checkpoint settings byte-for-byte elsewhere', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install);
  const versionDir = path.join(install, 'versions', '1.165.2-abc');
  const localFile = path.join(project, '.claude', 'settings.local.json');
  const otherCmd = 'echo keep-me-exactly';
  const hooks = orchestratorHooksStale(versionDir);
  hooks.PreToolUse = [
    { matcher: 'Edit|Write', hooks: [{ type: 'command', command: staleScriptCommand(versionDir, 'handbuild-guard.mjs') }] },
    { matcher: 'Other', hooks: [{ type: 'command', command: otherCmd }] },
    ...hooks.PreToolUse,
  ];
  hooks.Stop.push({ hooks: [{ type: 'command', command: CHECKPOINT_HOOK }] });
  const localBefore = `{
  "permissions": { "allow": ["Bash(npm test)"] },
  "hooks": ${JSON.stringify(hooks, null, 4).replace(/^/gm, '  ').trimEnd()}
}
`;
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, localBefore);

  const trackedFile = path.join(project, '.claude', 'settings.json');
  const trackedBefore = `{
  "hooks": {
    "PreToolUse": [
      { "hooks": [ { "type": "command", "command": ${JSON.stringify(staleScriptCommand(versionDir, 'handbuild-guard.mjs'))} } ] }
    ]
  }
}
`;
  await fs.writeFile(trackedFile, trackedBefore);

  await initGitRepo(project);
  const staleCheck = path.join(versionDir, 'tools', 'githook-check.mjs');
  installGitHooks(project, { checkScript: staleCheck });

  const { stdout } = await runHandbuildCommand(project, ['install'], { installRoot: install, now: () => Date.now() });
  assert.match(stdout, /hooks-path-fixed-tracked/);

  const localAfter = await fs.readFile(localFile, 'utf8');
  assert.deepEqual(JSON.parse(localAfter).permissions, { allow: ['Bash(npm test)'] });
  assert.ok(localAfter.includes(JSON.stringify(otherCmd)));
  assertAllCurrent(localAfter, install);

  const trackedAfter = await fs.readFile(trackedFile, 'utf8');
  assert.ok(trackedAfter.includes('"hooks"'));
  assert.ok(trackedAfter.includes(JSON.stringify(hookScriptCommand(install, 'handbuild-guard.mjs'))));
  assert.ok(!trackedAfter.includes('versions/1.165.2-abc'));

  const preCommit = await fs.readFile(path.join(project, '.git', 'hooks', 'pre-commit'), 'utf8');
  const expectedCheck = path.join(await fs.realpath(path.join(install, 'current')), 'tools', 'githook-check.mjs');
  assert.ok(preCommit.includes(HOOK_MARKER));
  assert.ok(preCommit.includes(expectedCheck));
  assert.ok(!preCommit.includes(path.join('versions', '1.165.2-abc', 'tools')));
});

test('bumpPointers refresh re-points hooks for pinned projects without installing absent hooks', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install);
  const versionDir = path.join(install, 'versions', '1.165.2-abc');
  await writeJson(path.join(project, '.project-swarm.json'), { profile: { project: 'x' }, pinnedVersion: '1.0.0' });
  await writeJson(path.join(project, '.swarm', 'runner-pointer.json'), { install, version: '1.0.0' });
  await writeJson(path.join(install, '.swarm-projects.json'), [project]);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  const hooks = orchestratorHooksStale(versionDir);
  hooks.PreToolUse = [
    { matcher: 'Edit', hooks: [{ type: 'command', command: staleScriptCommand(versionDir, 'handbuild-guard.mjs') }] },
    ...hooks.PreToolUse,
  ];
  hooks.Stop.push({ hooks: [{ type: 'command', command: CHECKPOINT_HOOK }] });
  await writeJson(localFile, { hooks });
  const pointerBefore = await fs.readFile(path.join(project, '.swarm', 'runner-pointer.json'), 'utf8');

  const result = await bumpPointers(install);
  const projectReal = await fs.realpath(project);
  assert.ok(result.skipped.some(s => s.project === projectReal));
  assert.equal(result.bumped.length, 0);

  const localAfter = await fs.readFile(localFile, 'utf8');
  assertAllCurrent(localAfter, install);
  assert.equal(await fs.readFile(path.join(project, '.swarm', 'runner-pointer.json'), 'utf8'), pointerBefore);
});

test('refreshProjectInstallHooks leaves projects without swarm hooks untouched', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install);
  const localFile = path.join(project, '.claude', 'settings.local.json');
  const before = '{ "hooks": { "Stop": [ { "hooks": [ { "type": "command", "command": "echo noop" } ] } ] } }\n';
  await fs.mkdir(path.dirname(localFile), { recursive: true });
  await fs.writeFile(localFile, before);
  const orch = await refreshProjectInstallHooks(project, install, { refreshOnly: true });
  assert.equal(orch.orchestrator.status, 'absent');
  assert.equal(orch.handbuild.status, 'absent');
  assert.equal(await fs.readFile(localFile, 'utf8'), before);
});

test('refreshGitHooksCheckScript re-points only swarm-installed git hooks', async () => {
  const install = await tmp();
  const project = await tmp();
  await seedInstallBase(install);
  await initGitRepo(project);
  const versionDir = path.join(install, 'versions', '1.165.2-abc');
  installGitHooks(project, { checkScript: path.join(versionDir, 'tools', 'githook-check.mjs') });
  const currentCheck = path.join(install, 'current', 'tools', 'githook-check.mjs');
  const refreshed = refreshGitHooksCheckScript(project, currentCheck);
  assert.equal(refreshed.status, 'updated');
  const preCommit = await fs.readFile(path.join(project, '.git', 'hooks', 'pre-commit'), 'utf8');
  assert.ok(preCommit.includes(currentCheck));
});
