// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import path from 'node:path';

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

export function applyRule(existingText) {
  const block = ruleBlock();
  const startIdx = existingText.indexOf(RULE_START);
  const endIdx = startIdx === -1 ? -1 : existingText.indexOf(RULE_END, startIdx);
  if (startIdx !== -1 && endIdx !== -1) {
    const endOfBlock = endIdx + RULE_END.length;
    return existingText.slice(0, startIdx) + block + existingText.slice(endOfBlock);
  }
  if (existingText.length === 0) return block;
  const sep = existingText.endsWith('\n') ? '\n' : '\n\n';
  return existingText + sep + block;
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

async function updateExisting(root, name, written, unchanged) {
  const kind = await fileKind(root, name);
  if (kind === 'missing') return;
  if (kind === 'symlink') {
    throw new Error(`refused symlink target: ${name}`);
  }
  const filePath = path.join(root, name);
  const existing = await fs.readFile(filePath, 'utf8');
  const next = applyRule(existing);
  if (next === existing) {
    unchanged.push(name);
    return;
  }
  await fs.writeFile(filePath, next, 'utf8');
  written.push(name);
}

export async function writeRuleFiles(root) {
  const written = [];
  const unchanged = [];
  const claudeKind = await fileKind(root, 'CLAUDE.md');
  const agentsKind = await fileKind(root, 'AGENTS.md');
  if (claudeKind === 'symlink') {
    throw new Error('refused symlink target: CLAUDE.md');
  }
  if (agentsKind === 'symlink') {
    throw new Error('refused symlink target: AGENTS.md');
  }
  if (claudeKind === 'missing' && agentsKind === 'missing') {
    const text = applyRule('');
    await fs.writeFile(path.join(root, 'CLAUDE.md'), text, 'utf8');
    written.push('CLAUDE.md');
    return {written, unchanged};
  }
  if (claudeKind === 'file') await updateExisting(root, 'CLAUDE.md', written, unchanged);
  if (agentsKind === 'file') await updateExisting(root, 'AGENTS.md', written, unchanged);
  return {written, unchanged};
}
