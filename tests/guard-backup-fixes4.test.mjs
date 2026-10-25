// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import path from 'node:path';
import { runMerge, worktreeListTrustworthy } from '../tools/merge-guard.mjs';
import { holdsSwarmState, recordDeletion, deletionsLogFile } from '../tools/state-guard.mjs';
import * as lb from '../tools/ledger-backup.mjs';

const PR_JSON =
  'state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository';

function greenPrView(over = {}) {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: 'feat',
    headRefOid: 'abc',
    statusCheckRollup: [{ name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    isCrossRepository: false,
    ...over,
  };
}

function mergeRoutes(prNumber, repo, view, worktreeStdout = '') {
  const n = String(prNumber);
  const key = `gh pr view ${n} --repo ${repo} --json ${PR_JSON}`;
  return {
    [`gh repo view --repo ${repo} --json defaultBranchRef,nameWithOwner`]: {
      code: 0,
      stdout: JSON.stringify({ defaultBranchRef: { name: 'main' }, nameWithOwner: repo }),
      stderr: '',
    },
    [key]: { code: 0, stdout: JSON.stringify(view), stderr: '' },
    [`gh pr list --repo ${repo} --base ${view.headRefName} --state open --json number`]: {
      code: 0,
      stdout: '[]',
      stderr: '',
    },
    [`gh pr merge ${n} --repo ${repo} --squash --match-head-commit ${view.headRefOid}`]: {
      code: 0,
      stdout: '',
      stderr: '',
    },
    [`gh api -X DELETE repos/${repo}/git/refs/heads/${view.headRefName}`]: {
      code: 0,
      stdout: '',
      stderr: '',
    },
    [`gh pr view ${n} --repo ${repo} --json state`]: {
      code: 0,
      stdout: JSON.stringify({ state: 'MERGED' }),
      stderr: '',
    },
    [`gh api repos/${repo}/branches/main/protection/required_status_checks`]: {
      code: 1,
      stdout: '',
      stderr: '404',
    },
    'git worktree list --porcelain': { code: 0, stdout: worktreeStdout, stderr: '' },
    'git rev-parse --is-inside-work-tree': { code: 0, stdout: 'true\n', stderr: '' },
    'git remote get-url origin': { code: 0, stdout: `git@github.com:${repo}.git\n`, stderr: '' },
    'git status --porcelain': { code: 0, stdout: '', stderr: '' },
    'git fetch origin': { code: 0, stdout: '', stderr: '' },
    'git checkout main --': { code: 0, stdout: '', stderr: '' },
    'git pull --ff-only origin main': { code: 0, stdout: '', stderr: '' },
  };
}

test('finding 1: isCrossRepository on first pr view; delete only when strictly false', async () => {
  const calls = [];
  const view = greenPrView({ isCrossRepository: false });
  const routes = mergeRoutes(1, 'o/r', view, `worktree ${process.cwd()}\nbranch refs/heads/feat\n\n`);
  const exec = async (command, args) => {
    calls.push([command, ...args]);
    const key = [command, ...args].join(' ');
    return routes[key] ?? { code: 1, stdout: '', stderr: `unexpected ${key}` };
  };
  const r = await runMerge('.', ['1', '--repo', 'o/r'], {
    exec,
    sleep: async () => {},
    holdsSwarmState: async () => true,
  });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  const jsonField = (a) => {
    const j = a.indexOf('--json');
    return j >= 0 ? String(a[j + 1] ?? '') : '';
  };
  const prViews = calls.filter((a) => a[0] === 'gh' && a[1] === 'pr' && a[2] === 'view');
  assert.ok(prViews.some((a) => jsonField(a).includes('isCrossRepository')));
  assert.equal(prViews.filter((a) => jsonField(a) === 'isCrossRepository').length, 0);
  assert.ok(calls.some((a) => a[0] === 'gh' && a[1] === 'api' && a[2] === '-X'));
});

test('finding 1b: skip remote delete when isCrossRepository is true or unknown', async () => {
  for (const cross of [true, undefined]) {
    const calls = [];
    const view = greenPrView();
    if (cross === true) view.isCrossRepository = true;
    else delete view.isCrossRepository;
    const routes = mergeRoutes(2, 'o/r', view, `worktree ${process.cwd()}\nbranch refs/heads/feat\n\n`);
    const exec = async (command, args) => {
      calls.push([command, ...args]);
      const key = [command, ...args].join(' ');
      return routes[key] ?? { code: 1, stdout: '', stderr: `unexpected ${key}` };
    };
    const r = await runMerge('.', ['2', '--repo', 'o/r'], {
      exec,
      sleep: async () => {},
      holdsSwarmState: async () => true,
    });
    assert.equal(r.status, 'merged');
    assert.equal(
      calls.some((a) => a[0] === 'gh' && a[1] === 'api' && a[2] === '-X'),
      false,
    );
  }
});

test('finding 3: empty git worktree list output is untrustworthy (keep local branch)', () => {
  assert.equal(worktreeListTrustworthy(''), false);
  assert.equal(worktreeListTrustworthy('   \n'), false);
});

test('finding 3b: empty worktree list keeps head branch during merge', async () => {
  const calls = [];
  const view = greenPrView({ isCrossRepository: false });
  const routes = mergeRoutes(4, 'o/r', view, '');
  const exec = async (command, args) => {
    calls.push([command, ...args].join(' '));
    const key = [command, ...args].join(' ');
    return routes[key] ?? { code: 1, stdout: '', stderr: `unexpected ${key}` };
  };
  const r = await runMerge('.', ['4', '--repo', 'o/r'], { exec, sleep: async () => {} });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  const merge = calls.find((c) => c.startsWith('gh pr merge'));
  assert.ok(merge);
  assert.equal(merge.includes('--delete-branch'), false);
});

test('finding 2: pointer .project-swarm.json parse errors refuse deletion', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf4-pointer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, '.project-swarm.json'), '{not json');
  assert.equal(await holdsSwarmState(dir, { fs }), true);
});

