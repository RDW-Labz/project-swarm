// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject, CHECKPOINT_HOOK } from '../tools/install.mjs';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
async function temp(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-p10b-init-')));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const settingsOf = root => fs.readFile(path.join(root, '.claude/settings.local.json'), 'utf8').then(JSON.parse);

test('init points every agent at swarm brief, including Gemini', async t => {
  const root = await temp(t);
  const result = await installProject(root, { source: packageRoot });
  assert.ok(result.agentFiles.includes('GEMINI.md'));
  for (const file of ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.cursor/rules/project-swarm.mdc']) {
    const text = await fs.readFile(path.join(root, file), 'utf8');
    assert.match(text, /At session start, run `swarm brief` and continue from its next actions\./, file);
    assert.match(text, /swarm handoff --to <agent>/, file);
    assert.ok(!/Read and maintain `coordination\/HANDOFF\.md`/.test(text), `${file} no longer tells agents to hand-write HANDOFF.md`);
  }
});

test('init installs the checkpoint hook once, keeps other settings and hooks, and skips unreadable files', async t => {
  const root = await temp(t);
  assert.equal((await installProject(root, { source: packageRoot })).claudeHook.status, 'created');
  const settings = await settingsOf(root);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, CHECKPOINT_HOOK);
  assert.match(CHECKPOINT_HOOK, /command -v swarm .* \|\| true$/);
  assert.equal((await installProject(root, { source: packageRoot })).claudeHook.status, 'unchanged');
  const stopCommands = (await settingsOf(root)).hooks.Stop.flatMap(entry => entry.hooks.map(hook => hook.command));
  assert.equal(stopCommands.filter(c => c === CHECKPOINT_HOOK).length, 1, 'the checkpoint hook is there once');
  assert.equal(stopCommands.filter(c => c.includes('orchestrator-hook.mjs')).length, 1, 'and so is the Orchestrator lane hook');

  const other = await temp(t);
  await fs.mkdir(path.join(other, '.claude'));
  await fs.writeFile(path.join(other, '.claude/settings.local.json'), JSON.stringify({ model: 'x', hooks: { Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }], PreToolUse: [] } }));
  assert.equal((await installProject(other, { source: packageRoot })).claudeHook.status, 'updated');
  const merged = await settingsOf(other);
  assert.equal(merged.model, 'x');
  assert.deepEqual(merged.hooks.PreToolUse.flatMap(entry => entry.hooks.map(hook => hook.command)).filter(c => !c.includes('orchestrator-hook.mjs') && !c.includes('handbuild-guard.mjs')), [], 'the empty list only gained the Orchestrator lane and guard hooks');
  assert.deepEqual(merged.hooks.Stop.flatMap(entry => entry.hooks.map(hook => hook.command)).filter(c => !c.includes('orchestrator-hook.mjs')), ['echo mine', CHECKPOINT_HOOK]);

  const broken = await temp(t);
  await fs.mkdir(path.join(broken, '.claude'));
  await fs.writeFile(path.join(broken, '.claude/settings.local.json'), '{not json');
  assert.equal((await installProject(broken, { source: packageRoot })).claudeHook.status, 'skipped');
  assert.equal(await fs.readFile(path.join(broken, '.claude/settings.local.json'), 'utf8'), '{not json');

  const odd = await temp(t);
  await fs.mkdir(path.join(odd, '.claude'));
  await fs.writeFile(path.join(odd, '.claude/settings.local.json'), JSON.stringify({ hooks: { Stop: 'nope' } }));
  assert.equal((await installProject(odd, { source: packageRoot })).claudeHook.status, 'skipped');
});

test('no agent files means no hook', async t => {
  const root = await temp(t);
  const result = await installProject(root, { source: packageRoot, agentFiles: false });
  assert.equal(result.claudeHook, null);
  await assert.rejects(fs.access(path.join(root, '.claude/settings.local.json')));
});

test('the hook goes in the local, git-ignored settings file, once', async t => {
  const root = await temp(t);
  await installProject(root, { source: packageRoot });
  await installProject(root, { source: packageRoot });
  const ignore = await fs.readFile(path.join(root, '.gitignore'), 'utf8');
  assert.equal(ignore.split('\n').filter(line => line.trim() === '.claude/settings.local.json').length, 1);
  await assert.rejects(fs.access(path.join(root, '.claude/settings.json')), 'the shared, committed settings file is not touched');
});
