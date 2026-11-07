// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  writeHandoffFile,
  buildHandoffDocument,
  handoffContentEquivalent,
  maskHandoffTimestamps,
  collectPendingApprovalEntries,
} from '../tools/project-commands.mjs';
import { appendEvent } from '../tools/journal.mjs';

const execFileAsync = promisify(execFile);
const NOW = () => Date.parse('2030-06-15T12:00:00.000Z');
const tmpBase = () => process.env.SWARM_TEST_TMP || os.tmpdir();

async function project(t, { git = true } = {}) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpBase(), 'handoff-regen-')));
  const home = await fs.mkdtemp(path.join(tmpBase(), 'handoff-regen-home-'));
  const env = {
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(home, '.gitconfig'),
    GIT_CONFIG_SYSTEM: '/dev/null',
    SWARM_CONFIG: process.env.SWARM_CONFIG,
    SWARM_TEST_TMP: process.env.SWARM_TEST_TMP,
  };
  t.after(async () => {
    await fs.rm(root, { recursive: true, force: true }).catch(() => {});
    await fs.rm(home, { recursive: true, force: true }).catch(() => {});
  });
  await fs.writeFile(path.join(root, '.project-swarm.json'), JSON.stringify({ install: '/x', version: '1.0.0' }));
  await fs.mkdir(path.join(root, 'coordination'), { recursive: true });
  await fs.writeFile(path.join(root, 'coordination/TASK.md'), '# Task\n');
  if (git) {
    await execFileAsync('git', ['init', '-q'], { cwd: root, env });
    await execFileAsync('git', ['-c', 'user.name=T', '-c', 'user.email=t@example.invalid', 'commit', '--allow-empty', '-qm', 'init'], { cwd: root, env });
  }
  const gitExec = async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, args, { cwd: root, env, maxBuffer: 8 * 1024 * 1024 });
    return { stdout };
  };
  return { root, env, gitExec };
}

test('read-only regen does not touch HANDOFF when only timestamp changes', async t => {
  const { root, gitExec } = await project(t);
  const target = path.join(root, 'coordination/HANDOFF.md');
  const first = await writeHandoffFile(root, { now: NOW, exec: gitExec });
  assert.equal(first.written, true);
  const stat1 = await fs.stat(target);
  const bytes1 = await fs.readFile(target);
  await new Promise(r => setTimeout(r, 20));
  const second = await writeHandoffFile(root, { now: () => NOW() + 60_000, exec: gitExec });
  assert.equal(second.written, false);
  assert.equal(second.reason, 'unchanged');
  const stat2 = await fs.stat(target);
  const bytes2 = await fs.readFile(target);
  assert.equal(stat2.mtimeMs, stat1.mtimeMs);
  assert.deepEqual(bytes2, bytes1);
});

test('maskHandoffTimestamps treats timestamp-only docs as equivalent', () => {
  const a = 'x\n\nGenerated at: 2030-01-01T00:00:00.000Z\n';
  const b = 'x\n\nGenerated at: 2030-02-02T00:00:00.000Z\n';
  assert.equal(handoffContentEquivalent(a, b), true);
  assert.notEqual(maskHandoffTimestamps(a), a);
});

test('content change rewrites and rotates generated backups once', async t => {
  const { root, gitExec } = await project(t);
  await writeHandoffFile(root, { now: NOW, exec: gitExec });
  const before = await fs.readFile(path.join(root, 'coordination/HANDOFF.md'), 'utf8');
  await appendEvent(root, { kind: 'goal', text: 'new goal for handoff' }, { now: NOW });
  const second = await writeHandoffFile(root, { now: () => NOW() + 1000, exec: gitExec });
  assert.equal(second.written, true);
  assert.equal(await fs.readFile(path.join(root, 'coordination/HANDOFF.previous.md'), 'utf8'), before);
  const third = await writeHandoffFile(root, { now: () => NOW() + 2000, exec: gitExec });
  assert.equal(third.written, false);
});

test('Pending approvals none when empty', async t => {
  const { root, gitExec } = await project(t);
  const doc = await buildHandoffDocument(root, { now: NOW, exec: gitExec });
  assert.match(doc, /Pending approvals: none/);
});