test('finding 2b: ENOENT on pointer means no ledger pointer', async (t) => {
  const dir = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf4-no-pointer-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  assert.equal(await holdsSwarmState(dir, { fs }), false);
});

test('finding 5: recordDeletion chmods via open handle', async (t) => {
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf4-home-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const env = { PROJECT_SWARM_HOME: path.join(home, 'ps') };
  let chmodOnHandle = false;
  const realFs = fs;
  const fsImpl = {
    mkdir: realFs.mkdir.bind(realFs),
    open: async (file, flags, mode) => {
      const handle = await realFs.open(file, flags, mode);
      const origChmod = handle.chmod.bind(handle);
      handle.chmod = async (m) => {
        chmodOnHandle = true;
        return origChmod(m);
      };
      return handle;
    },
  };
  await recordDeletion({ dir: '/tmp/x', caller: 'test', outcome: 'refused', home, env, fs: fsImpl });
  assert.equal(chmodOnHandle, true);
  const log = deletionsLogFile(home, env);
  const st = await fs.stat(log);
  assert.equal(st.mode & 0o777, 0o600);
});

test('finding 4: failed staging rename removes staging dir and excludes it from listings', async (t) => {
  const root = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf4-ledger-'));
  const home = await fs.mkdtemp(path.join(process.env.SWARM_TEST_TMP, 'gbf4-ledger-home-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  t.after(() => fs.rm(home, { recursive: true, force: true }));

  const projectDir = path.join(root, '.swarm', 'project');
  await fs.mkdir(projectDir, { recursive: true });
  const ledger = { version: 1, tickets: [{ id: 't1', status: 'open' }] };
  await fs.writeFile(path.join(projectDir, 'tickets.json'), JSON.stringify(ledger));

  let stagingPath = null;
  const fsWrap = new Proxy(fs, {
    get(target, prop, receiver) {
      if (prop === 'rename') {
        return async (from, to) => {
          const fromStr = String(from);
          const toStr = String(to);
          if (fromStr.includes('.staging-') && !toStr.includes('.staging-')) {
            stagingPath = from;
            throw new Error('rename blocked');
          }
          return Reflect.apply(target.rename, target, [from, to]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  const first = await lb.backupLedger(root, { home, fs: fsWrap, now: () => 1_700_000_000_000 });
  assert.equal(first.ok, false);
  assert.match(first.reason ?? '', /rename blocked/);
  assert.ok(stagingPath);

  await fs.access(stagingPath).then(
    () => assert.fail('staging dir should be removed'),
    () => {},
  );

  const key = await lb.ledgerBackupKey(root, fs);
  const keyDir = path.join(lb.ledgerBackupsRoot(home), key);
  const names = await fs.readdir(keyDir);
  assert.equal(names.some((n) => n.includes('.staging-')), false);

  const left = await lb.backupLedger(root, { home, fs, now: () => 1_700_000_000_001 });
  assert.equal(left.ok, true);
  const listed = await lb.listLedgerBackups(root, { home, fs });
  assert.equal(listed.every((row) => !row.id.includes('.staging-')), true);
  assert.equal(listed.length, 1);
});
