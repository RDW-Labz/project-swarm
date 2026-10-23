// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision } from '../tools/handbuild.mjs';
import { handbuildShellPolicy, isSelfApprovalCommand } from '../tools/self-approval.mjs';
import { swarmHandbuildVerbFromPlain } from '../tools/shell-writes.mjs';

const GUARD = fileURLToPath(new URL('../tools/handbuild-guard.mjs', import.meta.url));

const REASON_WORDS = ['approve', 'approved', 'approving', 'deny', 'denied', 'on', 'off', 'swarm handbuild approve'];
const ORCH_VERBS = ['request', 'status', 'list', 'show', 'log'];

function reasonFlags(word) {
  return [
    `--reason ${word}`,
    `--reason "${word}"`,
    `--reason '${word}'`,
    `--reason "text ${word} tail"`,
  ];
}

for (const verb of ORCH_VERBS) {
  for (const word of REASON_WORDS) {
    for (const rf of reasonFlags(word)) {
      test(`orchestrator allows swarm handbuild ${verb} with ${rf}`, () => {
        const cmd = `swarm handbuild ${verb} ${rf} --files a.ts --kind tiny`;
        const pol = handbuildShellPolicy(cmd);
        assert.equal(pol.allow, true, cmd);
        assert.equal(isSelfApprovalCommand(cmd), false, cmd);
        assert.notEqual(swarmHandbuildVerbFromPlain(cmd.split(/\s+/)), 'approve');
      });
    }
  }
}

test('quoted and echo-prefixed approve text does not block status', () => {
  const cmds = [
    'echo "swarm handbuild approve" && swarm handbuild status',
    "echo 'swarm handbuild approve' && swarm handbuild list",
    'swarm handbuild show --reason "owner said approve"',
  ];
  for (const cmd of cmds) {
    const pol = handbuildShellPolicy(cmd);
    assert.equal(pol.allow, true, cmd);
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
  }
});

test('real owner approve forms stay blocked', () => {
  const blocked = [
    'swarm handbuild approve hb-abc',
    'swarm handbuild deny hb-abc',
    'swarm handbuild on',
    'swarm handbuild off',
    'echo warmup && swarm handbuild approve hb-abc',
    'env FOO=1 swarm handbuild approve hb-abc',
    'swarm decide handbuild-hb-abc approve',
  ];
  for (const cmd of blocked) {
    const pol = handbuildShellPolicy(cmd);
    assert.equal(pol.allow, false, cmd);
    assert.equal(isSelfApprovalCommand(cmd), true, cmd);
  }
});

async function tmpProject() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hb-reason-'));
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  return root;
}

test('guardDecision allows orchestrator verbs with reason words', async () => {
  const root = await tmpProject();
  for (const verb of ORCH_VERBS) {
    const cmd = `swarm handbuild ${verb} --reason "approved denied on off swarm handbuild approve"`;
    const decision = guardDecision({ tool: 'Bash', toolInput: { command: cmd }, root, cwd: root });
    assert.equal(decision.allow, true, cmd);
  }
});

test('handbuild-guard hook allows status with reason words on stdin', async () => {
  const root = await tmpProject();
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'swarm handbuild status --reason "approving and denied off"' },
    cwd: root,
  });
  const r = spawnSync(process.execPath, [GUARD], {
    input,
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root, HOME: process.env.HOME },
  });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), '');
});
