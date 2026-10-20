#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code hook for the Orchestrator lane: `node orchestrator-hook.mjs pre|post|stop|prompt`, the hook input as JSON on stdin. Writes one small event to the project's
// .swarm/orchestrator/events.ndjson and prints nothing. It never blocks or changes anything: whatever goes wrong, it exits 0 so a tool call is never held up by it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvent, appendEvent, projectRootOf, isWorkerCwd } from './orchestrator-events.mjs';
import { analyzeShell } from './shell-writes.mjs';
import { recordChatMerge } from './handbuild.mjs';

const hookScriptPath = (() => {
  try { return fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); }
})();

const CLAUDE_PROJECTS_ROOT = (() => {
  try {
    return fs.realpathSync.native(path.join(os.homedir(), '.claude', 'projects'));
  } catch {
    return path.join(os.homedir(), '.claude', 'projects');
  }
})();

/** True when orchestrator hooks for this script are installed in the project's personal Claude settings. */
function orchestratorHookInstalledFor(projectRoot) {
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(projectRoot, '.claude', 'settings.local.json'), 'utf8'));
    const cmds = [];
    for (const list of Object.values(settings.hooks ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const entry of list) {
        for (const hook of entry?.hooks ?? []) {
          if (typeof hook?.command === 'string') cmds.push(hook.command);
        }
      }
    }
    return cmds.some(command => {
      if (!command.includes('orchestrator-hook.mjs')) return false;
      const m = command.match(/node\s+(?:'([^']+)'|"([^"]+)"|(\S+))/);
      const script = m?.[1] ?? m?.[2] ?? m?.[3];
      if (!script) return command.includes(hookScriptPath);
      try { return fs.realpathSync.native(script) === hookScriptPath; } catch { return script === hookScriptPath; }
    });
  } catch { return false; }
}

function messageContentText(message) {
  if (!message || typeof message !== 'object') return '';
  const content = message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  let out = '';
  for (const part of content) {
    if (typeof part === 'string') out += part;
    else if (part && typeof part.text === 'string') out += part.text;
  }
  return out;
}

function lastUserMessageFromTranscript(transcriptPath) {
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return null;
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const readLen = Math.min(stat.size, 65536);
      const buf = Buffer.alloc(readLen);
      fs.readSync(fd, buf, 0, readLen, stat.size - readLen);
      const tail = buf.toString('utf8');
      const lines = tail.split('\n').filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const row = JSON.parse(lines[i]);
          if (row?.type === 'user') return messageContentText(row.message);
        } catch { /* skip bad line */ }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch { /* unreadable */ }
  return null;
}

function transcriptUnderClaudeProjects(transcriptPath) {
  try {
    const real = fs.realpathSync.native(transcriptPath);
    const root = CLAUDE_PROJECTS_ROOT.endsWith(path.sep)
      ? CLAUDE_PROJECTS_ROOT
      : CLAUDE_PROJECTS_ROOT + path.sep;
    return real === CLAUDE_PROJECTS_ROOT || real.startsWith(root);
  } catch {
    return false;
  }
}

function promptMatchesTranscript(transcriptPath, prompt) {
  if (typeof transcriptPath !== 'string' || !transcriptPath) return false;
  if (!transcriptUnderClaudeProjects(transcriptPath)) return false;
  const lastUser = lastUserMessageFromTranscript(transcriptPath);
  if (lastUser == null) return false;
  const trimmedPrompt = String(prompt ?? '').trim();
  return lastUser.trim() === trimmedPrompt;
}

function shouldRecordChatMerge(input, projectRoot) {
  if (!projectRoot) return false;
  if (isWorkerCwd(input.cwd)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id) return false;
  if (typeof input.transcript_path !== 'string' || !input.transcript_path) return false;
  if (!orchestratorHookInstalledFor(projectRoot)) return false;
  const prompt = typeof input.prompt === 'string' ? input.prompt : (typeof input.user_prompt === 'string' ? input.user_prompt : '');
  if (!promptMatchesTranscript(input.transcript_path, prompt)) return false;
  return true;
}

const kind = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (raw.length < 2000000) raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const root = projectRootOf(input.cwd);
    if (root) {
      const event = buildEvent(kind, input, { root, analyze: analyzeShell });
      if (event) appendEvent(root, event);
      if (kind === 'prompt' && input.hook_event_name === 'UserPromptSubmit' && shouldRecordChatMerge(input, root)) {
        try {
          const prompt = typeof input.prompt === 'string' ? input.prompt : (typeof input.user_prompt === 'string' ? input.user_prompt : '');
          const trimmed = prompt.trim();
          if (!trimmed.includes('\n') && !trimmed.includes('\r')) {
            const patterns = [
              /^merge\s+#?(\d{1,6})$/i,
              /^merge\s+pr\s+#?(\d{1,6})$/i,
              /^merge\s+pull\s+request\s+#?(\d{1,6})$/i,
            ];
            for (const re of patterns) {
              const m = trimmed.match(re);
              if (m) {
                const nowMs = Date.now();
                recordChatMerge(root, m[1], { now: () => nowMs });
                break;
              }
            }
          }
        } catch { /* never throw from the hook */ }
      }
    }
  } catch { /* an unreadable input is dropped */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();
