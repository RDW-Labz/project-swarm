// SPDX-License-Identifier: Apache-2.0
// This project's own local, machine-specific config: a public repo names no private package or
// service, so anything project-specific (keychain service name, rig port file, cheap-tier
// override, extra denied home directories) arrives here instead of as a source literal.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function loadLocalConfig({ home = os.homedir(), env = process.env } = {}) {
  const file = env.SWARM_CONFIG || path.join(home, '.project-swarm', 'config.json');
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch { return {}; }
  try { return JSON.parse(text); }
  catch { throw Error(`invalid swarm config: ${file}`); }
}
