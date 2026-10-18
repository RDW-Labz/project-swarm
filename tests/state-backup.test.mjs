import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import * as sb from '../tools/state-backup.mjs';

async function tmpRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'sb-test-'));
}

async function put(root, rel, text) {
  const p = path.join(root, ...rel.split('/'));
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, text);
}

async function get(root, rel) {
  return fs.readFile(path.join(root, ...rel.split('/')), 'utf8');
}

const clock = (i) => () => Date.UTC(2024, 0, 1, 0, 0, i);

async function manifestOf(root, id) {
  return JSON.parse(await get(root, `${sb.BACKUP_DIR}/${id}/manifest.json`));
}

test('secrets and app code are never copied', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/plan.md', 'plan');
  await put(root, '.swarm/project/.env.local', 'X=1');
  await put(root, '.swarm/project/api-key.txt', 'k');
  await put(root, '.project-swarm.json', '{}');
  await put(root, 'src/app.js', 'code');
  const r = await sb.createBackup(root, { reason: 't', now: clock(1) });
  const paths = (await manifestOf(root, r.id)).files.map((f) => f.path);
  assert.ok(paths.includes('.swarm/project/plan.md'));
  assert.ok(paths.includes('.project-swarm.json'));
  assert.equal(paths.includes('.swarm/project/.env.local'), false);
  assert.equal(paths.includes('.swarm/project/api-key.txt'), false);
  assert.equal(paths.includes('src/app.js'), false);
  assert.equal(paths.some((p) => sb.isSecretPath(p)), false);
});

test('isSecretPath flags env and secret-like names', () => {
  assert.equal(sb.isSecretPath('a/.env'), true);
  assert.equal(sb.isSecretPath('a/.env.production'), true);
  assert.equal(sb.isSecretPath('gpu-session.json'), true);
  assert.equal(sb.isSecretPath('keys/server.pem'), true);
  assert.equal(sb.isSecretPath('.swarm/project/plan.md'), false);
});

test('symlinks are skipped', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/real.md', 'real');
  await fs.symlink(path.join(root, '.swarm/project/real.md'), path.join(root, '.swarm/project/link.md'));
  const r = await sb.createBackup(root, { reason: 't', now: clock(2) });
  const paths = (await manifestOf(root, r.id)).files.map((f) => f.path);
  assert.ok(paths.includes('.swarm/project/real.md'));
  assert.equal(paths.includes('.swarm/project/link.md'), false);
});

test('bad ids are refused', async () => {
  const root = await tmpRoot();
  for (const bad of ['../x', '', '20240101-000000-ABCD', '20240101-000000-abc', 'x/../../y']) {
    await assert.rejects(sb.restoreBackup(root, bad, { yes: true }), { code: 'bad-id' });
    await assert.rejects(sb.verifyBackup(root, bad), { code: 'bad-id' });
  }
});

test('retention keeps only the newest backups', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/plan.md', 'plan');
  for (let i = 1; i <= 3; i++) {
    await sb.createBackup(root, { reason: 'r', now: clock(i), keep: 2 });
  }
  const list = await sb.listBackups(root);
  assert.equal(list.length, 2);
  assert.equal(list[0].at, '2024-01-01T00:00:03.000Z');
  assert.equal(list[1].at, '2024-01-01T00:00:02.000Z');
});

test('verify detects a changed file', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/plan.md', 'plan');
  const r = await sb.createBackup(root, { reason: 't', now: clock(4) });
  assert.equal((await sb.verifyBackup(root, r.id)).ok, true);
  await put(root, `${sb.BACKUP_DIR}/${r.id}/files/.swarm/project/plan.md`, 'tampered!');
  const v = await sb.verifyBackup(root, r.id);
  assert.equal(v.ok, false);
  assert.ok(v.problems.length > 0);
});

test('restore without yes only plans', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/plan.md', 'v1');
  const r = await sb.createBackup(root, { reason: 't', now: clock(5) });
  await put(root, '.swarm/project/plan.md', 'v2');
  const res = await sb.restoreBackup(root, r.id);
  assert.equal(res.planned, true);
  assert.equal(res.preRestore, null);
  assert.ok(res.restored.includes('.swarm/project/plan.md'));
  assert.equal(await get(root, '.swarm/project/plan.md'), 'v2');
});

test('restore takes a pre-restore backup and can be undone', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/plan.md', 'v1');
  const r = await sb.createBackup(root, { reason: 't', now: clock(6) });
  await put(root, '.swarm/project/plan.md', 'v2');
  const res = await sb.restoreBackup(root, r.id, { yes: true, now: clock(7) });
  assert.equal(res.planned, false);
  assert.equal(typeof res.preRestore, 'string');
  assert.notEqual(res.preRestore, r.id);
  assert.equal(await get(root, '.swarm/project/plan.md'), 'v1');
  const pre = await manifestOf(root, res.preRestore);
  assert.equal(pre.reason, 'pre-restore');
  await sb.restoreBackup(root, res.preRestore, { yes: true, now: clock(8) });
  assert.equal(await get(root, '.swarm/project/plan.md'), 'v2');
});

