// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { swarmProducedHashes, isSwarmProducedContent } from '../tools/swarm-produced.mjs';
import { guardDecision, createRequest, decideRequest } from '../tools/handbuild.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-produced-hash-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function withRunState(root, { id = 'RUN', files, hashes, integratedAt = '2026-01-01T00:00:00.000Z' }) {
  await fs.mkdir(path.join(root, '.swarm', 'runs', id), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'runs', id, 'state.json'), JSON.stringify({
    id,
    integratedAt,
    integratedFiles: files,
    integratedNewFiles: files,
    integratedHashes: hashes,
  }));
}

test('isSwarmProducedContent matches integrated hash bytes only', async t => {
  const root = await tmp(t);
  const rel = 'src/a.mjs';
  const bytes = Buffer.from('swarm bytes\n');
  await withRunState(root, { files: [rel], hashes: { [rel]: digest(bytes) } });
  assert.equal(isSwarmProducedContent(root, rel, bytes), true);
  assert.equal(isSwarmProducedContent(root, rel, Buffer.from('swarm bytes?\n')), false);
});

test('runs without integratedHashes contribute no content hashes', async t => {
  const root = await tmp(t);
  await withRunState(root, { files: ['src/old.mjs'], hashes: undefined });
  assert.equal(swarmProducedHashes(root).size, 0);
  assert.equal(isSwarmProducedContent(root, 'src/old.mjs', Buffer.from('x')), false);
});

test('symlinked state.json is ignored for hashes', async t => {
  const root = await tmp(t);
  const rel = 'src/real.mjs';
  const bytes = Buffer.from('ok\n');
  const dir = path.join(root, '.swarm', 'runs', 'LINK');
  await fs.mkdir(dir, { recursive: true });
  const real = path.join(dir, 'state-real.json');
  await fs.writeFile(real, JSON.stringify({
    id: 'LINK',
    integratedAt: '2026-01-01T00:00:00.000Z',
    integratedFiles: ['src/forged.mjs'],
    integratedHashes: { 'src/forged.mjs': digest(Buffer.from('forged\n')) },
  }));
  fsSync.symlinkSync(real, path.join(dir, 'state.json'));
  await withRunState(root, { id: 'GOOD', files: [rel], hashes: { [rel]: digest(bytes) } });
  assert.equal(isSwarmProducedContent(root, 'src/forged.mjs', Buffer.from('forged\n')), false);
  assert.equal(isSwarmProducedContent(root, rel, bytes), true);
});

test('commit allows matching swarm bytes and blocks hand-edited staged content', async t => {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  const rel = 'src/swarm.ts';
  const good = Buffer.from('integrated\n');
  await fs.writeFile(path.join(root, 'README.md'), 'base\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'base');
  git('branch', '-q', 'main');
  git('checkout', '-q', '-b', 'feature/x');
  await fs.writeFile(path.join(root, rel), good);
  await withRunState(root, { files: [rel], hashes: { [rel]: digest(good) } });
  const bash = command => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => T0, branchOf: () => 'feature/x' });
  git('add', rel);
  assert.equal(bash('git commit -m ok').allow, true);
  await fs.writeFile(path.join(root, rel), 'hand edit\n');
  git('add', rel);
  const blocked = bash('git commit -m bad');
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /commit|handbuild/i);
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot commit this edited file', files: rel, git: 'commit', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  assert.equal(bash('git commit -m bad', { now: () => T0 + 1000 }).allow, true);
});
