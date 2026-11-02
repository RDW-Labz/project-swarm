// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import {
  holdsSwarmState,
  projectSwarmHome,
  recordDeletion,
  deletionsLogFile,
} from '../tools/state-guard.mjs';
import { runMerge } from '../tools/merge-guard.mjs';
import { applyProjectGcPlan } from '../tools/gc.mjs';
import * as lb from '../tools/ledger-backup.mjs';
import { createLedger } from '../tools/tickets.mjs';

function minimalLedger(tickets = []) {
  return createLedger({
    scope: { name: 't', version: 1, hash: 'h', stages: [] },
    tickets,
  });
}

test('finding 1: non-ENOENT access errors fail closed', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-access-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const fsImpl = {
    access: async (p) => {
      if (String(p).includes('tickets.json')) {
        const err = new Error('denied');
        err.code = 'EACCES';
        throw err;
      }
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readdir: async () => {
      throw Object.assign(new Error('loop'), { code: 'ELOOP' });
    },
    readFile: async () => '',
    realpath: async (p) => p,
  };
  assert.equal(await holdsSwarmState(dir, { fs: fsImpl }), true);
});

test('finding 2: registry match uses realpath', async (t) => {
  const base = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-rp-'));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const child = path.join(base, 'proj');
  await fs.mkdir(child, { recursive: true });
  const registry = path.join(base, 'reg.json');
  await fs.writeFile(registry, JSON.stringify([{ root: child }]));
  const viaTmp = path.join(base, 'alias');
  await fs.symlink(child, viaTmp);
  assert.equal(await holdsSwarmState(viaTmp, { fs, registryFile: registry }), true);
});

test('finding 3: worktree list failure keeps local head branch', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const key = [command, ...args].join(' ');
    const routes = {
      'gh repo view --repo o/r --json defaultBranchRef,nameWithOwner': { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'o/r' }), stderr: '' },
      'gh pr view 1 --repo o/r --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository,title,body': {
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          isCrossRepository: false,
          title: 'Fix the widget',
          body: '',
        }),
        stderr: '',
      },
      'gh pr list --repo o/r --base feat --state open --json number': { code: 0, stdout: '[]', stderr: '' },
      'gh pr merge 1 --repo o/r --squash --match-head-commit abc': { code: 0, stdout: '', stderr: '' },
      'gh api -X DELETE repos/o/r/git/refs/heads/feat': { code: 0, stdout: '', stderr: '' },
      'gh pr view 1 --repo o/r --json state': { code: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' },
      'gh api repos/o/r/branches/main/protection/required_status_checks': { code: 1, stdout: '', stderr: '404' },
      'git worktree list --porcelain': { code: 1, stdout: '', stderr: 'fail' },
      'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
      'git remote get-url origin': { code: 0, stdout: 'git@github.com:o/r.git\n', stderr: '' },
      'git status --porcelain': { code: 0, stdout: '', stderr: '' },
      'git fetch origin': { code: 0, stdout: '', stderr: '' },
      'git checkout main --': { code: 0, stdout: '', stderr: '' },
      'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
    };
    return routes[key] ?? { code: 1, stdout: '', stderr: 'unexpected' };
  };
  const r = await runMerge('.', ['1', '--repo', 'o/r'], { exec, sleep: async () => {} });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  const merge = calls.find((c) => c.startsWith('gh pr merge'));
  assert.ok(merge);
  assert.equal(merge.includes('--delete-branch'), false);
});

test('finding 4: parent of registered project root is a state holder', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-parent-'));
  const child = path.join(dir, 'nested', 'app');
  await fs.mkdir(child, { recursive: true });
  const registry = path.join(dir, 'projects.json');
  await fs.writeFile(registry, JSON.stringify([{ root: child }]));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await holdsSwarmState(dir, { fs, registryFile: registry }), true);
  assert.equal(await holdsSwarmState(path.join(dir, 'nested'), { fs, registryFile: registry }), true);
});

