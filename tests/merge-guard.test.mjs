import test from 'node:test';
import assert from 'node:assert/strict';
import { checkRollup, assertMergeable, parsePrArgument, runMerge } from '../tools/merge-guard.mjs';

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
const CROSS_REPO = 'gh pr view 123 --json isCrossRepository';
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

const KEY = {
  repo: 'gh repo view --json defaultBranchRef,nameWithOwner',
  view: 'gh pr view 123 --json state,mergeable,baseRefName,headRefName,headRefOid,statusCheckRollup',
  after: 'gh pr view 123 --json state',
  merge: 'gh pr merge 123 --squash --delete-branch --match-head-commit abc123',
  mergeKeepLocal: 'gh pr merge 123 --squash --match-head-commit abc123',
};

function prView(over = {}) {
  return {
    state: 'OPEN',
    mergeable: 'MERGEABLE',
    baseRefName: 'main',
    headRefName: 'feat',
    headRefOid: 'abc123',
    statusCheckRollup: GREEN,
    ...over,
  };
}

function routes(o = {}, root = '/repo') {
  const headBranch = o.view?.headRefName ?? 'feat';
  const deleteKey = remoteDeleteKey(headBranch);
  const base = {
    [KEY.repo]: json({ defaultBranchRef: { name: 'main' }, nameWithOwner: 'octo/repo' }),
    [KEY.view]: o.rawView ?? json(prView(o.view)),
    [prListKey(headBranch)]: json(o.list ?? []),
    [KEY.merge]: o.merge ?? ok(''),
    [KEY.after]: json(o.after ?? { state: 'MERGED' }),
    [PROTECTION]: o.protection ?? fail('404 Not Found'),
    [REMOTE]: ok(o.remote ?? 'git@github.com:octo/repo.git\n'),
    [WORKTREE]: o.worktree ?? ok(worktreePorcelain(root)),
    [CROSS_REPO]: o.crossRepo ?? json({ isCrossRepository: false }),
    [deleteKey]: o.remoteDelete ?? ok(''),
    'git rev-parse --is-inside-work-tree': ok('true\n'),
    'git status --porcelain': ok(o.porcelain ?? ''),
    'git fetch origin': ok(''),
    'git checkout main --': ok(''),
    'git pull --ff-only origin main': ok(''),
  };
  if (o.keepLocalHeadBranch) {
    base[KEY.mergeKeepLocal] = o.merge ?? ok('');
    delete base[KEY.merge];
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

  const cross = calls.filter(
    (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('isCrossRepository'),
  );
  assert.equal(cross.length, 1);

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
    crossRepo: json({ isCrossRepository: true }),
  }));
  const r = await runMerge('/repo', ['123'], { exec, sleep: SLEEP });
  assert.equal(r.status, 'merged');
  assert.equal(r.localBranch, 'kept');
  assert.ok(!mergeCalls(calls)[0].args.includes('--delete-branch'));
  assert.equal(
    calls.filter(
      (c) => c.command === 'gh' && c.args[0] === 'pr' && c.args[1] === 'view' && c.args.includes('isCrossRepository'),
    ).length,
    1,
  );
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
