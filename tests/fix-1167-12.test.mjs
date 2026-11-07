// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, writeFile, mkdir, utimes } from 'node:fs/promises';
import { promises as fs } from 'node:fs';
import { runMerge } from '../tools/merge-guard.mjs';
import { backupLedger, ledgerBackupKey, ledgerBackupsRoot } from '../tools/ledger-backup.mjs';

const ok = (o) => ({ code: 0, stdout: JSON.stringify(o), stderr: '' });

function mergeableView(headBranch = 'feature') {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: headBranch,
    headRefOid: 'abc123',
    isCrossRepository: false,
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  };
}

function mergeExec({ deleteRefResult, wtPath = '/wt/feature' } = {}) {
  const headBranch = 'feature';
  return async (cmd, args) => {
    if (cmd !== 'gh' && cmd !== 'git') return { code: 1, stdout: '', stderr: 'unexpected' };
    if (cmd === 'git') {
      if (args[0] === 'worktree' && args[1] === 'list') {
        return {
          code: 0,
          stdout: `worktree ${wtPath}\nbranch refs/heads/${headBranch}\n\n`,
          stderr: '',
        };
      }
      if (args[0] === 'rev-parse') return { code: 1, stdout: '', stderr: '' };
      return { code: 0, stdout: '', stderr: '' };
    }
    const a = args;
    if (a[0] === 'repo' && a[1] === 'view') {
      return ok({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'o/r' });
    }
    if (a[0] === 'pr' && a[1] === 'view' && a.includes('state')) {
      return ok({ state: 'MERGED' });
    }
    if (a[0] === 'pr' && a[1] === 'view') {
      return ok(mergeableView(headBranch));
    }
    if (a[0] === 'api' && a.includes('protection')) {
      return { code: 1, stdout: '', stderr: 'no protection' };
    }
    if (a[0] === 'pr' && a[1] === 'list') return ok([]);
    if (a[0] === 'pr' && a[1] === 'merge') return ok({});
    if (a[0] === 'api' && a[1] === '-X' && a[2] === 'DELETE') {
      return deleteRefResult ?? {
        code: 1,
        stdout: '',
        stderr: 'gh: Reference does not exist (HTTP 404)',
      };
    }
    return { code: 1, stdout: '', stderr: `unexpected gh ${a.join(' ')}` };
  };
}

test('runMerge treats remote ref delete 404 as merged', async () => {
  const r = await runMerge('.', ['349', '--repo', 'o/r'], {
    exec: mergeExec(),
    holdsSwarmState: async () => true,
  });
  assert.equal(r.status, 'merged');
  assert.equal(r.warning, undefined);
});

test('runMerge keeps merged when remote ref delete fails with warning', async () => {
  const r = await runMerge('.', ['350', '--repo', 'o/r'], {
    exec: mergeExec({
      deleteRefResult: { code: 1, stdout: '', stderr: 'gh: forbidden (HTTP 403)' },
    }),
    holdsSwarmState: async () => true,
  });
  assert.equal(r.status, 'merged');
  assert.match(r.warning, /403|forbidden/i);
});

test('backupLedger prunes old staging dirs under key folder (real fs)', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ledger-root-'));
  const home = await mkdtemp(path.join(os.tmpdir(), 'ledger-home-'));
  const projectDir = path.join(root, '.swarm', 'project');
  await mkdir(projectDir, { recursive: true, mode: 0o700 });
  const tickets = JSON.stringify({ version: 1, tickets: [] });
  await writeFile(path.join(projectDir, 'tickets.json'), tickets, { mode: 0o600 });

  const key = await ledgerBackupKey(root, fs);
  const keyDir = path.join(ledgerBackupsRoot(home), key);
  await mkdir(keyDir, { recursive: true, mode: 0o700 });
  const staging = path.join(keyDir, `snap.staging-deadbeef`);
  await mkdir(staging, { mode: 0o700 });
  await writeFile(path.join(staging, 'partial.txt'), 'x', { mode: 0o600 });
  const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await utimes(staging, twoHoursAgo, twoHoursAgo);

  const result = await backupLedger(root, { home, fs, now: () => Date.now() });
  assert.equal(result.ok, true);

  const names = await fs.readdir(keyDir);
  assert.ok(!names.some((n) => n.includes('.staging-')));
});