test('finding 5: gc old-run worktrees subdirs guarded', async (t) => {
  const project = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-gc-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-gc-home-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(project, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const runDir = path.join(project, '.swarm', 'runs', 'old-run');
  const holder = path.join(runDir, 'worktrees', 'wt-holder');
  const plain = path.join(runDir, 'worktrees', 'wt-plain');
  await fs.mkdir(holder, { recursive: true });
  await fs.mkdir(plain, { recursive: true });
  await fs.mkdir(path.join(holder, '.swarm', 'runs', 'x'), { recursive: true });
  await fs.writeFile(path.join(runDir, 'state.json'), '{}');
  const plan = {
    bases: [project],
    categories: {
      finishedRuns: [],
      orphans: [],
      oldRunFolders: [{ path: runDir, bytes: 1, runId: 'old-run' }],
      scratch: [],
      untrackedArchives: [],
    },
  };
  await applyProjectGcPlan(project, plan, { env, home });
  await fs.access(holder);
  await fs.access(plain).then(() => assert.fail('plain should be removed')).catch(() => {});
});

test('finding 6: head ref segments encoded separately', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push(args);
    const key = [command, ...args].join(' ');
    const routes = {
      'gh repo view --repo o/r --json defaultBranchRef,nameWithOwner': { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'o/r' }), stderr: '' },
      'gh pr view 2 --repo o/r --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository,title,body': {
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'release/1.0', headRefOid: 'abc',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          isCrossRepository: false,
          title: 'Fix the widget',
          body: '',
        }),
        stderr: '',
      },
      'gh pr list --repo o/r --base release/1.0 --state open --json number': { code: 0, stdout: '[]', stderr: '' },
      'gh pr merge 2 --repo o/r --squash --match-head-commit abc': { code: 0, stdout: '', stderr: '' },
      'gh api -X DELETE repos/o/r/git/refs/heads/release/1.0': { code: 0, stdout: '', stderr: '' },
      'gh pr view 2 --repo o/r --json state': { code: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' },
      'gh api repos/o/r/branches/main/protection/required_status_checks': { code: 1, stdout: '', stderr: '404' },
      'git worktree list --porcelain': { code: 0, stdout: `worktree ${process.cwd()}\nbranch refs/heads/release/1.0\n\n`, stderr: '' },
      'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
      'git remote get-url origin': { code: 0, stdout: 'git@github.com:o/r.git\n', stderr: '' },
      'git status --porcelain': { code: 0, stdout: '', stderr: '' },
      'git fetch origin': { code: 0, stdout: '', stderr: '' },
      'git checkout main --': { code: 0, stdout: '', stderr: '' },
      'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
    };
    return routes[key] ?? { code: 1, stdout: '', stderr: 'unexpected ' + key };
  };
  const wt = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-wt-'));
  await fs.mkdir(path.join(wt, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(wt, '.swarm', 'project', 'tickets.json'), '{}');
  const porcelain = `worktree ${wt}\nbranch refs/heads/release/1.0\n\n`;
  const exec2 = async (command, args, opts) => {
    if (command === 'git' && args[0] === 'worktree') {
      return { code: 0, stdout: porcelain, stderr: '' };
    }
    return exec(command, args, opts);
  };
  const r = await runMerge('.', ['2', '--repo', 'o/r'], { exec: exec2, sleep: async () => {} });
  assert.equal(r.status, 'merged');
  const del = calls.find((a) => a[0] === 'api' && a[1] === '-X');
  assert.ok(del);
  assert.equal(del[3], 'repos/o/r/git/refs/heads/release/1.0');
  await fs.rm(wt, { recursive: true, force: true });
});

test('finding 7: cross-repository PR skips remote delete', async () => {
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const key = [command, ...args].join(' ');
    const routes = {
      'gh repo view --repo o/r --json defaultBranchRef,nameWithOwner': { code: 0, stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'o/r' }), stderr: '' },
      'gh pr view 3 --repo o/r --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository,title,body': {
        code: 0,
        stdout: JSON.stringify({
          state: 'OPEN', mergeable: 'MERGEABLE', baseRefName: 'main', headRefName: 'feat', headRefOid: 'abc',
          statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
          isCrossRepository: true,
          title: 'Fix the widget',
          body: '',
        }),
        stderr: '',
      },
      'gh pr list --repo o/r --base feat --state open --json number': { code: 0, stdout: '[]', stderr: '' },
      'gh pr merge 3 --repo o/r --squash --match-head-commit abc': { code: 0, stdout: '', stderr: '' },
      'gh pr view 3 --repo o/r --json state': { code: 0, stdout: JSON.stringify({ state: 'MERGED' }), stderr: '' },
      'gh api repos/o/r/branches/main/protection/required_status_checks': { code: 1, stdout: '', stderr: '404' },
      'git worktree list --porcelain': { code: 0, stdout: `worktree ${process.cwd()}\nbranch refs/heads/feat\n\n`, stderr: '' },
      'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
      'git remote get-url origin': { code: 0, stdout: 'git@github.com:o/r.git\n', stderr: '' },
      'git status --porcelain': { code: 0, stdout: '', stderr: '' },
      'git fetch origin': { code: 0, stdout: '', stderr: '' },
      'git checkout main --': { code: 0, stdout: '', stderr: '' },
      'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
    };
    return routes[key] ?? { code: 1, stdout: '', stderr: 'unexpected ' + key };
  };
  const wt = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-cross-'));
  await fs.mkdir(path.join(wt, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(wt, '.swarm', 'project', 'tickets.json'), '{}');
  const exec2 = async (command, args) => {
    if (command === 'git' && args[0] === 'worktree') {
      return { code: 0, stdout: `worktree ${wt}\nbranch refs/heads/feat\n\n`, stderr: '' };
    }
    return exec(command, args);
  };
  const r = await runMerge('.', ['3', '--repo', 'o/r'], { exec: exec2, sleep: async () => {} });
  assert.equal(r.status, 'merged');
  assert.equal(calls.some((c) => c.includes('DELETE') && c.includes('refs/heads')), false);
  await fs.rm(wt, { recursive: true, force: true });
});

