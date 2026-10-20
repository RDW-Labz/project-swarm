// SPDX-License-Identifier: Apache-2.0
// A long-running server (the board, swarm remote) keeps the code it started with: after `swarm update` it is still the old version until it is restarted. This reads the version this
// process runs and the version now installed, so the page can say so instead of quietly serving old behaviour. Read-only; a development checkout has no install to compare with.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OWN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let running = null;
let cached = null;

export async function versionInfo({ ownRoot = OWN_ROOT, now = Date.now, ttlMs = 5000 } = {}) {
  if (ownRoot === OWN_ROOT && cached && now() - cached.at < ttlMs) return cached.value;
  const read = async dir => { try { return JSON.parse(await fs.readFile(path.join(dir, 'package.json'), 'utf8')).version ?? null; } catch { return null; } };
  if (ownRoot === OWN_ROOT) running ??= await read(ownRoot);
  const runningVersion = ownRoot === OWN_ROOT ? running : await read(ownRoot);
  // An install keeps each version in <install>/versions/<version>-<hash> and points <install>/current at the newest.
  let installed = null;
  if (path.basename(path.dirname(ownRoot)) === 'versions') installed = await read(path.join(path.dirname(path.dirname(ownRoot)), 'current'));
  const value = { version: runningVersion, installedVersion: installed, stale: Boolean(runningVersion && installed && runningVersion !== installed) };
  if (ownRoot === OWN_ROOT) cached = { at: now(), value };
  return value;
}
