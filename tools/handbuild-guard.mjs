#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code PreToolUse hook: the hand-build guard (see tools/handbuild.mjs). Reads the hook input on stdin and, for an edit or a shell command that would build by hand without an
// approval, answers with a deny and the reason (what to do instead); otherwise it prints nothing. It is small and fast: it runs before every edit and shell command.
// If the guard itself crashes or hits its watchdog, it fails closed: deny with GUARD_ERROR_DENY_REASON (never silently allow).
import * as child_process from 'node:child_process';
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
  runGuardDecisionForHook,
} from './handbuild.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GUARDED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'NotebookEdit']);
const DECIDE_ARG = '--guard-decide';

const scriptPath = (() => {
  try { return fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); }
})();

const writeDeny = reason => {
  const hookOut = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason };
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: hookOut })}\n`);
};

function finishDenyCrash(root, tool, error) {
  if (root) {
    try { logGuardError(root, { kind: 'crash', tool, error }); } catch { /* best effort */ }
  }
  writeDeny(GUARD_ERROR_DENY_REASON);
  process.exit(0);
}

function finishDenyTimeout(root, tool) {
  if (root) {
    try {
      logGuardError(root, {
        kind: 'timeout',
        tool,
        error: { name: 'TimeoutError', message: 'hand-build guard watchdog' },
      });
    } catch { /* best effort */ }
  }
  writeDeny(GUARD_ERROR_DENY_REASON);
  process.exit(0);
}

function runDecideChild(raw) {
  let toolForLog = 'unknown';
  let rootForLog = null;
  try {
    const input = JSON.parse(raw);
    if (!input || typeof input !== 'object') {
      finishDenyCrash(rootForLog, toolForLog, { name: 'TypeError', message: 'hook input is not an object' });
      return;
    }
    const tool = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
    toolForLog = tool;
    const root = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR)
      ? fs.realpathSync(process.env.CLAUDE_PROJECT_DIR)
      : projectRootOf(input.cwd);
    rootForLog = root;
    if (!root || !GUARDED_TOOLS.has(tool)) {
      process.exit(0);
      return;
    }
    if (process.env.SWARM_GUARD_TEST_FAULT === 'hang') {
      for (;;) { /* test-only hang */ }
    }
    const { decision, input: hookInput } = runGuardDecisionForHook(input, { root, cwd: input.cwd });
    if (decision.allow) {
      if (decision.approval) logAction(root, { event: 'allowed', id: decision.approval, tool, files: decision.files });
      process.exit(0);
      return;
    }
    logAction(root, {
      event: 'blocked',
      by: 'guard',
      tool,
      files: decision.files,
      reason: decision.ruleId === ORCHESTRATOR_MODE_RULE_ID ? `orchestrator-mode: ${decision.reason.slice(0, 180)}` : decision.reason.slice(0, 200),
    });
    const event = buildEvent('blocked', hookInput, { root, analyze: analyzeShell });
    if (event) appendEvent(root, event);
    const hookOut = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: decision.reason };
    if (decision.ruleId) hookOut.ruleId = decision.ruleId;
    process.stdout.write(`${JSON.stringify({ hookSpecificOutput: hookOut })}\n`);
    process.exit(0);
  } catch (e) {
    finishDenyCrash(rootForLog, toolForLog, e);
  }
}

function runParentGuard(raw, truncated) {
  let rootForLog = null;
  let toolForLog = 'unknown';
  try {
      let fromEnv = null;
      try {
        fromEnv = process.env.CLAUDE_PROJECT_DIR && fs.existsSync(process.env.CLAUDE_PROJECT_DIR)
          ? fs.realpathSync(process.env.CLAUDE_PROJECT_DIR)
          : null;
      } catch (e) {
        finishDenyCrash(rootForLog, toolForLog, e);
        return;
      }

      if (truncated) {
        const root = fromEnv ?? projectRootOf(process.cwd());
        rootForLog = root;
        if (root && !fs.existsSync(path.join(root, OFF_FILE))) {
          logAction(root, { event: 'blocked', by: 'guard', tool: 'unknown', reason: 'the hook input was too large for the guard to read' });
          writeDeny('Hand-build guard: this tool call is too large for the guard to read, so it is refused. Write a ticket instead, or split the change.');
        }
        process.exit(0);
        return;
      }

      let input;
      try {
        input = JSON.parse(raw);
      } catch (e) {
        if (fromEnv) finishDenyCrash(fromEnv, toolForLog, e);
        else process.exit(0);
        return;
      }
      if (!input || typeof input !== 'object') {
        if (fromEnv) finishDenyCrash(fromEnv, toolForLog, { name: 'TypeError', message: 'hook input is not an object' });
        else process.exit(0);
        return;
      }

      toolForLog = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
      const tool = input.tool_name;

      let root;
      try {
        root = fromEnv ?? projectRootOf(input.cwd);
        rootForLog = root;
        if (!root) {
          process.exit(0);
          return;
        }
        if (fs.existsSync(path.join(root, OFF_FILE))) {
          process.exit(0);
          return;
        }
      } catch (e) {
        finishDenyCrash(rootForLog, toolForLog, e);
        return;
      }

      if (!GUARDED_TOOLS.has(tool)) {
        process.exit(0);
        return;
      }

      const timeoutMs = guardTimeoutMs();
      const child = child_process.spawnSync(process.execPath, [scriptPath, DECIDE_ARG], {
        input: raw,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: timeoutMs,
        killSignal: 'SIGKILL',
        maxBuffer: 4 * 1024 * 1024,
      });
      const out = String(child.stdout ?? '').trim();
      const err = String(child.stderr ?? '').trim();
      if (child.error?.code === 'ETIMEDOUT' || child.signal === 'SIGKILL') {
        finishDenyTimeout(root, toolForLog);
        return;
      }
      if (child.status !== 0) {
        finishDenyCrash(root, toolForLog, {
          name: 'Error',
          message: err || `guard child exited ${child.status}`,
        });
        return;
      }
      if (out) process.stdout.write(`${out.endsWith('\n') ? out : `${out}\n`}`);
      process.exit(0);
  } catch (e) {
    finishDenyCrash(rootForLog, toolForLog, e);
  }
}

if (process.argv.includes(DECIDE_ARG)) {
  try {
    const raw = fs.readFileSync(0, 'utf8');
    runDecideChild(raw);
  } catch (e) {
    finishDenyCrash(null, 'unknown', e);
  }
} else {
  let raw = '';
  let truncated = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { if (raw.length < 2000000) raw += chunk; else truncated = true; });
  process.stdin.on('error', e => finishDenyCrash(null, 'unknown', e));
  process.stdin.on('end', () => runParentGuard(raw, truncated));
}
