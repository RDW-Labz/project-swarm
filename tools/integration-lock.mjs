// SPDX-License-Identifier: Apache-2.0
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { repoKey, liveDir as defaultLiveDir } from './board.mjs';

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

export async function acquireIntegrationLock(root, { runId, liveDir = defaultLiveDir(), isAlive = pidAlive, pid = process.pid, now = Date.now } = {}) {
  const key = crypto.createHash('sha256').update(await repoKey(root)).digest('hex').slice(0, 16);
  const locks = [path.join(liveDir, 'locks', `integrate-${key}`), path.join(root, '.swarm/integration.lock')];
  const held = [], warnings = [];
  const release = async () => {
    while (held.length) {
      const lock = held[held.length - 1];
      await fs.unlink(path.join(lock, 'owner.json')).catch(error => { if (error.code !== 'ENOENT') throw error; });
      await fs.rmdir(lock).catch(error => { if (error.code !== 'ENOENT') throw error; });
      held.pop();
    }
  };
  try {
    for (const lock of locks) {
      await fs.mkdir(path.dirname(lock), { recursive: true });
      for (let attempt = 0; ; attempt++) {
        try { await fs.mkdir(lock); }
        catch (error) {
          if (error.code !== 'EEXIST') throw error;
          const stat = await fs.lstat(lock);
          let owner;
          if (stat.isDirectory()) {
            try { owner = JSON.parse(await fs.readFile(path.join(lock, 'owner.json'), 'utf8')); } catch { /* ownerless creation window */ }
          }
          const valid = owner && typeof owner === 'object' && Number.isInteger(owner.pid) && owner.pid > 0 && typeof owner.host === 'string';
          const stale = stat.isDirectory() && (valid ? owner.host === os.hostname() && !isAlive(owner.pid) : now() - stat.mtimeMs > 60000);
          const field = name => owner?.[name] ?? 'unknown';
          if (stale && attempt === 0) {
            await fs.rm(lock, { recursive: true, force: true });
            warnings.push(`integrate-lock-stale-cleared: ${lock} (pid ${field('pid')}, run ${field('runId')}, started ${field('startedAt')})`);
            continue;
          }
          throw Object.assign(new Error(`integrate-locked: another integrate holds this repository (pid ${field('pid')}, run ${field('runId')}, root ${field('root')}, started ${field('startedAt')})`), { code: 'integrate-locked' });
        }
        held.push(lock);
        await fs.writeFile(path.join(lock, 'owner.json'), JSON.stringify({ pid, host: os.hostname(), runId, root, startedAt: new Date(now()).toISOString() }));
        break;
      }
    }
    return { release, warnings };
  } catch (error) { await release(); throw error; }
}