test('Pending approvals lists main checkout hand-build request', async t => {
  const { root, gitExec } = await project(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', 'state.json'), `${JSON.stringify({
    version: 1,
    requests: {
      r1: { id: 'r1', status: 'pending', files: ['a.ts'], kind: 'tiny', reason: 'test', minutes: 10, requestedAt: '2030-01-01T00:00:00.000Z', requestedBy: 'owner' },
    },
  })}\n`);
  const entries = await collectPendingApprovalEntries(root, { now: NOW, exec: gitExec });
  assert.ok(entries.some(e => e.kind === 'hand-build-request' && e.id === 'r1' && e.worktree === 'main checkout'));
  const doc = await buildHandoffDocument(root, { now: NOW, exec: gitExec });
  assert.match(doc, /hand-build-request r1/);
  assert.match(doc, /main checkout/);
});

test('Pending approvals lists linked worktree item with branch and path', async t => {
  const { root, env, gitExec } = await project(t);
  const linked = path.join(path.dirname(root), `${path.basename(root)}-wt`);
  await execFileAsync('git', ['worktree', 'add', '-b', 'swarm/linked', linked], { cwd: root, env });
  await fs.mkdir(path.join(linked, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(linked, '.swarm', 'handbuild', 'state.json'), `${JSON.stringify({
    version: 1,
    requests: {
      w1: { id: 'w1', status: 'pending', files: ['b.ts'], kind: 'tiny', reason: 'wt', minutes: 5, requestedAt: '2030-02-01T00:00:00.000Z', requestedBy: 'owner' },
    },
  })}\n`);
  const execAll = async (cmd, args) => {
    const { stdout } = await execFileAsync(cmd, args, { env, maxBuffer: 8 * 1024 * 1024 });
    return { stdout };
  };
  const entries = await collectPendingApprovalEntries(root, { now: NOW, exec: execAll });
  const wtItem = entries.find(e => e.id === 'w1');
  assert.ok(wtItem);
  assert.match(wtItem.branch, /swarm\/linked/);
  assert.equal(wtItem.worktree, linked);
});

test('unreadable worktree does not abort generation', async t => {
  const { root, gitExec } = await project(t);
  const fakeExec = async (cmd, args) => {
    if (args.includes('worktree') && args.includes('list')) {
      return { stdout: 'worktree /missing/path\nHEAD abc\nbranch refs/heads/main\n\n' };
    }
    return gitExec(cmd, args);
  };
  const entries = await collectPendingApprovalEntries(root, { now: NOW, exec: fakeExec });
  assert.ok(entries.some(e => e.kind === 'unreadable'));
  const doc = await buildHandoffDocument(root, { now: NOW, exec: fakeExec });
  assert.match(doc, /unreadable/);
});

test('atomic write leaves no partial file when write fails', async t => {
  const { root, gitExec } = await project(t);
  const target = path.join(root, 'coordination/HANDOFF.md');
  await writeHandoffFile(root, { now: NOW, exec: gitExec });
  await appendEvent(root, { kind: 'goal', text: 'force rewrite' }, { now: () => NOW() + 1 });
  await assert.rejects(writeHandoffFile(root, {
    now: () => NOW() + 2,
    exec: gitExec,
    writeAtomic: async (file, text) => {
      const dir = path.dirname(file);
      const tmp = path.join(dir, `.HANDOFF.md.${process.pid}.broken.tmp`);
      await fs.writeFile(tmp, 'partial');
      throw new Error('rename failed');
    },
  }), /handoff-write-failed/);
  const content = await fs.readFile(target, 'utf8');
  assert.ok(!content.includes('partial'));
});

test('pending entries sorted newest first then id', async t => {
  const { root, gitExec } = await project(t);
  await fs.mkdir(path.join(root, '.swarm', 'handbuild'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'handbuild', 'state.json'), `${JSON.stringify({
    version: 1,
    requests: {
      a: { id: 'a', status: 'pending', files: ['a.ts'], kind: 'tiny', reason: 'a', minutes: 1, requestedAt: '2030-01-01T00:00:00.000Z', requestedBy: 'owner' },
      b: { id: 'b', status: 'pending', files: ['b.ts'], kind: 'tiny', reason: 'b', minutes: 1, requestedAt: '2030-03-01T00:00:00.000Z', requestedBy: 'owner' },
    },
  })}\n`);
  const entries = await collectPendingApprovalEntries(root, { now: NOW, exec: gitExec });
  assert.deepEqual(entries.map(e => e.id), ['b', 'a']);
});