test('finding 8: meta.json appears only after payload files', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-meta-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-meta-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ledger = minimalLedger();
  const ticketsPath = path.join(root, '.swarm', 'project', 'tickets.json');
  await fs.mkdir(path.dirname(ticketsPath), { recursive: true });
  await fs.writeFile(ticketsPath, JSON.stringify(ledger, null, 2) + '\n');
  const r = await lb.backupLedger(root, { home, now: () => Date.UTC(2025, 1, 1) });
  assert.equal(r.ok, true);
  const snapDir = path.join(lb.ledgerBackupsRoot(home), r.key, r.id);
  const names = await fs.readdir(snapDir);
  assert.ok(names.includes('meta.json'));
  assert.ok(names.includes('tickets.json'));
});

test('finding 9: restore verifies snapshot hash before copy', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-hash-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-hash-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ledger = minimalLedger([{ id: 'T-0001', title: 'x', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  const ticketsPath = path.join(root, '.swarm', 'project', 'tickets.json');
  await fs.mkdir(path.dirname(ticketsPath), { recursive: true });
  await fs.writeFile(ticketsPath, JSON.stringify(ledger, null, 2) + '\n');
  const made = await lb.backupLedger(root, { home, now: () => Date.UTC(2025, 2, 1) });
  const snapDir = path.join(lb.ledgerBackupsRoot(home), made.key, made.id);
  await fs.writeFile(path.join(snapDir, 'tickets.json'), '{"tickets":[]}\n');
  const res = await lb.restoreLedgerSnapshot(root, { id: made.id, fromKey: made.key, home, yes: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /hash mismatch/);
});

test('finding 10: restore --into refuses symlink targets', async (t) => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-into-home-'));
  const srcRoot = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-into-src-'));
  const target = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-into-tgt-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  t.after(() => fs.rm(srcRoot, { recursive: true, force: true }));
  t.after(() => fs.rm(target, { recursive: true, force: true }));
  const ledger = minimalLedger();
  await fs.mkdir(path.join(srcRoot, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(srcRoot, '.swarm', 'project', 'tickets.json'), JSON.stringify(ledger, null, 2) + '\n');
  const made = await lb.backupLedger(srcRoot, { home, now: () => Date.UTC(2025, 3, 1) });
  await fs.mkdir(path.join(target, '.swarm'), { recursive: true });
  const evil = path.join(target, 'escape');
  await fs.mkdir(evil, { recursive: true });
  await fs.symlink(evil, path.join(target, '.swarm', 'project'));
  const res = await lb.restoreLedgerSnapshot(srcRoot, { id: made.id, fromKey: made.key, into: target, home, yes: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /symlink/);
});

test('finding 11: dedupe ignores newest incomplete snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-dedupe-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-dedupe-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ledger = minimalLedger();
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  const body = JSON.stringify(ledger, null, 2) + '\n';
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), body);
  const first = await lb.backupLedger(root, { home, now: () => Date.UTC(2025, 4, 1) });
  const keyDir = path.join(lb.ledgerBackupsRoot(home), first.key);
  const incomplete = path.join(keyDir, '2099-01-01T00-00-00-000Z-deadbeef');
  await fs.mkdir(incomplete, { recursive: true });
  await fs.writeFile(path.join(incomplete, 'tickets.json'), body);
  const second = await lb.backupLedger(root, { home, now: () => Date.UTC(2025, 4, 2) });
  assert.equal(second.skipped, true);
  assert.equal(second.id, first.id);
});

test('finding 12: restore latest skips incomplete snapshot', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-latest-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-latest-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ledger = minimalLedger([{ id: 'T-0001', title: 'good', type: 'docs', scopeRefs: ['R-001'], size: 'S', risk: 'low', status: 'todo', stage: 's1' }]);
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify(ledger, null, 2) + '\n');
  const good = await lb.backupLedger(root, { home, now: () => Date.UTC(2025, 5, 1) });
  const keyDir = path.join(lb.ledgerBackupsRoot(home), good.key);
  const badId = '2099-12-31T00-00-00-000Z-ffffffff';
  await fs.mkdir(path.join(keyDir, badId), { recursive: true });
  await fs.writeFile(path.join(keyDir, badId, 'tickets.json'), '{}');
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), '{"tickets":[]}\n');
  const res = await lb.restoreLedgerSnapshot(root, { id: 'latest', fromKey: good.key, home, yes: true });
  assert.equal(res.ok, true);
  assert.equal(res.id, good.id);
  const raw = await fs.readFile(path.join(root, '.swarm', 'project', 'tickets.json'), 'utf8');
  assert.match(raw, /good/);
});

