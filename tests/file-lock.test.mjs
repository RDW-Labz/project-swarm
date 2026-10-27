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

// Lock records are built at run time so no literal secret-looking values appear in this file.
const fakeId = ch => ch.repeat(32);
const DEAD_PID = 2_147_483_000;
const lockRecord = (extra = {}) => `${JSON.stringify({
  pid: process.pid,
  token: fakeId('c'),
  startedAt: new Date().toISOString(),
  ...extra,
})}\n`;

const breakRaceWorker = `
import fs from 'node:fs/promises';
import path from 'node:path';
import { withFileLock } from ${JSON.stringify(fileLockModule)};

const [dir, lockName, markerName, startAt] = process.argv.slice(1);
const wait = Number(startAt) - Date.now();
if (wait > 0) await new Promise(r => setTimeout(r, wait));
await withFileLock(path.join(dir, lockName), async () => {
  let marker;
  try {
    marker = await fs.open(path.join(dir, markerName), 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') process.exit(3);
    throw e;
  }
  await marker.close();
  await new Promise(r => setTimeout(r, 30));
  await fs.unlink(path.join(dir, markerName));
}, { waitMs: 30000, pollMs: 2 });
`;

test('two processes breaking the same stale lock never end with two holders (25 loops)', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const children = [];
  t.after(() => {
    for (const child of children) killProcessGroup(child);
  });

  for (let i = 0; i < 25; i += 1) {
    const lockName = `race-${i}.lock`;
    await fs.writeFile(path.join(root, lockName), lockRecord({ pid: DEAD_PID }), 'utf8');
    const startAt = String(Date.now() + 250);
    const exits = [0, 1].map(() => {
      const child = spawnNodeInGroup([
        '--input-type=module', '-e', breakRaceWorker, '--', root, lockName, `marker-${i}`, startAt,
      ]);
      children.push(child);
      child.stdout.on('data', () => {});
      child.stderr.on('data', () => {});
      return new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code, signal) => resolve({ code, signal }));
      });
    });
    const results = await Promise.all(exits);
    for (const r of results) assert.deepEqual(r, { code: 0, signal: null }, `loop ${i}`);
  }
});

test('a live breaker holding the .break lock blocks breaking until that lock is stale', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'brk.lock');
  const breakPath = `${lockPath}.break`;
  const stale = lockRecord({ pid: DEAD_PID });
  await fs.writeFile(lockPath, stale, 'utf8');
  await fs.writeFile(breakPath, lockRecord({ token: fakeId('d') }), 'utf8');

  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 100, pollMs: 5 }),
    err => err.code === 'file-lock-timeout',
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), stale);

  await setLockMtimeMs(breakPath, Date.now() - 60_000);
  const release = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 5 });
  assert.equal(JSON.parse(await fs.readFile(lockPath, 'utf8')).pid, process.pid);
  await release();
  await assert.rejects(fs.stat(breakPath), err => err.code === 'ENOENT');
});

test('break re-checks inside the break lock: a fresh lock swapped in meanwhile is not removed', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'swap.lock');
  await fs.writeFile(lockPath, lockRecord({ pid: DEAD_PID }), 'utf8');
  const fresh = lockRecord({ token: fakeId('e') });
  let swapped = 0;

  await assert.rejects(
    acquireFileLock(lockPath, {
      waitMs: 100,
      pollMs: 5,
      hooks: {
        async onBreakLocked() {
          if (swapped++) return;
          await fs.unlink(lockPath);
          await fs.writeFile(lockPath, fresh, 'utf8');
        },
      },
    }),
    err => err.code === 'file-lock-timeout',
  );
  assert.equal(swapped >= 1, true);
  assert.equal(await fs.readFile(lockPath, 'utf8'), fresh);
});

test('live holder is not broken after a wall-clock jump while its heartbeat runs', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'hb.lock');
  // heartbeat every 100ms; waiter polls are >= 150ms apart so each poll sees a fresh mtime
  const release = await acquireFileLock(lockPath, { maxHoldMs: 400 });
  t.after(() => release());
  const jumped = () => Date.now() + 10 * 365 * 24 * 3600 * 1000;

  const before = await fs.readFile(lockPath, 'utf8');
  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 1000, pollMs: 150, maxHoldMs: 400, now: jumped }),
    err => err.code === 'file-lock-timeout',
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), before);
});

test('live owner pid is never broken on startedAt age alone', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'age.lock');
  const body = lockRecord({ startedAt: new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString() });
  await fs.writeFile(lockPath, body, 'utf8');

  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 150, pollMs: 5, maxHoldMs: 60_000 }),
    err => err.code === 'file-lock-timeout',
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), body);
});

test('a lock whose live holder stopped heartbeating becomes stale after maxHoldMs', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'nohb.lock');
  await fs.writeFile(lockPath, lockRecord(), 'utf8');
  await setLockMtimeMs(lockPath, Date.now() - 120_000);

  const release = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 5, maxHoldMs: 400 });
  const body = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.notEqual(body.token, fakeId('c'));
  await release();
});

