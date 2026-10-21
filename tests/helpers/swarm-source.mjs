// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const entryPath = path.join(packageRoot, 'tools/swarm.mjs');
const modulesDir = path.join(packageRoot, 'tools/swarm');

/** Combined tools/swarm.mjs source plus every tools/swarm/*.mjs module (post-split). */
export async function readSwarmSource() {
  const chunks = [await fs.readFile(entryPath, 'utf8')];
  let moduleNames = [];
  try {
    moduleNames = fsSync
      .readdirSync(modulesDir)
      .filter(name => name.endsWith('.mjs'))
      .sort();
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  for (const name of moduleNames) {
    const rel = `tools/swarm/${name}`;
    const body = await fs.readFile(path.join(modulesDir, name), 'utf8');
    chunks.push(`// ${rel}\n${body}`);
  }
  return chunks.join('\n');
}
