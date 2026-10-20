#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Claude Code hook for the Orchestrator lane: `node orchestrator-hook.mjs pre|post|stop|prompt`, the hook input as JSON on stdin. Writes one small event to the project's
// .swarm/orchestrator/events.ndjson and prints nothing. It never blocks or changes anything: whatever goes wrong, it exits 0 so a tool call is never held up by it.
import { buildEvent, appendEvent, projectRootOf } from './orchestrator-events.mjs';

const kind = process.argv[2];
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { if (raw.length < 2000000) raw += chunk; });
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(raw);
    const root = projectRootOf(input.cwd);
    if (root) {
      const event = buildEvent(kind, input, { root });
      if (event) appendEvent(root, event);
    }
  } catch { /* an unreadable input is dropped */ }
  process.exit(0);
});
process.stdin.on('error', () => process.exit(0));
setTimeout(() => process.exit(0), 4000).unref();
