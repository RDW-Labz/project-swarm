import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  acquireBaseCheckLock,
  withBaseCheckLock,
  BASE_CHECK_LOCK_REL,
} from '../tools/base-check-lock.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const lockModuleUrl = pathToFileURL(path.join(repoRoot, 'tools/base-check-lock.mjs')).href;
const isolateImport = path.join(repoRoot, 'tests/_isolate-config.mjs');

function lockPath(root) {
  return path.join(root, BASE_CHECK_LOCK_REL);
}

async function mkProjectRoot(t, prefix) {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function spawnModuleChild(script, envExtra = {}) {
  return spawn(
    process.execPath,
    ['--import', isolateImport, '--input-type=module', '-e', script],
    {
      cwd: repoRoot,
      env: { ...process.env, ...envExtra },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
}

function waitForLine(child, line, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`timeout waiting for ${JSON.stringify(line)}`));
    }, timeoutMs);
    const onData = chunk => {
      buf += chunk.toString();
      if (buf.includes(line)) {
        cleanup();
        resolve();
      }
    };
    const onExit = code => {
      cleanup();
      reject(new Error(`child exited ${code} before ${JSON.stringify(line)}`));
    };
    const cleanup = () => {
      clearTimeout(timer);
      child.stdout?.off('data', onData);
      child.off('exit', onExit);
    };
    child.stdout.on('data', onData);
    child.on('exit', onExit);
  });
}

test('BASE_CHECK_LOCK_REL and owner JSON shape with mode 0o600', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-shape-');
  const pid = 424242;
  const release = await acquireBaseCheckLock(root, { pid, now: () => 1_700_000_000_000 });
  t.after(async () => {
    await release().catch(() => {});
  });
  const file = lockPath(root);
  const owner = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(owner.pid, pid);
  assert.equal(typeof owner.host, 'string');
  assert.equal(owner.host, os.hostname());
  assert.equal(owner.startedAt, new Date(1_700_000_000_000).toISOString());
  const mode = (await fs.stat(file)).mode & 0o777;
  assert.equal(mode, 0o600);
  await release();
  await assert.rejects(fs.access(file), err => err.code === 'ENOENT');
});

test('acquireBaseCheckLock removes stale lock when owner pid is dead on this host', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-dead-');
  await fs.mkdir(path.dirname(lockPath(root)), { recursive: true });
  const staleOwner = { pid: 999_999, host: os.hostname(), startedAt: new Date().toISOString() };
  await fs.writeFile(lockPath(root), `${JSON.stringify(staleOwner)}\n`, { mode: 0o600 });
  const release = await acquireBaseCheckLock(root, {
    pid: process.pid,
    isAlive: () => false,
  });
  await release();
});

test('acquireBaseCheckLock removes unreadable owner as stale', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-empty-');
  await fs.mkdir(path.dirname(lockPath(root)), { recursive: true });
  await fs.writeFile(lockPath(root), '', { mode: 0o600 });
  const release = await acquireBaseCheckLock(root, { pid: 111 });
  const owner = JSON.parse(await fs.readFile(lockPath(root), 'utf8'));
  assert.equal(owner.pid, 111);
  await release();
});

