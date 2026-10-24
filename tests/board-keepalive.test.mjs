// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  loadOrCreateBoardIdentity,
  boardIdentityPath,
  DEFAULT_KEEPUP_PORT,
} from '../tools/board-keepalive.mjs';

const UID = 502;

function makeMemFs(seed = {}) {
  const files = new Map(Object.entries(seed));
  const dirs = new Set();
  return {
    files,
    async mkdir(dir, { mode } = {}) {
      dirs.add(dir);
      if (mode != null) dirs.add(`${dir}\0${mode}`);
    },
    async lstat(file) {
      const entry = files.get(file);
      if (!entry) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return {
        isSymbolicLink: () => Boolean(entry.symlink),
        isFile: () => !entry.symlink,
      };
    },
    async stat(file) {
      const entry = files.get(file);
      if (!entry) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return {
        mode: entry.mode ?? 0o100600,
        uid: entry.uid ?? UID,
        isFile: () => !entry.symlink,
      };
    },
    async readFile(file) {
      const entry = files.get(file);
      if (!entry || entry.symlink) {
        const err = new Error('ENOENT');
        err.code = 'ENOENT';
        throw err;
      }
      return entry.content;
    },
    async writeFile(file, content, { mode, flag } = {}) {
      if (flag === 'wx' && files.has(file)) {
        const err = new Error('EEXIST');
        err.code = 'EEXIST';
        throw err;
      }
      files.set(file, { content, mode: (mode ?? 0o600) | 0o100000, uid: UID });
    },
    async rename(from, to) {
      const entry = files.get(from);
      if (!entry) throw new Error(`rename missing ${from}`);
      files.delete(from);
      files.set(to, entry);
    },
    async rm(file) {
      files.delete(file);
    },
  };
}

function deps(over = {}) {
  const dir = over.dir ?? '/cfg/.project-swarm';
  const fs = over.fs ?? makeMemFs();
  let rand = 0;
  const randomBytes = over.randomBytes ?? (n => Buffer.from(Array.from({ length: n }, () => (rand++ * 17) % 256)));
  const warnings = [];
  const busy = new Set(over.busyPorts ?? []);
  const isPortFree = over.isPortFree ?? (async port => !busy.has(port));
  return {
    dir,
    fs,
    randomBytes,
    warn: msg => warnings.push(msg),
    uid: UID,
    isPortFree,
    warnings,
    identityFile: boardIdentityPath(dir),
  };
}

test('first run creates identity with default port', async () => {
  const d = deps();
  const first = await loadOrCreateBoardIdentity(d);
  assert.equal(first.port, DEFAULT_KEEPUP_PORT);
  assert.match(first.token, /^[0-9a-f]{48}$/);
  assert.ok(d.fs.files.has(d.identityFile));
  const onDisk = JSON.parse(d.fs.files.get(d.identityFile).content);
  assert.equal(onDisk.port, DEFAULT_KEEPUP_PORT);
  assert.equal(onDisk.token, first.token);
});

test('second run reuses the same token and port', async () => {
  const dir = '/cfg/.project-swarm';
  const file = boardIdentityPath(dir);
  const fs = makeMemFs({
    [file]: { content: '{"token":"a".repeat(48)}', mode: 0o100600, uid: UID },
  });
  fs.files.set(file, {
    content: `{"token":"${'a'.repeat(48)}","port":51058}\n`,
    mode: 0o100600,
    uid: UID,
  });
  const d = deps({ dir, fs, busyPorts: [] });
  const again = await loadOrCreateBoardIdentity(d);
  assert.equal(again.port, 51058);
  assert.equal(again.token, 'a'.repeat(48));
  assert.equal(d.warnings.length, 0);
});

test('corrupt identity file is replaced with a warning', async () => {
  const d = deps();
  d.fs.files.set(d.identityFile, { content: '{not-json', mode: 0o100600, uid: UID });
  const out = await loadOrCreateBoardIdentity(d);
  assert.ok(d.warnings.some(w => /corrupt|invalid/i.test(w)));
  const saved = JSON.parse(d.fs.files.get(d.identityFile).content);
  assert.equal(saved.token, out.token);
  assert.notEqual(saved.token, 'a'.repeat(48));
});

test('unsafe file mode is replaced with a warning', async () => {
  const d = deps();
  d.fs.files.set(d.identityFile, {
    content: `{"token":"${'b'.repeat(48)}","port":51058}\n`,
    mode: 0o100644,
    uid: UID,
  });
  const out = await loadOrCreateBoardIdentity(d);
  assert.ok(d.warnings.some(w => /mode/i.test(w)));
  assert.notEqual(out.token, 'b'.repeat(48));
});

test('symlink identity is refused and replaced', async () => {
  const d = deps();
  d.fs.files.set(d.identityFile, {
    content: `{"token":"${'c'.repeat(48)}","port":51058}\n`,
    mode: 0o100600,
    uid: UID,
    symlink: true,
  });
  const out = await loadOrCreateBoardIdentity(d);
  assert.ok(d.warnings.some(w => /symlink/i.test(w)));
  assert.notEqual(out.token, 'c'.repeat(48));
  assert.equal(d.fs.files.get(d.identityFile).symlink, undefined);
});

test('saved port busy fails without picking another port', async () => {
  const d = deps({ busyPorts: [51058] });
  d.fs.files.set(d.identityFile, {
    content: `{"token":"${'d'.repeat(48)}","port":51058}\n`,
    mode: 0o100600,
    uid: UID,
  });
  await assert.rejects(
    () => loadOrCreateBoardIdentity(d),
    err => err.code === 'board-port-busy' && /51058/.test(err.message) && /saved/i.test(err.message),
  );
});

test('identity file is never created world-readable', async () => {
  const d = deps();
  await loadOrCreateBoardIdentity(d);
  const entry = d.fs.files.get(d.identityFile);
  assert.equal(entry.mode & 0o777, 0o600);
  const tmp = [...d.fs.files.keys()].find(f => f.includes('.tmp'));
  if (tmp) assert.equal(d.fs.files.get(tmp).mode & 0o777, 0o600);
});
