// SPDX-License-Identifier: Apache-2.0
import './_isolate-config.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardDecision } from '../tools/handbuild.mjs';
import { HANDBUILD_OWNER_RULE_ID } from '../tools/self-approval.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const SWARM_SCRIPT = path.join(process.cwd(), 'tools', 'swarm.mjs');

const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-ro-guard-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('remote', 'add', 'origin', root);
  const branchOfFn = () => 'main';
  const env = { HOME: root, USERPROFILE: root };
  const decide = (command, extra = {}) => guardDecision({
    tool: 'Bash',
    toolInput: { command },
    root,
    cwd: root,
    now: () => T0,
    branchOf: branchOfFn,
    home: root,
    ...extra,
  });
  return { root, decide, env, branchOfFn };
}

function runGuardHook(root, toolInput, env) {
  const input = JSON.stringify({
    tool_name: 'Bash',
    tool_input: toolInput,
    cwd: root,
  });
  return spawnSync(process.execPath, [path.join(process.cwd(), 'tools', 'handbuild-guard.mjs')], {
    input,
    encoding: 'utf8',
    env: { ...env, CLAUDE_PROJECT_DIR: root },
  });
}

const ALLOW_GIT = [
  'git rev-parse HEAD',
  'git rev-parse --abbrev-ref HEAD',
  'git rev-parse --git-dir',
  'git rev-parse --show-toplevel',
  'git rev-parse --short HEAD',
  'git branch --show-current',
  'git branch',
  'git branch -l',
  'git branch --list',
  'git branch -a',
  'git branch -r',
  'git branch -v',
  'git branch -vv',
  'git branch --contains HEAD',
  'git branch --merged main',
  'git branch --no-merged main',
  'git branch --format="%(refname:short)"',
  'git branch --sort=-committerdate',
  'git branch --list "feature/*"',
  'git remote -v',
  'git remote show origin',
  'git remote get-url origin',
  'git config --get user.name',
  'git config --get-all user.email',
  'git config --get-regexp user',
  'git config --list',
  'git config -l',
  'git config --show-origin user.name',
  'git config user.email',
  'git ls-files',
  'git ls-remote origin',
  'git ls-tree HEAD',
  'git describe --tags',
  'git for-each-ref refs/heads',
  'git merge-base main HEAD',
  'git cat-file -p HEAD',
  'git blame src/a.ts',
  'git tag',
  'git tag -l',
  'git tag --list',
  'git stash list',
  'git stash show',
  'git worktree list',
  'git rev-list HEAD',
  'git symbolic-ref HEAD',
  'git show-ref',
  'git name-rev HEAD',
  'git shortlog -sn',
  'git count-objects -v',
  'git diff-tree HEAD',
  'git grep foo',
  'git check-ignore src',
  'git var GIT_COMMITTER_IDENT',
  'git version',
  'git --version',
  'git help branch',
  'git -C . rev-parse HEAD',
  'git --no-pager log -1',
  'cd . && git status',
  'git status | head -5',
  'git log -1 | jq .message',
  'git -C . branch --show-current',
  'git --no-pager diff HEAD~1',
  'gh api repos/o/r --jq ".name"',
  'gh api "/repos/o/r/issues?state=open&per_page=1"',
];

const ALLOW_GH = [
  'gh pr view 1',
  'gh pr list',
  'gh pr status',
  'gh pr diff 1',
  'gh pr checks 1',
  'gh issue view 2',
  'gh issue list',
  'gh issue status',
  'gh run view 3',
  'gh run list',
  'gh run status',
  'gh release list',
  'gh release view v1',
  'gh workflow list',
  'gh workflow view ci.yml',
  'gh repo view',
  'gh search repos swarm',
  'gh auth status',
  'gh --version',
  'gh api repos/o/r',
  'gh api repos/o/r -q .name',
  'gh api repos/o/r --paginate',
  'gh api -H "Accept: application/json" repos/o/r',
];

