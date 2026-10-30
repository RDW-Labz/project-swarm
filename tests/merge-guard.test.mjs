import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  checkRollup,
  assertMergeable,
  parsePrArgument,
  releaseReviewGate,
  runMerge,
} from '../tools/merge-guard.mjs';

const T1 = '2024-01-01T00:00:00Z';
const T2 = '2024-01-02T00:00:00Z';
const YEAR_ONE = '0001-01-01T00:00:00Z';

function run(name, status, conclusion, completedAt = T1, startedAt = T1, extra = {}) {
  return { name, status, conclusion, startedAt, completedAt, ...extra };
}

function ctx(context, state) {
  return { context, state };
}

const GREEN = [
  run('build', 'COMPLETED', 'SUCCESS'),
  run('lint', 'COMPLETED', 'NEUTRAL'),
  run('docs', 'COMPLETED', 'SKIPPED'),
];

function ok(stdout = '') {
  return { code: 0, stdout, stderr: '' };
}

function fail(stderr = 'boom') {
  return { code: 1, stdout: '', stderr };
}

function json(v) {
  return ok(JSON.stringify(v));
}

const SLEEP = async () => {};

function makeExec(routes) {
  const calls = [];
  const exec = async (command, args, opts = {}) => {
    calls.push({ command, args: [...args], cwd: opts.cwd });
    const key = [command, ...args].join(' ');
    if (!Object.prototype.hasOwnProperty.call(routes, key)) {
      return fail('unexpected call: ' + key);
    }
    return routes[key];
  };
  return { exec, calls };
}

const PROTECTION = 'gh api repos/octo/repo/branches/main/protection/required_status_checks';
const REMOTE = 'git remote get-url origin';
const WORKTREE = 'git worktree list --porcelain';
const REMOTE_DELETE_FEAT = 'gh api -X DELETE repos/octo/repo/git/refs/heads/feat';

function encodeRefPath(refName) {
  return String(refName).split('/').map((seg) => encodeURIComponent(seg)).join('/');
}

function remoteDeleteKey(headBranch) {
  return `gh api -X DELETE repos/octo/repo/git/refs/heads/${encodeRefPath(headBranch)}`;
}

function worktreePorcelain(root, branch = 'refs/heads/main') {
  return `worktree ${root}\nbranch ${branch}\n\n`;
}

function prListKey(baseBranch) {
  return `gh pr list --repo octo/repo --base ${baseBranch} --state open --json number`;
}

const PR_VIEW_FIELDS =
  'state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup,isCrossRepository,title,body';

const KEY = {
  repo: 'gh repo view --json defaultBranchRef,nameWithOwner',
  after: 'gh pr view 123 --json state',
};

function prViewKey(fields = PR_VIEW_FIELDS) {
  return `gh pr view 123 --json ${fields}`;
}

function mergeKey(headOid, deleteBranch = true) {
  const parts = ['gh', 'pr', 'merge', '123', '--squash'];
  if (deleteBranch) parts.push('--delete-branch');
  parts.push('--match-head-commit', headOid);
  return parts.join(' ');
}

const HEAD_SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const OTHER_SHA = 'fedcba0987654321fedcba0987654321fedcba09';

function prView(over = {}) {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: 'feat',
    headRefOid: 'abc123',
    statusCheckRollup: GREEN,
    isCrossRepository: false,
    title: 'Fix the widget',
    body: '',
    ...over,
  };
}

function routes(o = {}, root = '/repo') {
  const headBranch = o.view?.headRefName ?? 'feat';
  const headOid = o.view?.headRefOid ?? 'abc123';
  const deleteKey = remoteDeleteKey(headBranch);
  const viewKey = prViewKey();
  const mergeRoute = mergeKey(headOid, true);
  const mergeKeepLocalRoute = mergeKey(headOid, false);
  const base = {
    [KEY.repo]: json({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'octo/repo' }),
    [viewKey]: o.rawView ?? json(prView(o.view)),
    [prListKey(headBranch)]: json(o.list ?? []),
    [mergeRoute]: o.merge ?? ok(''),
    [KEY.after]: json(o.after ?? { state: 'MERGED' }),
    [PROTECTION]: o.protection ?? fail('404 Not Found'),
    [REMOTE]: ok(o.remote ?? 'git@github.com:octo/repo.git\n'),
    [WORKTREE]: o.worktree ?? ok(worktreePorcelain(root)),
    [deleteKey]: o.remoteDelete ?? ok(''),
    'git rev-parse --is-inside-work-tree': ok('true\n'),
    'git status --porcelain': ok(o.porcelain ?? ''),
    'git fetch origin': ok(''),
    'git checkout main --': ok(''),
    'git pull --ff-only origin main': ok(''),
  };
  if (o.keepLocalHeadBranch) {
    base[mergeKeepLocalRoute] = o.merge ?? ok('');
    delete base[mergeRoute];
  }
  return base;
}

