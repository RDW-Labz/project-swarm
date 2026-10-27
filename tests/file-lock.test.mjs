// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { acquireFileLock, withFileLock } from '../tools/file-lock.mjs';

const fileLockModule = fileURLToPath(new URL('../tools/file-lock.mjs', import.meta.url));
const testTmpBase = process.env.SWARM_TEST_TMP || process.env.TMPDIR || os.tmpdir();

const tmpDir = async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(testTmpBase, 'file-lock-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
};

async function setLockMtimeMs(lockPath, mtimeMs) {
  const mtime = new Date(mtimeMs);
  await fs.utimes(lockPath, mtime, mtime);
}

function spawnNodeInGroup(args, options = {}) {
  const child = spawn(process.execPath, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
  });
  if (process.platform !== 'win32' && child.pid) {
    try {
      process.kill(-child.pid, 0);
    } catch {
      /* group may not exist yet */
    }
  }
  return child;
}

function killProcessGroup(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { timeout: 5000 });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  }
}

const incrementWorker = `
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from ${JSON.stringify(fileLockModule)};

const [dir, lockName, counterName, rounds] = process.argv.slice(1);
const lockPath = path.join(dir, lockName);
const counterPath = path.join(dir, counterName);
const n = Number(rounds);

for (let i = 0; i < n; i += 1) {
  await withFileLock(lockPath, async () => {
    let value = 0;
    try {
      value = Number(await fs.readFile(counterPath, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    await fs.writeFile(counterPath, String(value + 1), 'utf8');
  });
}
`;

test('six processes each increment 20 times without lost updates, three rounds', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'test.lock');
  const counterPath = path.join(root, 'counter');
  const workers = 6;
  const perWorker = 20;
  const rounds = 3;

  const children = [];
  t.after(() => {
    for (const child of children) killProcessGroup(child);
  });

  for (let round = 0; round < rounds; round += 1) {
    await fs.writeFile(counterPath, '0', 'utf8');
    children.length = 0;

    const exits = [];
    for (let w = 0; w < workers; w += 1) {
      const child = spawnNodeInGroup([
        '--input-type=module',
        '-e',
        incrementWorker,
        '--',
        root,
        'test.lock',
        'counter',
        String(perWorker),
      ]);
      children.push(child);
      exits.push(new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code, signal) => {
          if (code === 0 && !signal) resolve();
          else reject(new Error(`worker exited code=${code} signal=${signal}`));
        });
      }));
    }
    await Promise.all(exits);
    const final = Number(await fs.readFile(counterPath, 'utf8'));
    assert.equal(final, workers * perWorker, `round ${round + 1}`);
  }
});

test('ten concurrent withFileLock calls in one process never overlap', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'mutex.lock');
  let depth = 0;
  let maxDepth = 0;

  await Promise.all(
    Array.from({ length: 10 }, () => withFileLock(lockPath, async () => {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
      await new Promise(r => setTimeout(r, 5));
      depth -= 1;
    })),
  );
  assert.equal(maxDepth, 1);
});

test('stale lock from a dead pid is cleared and acquired', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'stale.lock');

  const holder = spawnNodeInGroup(
    ['--input-type=module', '-e', 'setInterval(() => {}, 1000)'],
    { cwd: root },
  );
  t.after(() => killProcessGroup(holder));

  await new Promise((resolve, reject) => {
    holder.on('error', reject);
    holder.stdout?.on('data', () => {});
    holder.stderr?.on('data', () => {});
    if (holder.pid) resolve();
    else holder.on('spawn', resolve);
  });
  const deadPid = holder.pid;
  assert.ok(deadPid > 0);

  killProcessGroup(holder);
  await new Promise(r => setTimeout(r, 100));

  await fs.writeFile(
    lockPath,
    `${JSON.stringify({ pid: deadPid, token: 'a'.repeat(32), startedAt: new Date().toISOString() })}\n`,
    'utf8',
  );

  const release = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 10 });
  const body = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.equal(body.pid, process.pid);
  await release();
});

test('empty lock file is busy within graceMs then cleared', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'empty.lock');
  await fs.writeFile(lockPath, '', 'utf8');

  const graceMs = 5000;
  const now = Date.now();
  await setLockMtimeMs(lockPath, now);

  const start = Date.now();
  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 80, graceMs, pollMs: 10 }),
    err => err.code === 'file-lock-timeout',
  );
  assert.ok(Date.now() - start < 500, 'busy refusal should hit waitMs, not graceMs');

  await setLockMtimeMs(lockPath, now - 60_000);
  const release = await acquireFileLock(lockPath, { waitMs: 5000, graceMs, pollMs: 10 });
  await release();
});

test('live holder is not stolen; short waitMs yields file-lock-timeout', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'live.lock');

  const holder = spawnNodeInGroup([
    '--input-type=module',
    '-e',
    `
import { acquireFileLock } from ${JSON.stringify(fileLockModule)};
const release = await acquireFileLock(${JSON.stringify(lockPath)}, { waitMs: 60000 });
setInterval(() => {}, 500);
process.on('SIGTERM', async () => { await release(); process.exit(0); });
process.on('SIGINT', async () => { await release(); process.exit(0); });
`,
  ]);
  t.after(() => killProcessGroup(holder));

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      fs.readFile(lockPath, 'utf8')
        .then(() => resolve())
        .catch(() => {
          if (Date.now() > deadline) reject(new Error('holder never took lock'));
          else setTimeout(tick, 25);
        });
    };
    holder.on('error', reject);
    tick();
  });

  const before = await fs.readFile(lockPath, 'utf8');
  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 150, pollMs: 20 }),
    err => {
      assert.equal(err.code, 'file-lock-timeout');
      assert.match(err.message, /pid/);
      return true;
    },
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), before);

  killProcessGroup(holder);
  await new Promise(r => setTimeout(r, 300));
  const release = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 20 });
  await release();
});

test('release by a non-owner does not remove the lock', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'owner.lock');

  const releaseA = await acquireFileLock(lockPath);
  const forged = `${JSON.stringify({ pid: 999_999, token: 'b'.repeat(32), startedAt: new Date().toISOString() })}\n`;
  await fs.writeFile(lockPath, forged, 'utf8');
  await releaseA();
  assert.equal(await fs.readFile(lockPath, 'utf8'), forged);
});

test('symlinked parent directory is refused', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const realDir = path.join(root, 'real');
  const linkDir = path.join(root, 'link');
  await fs.mkdir(realDir, { recursive: true });
  await fs.symlink(realDir, linkDir);
  const lockPath = path.join(linkDir, 'nested', 'x.lock');

  await assert.rejects(acquireFileLock(lockPath), err => err.code === 'file-lock-refused');
});
