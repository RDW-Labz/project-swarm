// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  guardDecision,
  createRequest,
  decideRequest,
  recordChatMerge,
  mergeSwarmPrStandingEnabled,
  GH_PR_MERGE_BLOCKED,
  MERGE_BLOCKED_REASON,
} from '../tools/handbuild.mjs';

const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const T1 = T0 + 5000;
const tmp = async t => {
  const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-vm-')));
  t.after(() => fs.rm(d, { recursive: true, force: true }));
  return d;
};

async function project(t, { policy = null } = {}) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'x.mjs'), 'x\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const baseRef = git('rev-parse', 'HEAD').stdout.trim();
  git('branch', '-q', 'main', baseRef);
  git('checkout', '-q', '-b', 'feature/x');
  git('remote', 'add', 'origin', root);
  git('update-ref', 'refs/remotes/origin/main', baseRef);

  const policyPath = path.join(root, 'policy.json');
  let policyFile = policyPath;
  if (policy !== null) {
    await fs.writeFile(policyPath, JSON.stringify(policy));
  }

  const branchOfFn = () => 'feature/x';
  const bash = (command, extra = {}) => {
    const env = { ...process.env, SWARM_POLICY_FILE: policyFile };
    return guardDecision({
      tool: 'Bash',
      toolInput: { command },
      root,
      cwd: root,
      now: () => T0,
      branchOf: branchOfFn,
      home: root,
      ...extra,
      // guardDecision uses home for policy path; override via env only
    });
  };
  // Policy reads policyFilePath(home) — use SWARM_POLICY_FILE in process.env during decision
  const bashWithPolicy = (command, extra = {}) => {
    const prev = process.env.SWARM_POLICY_FILE;
    process.env.SWARM_POLICY_FILE = policyFile;
    try {
      return guardDecision({
        tool: 'Bash',
        toolInput: { command },
        root,
        cwd: root,
        now: () => T0,
        branchOf: branchOfFn,
        ...extra,
      });
    } finally {
      if (prev === undefined) delete process.env.SWARM_POLICY_FILE;
      else process.env.SWARM_POLICY_FILE = prev;
    }
  };

  return { root, bash: bashWithPolicy, policyPath, setPolicy: async obj => {
    if (obj === null) {
      policyFile = path.join(root, 'missing-policy.json');
      return;
    }
    await fs.writeFile(policyPath, JSON.stringify(obj));
    policyFile = policyPath;
  } };
}

test('vercel read-only commands are free', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'vercel ls',
    'vercel list',
    'vercel logs https://x.vercel.app',
    'vercel inspect dpl_abc',
    'vercel env ls',
    'vercel domains ls',
    'vercel projects ls',
    'vercel teams ls',
    'vercel whoami',
    'vercel --version',
    'vercel help',
    'vercel -h',
  ]) {
    assert.equal(bash(cmd).allow, true, cmd);
  }
});

test('vercel scope and token flags are deploy-like, not free', async t => {
  const { bash } = await project(t);
  for (const cmd of ['vercel --scope=team', 'vercel --token x', 'vercel --scope team']) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, /deploy|ticket/i, cmd);
  }
  assert.equal(bash('vercel --version').allow, true);
  assert.equal(bash('vercel -v').allow, true);
});

test('vercel deploy and mutating commands stay blocked', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'vercel',
    'vercel --prod',
    'vercel deploy',
    'vercel promote https://x.vercel.app',
    'vercel rm my-app',
    'vercel env pull',
    'vercel env add SECRET',
    'vercel domains add example.com',
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, /deploy|ticket/i, cmd);
  }
});

test('gh pr merge with repo flags is always blocked; use swarm merge', async t => {
  const { bash, root, setPolicy } = await project(t, {
    policy: { rules: [{ id: 'merge-swarm-pr', enabled: true }] },
  });
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from here today', files: 'src/x.mjs', git: 'merge', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0, channel: 'computer' });
  for (const cmd of ['gh -R owner/repo pr merge 12', 'gh --repo x pr merge 12']) {
    const d = bash(cmd, { now: () => T0 + 5000 });
    assert.equal(d.allow, false, cmd);
    assert.equal(d.reason, GH_PR_MERGE_BLOCKED, cmd);
    assert.match(d.reason, /use swarm merge/i);
  }
});

test('gh pr merge is always blocked; use swarm merge', async t => {
  const { bash, root, setPolicy } = await project(t, {
    policy: { rules: [{ id: 'merge-swarm-pr', enabled: true }] },
  });
  recordChatMerge(root, 12, { now: () => T0 });
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from here today', files: 'src/x.mjs', git: 'merge', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0, channel: 'computer' });

  for (const extra of [
    () => {},
    async () => { await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: true }] }); },
    () => recordChatMerge(root, 12, { now: () => T0 }),
  ]) {
    await extra();
    const d = bash('gh pr merge 12', { now: () => T0 + 5000 });
    assert.equal(d.allow, false);
    assert.match(d.reason, /gh pr merge is blocked/i);
    assert.match(d.reason, /use swarm merge/i);
    assert.equal(d.reason, GH_PR_MERGE_BLOCKED);
  }
});