function mergeCalls(calls) {
  return calls.filter((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'merge');
}

// checkRollup

test('checkRollup: all green check runs are ok', () => {
  const r = checkRollup(GREEN);
  assert.equal(r.ok, true);
  assert.equal(r.total, 3);
  assert.equal(r.green, 3);
  assert.deepEqual(r.failing, []);
  assert.deepEqual(r.pending, []);
});

test('checkRollup: a failure is listed as failing and not ok', () => {
  const r = checkRollup([run('build', 'COMPLETED', 'SUCCESS'), run('codeql', 'COMPLETED', 'FAILURE')]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failing, ['codeql']);
  assert.deepEqual(r.pending, []);
});

test('checkRollup: a newer success does not hide an older failure', () => {
  const r = checkRollup([
    run('test', 'COMPLETED', 'FAILURE', T1),
    run('test', 'COMPLETED', 'SUCCESS', T2),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failing, ['test']);
});

test('checkRollup: a stale cancelled run next to a newer success still counts as failing', () => {
  const r = checkRollup([
    run('test', 'COMPLETED', 'CANCELLED', T1),
    run('test', 'COMPLETED', 'SUCCESS', T2),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failing, ['test']);
});

test('checkRollup: the same name can be listed twice when both items are non-green', () => {
  const r = checkRollup([
    run('test', 'COMPLETED', 'FAILURE', T1),
    run('test', 'COMPLETED', 'CANCELLED', T2),
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failing, ['test', 'test']);
});

test('checkRollup: a pending run with a year-one completedAt is pending', () => {
  const r = checkRollup([run('lint', 'IN_PROGRESS', '', YEAR_ONE, YEAR_ONE)]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending, ['lint']);
  assert.deepEqual(r.failing, []);
});

test('checkRollup: a queued run without times is pending', () => {
  const r = checkRollup([{ name: 'build', status: 'QUEUED', conclusion: null }]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.pending, ['build']);
});

test('checkRollup: nameless and null items fail as invalid-item', () => {
  const r = checkRollup([{ status: 'COMPLETED', conclusion: 'SUCCESS' }, null]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.failing, ['invalid-item', 'invalid-item']);
});

test('checkRollup: workflowName is shown in brackets when present', () => {
  const r = checkRollup([run('build', 'COMPLETED', 'FAILURE', T1, T1, { workflowName: 'CI' })]);
  assert.deepEqual(r.failing, ['build [CI]']);
});

test('checkRollup: status contexts SUCCESS is green, PENDING is pending, FAILURE and ERROR fail', () => {
  const good = checkRollup([ctx('ci/x', 'SUCCESS')]);
  assert.equal(good.ok, true);
  assert.equal(good.green, 1);

  const pend = checkRollup([ctx('ci/y', 'PENDING')]);
  assert.equal(pend.ok, false);
  assert.deepEqual(pend.pending, ['ci/y']);

  const bad = checkRollup([ctx('ci/z', 'FAILURE'), ctx('ci/w', 'ERROR')]);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.failing, ['ci/z', 'ci/w']);
});

test('checkRollup: neutral and skipped conclusions are green', () => {
  const r = checkRollup([
    run('a', 'COMPLETED', 'NEUTRAL'),
    run('b', 'COMPLETED', 'SKIPPED'),
  ]);
  assert.equal(r.ok, true);
  assert.equal(r.green, 2);
});

test('checkRollup: empty array is not ok with total 0', () => {
  const r = checkRollup([]);
  assert.equal(r.ok, false);
  assert.equal(r.total, 0);
});

test('checkRollup: non-array rollups are not ok with total 0', () => {
  for (const input of [null, undefined, {}, 'x']) {
    const r = checkRollup(input);
    assert.equal(r.ok, false);
    assert.equal(r.total, 0);
  }
});

// assertMergeable

test('assertMergeable: clean open PR on default branch with green checks is ok with no reasons', () => {
  const r = assertMergeable(prView(), { defaultBranch: 'main' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.reasons, []);
});

test('assertMergeable: pr-not-open', () => {
  const r = assertMergeable(prView({ state: 'CLOSED' }), { defaultBranch: 'main' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['pr-not-open']);
});

test('assertMergeable: has-conflicts', () => {
  const r = assertMergeable(prView({ mergeable: 'CONFLICTING' }), { defaultBranch: 'main' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['has-conflicts']);
});

test('assertMergeable: not-default-branch', () => {
  const r = assertMergeable(prView({ baseRefName: 'feature-parent' }), { defaultBranch: 'main' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['not-default-branch']);
});

test('assertMergeable: no-checks', () => {
  const r = assertMergeable(prView({ statusCheckRollup: [] }), { defaultBranch: 'main' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['no-checks']);
});

test('assertMergeable: failing: <names>', () => {
  const r = assertMergeable(
    prView({ statusCheckRollup: [run('build', 'COMPLETED', 'FAILURE')] }),
    { defaultBranch: 'main' },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['failing: build']);
});

test('assertMergeable: pending: <names>', () => {
  const r = assertMergeable(
    prView({ statusCheckRollup: [run('lint', 'IN_PROGRESS', '', '')] }),
    { defaultBranch: 'main' },
  );
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['pending: lint']);
});

test('assertMergeable: no-head when headRefOid is missing', () => {
  const view = prView();
  delete view.headRefOid;
  const r = assertMergeable(view, { defaultBranch: 'main' });
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, ['no-head']);
});

// parsePrArgument

test('parsePrArgument: plain number', () => {
  const r = parsePrArgument('123');
  assert.equal(r.number, 123);
  assert.ok(!r.repo);
});

test('parsePrArgument: hash-prefixed number', () => {
  const r = parsePrArgument('#123');
  assert.equal(r.number, 123);
  assert.ok(!r.repo);
});

test('parsePrArgument: full PR URL gives number and repo', () => {
  const r = parsePrArgument('https://github.com/octo/repo/pull/123');
  assert.equal(r.number, 123);
  assert.equal(r.repo, 'octo/repo');
});

test('parsePrArgument: unparseable text returns null', () => {
  assert.equal(parsePrArgument('abc'), null);
});

// runMerge

test('runMerge: happy path merges with exact arguments, then pulls with checkout using the double dash', async () => {
  const { exec, calls } = makeExec(routes());
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.pr, 123);
  assert.equal(r.localUpdate, 'pulled');

  const merges = mergeCalls(calls);
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].args, [
    'pr', 'merge', '123', '--squash', '--delete-branch', '--match-head-commit', 'abc123',
  ]);
  assert.equal(merges[0].command, 'gh');

  const checkout = calls.find((c) => c.command === 'git' && c.args[0] === 'checkout');
  assert.deepEqual(checkout.args, ['checkout', 'main', '--']);

  const pull = calls.find((c) => c.command === 'git' && c.args[0] === 'pull');
  assert.deepEqual(pull.args, ['pull', '--ff-only', 'origin', 'main']);

  assert.ok(calls.indexOf(merges[0]) < calls.indexOf(pull), 'merge must come before the local pull');
});

test('runMerge: a red check refuses with reasons and never calls merge', async () => {
  const { exec, calls } = makeExec(routes({
    view: { statusCheckRollup: [run('codeql', 'COMPLETED', 'FAILURE')] },
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(Array.isArray(r.reasons));
  assert.deepEqual(r.checks.failing, ['codeql']);
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: a pending check refuses and never calls merge', async () => {
  const { exec, calls } = makeExec(routes({
    view: { statusCheckRollup: [run('lint', 'IN_PROGRESS', '', '')] },
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.deepEqual(r.checks.pending, ['lint']);
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: no checks refuses and never calls merge', async () => {
  const { exec, calls } = makeExec(routes({ view: { statusCheckRollup: [] } }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.includes('no-checks'));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: a required context missing from the rollup is pending and refuses', async () => {
  const { exec, calls } = makeExec(routes({
    protection: json({ contexts: ['build', 'codeql'], checks: [] }),
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(JSON.stringify(r).includes('codeql'));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: a protection API error is skipped and reported as requiredChecks unknown', async () => {
  const { exec, calls } = makeExec(routes({ protection: fail('404 Not Found') }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.requiredChecks, 'unknown');
  assert.equal(mergeCalls(calls).length, 1);
});

test('runMerge: a null PR view is refused as pr-view-unparseable', async () => {
  const { exec, calls } = makeExec(routes({ rawView: ok('null') }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.includes('pr-view-unparseable'));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: mergeable UNKNOWN is retried 4 times 2 seconds apart, then refused', async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const { exec, calls } = makeExec(routes({ view: { mergeable: 'UNKNOWN' } }));
  const r = await runMerge('/repo', ['123'], { exec, sleep });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.includes('mergeable-unknown'));
  assert.equal(sleeps.length, 4);
  assert.ok(sleeps.every((ms) => ms === 2000));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: stacked open PRs refuse and never call merge', async () => {
  const { exec, calls } = makeExec(routes({ list: [{ number: 200 }] }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.some((x) => x.startsWith('stacked-prs-open') && x.includes('#200')));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: the stacked PR list carries the repo argument', async () => {
  const base = makeExec(routes());
  const listCalls = [];
  const exec = async (command, args, opts) => {
    if (command === 'gh' && args[0] === 'pr' && args[1] === 'list') {
      listCalls.push([...args]);
      return json([]);
    }
    return base.exec(command, args, opts);
  };
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(listCalls.length, 1);
  const i = listCalls[0].indexOf('--repo');
  assert.ok(i >= 0, 'pr list must get --repo');
  assert.equal(listCalls[0][i + 1], 'octo/repo');
});

test('runMerge: a non-default base refuses and never calls merge', async () => {
  const { exec, calls } = makeExec(routes({ view: { baseRefName: 'feature-parent' } }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.includes('not-default-branch'));
  assert.equal(mergeCalls(calls).length, 0);
});

test('runMerge: every refused flag is refused and never merges', async () => {
  for (const flag of ['--force', '--admin', '--skip-checks', '--no-checks', '--yes']) {
    const { exec, calls } = makeExec(routes());
    const r = await runMerge('/repo', ['123', flag], { exec, sleep: SLEEP });
    assert.notEqual(r.status, 'merged', 'flag ' + flag + ' must not merge');
    assert.ok(JSON.stringify(r).includes('merge-flag-refused'), 'flag ' + flag + ' must be refused');
    assert.equal(mergeCalls(calls).length, 0, 'flag ' + flag + ' must not call merge');
  }
});

test('runMerge: a bad --repo value is refused before any gh call', async () => {
  const { exec, calls } = makeExec(routes());
  const r = await runMerge('/repo', ['123', '--repo', 'bad'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'refused');
  assert.ok(r.reasons.includes('bad-repo'));
  assert.equal(calls.length, 0);
});

test('runMerge: a merge failure returns merge-failed with reasons', async () => {
  const { exec } = makeExec(routes({ merge: fail('merge rejected') }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merge-failed');
  assert.ok(Array.isArray(r.reasons));
  assert.ok(r.reasons.length > 0);
  assert.ok(r.reasons[0].includes('merge rejected'));
});

test('runMerge: a state that is not MERGED after the call returns merge-failed', async () => {
  const { exec } = makeExec(routes({ after: { state: 'OPEN' } }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merge-failed');
  assert.ok(Array.isArray(r.reasons));
});

test('runMerge: a remote naming another repository skips the local update without failing the merge', async () => {
  const { exec, calls } = makeExec(routes({ remote: 'git@github.com:other/project.git\n' }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localUpdate, 'skipped: this folder is another repository');
  assert.equal(calls.some((c) => c.command === 'git' && c.args[0] === 'pull'), false);
});

test('runMerge: a dirty work tree skips the local update without failing the merge', async () => {
  const { exec, calls } = makeExec(routes({ porcelain: ' M src/x.mjs\n' }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.ok(String(r.localUpdate).startsWith('skipped:'));
  assert.equal(calls.some((c) => c.command === 'git' && c.args[0] === 'pull'), false);
});

test('runMerge: unparsable worktree list keeps local branch and deletes remote ref with encoded path', async () => {
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: ok('not-a-worktree-block\n\n'),
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');

  const merges = mergeCalls(calls);
  assert.equal(merges.length, 1);
  assert.deepEqual(merges[0].args, [
    'pr', 'merge', '123', '--squash', '--match-head-commit', 'abc123',
  ]);
  assert.ok(!merges[0].args.includes('--delete-branch'));

  const prViews = calls.filter((c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view');
  assert.ok(prViews.some((c) => c.args.includes('--json') && c.args.includes(PR_VIEW_FIELDS)));

  const deletes = calls.filter((c) => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === '-X' && c.args[2] === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.deepEqual(deletes[0].args, [
    'api', '-X', 'DELETE', 'repos/octo/repo/git/refs/heads/feat',
  ]);
});

test('runMerge: failing worktree list keeps local branch and deletes remote ref', async () => {
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: fail('worktree list failed'),
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  assert.equal(mergeCalls(calls).length, 1);
  assert.ok(!mergeCalls(calls)[0].args.includes('--delete-branch'));
  assert.equal(
    calls.filter(
      (c) => c.command === 'gh' && c.args[0] === 'api' && c.args[2] === 'DELETE' && c.args[3] === 'repos/octo/repo/git/refs/heads/feat',
    ).length,
    1,
  );
});

test('runMerge: head branch checked out in a state-holding worktree keeps local branch', async () => {
  const wtPath = '/repo/.swarm/worktrees/wt-1';
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: ok(worktreePorcelain('/repo', 'refs/heads/main') + worktreePorcelain(wtPath, 'refs/heads/feat')),
  }));
  const holdsSwarmState = async (path) => path === wtPath;
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP, holdsSwarmState });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  assert.deepEqual(mergeCalls(calls)[0].args, [
    'pr', 'merge', '123', '--squash', '--match-head-commit', 'abc123',
  ]);
  assert.equal(
    calls.filter(
      (c) => c.command === 'gh' && c.args[0] === 'api' && c.args[2] === 'DELETE' && c.args[3] === 'repos/octo/repo/git/refs/heads/feat',
    ).length,
    1,
  );
});

test('runMerge: cross-repository PR keeps local branch without remote ref delete', async () => {
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: fail('worktree list failed'),
    view: { isCrossRepository: true },
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  assert.ok(!mergeCalls(calls)[0].args.includes('--delete-branch'));
  assert.equal(
    calls.filter((c) => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === '-X').length,
    0,
  );
});

test('runMerge: missing isCrossRepository skips remote ref delete when local branch is kept', async () => {
  const view = prView();
  delete view.isCrossRepository;
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: fail('worktree list failed'),
    rawView: json(view),
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  assert.equal(
    calls.filter((c) => c.command === 'gh' && c.args[0] === 'api' && c.args[1] === '-X').length,
    0,
  );
});

test('runMerge: remote delete encodes each ref segment separately', async () => {
  const slashBranch = 'feat/with/slash';
  const { exec, calls } = makeExec(routes({
    keepLocalHeadBranch: true,
    worktree: ok('not-a-worktree-block\n\n'),
    view: { headRefName: slashBranch },
    list: [],
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  const deletes = calls.filter((c) => c.command === 'gh' && c.args[0] === 'api' && c.args[2] === 'DELETE');
  assert.equal(deletes.length, 1);
  assert.equal(deletes[0].args[3], `repos/octo/repo/git/refs/heads/${encodeRefPath(slashBranch)}`);
});

const RESULT_PATH = 'coordination/review/train5-review.json';
const RECORD_PATH = 'coordination/review/train5-review-run.json';
const MARKER = '<!-- swarm-review: ' + RESULT_PATH + ' -->';
const FENCE = '`'.repeat(3);
const LONG_FENCE = '`'.repeat(4);
const contentsKey = (file, head = HEAD_SHA) => 'gh api repos/octo/repo/contents/' + file + '?ref=' + head;
const commitKey = (head = HEAD_SHA) => 'gh api repos/octo/repo/commits/' + head;
const compareKey = (parent = OTHER_SHA, head = HEAD_SHA) => 'gh api repos/octo/repo/compare/' + parent + '...' + head;
const contentResponse = (bytes) => json({ encoding: 'base64', content: Buffer.from(bytes).toString('base64') });
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

async function releaseFixture(t, o = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-merge-review-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const result = o.resultBytes ?? JSON.stringify({ verdict: 'pass', head: OTHER_SHA, ...o.result });
  const record = {
    version: 1, runId: 'review-5', jobId: 'review', agent: 'claude', model: 'claude-opus-4-6',
    head: OTHER_SHA, status: 'complete', resultFile: RESULT_PATH, resultHash: hash(result),
    manifest: '.swarm/runs/review-5/manifest.json', finishedAt: T1,
    stateFile: '.swarm/runs/review-5/state.json', ...o.record,
  };
  const state = {
    status: 'complete', baseCommit: OTHER_SHA,
    jobs: [{ id: 'review', status: 'complete', agent: 'claude', model: 'claude-opus-4-6' }],
    ...o.state,
  };
  const writeRun = async (id, recordValue, stateValue, recordBytes, stateBytes) => {
    const dir = path.join(root, '.swarm/runs', id);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'review-record.json'), recordBytes ?? JSON.stringify(recordValue));
    if (stateValue !== undefined) await fs.writeFile(path.join(dir, 'state.json'), stateBytes ?? JSON.stringify(stateValue));
  };
  // A newer unrelated sibling must never supply the selected review or its hash.
  await writeRun('sibling', {
    ...record, runId: 'sibling', head: HEAD_SHA, resultFile: 'coordination/review/other-review.json',
    resultHash: '0'.repeat(64), finishedAt: T2, stateFile: '.swarm/runs/sibling/state.json',
  }, { ...state, baseCommit: HEAD_SHA });
  if (!o.noRecord) await writeRun('review-5', record, o.noState ? undefined : state, o.recordBytes, o.stateBytes);
  for (const sibling of o.siblings ?? []) {
    const id = sibling.id;
    await writeRun(id, {
      ...record, runId: id, manifest: '.swarm/runs/' + id + '/manifest.json',
      stateFile: '.swarm/runs/' + id + '/state.json', ...sibling.record,
    }, { ...state, ...sibling.state });
  }
  const view = { title: '1.0.0: x', headRefOid: HEAD_SHA, body: MARKER, ...o.view };
  const head = view.headRefOid;
  const rs = routes({ view }, root);
  rs[commitKey(head)] = o.commitResponse ?? json({ parents: [{ sha: OTHER_SHA }] });
  rs[compareKey(OTHER_SHA, head)] = o.compareResponse ?? json({ files: [{ filename: RESULT_PATH, status: 'added' }] });
  rs[contentsKey(RESULT_PATH, head)] = o.resultResponse ?? contentResponse(result);
  // A legacy committed record is available, but must never be trusted or fetched.
  rs[contentsKey(RECORD_PATH, head)] = contentResponse(JSON.stringify({ ...record, verdict: 'pass' }));
  return { root, ...makeExec(rs) };
}

async function checkRelease(t, o = {}, reason) {
  const { root, exec, calls } = await releaseFixture(t, o);
  const r = await runMerge(root, ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, reason ? 'refused' : 'merged', JSON.stringify(r));
  if (reason) assert.ok(r.reasons.includes(reason), JSON.stringify(r));
  assert.equal(mergeCalls(calls).length, reason ? 0 : 1, 'refusals must precede gh pr merge');
  assert.equal(calls.some((c) => [c.command, ...c.args].join(' ') === contentsKey(RECORD_PATH)), false);
  return { r, calls };
}

test('releaseReviewGate: non-release title is not required', async () => {
  const r = await releaseReviewGate({ title: 'Fix the widget', body: '', headRefOid: HEAD_SHA });
  assert.deepEqual(r, { required: false, ok: true });
});

test('runMerge: local completed Opus review and metadata-only result commit merge', async (t) => {
  const { calls } = await checkRelease(t);
  for (const key of [contentsKey(RESULT_PATH), commitKey(), compareKey()]) {
    assert.ok(calls.some((c) => [c.command, ...c.args].join(' ') === key), key);
  }
});

for (const title of ['v1.168.0 - ship', '  V1.168.0 - ship', ' Release 1.2.3', 'release 1.2.3']) {
  test('runMerge: release title ' + JSON.stringify(title) + ' requires a selector', async (t) => {
    await checkRelease(t, { view: { title, body: '' } }, 'marker-missing');
  });
}

for (const [name, options, reason] of [
  ['missing selector', { view: { body: 'pass' } }, 'marker-missing'],
  ['null body', { view: { body: null } }, 'marker-missing'],
  ['multiline selector', { view: { body: '<!-- swarm-review:\n' + RESULT_PATH + ' -->' } }, 'marker-missing'],
  ['inline selector', { view: { body: 'Ship it. ' + MARKER } }, 'marker-missing'],
  ['typed JSON verdict', { noRecord: true, view: { body: [FENCE + 'json', JSON.stringify({ verdict: 'pass', head: HEAD_SHA }), FENCE].join('\n') } }, 'marker-missing'],
  ['legacy committed record selector', { noRecord: true, view: { body: '<!-- swarm-review-run: ' + RECORD_PATH + ' -->' } }, 'marker-missing'],
  ['committed record without local run', { noRecord: true }, 'review-run-record-missing'],
  ['typed JSON alongside selector without local run', { noRecord: true, view: { body: [MARKER, FENCE + 'json', '{"verdict":"pass"}', FENCE].join('\n') } }, 'review-run-record-missing'],
  ['malformed local record', { recordBytes: '{bad' }, 'review-run-record-missing'],
  ['null local record', { recordBytes: 'null' }, 'review-run-record-missing'],
  ['record for another head', { record: { head: HEAD_SHA } }, 'review-run-record-missing'],
  ['record for another result', { record: { resultFile: 'coordination/review/another-review.json' } }, 'review-run-record-missing'],
  ['non-Opus model', { record: { model: 'sonnet' } }, 'review-run-model-not-opus'],
  ['missing model', { record: { model: null } }, 'review-run-model-not-opus'],
  ['wrong agent', { record: { agent: 'codex' } }, 'review-run-model-not-opus'],
  ['incomplete record', { record: { status: 'running' } }, 'review-run-state-mismatch'],
  ['wrong record version', { record: { version: 2 } }, 'review-run-state-mismatch'],
  ['invalid finish time', { record: { finishedAt: 'later' } }, 'review-run-state-mismatch'],
  ['missing state', { noState: true }, 'review-run-state-mismatch'],
  ['malformed state', { stateBytes: '{bad' }, 'review-run-state-mismatch'],
  ['incomplete state', { state: { status: 'running' } }, 'review-run-state-mismatch'],
  ['state for another head', { state: { baseCommit: HEAD_SHA } }, 'review-run-state-mismatch'],
  ['missing jobs', { state: { jobs: null } }, 'review-run-state-mismatch'],
  ['no matching job', { state: { jobs: [{ id: 'other', status: 'complete', agent: 'claude', model: 'claude-opus-4-6' }] } }, 'review-run-state-mismatch'],
  ['incomplete job', { state: { jobs: [{ id: 'review', status: 'running', agent: 'claude', model: 'claude-opus-4-6' }] } }, 'review-run-state-mismatch'],
  ['different job agent', { state: { jobs: [{ id: 'review', status: 'complete', agent: 'codex', model: 'claude-opus-4-6' }] } }, 'review-run-state-mismatch'],
  ['different job model', { state: { jobs: [{ id: 'review', status: 'complete', agent: 'claude', model: 'other-opus' }] } }, 'review-run-state-mismatch'],
  ['unsafe state path', { record: { stateFile: '../state.json' } }, 'review-run-state-mismatch'],
  ['another run state path', { record: { stateFile: '.swarm/runs/sibling/state.json' } }, 'review-run-state-mismatch'],
  ['mismatched run id', { record: { runId: 'sibling' } }, 'review-run-state-mismatch'],
  ['code in result commit', { compareResponse: json({ files: [{ filename: RESULT_PATH }, { filename: 'src/code.mjs' }] }) }, 'result-not-metadata-commit'],
  ['committed record in result commit', { compareResponse: json({ files: [{ filename: RESULT_PATH }, { filename: RECORD_PATH }] }) }, 'result-not-metadata-commit'],
  ['renamed code in result commit', { compareResponse: json({ files: [{ filename: RESULT_PATH, previous_filename: 'src/code.mjs', status: 'renamed' }] }) }, 'result-not-metadata-commit'],
  ['wrong result in compare', { compareResponse: json({ files: [{ filename: 'coordination/review/other-review.json' }] }) }, 'result-not-metadata-commit'],
  ['deleted result', { compareResponse: json({ files: [{ filename: RESULT_PATH, status: 'removed' }] }) }, 'result-not-metadata-commit'],
  ['missing changed files', { compareResponse: json({ files: [] }) }, 'result-not-metadata-commit'],
  ['malformed commit', { commitResponse: ok('{bad') }, 'result-not-metadata-commit'],
  ['multiple parents', { commitResponse: json({ parents: [{ sha: OTHER_SHA }, { sha: HEAD_SHA }] }) }, 'result-not-metadata-commit'],
  ['no parents', { commitResponse: json({ parents: [] }) }, 'result-not-metadata-commit'],
  ['short parent SHA', { commitResponse: json({ parents: [{ sha: 'abc123' }] }) }, 'result-not-metadata-commit'],
  ['short PR head', { view: { headRefOid: 'abc123' } }, 'result-not-metadata-commit'],
  ['commit fetch failure', { commitResponse: fail() }, 'result-not-metadata-commit'],
  ['compare fetch failure', { compareResponse: fail() }, 'result-not-metadata-commit'],
  ['compare parse failure', { compareResponse: ok('{bad') }, 'result-not-metadata-commit'],
  ['wrong hash', { record: { resultHash: '0'.repeat(64) } }, 'result-hash-mismatch'],
  ['malformed hash', { record: { resultHash: 'xyz' } }, 'result-hash-mismatch'],
  ['result fetch failure', { resultResponse: fail() }, 'result-hash-mismatch'],
  ['invalid base64', { resultResponse: json({ encoding: 'base64', content: '!!!!' }) }, 'result-hash-mismatch'],
  ['wrong contents encoding', { resultResponse: json({ encoding: 'utf8', content: '{}' }) }, 'result-hash-mismatch'],
  ['result verdict fail', { result: { verdict: 'fail' } }, 'result-verdict'],
  ['uppercase result verdict', { result: { verdict: 'PASS' } }, 'result-verdict'],
  ['result head mismatch', { result: { head: HEAD_SHA } }, 'result-head-mismatch'],
  ['result short head', { result: { head: OTHER_SHA.slice(0, 7) } }, 'result-head-mismatch'],
  ['result null head', { result: { head: null } }, 'result-head-mismatch'],
  ['malformed result', { resultBytes: '{bad json' }, 'result-verdict'],
  ['null result', { resultBytes: 'null' }, 'result-verdict'],
]) {
  test('runMerge: release refuses ' + name + ' before merging', async (t) => { await checkRelease(t, options, reason); });
}

for (const file of ['../train5-review.json', '/coordination/review/train5-review.json', 'coordination/review/../train5-review.json', 'coordination/review/%2e%2e/train5-review.json', 'coordination/review/train5-review-run.json', 'coordination/review/x\\train5-review.json', 'coordination/review/.json']) {
  test('runMerge: unsafe selector path ' + file + ' refuses', async (t) => {
    await checkRelease(t, { view: { body: '<!-- swarm-review: ' + file + ' -->' } }, 'selector-malformed');
  });
}

test('runMerge: result head may be absent and bytes are hashed without normalization', async (t) => {
  await checkRelease(t, { resultBytes: '{\r\n  "verdict": "pass"\r\n}\r\n' });
});

test('runMerge: selectors work anywhere in the body outside fenced blocks', async (t) => {
  await checkRelease(t, { view: { body: MARKER + '\n## Reviews\nnone' } });
});

for (const fence of [FENCE, '~~~~', '    ' + LONG_FENCE, '  ~~~~~']) {
  test('runMerge: ' + JSON.stringify(fence) + ' fences hide fake selectors', async (t) => {
    const body = [fence + 'markdown', MARKER, fence, fence + 'text', '<!-- swarm-review: bad -->', fence, MARKER].join('\r\n');
    await checkRelease(t, { view: { body } });
    await checkRelease(t, { view: { body: [fence, MARKER, fence].join('\r\n') } }, 'marker-missing');
  });
}

test('runMerge: shorter or different fence delimiter does not close a fence', async (t) => {
  await checkRelease(t, { view: { body: [LONG_FENCE, FENCE, '~~~', MARKER, LONG_FENCE].join('\n') } }, 'marker-missing');
});

test('runMerge: duplicate selectors refuse', async (t) => {
  await checkRelease(t, { view: { body: MARKER + '\n' + MARKER } }, 'selector-malformed');
});

test('runMerge: latest matching completed run supplies the hash', async (t) => {
  await checkRelease(t, { record: { resultHash: '0'.repeat(64) }, siblings: [
    { id: 'newer', record: { finishedAt: T2, resultHash: hash(JSON.stringify({ verdict: 'pass', head: OTHER_SHA })) } },
  ] });
  await checkRelease(t, { siblings: [
    { id: 'newer', record: { finishedAt: T2, resultHash: '0'.repeat(64) } },
  ] }, 'result-hash-mismatch');
});

test('runMerge: job maps may include unrelated incomplete jobs', async (t) => {
  await checkRelease(t, { state: { jobs: {
    review: { id: 'review', status: 'complete', agent: 'claude', model: 'claude-opus-4-6' },
    other: { id: 'other', status: 'running', agent: 'codex', model: 'other' },
  } } });
});

test('runMerge: completed job actualModel can match the runner record', async (t) => {
  await checkRelease(t, { state: { jobs: [{ id: 'review', status: 'complete', agent: 'claude', model: null, actualModel: 'claude-opus-4-6' }] } });
});

test('runMerge: non-release title merges without review API calls', async () => {
  const { exec, calls } = makeExec(routes());
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(calls.some((c) => c.args[1]?.match(/\/(contents|commits|compare)\//)), false);
});