const ALLOW_VERCEL = [
  'vercel ls',
  'vercel list',
  'vercel inspect dep_abc123',
  'vercel inspect https://x.vercel.app --logs',
  'vercel inspect dep_x --wait --timeout 60',
  'vercel inspect dep_x --scope team',
  'vercel inspect dep_x -S team',
  'vercel git ls',
  'vercel git ls --scope team',
  'vercel whoami',
  'vercel --version',
  'vercel project ls',
  'vercel domains ls',
  'vercel env ls',
  'vercel logs dep_abc',
];

const ALLOW_NODE_HANDBUILD = [
  `node ${SWARM_SCRIPT} handbuild request --kind tiny --reason "needs orchestrator filing" --files src/a.ts --minutes 10`,
  `node ${SWARM_SCRIPT} --root /tmp/p handbuild request --kind secret --reason "needs it now" --files src/a.ts --minutes 15`,
  `node ${SWARM_SCRIPT} handbuild status`,
  `node ${SWARM_SCRIPT} handbuild show`,
  `node ${SWARM_SCRIPT} handbuild list`,
  `env FOO=1 node ${SWARM_SCRIPT} handbuild status`,
  `cd ${process.cwd()} && node tools/swarm.mjs handbuild request --kind tiny --reason "cd prefix ok" --files src/a.ts --minutes 5`,
];

const BLOCK_GIT = [
  'git branch new-feature',
  'git branch -D old',
  'git branch -m old new',
  'git branch -M main',
  'git branch -c a b',
  'git branch -C a b',
  'git branch -u origin/x',
  'git branch --set-upstream-to=origin/main',
  'git branch --unset-upstream',
  'git config user.name bot',
  'git config --global user.name bot',
  'git config --unset user.name',
  'git config --add core.filemode false',
  'git config --replace-all user.name x',
  'git config -e',
  'git tag v1.0',
  'git tag -d v1',
  'git tag -a v2 -m m',
  'git stash push',
  'git stash save',
  'git stash pop',
  'git stash apply',
  'git stash drop',
  'git stash clear',
  'git stash branch tmp',
  'git worktree add ../wt',
  'git worktree remove ../wt',
  'git worktree prune',
  'git worktree move ../wt ../wt2',
  'git worktree lock wt',
  'git remote add o2 /tmp/r',
  'git remote remove origin',
  'git remote rename origin upstream',
  'git remote set-url origin /x',
  'git remote prune origin',
  'git symbolic-ref HEAD refs/heads/main refs/heads/x',
  'git symbolic-ref -d HEAD',
  'git push origin main',
  'git commit -m x',
  'git reset --hard',
  'git reset --hard HEAD',
  'git restore src/a.ts',
  'git clean -fd',
  'git rebase main',
  'git merge main',
  'git cherry-pick HEAD',
  'git revert HEAD',
];

const BLOCK_GH = [
  'gh pr merge 1',
  'gh api -X POST repos/o/r/issues',
  'gh api repos/o/r -X PUT',
  'gh api --method DELETE repos/o/r',
  'gh api repos/o/r -f title=x',
  'gh api graphql -f query="{}"',
  'gh issue create --title t',
  'gh issue comment 1 --body x',
  'gh issue close 1',
  'gh issue edit 1 --title x',
  'gh issue delete 1',
  'gh release create v1',
  'gh release delete v1',
  'gh release upload v1 x.tgz',
  'gh repo create x',
  'gh repo delete o/r',
  'gh repo edit --description x',
  'gh repo fork o/r',
  'gh workflow run ci.yml',
  'gh workflow enable ci.yml',
  'gh workflow disable ci.yml',
  'gh run rerun 1',
  'gh run cancel 1',
  'gh run delete 1',
  'gh auth login',
  'gh auth logout',
  'gh auth refresh',
  'gh auth token',
  'gh secret set X',
  'gh variable set X',
  'gh pr view 1 --web',
  'gh run download 1',
  'git status | sh -c "echo pwned"',
  'git status | bash -c "echo pwned"',
];

