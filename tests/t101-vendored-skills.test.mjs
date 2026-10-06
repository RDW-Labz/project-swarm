// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installProject } from '../tools/install.mjs';
import { loadSkillFile, skillSizeWarnings, tokenEstimate } from '../tools/skills.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = ['tdd', 'diagnosing-bugs', 'code-review', 'resolving-merge-conflicts', 'writing-for-agents'];
const pins = {
  '6fd947921b935b7e1e69293a200400f0fdd5c15f': ['tdd', 'diagnosing-bugs', 'code-review', 'writing-for-agents'],
  '153fc1b93de6584562765cdce299324e1ff9e661': ['resolving-merge-conflicts'],
};

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-t101-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}

test('vendored skills load, stay within the warning threshold, and carry attribution', async t => {
  const license = await fs.readFile(path.join(repoRoot, 'templates/coordination/skills', names[0], 'LICENSE'));
  assert.match(license.toString('utf8'), /^MIT License\n\nCopyright \(c\) 2026 Matt Pocock\n/);
  for (const name of names) {
    const file = path.join(repoRoot, 'templates/coordination/skills', name, 'SKILL.md');
    const skill = await loadSkillFile(file);
    assert.equal(skill.name, name);
    assert.ok(tokenEstimate(skill.chars) <= 800, `${name} is over 800 tokens`);
    assert.deepEqual(skillSizeWarnings([skill]), []);
    assert.match(skill.body, /^Adapted from mattpocock\/skills \(MIT\), commit [0-9a-f]+; trimmed\./);
    assert.deepEqual(await fs.readFile(path.join(path.dirname(file), 'LICENSE')), license);
  }
  const notice = await fs.readFile(path.join(repoRoot, 'NOTICE'), 'utf8');
  for (const pin of Object.keys(pins)) assert.match(notice, new RegExp(pin));
  for (const name of names) assert.match(notice, new RegExp(`- ${name} —`));
});

test('installProject copies complete absent skill folders and keeps an existing skill untouched', async t => {
  const source = await tempDir(t);
  const project = await tempDir(t);
  await fs.writeFile(path.join(source, 'package.json'), '{"name":"fixture","version":"1.0.0"}\n');
  await fs.cp(path.join(repoRoot, 'examples'), path.join(source, 'examples'), { recursive: true });
  await fs.cp(path.join(repoRoot, 'templates'), path.join(source, 'templates'), { recursive: true });

  const existing = path.join(project, 'coordination/skills/code-review/SKILL.md');
  const original = 'project-owned skill\n';
  await fs.mkdir(path.dirname(existing), { recursive: true });
  await fs.writeFile(existing, original);

  const result = await installProject(project, { source, agentFiles: false });
  for (const name of names.filter(value => value !== 'code-review')) {
    assert.ok(result.added.includes(`coordination/skills/${name}/SKILL.md`));
    assert.ok(result.added.includes(`coordination/skills/${name}/LICENSE`));
  }
  assert.ok(result.kept.includes('coordination/skills/code-review/SKILL.md'));
  assert.equal(await fs.readFile(existing, 'utf8'), original);
  await assert.rejects(fs.access(path.join(project, 'coordination/skills/code-review/LICENSE')));
});
