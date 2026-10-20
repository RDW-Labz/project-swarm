// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readState, createRequest, STATE_FILE } from '../tools/handbuild.mjs';
import { decide } from '../tools/inbox.mjs';
import { decideChannelFromEnvironment, inboxDeps } from '../tools/inbox-commands.mjs';
import { appendEvent, readJournal } from '../tools/journal.mjs';
import { syncPhone } from '../tools/phone.mjs';

const HOOK = fileURLToPath(new URL('../tools/orchestrator-hook.mjs', import.meta.url));
const CHAT_MERGE_MS = 60 * 60000;
const T0 = Date.UTC(2026, 9, 20, 12, 0, 0);
const tmp = async t => { const d = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'swarm-hb-hook-'))); t.after(() => fs.rm(d, { recursive: true, force: true })); return d; };

function ownerTerminalEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.SWARM_AGENT_SESSION;
  return env;
}

async function project(t) {
  const root = await tmp(t);
  const git = (...args) => spawnSync('git', ['-c', 'user.email=a@b', '-c', 'user.name=a', ...args], { cwd: root, encoding: 'utf8', env: ownerTerminalEnv() });
  git('init', '-q');
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'a.ts'), 'a\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  return { root };
}

async function installOrchestratorHook(root) {
  await fs.mkdir(path.join(root, '.claude'), { recursive: true });
  const command = `test -f ${JSON.stringify(HOOK)} && node ${JSON.stringify(HOOK)} prompt || true`;
  await fs.writeFile(path.join(root, '.claude', 'settings.local.json'), `${JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: 'command', command }] }] },
  }, null, 2)}\n`);
}

async function fakeClaudeHome(t) {
  const home = await tmp(t);
  await fs.mkdir(path.join(home, '.claude', 'projects', 'hb-hook-test'), { recursive: true });
  return home;
}

async function writeTranscript(home, lastUserText, rel = `hb-hook-${Date.now()}.jsonl`) {
  const transcriptPath = path.join(home, '.claude', 'projects', 'hb-hook-test', rel);
  await fs.writeFile(transcriptPath, `${JSON.stringify({ type: 'user', message: { content: lastUserText } })}\n`);
  return transcriptPath;
}

async function runHook(root, extra = {}) {
  const prompt = extra.prompt ?? 'merge 7';
  const home = extra.home;
  const transcript_path = extra.transcript_path ?? (home ? await writeTranscript(home, prompt) : undefined);
  return spawnSync(process.execPath, [HOOK, 'prompt'], {
    input: JSON.stringify({
      session_id: 'sess-owner',
      cwd: extra.cwd ?? root,
      hook_event_name: 'UserPromptSubmit',
      transcript_path,
      prompt,
    }),
    encoding: 'utf8',
    env: ownerTerminalEnv(home ? { HOME: home } : {}),
  });
}

async function journalDeps(root, { now = () => T0, channel } = {}) {
  return {
    ...inboxDeps({ now, channel }),
    readJournal: (r, o) => readJournal(r, o),
    appendEvent: (r, e, o) => appendEvent(r, e, o),
  };
}

async function openHandbuildDecision(root, ref, { now = () => T0 } = {}) {
  await appendEvent(root, {
    kind: 'decision',
    id: ref,
    text: 'hand-build',
    choice: 'deny',
    options: ['approve', 'deny'],
    confirm: true,
  }, { now });
}

test('chat merge hook: worker cwd and missing transcript record nothing', async t => {
  const home = await fakeClaudeHome(t);
  const { root } = await project(t);
  await installOrchestratorHook(root);
  const workerCwd = path.join(root, '.swarm', 'workspaces', 'run1', 'job1');
  await fs.mkdir(workerCwd, { recursive: true });
  await runHook(root, { cwd: workerCwd, prompt: 'merge 7', home });
  assert.equal(readState(root).merges?.['7'], undefined);

  const { root: root2 } = await project(t);
  await installOrchestratorHook(root2);
  await runHook(root2, { transcript_path: undefined, prompt: 'merge 7' });
  assert.equal(readState(root2).merges?.['7'], undefined);
});

