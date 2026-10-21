#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code PreToolUse hook: the hand-build guard (see tools/handbuild.mjs). Reads the hook input on stdin and, for an edit or a shell command that would build by hand without an
// approval, answers with a deny and the reason (what to do instead); otherwise it prints nothing. It is small and fast: it runs before every edit and shell command.
// If it breaks, it lets the call through (and says nothing): a bug in the guard must never lock the owner out of their own project.
import { projectRootOf, buildEvent, appendEvent } from './orchestrator-events.mjs';
import { analyzeShell } from './shell-writes.mjs';
import { guardDecision, logAction, OFF_FILE } from './handbuild.mjs';
import fs from 'node:fs';
import path from 'node:path';

let raw = '';
let truncated = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (raw.length < 2000000) raw += chunk; else truncated = true; });
process.stdin.on('end', () => {
  try {
    // Claude Code names the project in CLAUDE_PROJECT_DIR; a session that has moved into another folder (or a swarm workspace) is still guarded for the project it belongs to.
    const fromEnv = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR) ? fs.realpathSync(process.env.CLAUDE_PROJECT_DIR) : null;
    if (truncated) {
      const root = fromEnv ?? projectRootOf(process.cwd());
      if (root && !fs.existsSync(path.join(root, OFF_FILE))) {
        logAction(root, { event: 'blocked', by: 'guard', tool: 'unknown', reason: 'the hook input was too large for the guard to read' });
        process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Hand-build guard: this tool call is too large for the guard to read, so it is refused. Write a ticket instead, or split the change.' } })}\n`);
      }
      process.exit(0);
    }
    const input = JSON.parse(raw);
    const root = fromEnv ?? projectRootOf(input.cwd);
    if (!root || fs.existsSync(path.join(root, OFF_FILE))) process.exit(0);
    const tool = input.tool_name;
    const decision = guardDecision({ tool, toolInput: input.tool_input, root, cwd: input.cwd });
    if (decision.allow) {
      if (decision.approval) logAction(root, { event: 'allowed', id: decision.approval, tool, files: decision.files });
      process.exit(0);
    }
    logAction(root, { event: 'blocked', by: 'guard', tool, files: decision.files, reason: decision.reason.slice(0, 200) });
    const event = buildEvent('blocked', input, { root, analyze: analyzeShell });
    if (event) appendEvent(root, event);
    const hookOut = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason };
    if (decision.ruleId) hookOut.ruleId = decision.ruleId;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: hookOut })}\n`);
  } catch { /* fail open */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();
