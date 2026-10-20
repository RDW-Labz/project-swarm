#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code hook for the Orchestrator lane: `node orchestrator-hook.mjs pre|post|stop|prompt`, the hook input as JSON on stdin. Writes one small event to the project's
// .swarm/orchestrator/events.ndjson and prints nothing. It never blocks or changes anything: whatever goes wrong, it exits 0 so a tool call is never held up by it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEvent, appendEvent, projectRootOf, isWorkerCwd } from './orchestrator-events.mjs';
import { analyzeShell } from './shell-writes.mjs';
import { recordChatMerge } from './handbuild.mjs';

const hookScriptPath = (() => {
  try { return fs.realpathSync.native(fileURLToPath(import.meta.url)); } catch { return fileURLToPath(import.meta.url); }
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

function shouldRecordChatMerge(input, projectRoot) {
  if (!projectRoot) return false;
  if (isWorkerCwd(input.cwd)) return false;
  if (typeof input.session_id !== 'string' || !input.session_id) return false;
  if (typeof input.transcript_path !== 'string' || !input.transcript_path) return false;
  if (!orchestratorHookInstalledFor(projectRoot)) return false;
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