test('chat merge hook: valid owner prompt records merge expiry about 60 minutes ahead', async t => {
  const home = await fakeClaudeHome(t);
  const { root } = await project(t);
  await installOrchestratorHook(root);
  const before = Date.now();
  await runHook(root, { prompt: 'merge 7', home });
  const after = Date.now();
  const exp = readState(root).merges?.['7'];
  assert.ok(Number.isFinite(exp));
  assert.ok(exp >= before + CHAT_MERGE_MS - 500);
  assert.ok(exp <= after + CHAT_MERGE_MS + 500);
});

test('approve unknown hand-build request is refused from every channel', async t => {
  const { root } = await project(t);
  const ref = 'handbuild-missing-req';
  await openHandbuildDecision(root, ref);
  for (const channel of ['phone', 'board', 'remote-control', 'computer', 'agent', undefined]) {
    const deps = await journalDeps(root, { channel });
    await assert.rejects(() => decide(root, ref, 'approve', deps), /handbuild-request-unknown/);
  }
});

test('approve hand-build request with no git field is refused from every channel', async t => {
  const { root } = await project(t);
  const req = createRequest(root, { kind: 'tiny', reason: 'the swarm cannot merge without git field', files: 'src/a.ts', git: 'merge', minutes: 30 }, { now: () => T0 });
  const ref = `handbuild-${req.id}`;
  await openHandbuildDecision(root, ref);
  const state = readState(root);
  delete state.requests[req.id].git;
  await fs.mkdir(path.dirname(path.join(root, STATE_FILE)), { recursive: true });
  await fs.writeFile(path.join(root, STATE_FILE), `${JSON.stringify(state)}\n`);
  for (const channel of ['phone', 'board', 'remote-control', 'computer', 'agent', undefined]) {
    const deps = await journalDeps(root, { channel });
    await assert.rejects(() => decide(root, ref, 'approve', deps), /handbuild-request-unknown/);
  }
});

test('phone path refuses unknown hand-build approve before decide runs', async t => {
  const { root } = await project(t);
  await openHandbuildDecision(root, 'handbuild-missing-phone');
  const dir = await tmp(t);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, 'config.json'), JSON.stringify({ repo: 'o/r', owners: ['me'], enabled: true }));
  const key = `${root}|decision|handbuild-missing-phone`;
  await fs.writeFile(path.join(dir, 'state.json'), JSON.stringify({
    repo: 'o/r',
    issues: {
      '9': {
        key,
        kind: 'decision',
        root,
        projectName: 'p',
        itemId: 'handbuild-missing-phone',
        options: ['approve', 'deny'],
        default: 'approve',
        status: 'open',
        createdAt: T0,
        expiresAt: T0 + 86400000,
        seen: [],
      },
    },
  }));
  let decided = false;
  const r = await syncPhone({
    dir,
    deps: {
      now: () => T0 + 1000,
      gh: async () => JSON.stringify([{ id: 'c9', body: '1', user: { login: 'me', type: 'User' }, created_at: new Date(T0 + 1000).toISOString(), updated_at: new Date(T0 + 1000).toISOString() }]),
      items: async () => [{ key, root, projectName: 'p', kind: 'decision', itemId: 'handbuild-missing-phone', title: 't', options: ['approve', 'deny'], default: 'approve', secondStep: false }],
      decideInbox: async () => { decided = true; return { ok: true, text: 'ok' }; },
      runSwarm: async () => ({ ok: true, text: 'ok' }),
    },
  });
  assert.equal(r.ok, true);
  assert.equal(decided, false);
  assert.equal(r.answered.includes('9'), true);
});

test('decideChannelFromEnvironment: SWARM_AGENT_SESSION yields agent', () => {
  const savedIn = process.stdin.isTTY;
  const savedOut = process.stdout.isTTY;
  try {
    process.stdin.isTTY = true;
    process.stdout.isTTY = true;
    assert.equal(decideChannelFromEnvironment({ SWARM_AGENT_SESSION: '1' }), 'agent');
    assert.equal(decideChannelFromEnvironment({}), 'computer');
  } finally {
    process.stdin.isTTY = savedIn;
    process.stdout.isTTY = savedOut;
  }
});
