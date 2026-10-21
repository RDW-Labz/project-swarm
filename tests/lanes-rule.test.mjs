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

test('applyRule refuses orphan start marker', () => {
  const text = `${RULE_START}\nuser-owned notes must stay\n`;
  assert.throws(() => applyRule(text), /start marker without end marker/);
});

test('applyRule refuses end before start', () => {
  const text = `${RULE_END}\n${RULE_START}\n`;
  assert.throws(() => applyRule(text), /end marker before start marker/);
});

test('applyRule refuses two start markers', () => {
  const text = `${RULE_START}\na\n${RULE_START}\nb\n${RULE_END}\n`;
  assert.throws(() => applyRule(text), /more than one start marker/);
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

test('writeRuleFiles leaves file unchanged when orphan start marker is present', async t => {
  const root = await tempDir(t);
  const claudePath = path.join(root, 'CLAUDE.md');
  const before = `# Title\n\n${RULE_START}\nuser text that must not be deleted\n`;
  await fs.writeFile(claudePath, before);
  const result = await writeRuleFiles(root);
  assert.deepEqual(result.written, []);
  assert.deepEqual(result.unchanged, []);
  assert.equal(result.errors?.['CLAUDE.md'], 'start marker without end marker');
  assert.equal(await fs.readFile(claudePath, 'utf8'), before);
});

test('writeRuleFiles refuses end before start without modifying the file', async t => {
  const root = await tempDir(t);
  const claudePath = path.join(root, 'CLAUDE.md');
  const before = `${RULE_END}\nmid\n${RULE_START}\n`;
  await fs.writeFile(claudePath, before);
  const result = await writeRuleFiles(root);
  assert.equal(result.errors?.['CLAUDE.md'], 'end marker before start marker');
  assert.equal(await fs.readFile(claudePath, 'utf8'), before);
});

test('writeRuleFiles refuses two start markers without modifying the file', async t => {
  const root = await tempDir(t);
  const claudePath = path.join(root, 'CLAUDE.md');
  const before = `${RULE_START}\na\n${RULE_START}\nb\n${RULE_END}\n`;
  await fs.writeFile(claudePath, before);
  const result = await writeRuleFiles(root);
  assert.equal(result.errors?.['CLAUDE.md'], 'more than one start marker');
  assert.equal(await fs.readFile(claudePath, 'utf8'), before);
});

test('writeRuleFiles still updates the other file when one file is malformed', async t => {
  const root = await tempDir(t);
  const claudePath = path.join(root, 'CLAUDE.md');
  const agentsPath = path.join(root, 'AGENTS.md');
  const claudeBefore = `${RULE_START}\norphan\n`;
  await fs.writeFile(claudePath, claudeBefore);
  await fs.writeFile(agentsPath, '# Agents\n');
  const result = await writeRuleFiles(root);
  assert.equal(await fs.readFile(claudePath, 'utf8'), claudeBefore);
  assert.equal(result.errors?.['CLAUDE.md'], 'start marker without end marker');
  assert.ok(result.written.includes('AGENTS.md'));
  assert.ok((await fs.readFile(agentsPath, 'utf8')).includes(RULE_START));
});

test('writeRuleFiles refuses a symlinked parent directory', async t => {
  const root = await tempDir(t);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-lanes-outside-'));
  t.after(() => fs.rm(outside, {recursive: true, force: true}));
  await fs.writeFile(path.join(root, 'AGENTS.md'), '# agents\n');
  const gate = path.join(root, 'gate');
  await fs.symlink(outside, gate);
  const outsideTarget = path.join(gate, 'secret.md');
  await fs.writeFile(outsideTarget, '# secret\n');
  await fs.symlink(outsideTarget, path.join(root, 'CLAUDE.md'));
  const result = await writeRuleFiles(root);
  assert.equal(result.errors?.['CLAUDE.md'], 'refused symlink target: CLAUDE.md');
  assert.ok(result.written.includes('AGENTS.md'));
  assert.equal(await fs.readFile(outsideTarget, 'utf8'), '# secret\n');
});

test('writeRuleFiles atomic write leaves no temp file', async t => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'CLAUDE.md'), '# A\n');
  await writeRuleFiles(root);
  const names = await fs.readdir(root);
  assert.ok(!names.some(name => name.includes('.swarm-lanes-rule-') && name.endsWith('.tmp')));
});
