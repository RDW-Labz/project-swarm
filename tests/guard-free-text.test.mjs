// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';
import {
  HANDBUILD_OWNER_RULE_ID,
  HANDBUILD_SELF_APPROVAL_RULE_ID,
  SELF_APPROVAL_REASON,
  isSelfApprovalCommand,
} from '../tools/self-approval.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));
const T0 = () => Date.UTC(2026, 9, 21, 12, 0, 0);

const RISKY = 'approve; approved deny && handbuild approve | guard off';

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'guard-free-text-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t) {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools/handbuild-guard.mjs'), '// hook fixture\n');
  return root;
}

const bash = (root, command, home = process.env.HOME) => guardDecision({
  tool: 'Bash',
  toolInput: { command },
  root,
  cwd: root,
  now: T0,
  home,
});

function runHook(root, command, home = process.env.HOME) {
  return spawnSync(process.execPath, [GUARD], {
    input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: root }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: home },
  });
}

function readOnlyFreeTextMatrix() {
  const q = JSON.stringify(RISKY);
  return [
    `swarm note ${q}`,
    `swarm tickets T-0001 --note ${q}`,
    `swarm ask ${q}`,
    `swarm decision ${q}`,
    `swarm lesson add --evidence ${q} --rule ${q} --fix ${q}`,
    `swarm handoff --to cursor ${q}`,
    `swarm backlog add ${q}`,
    `swarm change ${q}`,
    `swarm time log ${q}`,
    `swarm handbuild request --kind tiny --reason ${q} --files src/a.ts`,
    `swarm note <<'EOF'\n${RISKY}\nEOF`,
    'swarm handbuild status \\\n--reason "approve deny off"',
    `gh pr create --title safe --body ${q}`,
    `gh pr create --body-file - <<'EOF'\n${RISKY}\nEOF`,
  ];
}

function commitMessageFreeTextMatrix() {
  const q = JSON.stringify(RISKY);
  return [
    `git commit -m ${q}`,
    `git commit -m ${JSON.stringify('line1')} -m ${q}`,
    `git commit -F - <<'EOF'\n${RISKY}\nEOF`,
  ];
}

function assertNotHandbuildWordFalsePositive(d, cmd) {
  assert.notEqual(d.reason, SELF_APPROVAL_REASON, cmd);
  assert.doesNotMatch(String(d.reason ?? ''), new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
  assert.doesNotMatch(String(d.reason ?? ''), new RegExp(`\\[${HANDBUILD_SELF_APPROVAL_RULE_ID}\\]`));
}

test('free-text channels with guard words: guardDecision allow and hook pass', async t => {
  const root = await project(t);
  for (const cmd of readOnlyFreeTextMatrix()) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
    const d = bash(root, cmd);
    assert.equal(d.allow, true, cmd);
    const hook = runHook(root, cmd);
    assert.equal(hook.stdout.trim(), '', cmd);
  }
});

test('commit and gh message bodies: no handbuild owner/self-approval false positive', async t => {
  const root = await project(t);
  for (const cmd of commitMessageFreeTextMatrix()) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
    const d = bash(root, cmd);
    assertNotHandbuildWordFalsePositive(d, cmd);
  }
});

test('structural owner handbuild commands still block with rule id and matched token', async t => {
  const root = await project(t);
  const blocked = [
    'swarm handbuild approve hb-abc',
    'swarm handbuild deny hb-abc',
    'swarm handbuild off',
    'echo warmup && swarm handbuild approve hb-abc',
    '( swarm handbuild deny hb-abc )',
    'env FOO=1 swarm handbuild install',
    'cd tools && swarm handbuild on',
    'swarm decide handbuild-hb-9 approve',
    'node tools/swarm.mjs handbuild deny hb-1',
  ];
  for (const cmd of blocked) {
    const d = bash(root, cmd);
    assert.equal(d.allow, false, cmd);
    assert.equal(d.ruleId, HANDBUILD_OWNER_RULE_ID, cmd);
    assert.match(d.reason, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
    assert.match(d.reason, /matched "[^"]+" at executable position \d+/);
    const hook = runHook(root, cmd);
    const out = JSON.parse(hook.stdout.trim());
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /matched "[^"]+" at executable position \d+/);
  }
});

test('guard script edits still use self-approval rule id', async t => {
  const root = await project(t);
  const cmd = 'sed -i "" s/x/y tools/handbuild-guard.mjs';
  const d = bash(root, cmd);
  assert.equal(d.allow, false);
  assert.equal(d.ruleId, HANDBUILD_SELF_APPROVAL_RULE_ID);
  assert.equal(d.reason, SELF_APPROVAL_REASON);
});