test('swarm merge policy: blocked, standing, chat, and edge cases', async t => {
  const { bash, root, setPolicy, policyPath } = await project(t);

  let d = bash('swarm merge 12');
  assert.equal(d.allow, false);
  assert.equal(d.reason, MERGE_BLOCKED_REASON);
  assert.doesNotMatch(d.reason, /write a ticket instead/);
  assert.doesNotMatch(d.reason, /\bedit\b/i);
  assert.doesNotMatch(d.reason, /policy file/i);

  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: true }] });
  const allowed = bash('swarm merge 12');
  assert.equal(allowed.allow, true);
  assert.equal(allowed.standing, 'merge-swarm-pr');

  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: false }] });
  assert.equal(bash('swarm merge 12').allow, false);

  await fs.writeFile(path.join(root, 'policy.json'), '{not json');
  assert.equal(bash('swarm merge 12').allow, false);

  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: true }] });
  for (const cmd of ['swarm merge 12 --force', 'swarm merge 12 --admin', 'swarm merge 12 --auto', 'swarm merge 12 --yes', 'swarm merge 12 --force=true', 'swarm merge 12 -fy']) {
    assert.equal(bash(cmd).allow, false, cmd);
  }
  assert.equal(bash('swarm merge 12 13').allow, false);
  assert.equal(bash('swarm merge').allow, false);

  await setPolicy({ rules: [{ id: 'merge-swarm-pr' }] });
  assert.equal(bash('swarm merge 12').allow, false);
  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: 'true' }] });
  assert.equal(bash('swarm merge 12').allow, false);
  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: 0 }] });
  assert.equal(bash('swarm merge 12').allow, false);
  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: true, disabled: true }] });
  assert.equal(bash('swarm merge 12').allow, false);
  await setPolicy({ rules: [{ id: 'merge-swarm-pr', enabled: true }, { id: 'merge-swarm-pr', disabled: true }] });
  assert.equal(bash('swarm merge 12').allow, false);

  const relPolicy = path.join(root, 'rel-policy.json');
  await fs.writeFile(relPolicy, JSON.stringify({ rules: [{ id: 'merge-swarm-pr', enabled: true }] }));
  const prev = process.env.SWARM_POLICY_FILE;
  process.env.SWARM_POLICY_FILE = 'policy.json';
  try {
    assert.equal(mergeSwarmPrStandingEnabled(), false);
    assert.equal(bash('swarm merge 12').allow, false);
  } finally {
    if (prev === undefined) delete process.env.SWARM_POLICY_FILE;
    else process.env.SWARM_POLICY_FILE = prev;
    process.env.SWARM_POLICY_FILE = policyPath;
  }

  await setPolicy(null);
  recordChatMerge(root, 12, { now: () => T0 });
  assert.equal(bash('swarm merge 12', { now: () => T0 + 1000 }).allow, true);
});

test('git merge keeps generic hand-build denial', async t => {
  const { bash } = await project(t);
  const d = bash('git merge origin/main');
  assert.equal(d.allow, false);
  assert.match(d.reason, /write a ticket instead/);
  assert.match(d.reason, /git merge/);
  assert.notEqual(d.reason, MERGE_BLOCKED_REASON);
});

test('git config-style flags anywhere in git commands are not free', async t => {
  const { bash } = await project(t);
  for (const cmd of [
    'git rebase -x CMD origin/main',
    'git fetch --upload-pack=X .',
    'git push --receive-pack=X origin feature/x',
  ]) {
    const d = bash(cmd);
    assert.equal(d.allow, false, cmd);
    assert.match(d.reason, /blocked: git (config|commit|push|fetch)/i, cmd);
  }
});

test('gh commands off the free list need approval naming gh; pr merge stays blocked', async t => {
  const { bash, root } = await project(t);
  const blocked = bash('gh pr comment 5');
  assert.equal(blocked.allow, false);
  assert.match(blocked.reason, /blocked: gh\b/);

  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot comment on prs from here', files: 'src/x.mjs', git: 'gh', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0 });
  assert.equal(bash('gh pr comment 5', { now: () => T1 }).allow, true);

  const withGh = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge prs with gh cli', files: 'src/x.mjs', git: 'gh', minutes: 30 }, { now: () => T0 });
  decideRequest(root, withGh.id, 'approve', { now: () => T0, channel: 'phone' });
  const merge = bash('gh pr merge 5', { now: () => T1 });
  assert.equal(merge.allow, false);
  assert.equal(merge.reason, GH_PR_MERGE_BLOCKED);
});
