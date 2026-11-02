import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, symlink, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeNoFollow } from '../src/no-symlink-write.mjs';

async function withDir(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'wnf-'));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('writes a new file with the given text', () => withDir(async (root) => {
  await writeNoFollow(root, 'plan.json', 'hello');
  assert.equal(await readFile(path.join(root, 'plan.json'), 'utf8'), 'hello');
}));

test('replaces an existing regular file', () => withDir(async (root) => {
  await writeFile(path.join(root, 'plan.json'), 'old', 'utf8');
  await writeNoFollow(root, 'plan.json', 'new');
  assert.equal(await readFile(path.join(root, 'plan.json'), 'utf8'), 'new');
}));

test('writes empty text as an empty file', () => withDir(async (root) => {
  await writeNoFollow(root, 'empty.txt', '');
  assert.equal(await readFile(path.join(root, 'empty.txt'), 'utf8'), '');
}));

test('keeps multi-byte text intact', () => withDir(async (root) => {
  const text = 'na\u00efve \u2713 \u65e5\u672c';
  await writeNoFollow(root, 'u.txt', text);
  assert.equal(await readFile(path.join(root, 'u.txt'), 'utf8'), text);
}));

test('leaves only the target in the folder after success', () => withDir(async (root) => {
  await writeNoFollow(root, 'a.txt', 'a');
  assert.deepEqual((await readdir(root)).sort(), ['a.txt']);
}));

test('rejects when the target is a symlink, with code symlink', () => withDir(async (root) => {
  await writeFile(path.join(root, 'real.txt'), 'original', 'utf8');
  await symlink('real.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
}));

test('leaves the symlink target untouched', () => withDir(async (root) => {
  await writeFile(path.join(root, 'real.txt'), 'original', 'utf8');
  await symlink('real.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
  assert.equal(await readFile(path.join(root, 'real.txt'), 'utf8'), 'original');
}));

test('keeps the symlink itself after a rejected write', () => withDir(async (root) => {
  await writeFile(path.join(root, 'real.txt'), 'original', 'utf8');
  await symlink('real.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
  assert.equal((await lstat(path.join(root, 'out.txt'))).isSymbolicLink(), true);
}));

test('rejects a dangling symlink with code symlink', () => withDir(async (root) => {
  await symlink('ghost.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
}));

test('does not create the target of a dangling symlink', () => withDir(async (root) => {
  await symlink('ghost.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
  await assert.rejects(lstat(path.join(root, 'ghost.txt')), { code: 'ENOENT' });
}));

test('leaves no temp files after a rejected write', () => withDir(async (root) => {
  await writeFile(path.join(root, 'real.txt'), 'original', 'utf8');
  await symlink('real.txt', path.join(root, 'out.txt'));
  await assert.rejects(writeNoFollow(root, 'out.txt', 'new'), { code: 'symlink' });
  assert.deepEqual((await readdir(root)).sort(), ['out.txt', 'real.txt']);
}));
