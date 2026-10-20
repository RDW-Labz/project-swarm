#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code hook for the Orchestrator lane: `node orchestrator-hook.mjs pre|post|stop|prompt`, the hook input as JSON on stdin. Writes one small event to the project's
// .swarm/orchestrator/events.ndjson and prints nothing. It never blocks or changes anything: whatever goes wrong, it exits 0 so a tool call is never held up by it.
import { buildEvent, appendEvent, projectRootOf } from './orchestrator-events.mjs';
import { analyzeShell } from './shell-writes.mjs';
import { recordChatMerge } from './handbuild.mjs';

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
      if (kind === 'prompt' && input.hook_event_name === 'UserPromptSubmit') {
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
              if (m) { recordChatMerge(root, m[1], { now: Date.now }); break; }
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