test('unsafe manifest paths are refused', async () => {
  const root = await tmpRoot();
  const id = '20240101-000000-abcd';
  const data = 'x';
  await put(root, `${sb.BACKUP_DIR}/${id}/files/placeholder.txt`, data);
  const manifest = {
    version: 1,
    id,
    at: '2024-01-01T00:00:00.000Z',
    reason: 'hostile',
    files: [{ path: '../escape.txt', sha256: createHash('sha256').update(data).digest('hex'), bytes: data.length }],
  };
  await put(root, `${sb.BACKUP_DIR}/${id}/manifest.json`, JSON.stringify(manifest));
  await assert.rejects(
    sb.restoreBackup(root, id, { yes: true }),
    (e) => e.code === 'unsafe-path' || e.code === 'backup-corrupt',
  );
  await assert.rejects(sb.restoreBackup(root, id), { code: 'unsafe-path' });
});

test('review findings: secret names are matched case-insensitively and widely', () => {
  for (const name of ['.swarm/project/Private_Key.json', '.swarm/project/ID_RSA', '.swarm/project/.ENV', '.swarm/project/ssh-key', '.swarm/project/access-key.json', '.swarm/project/password.txt', '.swarm/project/.npmrc', '.swarm/project/cert.P12', '.swarm/project/keys/a.json']) {
    assert.equal(sb.isSecretPath(name), true, name);
  }
  for (const name of ['.swarm/project/tickets.json', '.swarm/project/tickets.log', '.project-swarm.json', '.swarm/project/monkey.json']) {
    assert.equal(sb.isSecretPath(name), false, name);
  }
});

test('review findings: restoring the oldest backup survives the pre-restore prune', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/tickets.json', 'v1');
  const first = await sb.createBackup(root, { reason: 'one', now: clock(1), keep: 2 });
  await put(root, '.swarm/project/tickets.json', 'v2');
  await sb.createBackup(root, { reason: 'two', now: clock(2), keep: 2 });
  const res = await sb.restoreBackup(root, first.id, { yes: true, now: clock(3) });
  assert.equal(await get(root, '.swarm/project/tickets.json'), 'v1');
  const ids = (await sb.listBackups(root)).map((b) => b.id);
  assert.ok(ids.includes(first.id), 'the backup that was restored is still there');
  assert.ok(ids.includes(res.preRestore));
});

test('review findings: a planted backup cannot restore a path outside swarm state', async () => {
  const root = await tmpRoot();
  await put(root, '.swarm/project/tickets.json', 'v1');
  const made = await sb.createBackup(root, { reason: 'x', now: clock(1) });
  const file = path.join(root, sb.BACKUP_DIR, made.id, 'manifest.json');
  const m = JSON.parse(await fs.readFile(file, 'utf8'));
  const evil = Buffer.from('evil');
  m.files = [{ path: 'tools/evil.mjs', sha256: createHash('sha256').update(evil).digest('hex'), bytes: evil.length }];
  await fs.writeFile(file, JSON.stringify(m));
  await put(root, `${sb.BACKUP_DIR}/${made.id}/files/tools/evil.mjs`, 'evil');
  await assert.rejects(() => sb.restoreBackup(root, made.id, { yes: true }), (e) => e.code === 'unsafe-path');
  await assert.rejects(() => sb.restoreBackup(root, made.id), (e) => e.code === 'unsafe-path', 'also the plan refuses');
  await assert.rejects(fs.stat(path.join(root, 'tools/evil.mjs')));
});

test('review findings: a symlinked .swarm/backups is refused; incomplete backups are neither listed nor counted; bad keep falls back', async () => {
  const root = await tmpRoot();
  const outside = await tmpRoot();
  await put(root, '.swarm/project/tickets.json', 'v1');
  await fs.mkdir(path.join(root, '.swarm'), { recursive: true });
  await fs.symlink(outside, path.join(root, sb.BACKUP_DIR));
  await assert.rejects(() => sb.createBackup(root, { reason: 'x' }), (e) => e.code === 'unsafe-path');
  assert.deepEqual(await fs.readdir(outside), [], 'nothing was written outside');
  await fs.rm(path.join(root, sb.BACKUP_DIR));
  await fs.mkdir(path.join(root, sb.BACKUP_DIR, '20240101-000000-aaaa'), { recursive: true });
  const a = await sb.createBackup(root, { reason: 'a', now: clock(1), keep: NaN });
  assert.deepEqual((await sb.listBackups(root)).map((b) => b.id), [a.id]);
  assert.ok(await fs.stat(path.join(root, sb.BACKUP_DIR, '20240101-000000-aaaa')), 'an incomplete backup is left alone');
});
