// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

export const RULE_START = '<!-- swarm:keep-lanes-busy:start -->';
export const RULE_END = '<!-- swarm:keep-lanes-busy:end -->';

export const RULE_TEXT = `## Keep the lanes busy (swarm rule)

Never leave swarm lanes idle while ready tickets exist.
When a run or wave finishes, start the next ready tickets with \`swarm go --scope\` (or let swarm autopilot do it).
Queue work through swarm jobs, not by hand.
A pending approval blocks only the tickets whose files it names — keep every other ready ticket running.
Never wait for the owner on work that is already approved.
Never merge, deploy, raise a cap, or override without the owner.`;

function ruleBlock() {
  return `${RULE_START}\n${RULE_TEXT}\n${RULE_END}`;
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let idx = 0;
  while ((idx = haystack.indexOf(needle, idx)) !== -1) {
    count += 1;
    idx += needle.length;
  }
  return count;
}

function markerProblem(existingText) {
  const startCount = countOccurrences(existingText, RULE_START);
  const endCount = countOccurrences(existingText, RULE_END);
  if (startCount === 0 && endCount === 0) return null;
  if (startCount > 1) return 'more than one start marker';
  if (endCount > 1) return 'more than one end marker';
  if (startCount === 1 && endCount === 0) return 'start marker without end marker';
  if (startCount === 0 && endCount > 0) return 'end marker without start marker';
  const startIdx = existingText.indexOf(RULE_START);
  const endIdx = existingText.indexOf(RULE_END);
  if (endIdx < startIdx) return 'end marker before start marker';
  return null;
}

export function applyRule(existingText) {
  const problem = markerProblem(existingText);
  if (problem) {
    throw new Error(problem);
  }
  const block = ruleBlock();
  const startIdx = existingText.indexOf(RULE_START);
  const endIdx = existingText.indexOf(RULE_END);
  if (startIdx !== -1 && endIdx !== -1) {
    const endOfBlock = endIdx + RULE_END.length;
    return existingText.slice(0, startIdx) + block + existingText.slice(endOfBlock);
  }
  if (existingText.length === 0) return block;
  const sep = existingText.endsWith('\n') ? '\n' : '\n\n';
  return existingText + sep + block;
}

function pathInsideRoot(rootReal, candidateReal) {
  const rel = path.relative(rootReal, candidateReal);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function fileKind(root, name) {
  try {
    const stat = await fs.lstat(path.join(root, name));
    if (stat.isSymbolicLink()) return 'symlink';
    return 'file';
  } catch (err) {
    if (err.code === 'ENOENT') return 'missing';
    throw err;
  }
}

async function assertSafeTarget(root, name) {
  const rootReal = await fs.realpath(root);
  const filePath = path.join(root, name);
  const parent = path.dirname(filePath);
  let parentReal;
  try {
    parentReal = await fs.realpath(parent);
  } catch (err) {
    if (err.code === 'ENOENT') parentReal = rootReal;
    else throw err;
  }
  if (!pathInsideRoot(rootReal, parentReal)) {
    throw new Error(`refused path outside project root: ${name}`);
  }
  const kind = await fileKind(root, name);
  if (kind === 'symlink') {
    throw new Error(`refused symlink target: ${name}`);
  }
  if (kind === 'file') {
    const fileReal = await fs.realpath(filePath);
    if (!pathInsideRoot(rootReal, fileReal)) {
      throw new Error(`refused path outside project root: ${name}`);
    }
  }
  return filePath;
}

async function atomicWriteUtf8(filePath, content) {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.swarm-lanes-rule-${randomBytes(8).toString('hex')}.tmp`);
  const fh = await fs.open(tmpPath, 'wx');
  try {
    await fh.writeFile(content, 'utf8');
  } finally {
    await fh.close();
  }
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) {
      await fs.unlink(tmpPath).catch(() => {});
      throw new Error(`refused symlink target: ${path.basename(filePath)}`);
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  await fs.rename(tmpPath, filePath);
}

async function updateExisting(root, name, written, unchanged, errors) {
  let filePath;
  try {
    filePath = await assertSafeTarget(root, name);
  } catch (err) {
    errors[name] = String(err.message);
    return;
  }
  const existing = await fs.readFile(filePath, 'utf8');
  let next;
  try {
    next = applyRule(existing);
  } catch (err) {
    errors[name] = String(err.message);
    return;
  }
  if (next === existing) {
    unchanged.push(name);
    return;
  }
  await atomicWriteUtf8(filePath, next);
  written.push(name);
}

// When neither agent file exists, only CLAUDE.md is created. When only one exists, only that file is updated.
export async function writeRuleFiles(root) {
  root = await fs.realpath(root);
  const written = [];
  const unchanged = [];
  const errors = {};
  const claudeKind = await fileKind(root, 'CLAUDE.md');
  const agentsKind = await fileKind(root, 'AGENTS.md');
  if (claudeKind === 'symlink' && agentsKind !== 'file') {
    throw new Error('refused symlink target: CLAUDE.md');
  }
  if (agentsKind === 'symlink' && claudeKind !== 'file') {
    throw new Error('refused symlink target: AGENTS.md');
  }
  if (claudeKind === 'symlink') {
    errors['CLAUDE.md'] = 'refused symlink target: CLAUDE.md';
  }
  if (agentsKind === 'symlink') {
    errors['AGENTS.md'] = 'refused symlink target: AGENTS.md';
  }
  if (claudeKind === 'missing' && agentsKind === 'missing') {
    const filePath = await assertSafeTarget(root, 'CLAUDE.md');
    const text = applyRule('');
    await atomicWriteUtf8(filePath, text);
    written.push('CLAUDE.md');
    return {written, unchanged};
  }
  if (claudeKind === 'file') await updateExisting(root, 'CLAUDE.md', written, unchanged, errors);
  if (agentsKind === 'file') await updateExisting(root, 'AGENTS.md', written, unchanged, errors);
  return {
    written,
    unchanged,
    ...(Object.keys(errors).length ? {errors} : {}),
  };
}
