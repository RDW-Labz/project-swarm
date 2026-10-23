// SPDX-License-Identifier: Apache-2.0
// Stable per-machine node id for cluster lease holders (S9). Stored locally only; no registry or network.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const NODE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function nodeSelfFile(env = process.env, home = env.HOME || os.homedir()) {
  if (env.SWARM_NODE_SELF_FILE) return env.SWARM_NODE_SELF_FILE;
  const install = env.SWARM_HOME || path.join(home, '.project-swarm');
  return path.join(install, 'nodes', 'self');
}

export function parseNodeId(text) {
  const id = String(text).trim();
  return NODE_ID_RE.test(id) ? id : null;
}

async function readStoredNodeId(file) {
  try {
    return parseNodeId(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function writeNewNodeId(file, id) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const handle = await fs.open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${id}\n`);
  } finally {
    await handle.close();
  }
}

/** Read the local node id, creating and persisting one on first use. */
export async function getNodeId({ env = process.env, home = env.HOME || os.homedir() } = {}) {
  const file = nodeSelfFile(env, home);
  const existing = await readStoredNodeId(file);
  if (existing) return existing;

  const id = randomUUID();
  try {
    await writeNewNodeId(file, id);
    return id;
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const raced = await readStoredNodeId(file);
    if (raced) return raced;
    throw Object.assign(new Error('node-self-invalid: ~/.project-swarm/nodes/self exists but is not a valid node id'), { code: 'node-self-invalid' });
  }
}
