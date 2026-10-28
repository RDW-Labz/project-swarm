// SPDX-License-Identifier: Apache-2.0
// Side-effect-free helper: whether the orchestrator hook script is installed in Claude settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const hookScriptPath = (() => {
  const plain = fileURLToPath(new URL('./orchestrator-hook.mjs', import.meta.url));
  try { return fs.realpathSync.native(plain); } catch { return plain; }
})();

/** True when orchestrator hooks for this script are installed in the project's personal Claude settings. */
export function orchestratorHookInstalledFor(projectRoot) {
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
