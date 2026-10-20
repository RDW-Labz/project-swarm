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
      if (kind === 'prompt') {
        try {
          const prompt = typeof input.prompt === 'string' ? input.prompt : (typeof input.user_prompt === 'string' ? input.user_prompt : '');
          let recorded = 0;
          for (const line of prompt.split('\n')) {
            if (recorded >= 5) break;
            const m = line.match(/^\s*(?:(?:\d+\.|[-*])\s+)?merge\s+#?(\d+)\s*$/i);
            if (m) { recordChatMerge(root, m[1], { now: Date.now }); recorded += 1; }
          }
        } catch { /* never throw from the hook */ }
      }
    }
  } catch { /* an unreadable input is dropped */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();
