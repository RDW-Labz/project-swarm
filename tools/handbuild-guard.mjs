#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code PreToolUse hook: the hand-build guard (see tools/handbuild.mjs). Reads the hook input on stdin and, for an edit or a shell command that would build by hand without an
// approval, answers with a deny and the reason (what to do instead); otherwise it prints nothing. It is small and fast: it runs before every edit and shell command.
// If the guard itself crashes or hits its watchdog, it fails closed: deny with GUARD_ERROR_DENY_REASON (never silently allow).
import { projectRootOf, buildEvent, appendEvent } from './orchestrator-events.mjs';
import { analyzeShell } from './shell-writes.mjs';
import {
  guardDecision,
  logAction,
  logGuardError,
  guardTimeoutMs,
  OFF_FILE,
  ORCHESTRATOR_MODE_RULE_ID,
  GUARD_ERROR_DENY_REASON,
  isGuardTestMode,
  isTempProjectRoot,
} from './handbuild.mjs';
import fs from 'node:fs';
import path from 'node:path';

const GUARDED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);

let raw = '';
let truncated = false;
let decided = false;
let watchdog = null;
let rootForLog = null;
let toolForLog = 'unknown';

process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (raw.length < 2000000) raw += chunk; else truncated = true; });

const writeDeny = reason => {
  const hookOut = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: hookOut })}\n`);
};

const finishAllow = () => {
  if (decided) return;
  decided = true;
  if (watchdog !== null) clearTimeout(watchdog);
  process.exit(0);
};

const finishDeny = (reason, { kind, error, root, tool } = {}) => {
  if (decided) return;
  decided = true;
  if (watchdog !== null) clearTimeout(watchdog);
  const logRoot = root ?? rootForLog;
  if (logRoot && kind) {
    try { logGuardError(logRoot, { kind, tool: tool ?? toolForLog, error }); } catch { /* best effort */ }
  }
  writeDeny(reason);
  process.exit(0);
};

process.stdin.on('error', e => {
  finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: e, root: rootForLog, tool: toolForLog });
});

process.stdin.on('end', async () => {
  watchdog = setTimeout(() => {
    finishDeny(GUARD_ERROR_DENY_REASON, {
      kind: 'timeout',
      error: { name: 'TimeoutError', message: 'hand-build guard watchdog' },
      root: rootForLog,
      tool: toolForLog,
    });
  }, guardTimeoutMs());

  try {
    let fromEnv = null;
    try {
      fromEnv = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR)
        ? fs.realpathSync(process.env.CLAUDE_PROJECT_DIR)
        : null;
    } catch (e) {
      finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: e, root: rootForLog, tool: toolForLog });
      return;
    }

    if (truncated) {
      const root = fromEnv ?? projectRootOf(process.cwd());
      rootForLog = root;
      if (root && !fs.existsSync(path.join(root, OFF_FILE))) {
        logAction(root, { event: 'blocked', by: 'guard', tool: 'unknown', reason: 'the hook input was too large for the guard to read' });
        if (decided) return;
        decided = true;
        if (watchdog !== null) clearTimeout(watchdog);
        writeDeny('Hand-build guard: this tool call is too large for the guard to read, so it is refused. Write a ticket instead, or split the change.');
        process.exit(0);
        return;
      }
      finishAllow();
      return;
    }

    let input;
    try {
      input = JSON.parse(raw);
    } catch (e) {
      if (fromEnv) {
        rootForLog = fromEnv;
        finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: e, root: rootForLog, tool: toolForLog });
      } else finishAllow();
      return;
    }
    if (!input || typeof input !== 'object') {
      if (fromEnv) {
        rootForLog = fromEnv;
        finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: { name: 'TypeError', message: 'hook input is not an object' }, root: rootForLog, tool: toolForLog });
      } else finishAllow();
      return;
    }

    toolForLog = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';

    try {
      const root = fromEnv ?? projectRootOf(input.cwd);
      rootForLog = root;
      if (!root) {
        finishAllow();
        return;
      }
      if (fs.existsSync(path.join(root, OFF_FILE))) {
        finishAllow();
        return;
      }
    } catch (e) {
      finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: e, root: rootForLog, tool: toolForLog });
      return;
    }

    const root = rootForLog;
    const tool = input.tool_name;
    if (!GUARDED_TOOLS.has(tool)) {
      finishAllow();
      return;
    }

    if (process.env.SWARM_GUARD_TEST_FAULT === 'hang' && isGuardTestMode() && isTempProjectRoot(root)) {
      await new Promise(() => {});
      return;
    }

    const decision = guardDecision({ tool, toolInput: input.tool_input, root, cwd: input.cwd });
    if (decision.allow) {
      if (decision.approval) logAction(root, { event: 'allowed', id: decision.approval, tool, files: decision.files });
      finishAllow();
      return;
    }
    logAction(root, {
      event: 'blocked',
      by: 'guard',
      tool,
      files: decision.files,
      reason: decision.ruleId === ORCHESTRATOR_MODE_RULE_ID ? `orchestrator-mode: ${decision.reason.slice(0, 180)}` : decision.reason.slice(0, 200),
    });
    const event = buildEvent('blocked', input, { root, analyze: analyzeShell });
    if (event) appendEvent(root, event);
    const hookOut = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason };
    if (decision.ruleId) hookOut.ruleId = decision.ruleId;
    if (decided) return;
    decided = true;
    if (watchdog !== null) clearTimeout(watchdog);
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: hookOut })}\n`);
    process.exit(0);
  } catch (e) {
    finishDeny(GUARD_ERROR_DENY_REASON, { kind: 'crash', error: e, root: rootForLog, tool: toolForLog });
  }
});
