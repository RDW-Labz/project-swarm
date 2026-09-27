// SPDX-License-Identifier: Apache-2.0
// Field lesson #141: two checks in different worktrees started a dev server on the same fixed
// port at the same time; one side failed on "port in use" and looked like a real test failure.
// Every worktree gets its own stable block of 10 ports, derived from its own path.
import { realpathSync } from 'node:fs';
import net from 'node:net';

const BLOCK_MIN = 20000;
const BLOCK_MAX = 27990;
const BLOCK_STEP = 10;
const HASH_MOD = 790;
// 24678 is Vite's default HMR port; the block containing it is never handed out.
const BUSY_BLOCK = 24670;
const MAX_TRIES = 50;

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function portBlockFor(root) {
  let resolved;
  try { resolved = realpathSync(root); } catch { resolved = root; }
  const base = BLOCK_MIN + (fnv1a(resolved) % HASH_MOD) * BLOCK_STEP;
  return base === BUSY_BLOCK ? base + BLOCK_STEP : base;
}

function nextBlock(base) {
  const next = base + BLOCK_STEP > BLOCK_MAX ? BLOCK_MIN : base + BLOCK_STEP;
  return next === BUSY_BLOCK ? next + BLOCK_STEP : next;
}

export async function isPortFree(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

export async function resolvePortBlock(root, { isFree = isPortFree } = {}) {
  const original = portBlockFor(root);
  let base = original;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    if (await isFree(base)) return { base, moved: attempt > 0 };
    base = nextBlock(base);
  }
  return { base: original, moved: true };
}
