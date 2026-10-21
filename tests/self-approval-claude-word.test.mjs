// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSelfApprovalCommand } from '../tools/self-approval.mjs';

test('isSelfApprovalCommand: claude word false positives stay false', () => {
  const falseCases = [
    'swarm run manifest.json --agent claude',
    'swarm go --agent claude --model sonnet',
    "git commit -m 'fix x' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'",
    `git commit -m 'fix' -m "$(cat <<'EOF'
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"`,
    'echo claude',
    'cat ~/.claude/settings.json',
    'ls .claude',
    'node tools/swarm.mjs ask --agent claude question',
    'echo agent: claude',
    'swarm run --model claude-opus-4 task.json',
  ];
  for (const cmd of falseCases) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
  }
});

test('isSelfApprovalCommand: headless claude invocations stay true', () => {
  const trueCases = [
    'claude -p hello',
    'claude --print hello',
    'claude hello world',
    'env FOO=1 claude -p x',
    'command claude -p x',
    '/usr/local/bin/claude -p x',
    'bash -c "claude -p inside"',
    'eval "claude -p inside"',
    'nohup claude -p x &',
  ];
  for (const cmd of trueCases) {
    assert.ok(isSelfApprovalCommand(cmd), cmd);
  }
});

test('isSelfApprovalCommand: ordinary claude CLI subcommands stay false', () => {
  const falseCases = [
    'claude mcp list',
    'claude --version',
    'claude doctor',
  ];
  for (const cmd of falseCases) {
    assert.equal(isSelfApprovalCommand(cmd), false, cmd);
  }
});