const BLOCK_VERCEL = [
  'vercel git connect',
  'vercel git disconnect',
  'vercel deploy',
  'vercel --prod',
  'vercel rm dep',
  'vercel remove dep',
  'vercel promote dep',
  'vercel rollback dep',
  'vercel env pull',
  'vercel env add NAME',
  'vercel env rm NAME',
  'vercel link',
  'vercel unlink',
  'vercel login',
  'vercel logout',
  'vercel switch',
  'vercel dev',
  'vercel build',
  'vercel pull',
  'vercel redeploy dep',
  'vercel alias set x y',
  'vercel domains add x.com',
  'vercel domains rm x.com',
  'vercel ls | sh',
  'vercel --token abc ls',
];

const BLOCK_NODE_HANDBUILD = [
  `node ${SWARM_SCRIPT} handbuild approve hb-abc`,
  `node ${SWARM_SCRIPT} handbuild deny hb-abc`,
  `node ${SWARM_SCRIPT} handbuild on`,
  `node ${SWARM_SCRIPT} handbuild off`,
  `node ${SWARM_SCRIPT} handbuild install`,
  `node ${SWARM_SCRIPT} handbuild uninstall`,
  `node ${SWARM_SCRIPT} decide handbuild-hb-9 approve`,
];

const ALL_ALLOW = [...ALLOW_GIT, ...ALLOW_GH, ...ALLOW_VERCEL, ...ALLOW_NODE_HANDBUILD];
const ALL_BLOCK = [...BLOCK_GIT, ...BLOCK_GH, ...BLOCK_VERCEL, ...BLOCK_NODE_HANDBUILD];

test('read-only allow table (guardDecision)', async t => {
  assert.ok(ALL_ALLOW.length >= 70, `expected >=70 allow cases, got ${ALL_ALLOW.length}`);
  const { decide } = await project(t);
  for (const cmd of ALL_ALLOW) {
    const d = decide(cmd);
    assert.equal(d.allow, true, cmd);
  }
});

test('read-only block table (guardDecision)', async t => {
  assert.ok(ALL_BLOCK.length >= 50, `expected >=50 block cases, got ${ALL_BLOCK.length}`);
  const { decide } = await project(t);
  for (const cmd of ALL_BLOCK) {
    const d = decide(cmd);
    assert.equal(d.allow, false, cmd);
  }
});

test('node-form handbuild owner actions use owner-verb rule id', async t => {
  const { decide } = await project(t);
  for (const cmd of BLOCK_NODE_HANDBUILD) {
    const d = decide(cmd);
    assert.equal(d.allow, false, cmd);
    assert.equal(d.ruleId, HANDBUILD_OWNER_RULE_ID, cmd);
    assert.match(d.reason, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));
  }
});

for (const claudeFlag of [undefined, '1']) {
  test(`handbuild-guard hook e2e (CLAUDECODE=${claudeFlag ?? 'unset'})`, async t => {
    const { root, env } = await project(t);
    const baseEnv = { ...env, PATH: process.env.PATH ?? '/usr/bin:/bin' };
    if (claudeFlag !== undefined) baseEnv.CLAUDECODE = claudeFlag;

    const allowed = runGuardHook(root, { command: 'git rev-parse HEAD' }, baseEnv);
    assert.equal(allowed.stdout.trim(), '', 'allowed read should print nothing');

    const blocked = runGuardHook(root, { command: 'git commit -m x' }, baseEnv);
    assert.match(blocked.stdout, /permissionDecision":"deny"/);
    assert.match(blocked.stdout, /write a ticket instead/);

    const nodeReq = runGuardHook(root, { command: ALLOW_NODE_HANDBUILD[0] }, baseEnv);
    assert.equal(nodeReq.stdout.trim(), '', 'node handbuild request allowed');

    const nodeDeny = runGuardHook(root, { command: BLOCK_NODE_HANDBUILD[0] }, baseEnv);
    assert.match(nodeDeny.stdout, /permissionDecision":"deny"/);
    assert.match(nodeDeny.stdout, new RegExp(`\\[${HANDBUILD_OWNER_RULE_ID}\\]`));

    const vercelBlock = runGuardHook(root, { command: 'vercel deploy' }, baseEnv);
    assert.match(vercelBlock.stdout, /permissionDecision":"deny"/);

    const pipeSh = runGuardHook(root, { command: 'git status | sh -c "id"' }, baseEnv);
    assert.match(pipeSh.stdout, /permissionDecision":"deny"/);
  });
}