test('acquireBaseCheckLock treats mtime older than 60s as stale', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-mtime-');
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const liveOwner = { pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify(liveOwner)}\n`, { mode: 0o600 });
  const old = Date.now() - 61_000;
  await fs.utimes(file, old / 1000, old / 1000);
  const release = await acquireBaseCheckLock(root, { pid: 222, isAlive: () => true });
  const owner = JSON.parse(await fs.readFile(file, 'utf8'));
  assert.equal(owner.pid, 222);
  await release();
});

test('acquireBaseCheckLock waitMs throws base-check-locked with message', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-busy-');
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const startedAt = '2026-04-01T12:00:00.000Z';
  const busyOwner = { pid: 7777, host: os.hostname(), startedAt };
  await fs.writeFile(file, `${JSON.stringify(busyOwner)}\n`, { mode: 0o600 });
  let tick = 0;
  const t0 = 1_000_000;
  await assert.rejects(
    acquireBaseCheckLock(root, {
      waitMs: 50,
      isAlive: () => true,
      now: () => t0 + tick++ * 30,
      sleep: async () => {},
    }),
    err => {
      assert.equal(err.code, 'base-check-locked');
      assert.match(
        err.message,
        /^base-check-locked: another base check is running in this checkout \(pid 7777, started 2026-04-01T12:00:00.000Z\)$/,
      );
      return true;
    },
  );
});

test('acquireBaseCheckLock polls with injectable sleep until lock frees', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-poll-');
  const file = lockPath(root);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const holder = { pid: 8888, host: os.hostname(), startedAt: new Date().toISOString() };
  await fs.writeFile(file, `${JSON.stringify(holder)}\n`, { mode: 0o600 });
  let sleeps = 0;
  let alive = true;
  const acquirePromise = acquireBaseCheckLock(root, {
    pid: 333,
    waitMs: 5000,
    isAlive: pid => pid !== 8888 || alive,
    sleep: async ms => {
      sleeps += 1;
      if (sleeps === 2) {
        alive = false;
        await fs.rm(file, { force: true });
      }
      assert.ok(ms >= 40 && ms <= 250);
    },
  });
  const release = await acquirePromise;
  assert.ok(sleeps >= 2);
  await release();
});

test('withBaseCheckLock releases lock when callback throws', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-finally-');
  await assert.rejects(
    withBaseCheckLock(root, async () => {
      assert.ok(await fs.readFile(lockPath(root), 'utf8'));
      throw new Error('callback-fail');
    }),
    /callback-fail/,
  );
  await assert.rejects(fs.access(lockPath(root)), err => err.code === 'ENOENT');
});

test('withBaseCheckLock returns callback result and releases', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-return-');
  const value = await withBaseCheckLock(root, async () => 42);
  assert.equal(value, 42);
  await assert.rejects(fs.access(lockPath(root)), err => err.code === 'ENOENT');
});

test('SIGKILL mid-hold: next acquirer recovers stale dead owner', async t => {
  const root = await mkProjectRoot(t, 'p2-bcl-crash-');
  const script = `
import fs from 'node:fs/promises';
const root = process.env.TEST_ROOT;
const { acquireBaseCheckLock } = await import(${JSON.stringify(lockModuleUrl)});
const release = await acquireBaseCheckLock(root);
process.stdout.write('ready\\n');
await new Promise(() => {});
await release();
`;
  const child = spawnModuleChild(script, { TEST_ROOT: root });
  t.after(() => {
    try {
      child.kill('SIGKILL');
    } catch {
      /* gone */
    }
  });
  await waitForLine(child, 'ready\n');
  child.kill('SIGKILL');
  await new Promise(resolve => child.once('exit', resolve));
  const release = await acquireBaseCheckLock(root, { pid: 5555 });
  const owner = JSON.parse(await fs.readFile(lockPath(root), 'utf8'));
  assert.equal(owner.pid, 5555);
  await release();
});

test(
  'O_EXCL create before owner write: contender must not delete live lock (two holders today)',
  {
    todo:
      'Phase 2: tryTakeLock O_EXCL then write — empty owner read is stale and rm; fixed: publish owner atomically or never treat in-flight create as stale',
  },
  async t => {
    const root = await mkProjectRoot(t, 'p2-bcl-race-');
    const file = lockPath(root);
    await fs.mkdir(path.dirname(file), { recursive: true });
    const proceed = path.join(root, '.swarm', 'project', 'proceed-gap');
    await fs.mkdir(path.dirname(proceed), { recursive: true });
    const holderScript = `
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
const file = process.env.LOCK_FILE;
const proceed = process.env.PROCEED_FILE;
const handle = await fs.open(
  file,
  constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
  0o600,
);
process.stdout.write('opened\\n');
for (;;) {
  try {
    if ((await fs.readFile(proceed, 'utf8')).includes('go')) break;
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  await new Promise(r => setImmediate(r));
}
await handle.writeFile(JSON.stringify({ pid: process.pid, host: os.hostname(), startedAt: new Date().toISOString() }) + '\\n');
await handle.close();
process.stdout.write('written\\n');
await new Promise(() => {});
`;
    const holder = spawnModuleChild(holderScript, {
      TEST_ROOT: root,
      LOCK_FILE: file,
      PROCEED_FILE: proceed,
    });
    t.after(() => {
      try {
        holder.kill('SIGKILL');
      } catch {
        /* gone */
      }
    });
    await waitForLine(holder, 'opened\n');
    const contenderScript = `
const root = process.env.TEST_ROOT;
const { acquireBaseCheckLock } = await import(${JSON.stringify(lockModuleUrl)});
const release = await acquireBaseCheckLock(root, { waitMs: 5000 });
process.stdout.write('contender\\n');
await new Promise(() => {});
await release();
`;
    const contender = spawnModuleChild(contenderScript, { TEST_ROOT: root });
    t.after(() => {
      try {
        contender.kill('SIGKILL');
      } catch {
        /* gone */
      }
    });
    await waitForLine(contender, 'contender\n');
    await fs.writeFile(proceed, 'go\n');
    await waitForLine(holder, 'written\n');
    const raw = await fs.readFile(file, 'utf8');
    const owner = JSON.parse(raw);
    assert.equal(owner.pid, contender.pid);
    assert.notEqual(owner.pid, holder.pid);
    assert.ok(holder.exitCode === null, 'holder still running while contender owns lock path (two holders today)');
  },
);
