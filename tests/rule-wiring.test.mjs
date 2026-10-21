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
import { initProject } from '../tools/init.mjs';
import { updateProjects } from '../tools/swarm.mjs';
import { RULE_START, RULE_END } from '../tools/lanes-rule.mjs';

const source = fileURLToPath(new URL('..', import.meta.url));
const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  return (await execFileAsync('git', args, { cwd, encoding: 'utf8' })).stdout;
}

async function tempGitProject(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-rule-wiring-'));
  const registry = path.join(source, '.swarm-projects.json');
  const before = await fs.readFile(registry, 'utf8').catch(() => null);
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true });
    if (before === null) await fs.rm(registry, { force: true });
    else await fs.writeFile(registry, before);
  });
  await git(root, ['init']);
  await git(root, ['checkout', '-b', 'main']);
  await git(root, ['config', 'user.email', 'test@example.com']);
  await git(root, ['config', 'user.name', 'Test']);
  await fs.writeFile(
    path.join(root, 'package.json'),
    `${JSON.stringify({ name: 'sample', scripts: { test: 'node --test' } })}\n`,
  );
  return root;
}

test('initProject writes the marker block into CLAUDE.md and returns ruleFiles', async t => {
  const root = await tempGitProject(t);
  const result = await initProject(root, { source, map: false });
  assert.ok(result.ruleFiles);
  assert.ok(result.ruleFiles.written.includes('CLAUDE.md') || result.ruleFiles.unchanged.includes('CLAUDE.md'));
  const claude = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.includes(RULE_START));
  assert.ok(claude.includes(RULE_END));
});

test('a second initProject leaves CLAUDE.md bytes unchanged', async t => {
  const root = await tempGitProject(t);
  await initProject(root, { source, map: false });
  const afterFirst = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  await initProject(root, { source, map: false });
  const afterSecond = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(afterSecond, afterFirst);
});

test('initProject keeps custom text outside the rule markers in an existing CLAUDE.md', async t => {
  const root = await tempGitProject(t);
  const preamble = '# My project\n\nOwner notes stay here.\n';
  await fs.writeFile(path.join(root, 'CLAUDE.md'), preamble);
  await initProject(root, { source, map: false });
  const claude = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.equal(claude.slice(0, preamble.length), preamble);
  assert.ok(claude.includes(RULE_START));
});

test('updateProjects without --yes does not write rule markers; with --yes does', async t => {
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-rule-update-install-'));
  t.after(() => fs.rm(installRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  const project = await tempGitProject(t);
  await fs.writeFile(
    path.join(project, '.project-swarm.json'),
    JSON.stringify({ install: installRoot, version: '1.0.0' }),
  );
  const claudePath = path.join(project, 'CLAUDE.md');
  await fs.writeFile(claudePath, '# linked\n');

  const dry = await updateProjects(installRoot, { projects: [project] });
  assert.equal(dry.projects[0].action, 'up-to-date');
  assert.equal(dry.projects[0].ruleFiles, undefined);
  assert.equal(await fs.readFile(claudePath, 'utf8'), '# linked\n');

  const applied = await updateProjects(installRoot, { projects: [project], yes: true });
  assert.equal(applied.projects[0].action, 'up-to-date');
  assert.ok(applied.projects[0].ruleFiles);
  const updated = await fs.readFile(claudePath, 'utf8');
  assert.match(updated, /^# linked/);
  assert.ok(updated.includes(RULE_START));
});

test('initProject reports malformed rule markers without failing and still updates the other file', async t => {
  const root = await tempGitProject(t);
  const agentsPath = path.join(root, 'AGENTS.md');
  const agentsBefore = `${RULE_START}\nkeep this text\n`;
  await fs.writeFile(agentsPath, agentsBefore);
  const result = await initProject(root, { source, map: false });
  const agents = await fs.readFile(agentsPath, 'utf8');
  assert.equal(agents.slice(0, agentsBefore.length), agentsBefore);
  assert.ok(result.ruleFiles?.errors?.['AGENTS.md']);
  assert.match(result.ruleFiles.errors['AGENTS.md'], /start marker without end marker/);
  const claude = await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8');
  assert.ok(claude.includes(RULE_START));
  assert.ok(agents.includes('<!-- project-swarm:start -->'));
  assert.equal(result.ruleFilesError, undefined);
});

test('updateProjects with --yes reports malformed rule markers without failing', async t => {
  const installRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-rule-update-malformed-'));
  t.after(() => fs.rm(installRoot, { recursive: true, force: true }));
  await fs.writeFile(path.join(installRoot, 'package.json'), JSON.stringify({ name: 'x', version: '1.0.0' }));

  const project = await tempGitProject(t);
  await fs.writeFile(
    path.join(project, '.project-swarm.json'),
    JSON.stringify({ install: installRoot, version: '1.0.0' }),
  );
  const claudePath = path.join(project, 'CLAUDE.md');
  const claudeBefore = `${RULE_END}\ntrailer\n`;
  await fs.writeFile(claudePath, claudeBefore);

  const applied = await updateProjects(installRoot, { projects: [project], yes: true });
  assert.equal(applied.projects[0].action, 'up-to-date');
  assert.equal(await fs.readFile(claudePath, 'utf8'), claudeBefore);
  assert.ok(applied.projects[0].ruleFiles?.errors?.['CLAUDE.md']);
  assert.match(applied.projects[0].ruleFiles.errors['CLAUDE.md'], /end marker without start marker/);
  assert.equal(applied.projects[0].ruleFilesError, undefined);
});
