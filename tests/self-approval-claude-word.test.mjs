// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { isSelfApprovalCommand } from '../tools/self-approval.mjs';

test('isSelfApprovalCommand: claude word false positives stay false', () => {
  const falseCases = [
    'swarm run manifest.json --agent claude',
    'swarm go --agent claude --model claude-sonnet',
    "git commit -m 'Fix X; Claude review follow-ups'",
    "git commit -m 'Bob & Claude Sonnet pairing'",
    "git commit -m 'fix' -m 'Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>'",
    `git commit -m 'fix' -m "$(cat <<'EOF'
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
)"`,
    'git commit -m \'msg with | pipe and "claude" in quotes\'',
    'echo claude -p hello',
    'cat ~/.claude/settings.json',
    'ls .claude',
    'node tools/swarm.mjs ask --agent claude question',
    'echo agent: claude',
    'swarm run --model claude-opus-4 task.json',
    'claude mcp list',
    'claude --version',
    'claude doctor',
    'claude setup-token',
    'claude --model opus',
    'claude --resume abc123',
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
    'FOO=1 claude -p x',
    'CLAUDE_CONFIG_DIR=/tmp/x claude -p hi',
    'env -i claude -p x',
    'env -u X claude -p x',
    'env FOO=1 claude -p x',
    'command claude -p x',
    'timeout 600 claude -p x',
    'nice -n 10 claude -p x',
    'sudo -u bob claude -p x',
    'xargs -n 1 claude -p',
    'nohup claude -p x &',
    '/usr/local/bin/claude -p x',
    '"/path/with spaces/claude" -p x',
    '(claude -p x)',
    'echo $(claude -p x)',
    'echo `claude -p x`',
    'for f in a b; do claude -p $f; done',
    'echo ok\nclaude -p hi',
    'cd repo && claude -p hi',
    'echo x | claude -p y',
    "bash -c 'claude -p x'",
    'eval "claude -p x"',
    "python3 -c \"import subprocess; subprocess.run(['claude','-p','x'])\"",
    "node -e \"require('child_process').execSync('claude -p hi')\"",
  ];
  for (const cmd of trueCases) {
    assert.ok(isSelfApprovalCommand(cmd), cmd);
  }
});
