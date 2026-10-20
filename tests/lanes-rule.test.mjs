// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  RULE_START,
  RULE_END,
  RULE_TEXT,
  applyRule,
  writeRuleFiles,
} from '../tools/lanes-rule.mjs';

async function tempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lanes-rule-'));
  t.after(() => fs.rm(dir, {recursive: true, force: true}));
  return fs.realpath(dir);
}

test('applyRule appends to a file without markers and keeps the old text byte for byte at the start', () => {
  const before = '# Project\n\nCustom body.\n';
  const after = applyRule(before);
  assert.equal(after.slice(0, before.length), before);
  assert.ok(after.endsWith(applyRule('')));
});

test('applyRule replaces an old block and preserves text before and after the markers', () => {
  const before = 'preamble\n\n';
  const oldMiddle = 'stale rule text';
  const afterText = '\n\ntrailer\n';
  const existing = `${before}${RULE_START}\n${oldMiddle}\n${RULE_END}${afterText}`;
  const next = applyRule(existing);
  assert.equal(next.slice(0, before.length), before);
  assert.equal(next.slice(next.length - afterText.length), afterText);
  assert.ok(next.includes(RULE_TEXT));
  assert.ok(!next.includes(oldMiddle));
});

test('applyRule is idempotent', () => {
  const once = applyRule('intro\n');
  const twice = applyRule(once);
  assert.equal(twice, once);
});

test('writeRuleFiles creates CLAUDE.md when neither agent file exists', async t => {
  const root = await tempDir(t);
  const result = await writeRuleFiles(root);
  assert.deepEqual(result, {written: ['CLAUDE.md'], unchanged: []});
  assert.equal(await fs.readFile(path.join(root, 'CLAUDE.md'), 'utf8'), applyRule(''));
  await assert.rejects(fs.access(path.join(root, 'AGENTS.md')));
});

test('writeRuleFiles leaves both unchanged on a second call', async t => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# A\n');
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# B\n');
  const first = await writeRuleFiles(root);
  assert.deepEqual(first.written.sort(), ['AGENTS.md', 'CLAUDE.md']);
  assert.deepEqual(first.unchanged, []);
  const second = await writeRuleFiles(root);
  assert.deepEqual(second.written, []);
  assert.deepEqual(second.unchanged.sort(), ['AGENTS.md', 'CLAUDE.md']);
});

test('writeRuleFiles updates AGENTS.md only when CLAUDE.md is absent', async t => {
  const root = await tempDir(t);
  const agentsPath = path.join(root, 'AGENTS.md');
  await fs.writeFile(agentsPath, '# Agents only\n');
  const result = await writeRuleFiles(root);
  assert.deepEqual(result, {written: ['AGENTS.md'], unchanged: []});
  const text = await fs.readFile(agentsPath, 'utf8');
  assert.match(text, /^# Agents only/);
  assert.ok(text.includes(RULE_START));
  await assert.rejects(fs.access(path.join(root, 'CLAUDE.md')));
});

test('writeRuleFiles refuses a symlinked CLAUDE.md', async t => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'real-claude.md'), '# real\n');
  await fs.symlink('real-claude.md', path.join(root, 'CLAUDE.md'));
  await assert.rejects(writeRuleFiles(root), /refused symlink target: CLAUDE\.md/);
});
