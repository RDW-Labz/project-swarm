// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { guardDecision, createRequest, decideRequest, recordChatMerge, readState } from '../tools/handbuild.mjs';
import { decide } from '../tools/inbox.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';
import { syncPhone } from '../tools/phone.mjs';
import { inboxDeps } from '../tools/inbox-commands.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const CHAT_MERGE_MS = 60 * 60000;
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-ch-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8' });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('checkout', '-q', '-b', 'feature/x');
  return { root, git };
}

async function journalDeps(root, { now = () => T0, channel } = {}) {
  return {
    ...inboxDeps({ now, channel }),
    readJournal: (r, o) => readJournal(r, o),
    appendEvent: (r, e, o) => appendEvent(r, e, o),
  };
}

async function installOrchestratorHook(root) {
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const command = `test -f ${JSON.stringify(HOOK)} && node ${JSON.stringify(HOOK)} prompt || true`;
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), `${JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2)}\n`);
}

async function openHandbuildDecision(root, req, { now = () => T0 } = {}) {
  await appendEvent(root, {
    kind: 'decision',
    id: `handbuild-${req.id}`,
    text: 'Hand-build test',
    choice: 'deny',
    options: ['approve', 'deny'],
    confirm: true,
  }, { now });
}

test('elevated hand-build approve is computer-only; deny and non-elevated stay open', async t => {
  const { root } = await project(t);
  const elevated = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from the phone', files: 'src/a.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  await openHandbuildDecision(root, elevated);
  const ref = `handbuild-${elevated.id}`;
  for (const channel of ['phone', 'board', 'remote-control', undefined]) {
    const deps = await journalDeps(root, { channel });
    await assert.rejects(() => decide(root, ref, 'approve', deps), /handbuild-computer-only:/);
  }
  await decide(root, ref, 'approve', await journalDeps(root, { channel: 'computer' }));
  assert.equal(readState(root).requests[elevated.id].status, 'approved');

  const denyReq = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot deploy from the phone', files: 'src/a.ts', git: 'deploy', minutes: 30 }, { now: () => T0 });
  await openHandbuildDecision(root, denyReq);
  await decide(root, `handbuild-${denyReq.id}`, 'deny', await journalDeps(root, { channel: 'phone' }));

  const plain = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot commit from the phone', files: 'src/a.ts', git: 'commit,push', minutes: 30 }, { now: () => T0 });
  await openHandbuildDecision(root, plain);
  await decide(root, `handbuild-${plain.id}`, 'approve', await journalDeps(root, { channel: 'phone' }));
  assert.equal(readState(root).requests[plain.id].status, 'approved');
});

test('force push to main is never approvable; feature branch with approval is allowed', async t => {
  const { root, git } = await project(t);
  const bash = (command, now = T0) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => now, branchOf: () => 'feature/x' });
  const r = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot force push from here', files: 'src/a.ts', git: 'force-push', minutes: 30 }, { now: () => T0 });
  decideRequest(root, r.id, 'approve', { now: () => T0, channel: 'computer' });
  const main = bash('git push --force origin main', T0 + 1000);
  assert.equal(main.allow, false);
  assert.match(main.reason, /never approvable/i);
  const feat = bash('git push --force origin feature/x', T0 + 1000);
  assert.equal(feat.allow, true);
});

test('chat merge: record, consume once, wrong PR and expiry', async t => {
  const { root } = await project(t);
  const bash = (command, now = T0) => guardDecision({ tool: 'Bash', toolInput: { command }, root, cwd: root, now: () => now, branchOf: () => 'feature/x' });
  recordChatMerge(root, 5, { now: () => T0 });
  assert.equal(bash('gh pr merge 5', T0 + 1000).allow, true);
  assert.equal(bash('gh pr merge 5', T0 + 2000).allow, false);
  assert.equal(bash('gh pr merge 6', T0 + 2000).allow, false);
  recordChatMerge(root, 9, { now: () => T0 });
  assert.equal(bash('swarm merge 9', T0 + CHAT_MERGE_MS + 1).allow, false);
});

async function fakeClaudeHome(t) {
  const home = await tmp(t);
  await fs.mkdir(path.join(home, '.claude', 'projects', 'hb-channel-test'), { recursive: true });
  return home;
}

async function writeTranscript(home, lastUserText, rel) {
  const transcriptPath = path.join(home, '.claude', 'projects', 'hb-channel-test', rel);
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: lastUserText } })}\n`);
  return transcriptPath;
}

test('orchestrator prompt hook records merge lines only at line start', async t => {
  const home = await fakeClaudeHome(t);
  const { root } = await project(t);
  await installOrchestratorHook(root);
  let seq = 0;
  const runHook = async (prompt, hookEventName = 'UserPromptSubmit') => {
    const transcript_path = await writeTranscript(home, prompt, `s-${seq++}.jsonl`);
    return spawnSync(process.execPath, [HOOK, 'prompt'], {
      input: JSON.stringify({
        session_id: 's',
        cwd: root,
        transcript_path,
        prompt,
        hook_event_name: hookEventName,
      }),
      encoding: 'utf8',
      env: { ...process.env, HOME: home },
    });
  };
  for (const prompt of ['merge #203', 'Merge 7', 'merge pr #5']) {
    assert.equal((await runHook(prompt)).status, 0);
  }
  for (const [prompt, event] of [
    ['1. merge #99', 'UserPromptSubmit'],
    ['please merge #98 soon', 'UserPromptSubmit'],
    ['```merge #97```', 'UserPromptSubmit'],
    ['merge #96\nsecond line', 'UserPromptSubmit'],
    ['merge #95', 'SessionStart'],
  ]) {
    assert.equal((await runHook(prompt, event)).status, 0);
  }
  const state = readState(root);
  assert.ok(state.merges['203'] > T0);
  assert.ok(state.merges['7'] > T0);
  assert.ok(state.merges['5'] > T0);
  for (const pr of ['99', '98', '97', '96', '95']) assert.equal(state.merges[pr], undefined);
});

test('phone refuses elevated hand-build approve before decide runs', async t => {
  const { root } = await project(t);
  const req = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge from the phone sync', files: 'src/a.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  await openHandbuildDecision(root, req);
  const dir = await tmp(t);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ repo: 'o/r', owners: ['me'], enabled: true }));
  const key = `${root}|decision|handbuild-${req.id}`;
  const state = {
    repo: 'o/r',
    issues: {
      '1': {
        key,
        kind: 'decision',
        root,
        projectName: 'p',
        itemId: `handbuild-${req.id}`,
        options: ['approve', 'deny'],
        default: 'approve',
        status: 'open',
        createdAt: T0,
        expiresAt: T0 + 86400000,
        seen: [],
      },
    },
  };
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify(state));
  let decided = false;
  const r = await syncPhone({
    dir,
    deps: {
      now: () => T0 + 1000,
      gh: async () => JSON.stringify([{ id: 'c1', body: '1', user: { login: 'me', type: 'User' }, created_at: new Date(T0 + 1000).toISOString(), updated_at: new Date(T0 + 1000).toISOString() }]),
      items: async () => [{ key, root, projectName: 'p', kind: 'decision', itemId: `handbuild-${req.id}`, title: 't', options: ['approve', 'deny'], default: 'approve', secondStep: false }],
      decideInbox: async () => { decided = true; return { ok: true, text: 'ok' }; },
      runSwarm: async () => ({ ok: true, text: 'ok' }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(decided, false);
  assert.ok(r.answered.includes('1'));
});