test('finding 13: invalid --from key rejected', async () => {
  const res = await lb.restoreLedgerSnapshot('/tmp/x', { fromKey: '../evil', yes: true });
  assert.equal(res.ok, false);
  assert.match(res.reason, /invalid/);
});

test('finding 14: prune incomplete snapshots older than one hour', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-prune-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-prune-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const ledger = minimalLedger();
  await fs.mkdir(path.join(root, '.swarm', 'project'), { recursive: true });
  await fs.writeFile(path.join(root, '.swarm', 'project', 'tickets.json'), JSON.stringify(ledger, null, 2) + '\n');
  const key = await lb.ledgerBackupKey(root);
  const keyDir = path.join(lb.ledgerBackupsRoot(home), key);
  await fs.mkdir(keyDir, { recursive: true });
  const oldIncomplete = path.join(keyDir, '2020-01-01T00-00-00-000Z-aaaa0000');
  await fs.mkdir(oldIncomplete, { recursive: true });
  await fs.writeFile(path.join(oldIncomplete, 'tickets.json'), '{}');
  const old = new Date('2020-01-01T00:00:00.000Z');
  await fs.utimes(oldIncomplete, old, old);
  await lb.backupLedger(root, { home, now: () => Date.UTC(2026, 0, 1) });
  const left = await fs.readdir(keyDir);
  assert.equal(left.includes('2020-01-01T00-00-00-000Z-aaaa0000'), false);
});

test('finding 15: projectSwarmHome trims override', () => {
  const resolved = projectSwarmHome('/home/u', { PROJECT_SWARM_HOME: '  /tmp/ps  ' });
  assert.equal(resolved, path.resolve('/tmp/ps'));
  assert.equal(lb.swarmHome({ PROJECT_SWARM_HOME: '  /tmp/ps2  ' }), path.resolve('/tmp/ps2'));
});

test('finding 16: deletions.log opened with O_APPEND and O_NOFOLLOW', async (t) => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-log-'));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const log = deletionsLogFile(home, env);
  await fs.mkdir(path.dirname(log), { recursive: true });
  await fs.writeFile(log, '', { mode: 0o600 });
  let flags;
  const want = fssync.constants.O_WRONLY | fssync.constants.O_APPEND | fssync.constants.O_CREAT | fssync.constants.O_NOFOLLOW;
  const fsImpl = {
    ...fs,
    open: async (file, f, mode) => {
      if (file === log) flags = f;
      return fs.open(file, f, mode);
    },
  };
  await recordDeletion({ dir: '/x', caller: 't', outcome: 'allowed', home, env, fs: fsImpl });
  assert.equal(flags & want, want);
});

test('finding 17: registry parse failure fails closed', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-parse-'));
  const registry = path.join(dir, 'bad.json');
  await fs.writeFile(registry, '{not json');
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await holdsSwarmState(dir, { fs, registryFile: registry }), true);
});

test('finding 18: realpath failure on registry root fails closed', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf-rpfail-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const registry = path.join(dir, 'reg.json');
  await fs.writeFile(registry, JSON.stringify([{ root: '/no/such/root' }]));
  const fsImpl = {
    ...fs,
    realpath: async (p) => {
      if (String(p) === '/no/such/root') {
        throw Object.assign(new Error('io'), { code: 'EIO' });
      }
      return fs.realpath(p);
    },
  };
  assert.equal(await holdsSwarmState(dir, { fs: fsImpl, registryFile: registry }), true);
});
