// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { isSelfApprovalCommand, SELF_APPROVAL_REASON, HANDBUILD_OWNER_RULE_ID, HANDBUILD_SELF_APPROVAL_RULE_ID } from '../tools/self-approval.mjs';
import { guardDecision } from '../tools/handbuild.mjs';

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-guard-word-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

const project = async t => {
  const root = await tmp(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(path.join(root, 'src'));
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools/handbuild-guard.mjs'), '// hook\n');
  return root;
};

const bash = (root, command) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root });

test('guard words in prompts, messages, and paths do not trigger self-approval', () => {
  const allowed = [
    'git commit -m "fix safeguard for auth tokens"',
    'git commit -m "parts-app: hand-build guard false positive"',
    'swarm ask "update the guardrail docs for merge guard"',
    'swarm handbuild request --kind tiny --reason "the guard blocks safeguard paths only in prod"',
    'echo safeguard && grep -r guards tests/',
    'npm test -- --grep guard',
    'cat tools/handbuild-guard.mjs | head -5',
    'node --test tests/guard-word-false-positive.test.mjs',
    `git commit -F - <<'EOF'
safeguard guarded guardrails; do not switch the guard off in prose
EOF`,
    'gh pr create --title "guard-word false positive" --body "guards and safeguard wording"',
  ];
  for (const cmd of allowed) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
  }
});

test('guardDecision allows harmless guard wording; risky guard control still blocked', async t => {
  const root = await project(t);
  for (const cmd of [
    'swarm ask "manifest prompt mentions guards"',
    'grep -n guard tools/handbuild.mjs',
    'echo guarded mode is fine',
    'cat tools/handbuild-guard.mjs',
  ]) {
    const d = bash(root, cmd);
    assert.equal(d.allow, true, cmd);
  }
  assert.notEqual(bash(root, 'git commit -m "safeguard merge guardrail"').reason, SELF_APPROVAL_REASON);

  const blocked = [
    'swarm handbuild off',
    'swarm handbuild approve hb-abc',
    'swarm handbuild install',
    'node tools/swarm.mjs handbuild deny hb-1',
    'swarm decide handbuild-hb-9 approve',
    'sed -i "" s/x/y tools/handbuild-guard.mjs',
  ];
  for (const cmd of blocked) {
    const d = bash(root, cmd);
    assert.equal(d.allow, false, cmd);
    if (cmd.includes('handbuild-guard.mjs')) {
      assert.equal(d.ruleId, HANDBUILD_SELF_APPROVAL_RULE_ID, cmd);
      assert.equal(d.reason, SELF_APPROVAL_REASON, cmd);
      continue;
    }
    assert.equal(d.ruleId, HANDBUILD_OWNER_RULE_ID, cmd);
    assert.match(d.reason, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
  }
  assert.match(SELF_APPROVAL_REASON, new RegExp(`\\[${HANDBUILD_SELF_APPROVAL_RULE_ID}\\]`));
});