test('stale needs the lock unchanged for two heartbeat intervals of monotonic time', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'sleep.lock');
  await fs.writeFile(lockPath, lockRecord(), 'utf8');
  await setLockMtimeMs(lockPath, Date.now() - 120_000);

  // maxHoldMs 2000 => heartbeat interval 500ms => at least 1000ms unchanged before breaking
  const started = process.hrtime.bigint();
  const release = await acquireFileLock(lockPath, { waitMs: 10_000, pollMs: 5, maxHoldMs: 2000 });
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(elapsedMs >= 950, `broke after only ${elapsedMs}ms`);
  await release();
});

test('a holder running in another time zone is not mistaken for a dead process', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'tz.lock');
  // pick a zone that differs from the parent's so the test is not vacuous on a UTC machine
  const holderTz = new Date().getTimezoneOffset() === 0 ? 'Asia/Tokyo' : 'UTC';

  const holder = spawnNodeInGroup([
    '--input-type=module',
    '-e',
    `
import { acquireFileLock } from ${JSON.stringify(fileLockModule)};
await acquireFileLock(${JSON.stringify(lockPath)}, { waitMs: 30000 });
setInterval(() => {}, 500);
`,
  ], { env: { ...process.env, TZ: holderTz } });
  t.after(() => killProcessGroup(holder));
  holder.stdout.on('data', () => {});
  holder.stderr.on('data', () => {});

  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const tick = () => {
      fs.readFile(lockPath, 'utf8')
        .then(text => (text.trim() ? resolve() : Promise.reject(new Error('empty'))))
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
    acquireFileLock(lockPath, { waitMs: 300, pollMs: 20 }),
    err => err.code === 'file-lock-timeout',
  );
  assert.equal(await fs.readFile(lockPath, 'utf8'), before);
});

test('an owner whose recorded process start time differs is treated as dead', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const probe = path.join(root, 'probe.lock');
  const releaseProbe = await acquireFileLock(probe);
  const probeBody = JSON.parse(await fs.readFile(probe, 'utf8'));
  await releaseProbe();
  if (!probeBody.ownerStartedAt) {
    t.skip('platform does not expose process start time');
    return;
  }

  const lockPath = path.join(root, 'reuse.lock');
  await fs.writeFile(lockPath, lockRecord({ ownerStartedAt: 'Thu Jan  1 00:00:00 1970' }), 'utf8');
  const release = await acquireFileLock(lockPath, { waitMs: 5000, pollMs: 5, maxHoldMs: 600_000 });
  await release();
});

test('nested acquire of the same lock from inside withFileLock throws file-lock-reentrant', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'nest.lock');
  await withFileLock(lockPath, async () => {
    await assert.rejects(
      withFileLock(lockPath, () => {}, { waitMs: 30_000 }),
      err => err.code === 'file-lock-reentrant',
    );
    await assert.rejects(
      acquireFileLock(lockPath, { waitMs: 30_000 }),
      err => err.code === 'file-lock-reentrant',
    );
  });
  const release = await acquireFileLock(lockPath);
  await release();
});

test('in-process queue respects waitMs and keeps later waiters chained', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'queue.lock');
  const releaseFirst = await acquireFileLock(lockPath);

  const started = Date.now();
  await assert.rejects(
    acquireFileLock(lockPath, { waitMs: 60 }),
    err => err.code === 'file-lock-timeout',
  );
  assert.ok(Date.now() - started < 5000);

  let third = false;
  const thirdAcquire = acquireFileLock(lockPath, { waitMs: 10_000 }).then(rel => {
    third = true;
    return rel;
  });
  await new Promise(r => setTimeout(r, 30));
  assert.equal(third, false, 'must still wait for the first holder');
  await releaseFirst();
  const releaseThird = await thirdAcquire;
  await releaseThird();
});

test('filesystem without hard links gives file-lock-unsupported-fs naming the folder', { timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const lockPath = path.join(root, 'nolink.lock');
  for (const code of ['EPERM', 'ENOTSUP']) {
    await assert.rejects(
      acquireFileLock(lockPath, {
        link: async () => { throw Object.assign(new Error('link failed'), { code }); },
      }),
      err => {
        assert.equal(err.code, 'file-lock-unsupported-fs');
        assert.ok(err.message.includes(root));
        return true;
      },
    );
  }
  const left = (await fs.readdir(root)).filter(n => n.endsWith('.tmp') || n.endsWith('.lock'));
  assert.deepEqual(left, []);
  const release = await acquireFileLock(lockPath);
  await release();
});

test('symlinked parent directory is refused',{ timeout: 60_000 }, async t => {
  const root = await tmpDir(t);
  const realDir = path.join(root, 'real');
  const linkDir = path.join(root, 'link');
  await fs.mkdir(realDir, { recursive: true });
  await fs.symlink(realDir, linkDir);
  const lockPath = path.join(linkDir, 'nested', 'x.lock');

  await assert.rejects(acquireFileLock(lockPath), err => err.code === 'file-lock-refused');
});
